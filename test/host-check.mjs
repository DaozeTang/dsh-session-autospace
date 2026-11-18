/**
 * Host smoke test for index.js.
 *
 * Runs the real `apply(ctx, config)` against a stub Cordis context whose
 * session/workspace/storage services behave like the documented contracts, then
 * drives the plugin's HTTP routes through fake request/response objects. The
 * filesystem is real: every scratch folder, inventory read, and rebuild lands in
 * a temporary root under the repository's .tmp directory. Trash calls are avoided (macOS
 * would ask for Finder automation permission), so the actions that would use
 * them are asserted through their validation paths instead.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, normalizeConfig, configuredRoot } from '../index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const workdir = path.join(here, '..', '.tmp', 'host-check')
await fsp.rm(workdir, { recursive: true, force: true })
await fsp.mkdir(workdir, { recursive: true })
const root = path.join(workdir, 'root')
// The plugin keeps its remembered choice under DSH_HOME; isolate it here so a
// test never touches the real one.
process.env.DSH_HOME = path.join(workdir, 'home')
process.env.DSH_PROFILE = 'check'

// ────────────────────────────────────────────── fake DSH services ──

let seq = 0
const sessions = new Map()
const workspaces = []
const archived = new Set()
const pinned = new Set()
let routeHandlers = new Map()
let sessionEventListener = null
let configEditorCalls = []

const sessionSummary = (session) => ({
  agentAvailable: true,
  sessionId: session.id,
  updatedAt: session.updatedAt,
  running: session.running,
  blank: session.blank,
  cwd: session.cwd,
})

const workspaceRegistry = {
  async create(dir, title) {
    const info = await fsp.lstat(dir)
    assert.ok(info.isDirectory(), 'workspace path must be an existing directory')
    const workspace = {
      id: `ws-${++seq}`,
      path: path.resolve(dir),
      title: title ?? path.basename(dir),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sessionIds: [],
    }
    workspaces.unshift(workspace)
    return workspace
  },
  get(id) {
    return workspaces.find(workspace => workspace.id === id)
  },
  list() {
    return workspaces
  },
  async delete(id) {
    const index = workspaces.findIndex(workspace => workspace.id === id)
    if (index < 0) return false
    workspaces.splice(index, 1)
    return true
  },
  async archiveSession(sessionId, options = {}) {
    const session = sessions.get(sessionId)
    assert.ok(session !== undefined, 'archive target must exist')
    if (session.running && options.stopActivity !== true) throw new Error('session is running')
    archived.add(sessionId)
  },
  async unarchiveSession(sessionId) {
    archived.delete(sessionId)
  },
  async pinSession(sessionId) {
    pinned.add(sessionId)
  },
  async unpinSession(sessionId) {
    pinned.delete(sessionId)
  },
}

const sessionController = {
  async list() {
    return { items: [...sessions.values()].map(sessionSummary) }
  },
  async create(request) {
    const workspace = request.workspaceId === undefined ? undefined : workspaceRegistry.get(request.workspaceId)
    const cwd = workspace?.path ?? request.cwd ?? root
    const session = {
      id: request.sessionId ?? `session-${crypto.randomUUID()}`,
      cwd,
      blank: true,
      running: false,
      updatedAt: Date.now(),
      title: undefined,
    }
    sessions.set(session.id, session)
    if (workspace !== undefined) workspace.sessionIds.unshift(session.id)
    return { sessionId: session.id }
  },
  async rename(request) {
    const session = sessions.get(request.sessionId)
    assert.ok(session !== undefined)
    session.title = request.title
    return { title: request.title, seq: 1 }
  },
  async openWorkspacePath() {
    return { opened: true }
  },
}

const webServer = {
  register(route) {
    routeHandlers.set(route.path, route)
    return () => { routeHandlers.delete(route.path) }
  },
}

const stubCtx = {
  fiber: { entry: { id: 'session-autospace' } },
  effect(fn) {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  inject(_deps, callback) {
    callback(stubCtx)
    return () => {}
  },
  on(event, listener) {
    if (event === 'session/event') sessionEventListener = listener
    return () => { sessionEventListener = null }
  },
  get(name) {
    switch (name) {
      case 'webServer': return webServer
      case 'connection': return { admit: () => ({ peer: { id: 'browser' } }) }
      case 'sessionController': return sessionController
      case 'workspaceRegistry': return workspaceRegistry
      case 'configEditor':
        return {
          async edit(entry, change) {
            const next = change({ workspaceRoot: '', ...currentConfig })
            Object.assign(currentConfig, next)
            configEditorCalls.push(next)
          },
        }
      default: return undefined
    }
  },
  logger() {
    return { info: () => {}, warn: () => {} }
  },
}

let currentConfig = normalizeConfig({ workspaceRoot: root, trashOnDelete: false, autoReclaimHours: 0 })

// ─────────────────────────────────────────────── HTTP plumbing ──

function makeRequest(body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    method: 'POST',
    headers: { host: '127.0.0.1:49817', origin: 'http://127.0.0.1:49817' },
    resume() {},
    async *[Symbol.asyncIterator]() {
      if (text !== '') yield Buffer.from(text)
    },
  }
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(text) { if (typeof text === 'string') this.body += text },
  }
}

async function call(route, body) {
  const handler = routeHandlers.get(`/api/session-autospace${route}`)
  assert.ok(handler !== undefined, `route ${route} is not registered`)
  const res = makeResponse()
  await handler.handler(makeRequest(body), res)
  const payload = res.body === '' ? null : JSON.parse(res.body)
  return { status: res.statusCode, payload }
}

async function ok(route, body) {
  const { status, payload } = await call(route, body)
  assert.equal(status, 200, `${route} http status`)
  assert.equal(payload.ok, true, `${route} failed: ${JSON.stringify(payload)}`)
  return payload.value
}

// ────────────────────────────────────────────────────── scenarios ──

const results = []
const step = (name, detail) => { results.push([name, detail]) }

assert.ok(configuredRoot(normalizeConfig({})).endsWith('/DSH'), 'default root is ~/DSH')
assert.equal(normalizeConfig({ autoReclaimHours: 999 }).autoReclaimHours, 999)
assert.equal(normalizeConfig({ autoReclaimHours: -5 }).autoReclaimHours, 0)
assert.equal(normalizeConfig({ pickerEntry: 'yes' }).pickerEntry, true, 'non-boolean falls back to the default')
step('config normalization', 'defaults, clamping, type fallback')

apply(stubCtx, currentConfig)
assert.equal(routeHandlers.size, 12, `unexpected route count: ${[...routeHandlers.keys()].join(",")}`)
step('apply', '12 routes registered')

const initial = await ok('/status')
assert.equal(initial.root, await fsp.realpath(root))
assert.equal(initial.staged.length, 0)
assert.equal(initial.caps.trash, true)
assert.equal(initial.lastPick, null, 'a fresh state has no remembered choice')
step('status', `root ${initial.root}`)

// the remembered choice round-trips through the Host
const remembered = await ok('/memory', { kind: 'workspace' })
assert.equal(remembered.kind, 'workspace')
assert.equal((await ok('/status')).lastPick, 'workspace')
const memoryFile = path.join(workdir, 'home', 'session-autospace', 'last-pick-check.json')
const storedMemory = JSON.parse(await fsp.readFile(memoryFile, 'utf8'))
assert.equal(storedMemory.kind, 'workspace')
const badMemory = await call('/memory', { kind: 'nonsense' })
assert.equal(badMemory.payload.ok, false)
assert.equal(badMemory.payload.code, 'MEMORY_INVALID')
step('memory', 'choice saved to DSH_HOME and reported by /status')

// prepare → folder, workspace, session
const prepared = await ok('/prepare', { requestId: 'r1', locale: 'en' })
assert.match(prepared.sessionId, /^session-[0-9a-f-]{36}$/)
assert.equal(prepared.path, path.join(root, prepared.sessionId))
assert.equal(prepared.reused, false)
const folderInfo = await fsp.lstat(prepared.path)
assert.ok(folderInfo.isDirectory())
assert.equal(folderInfo.mode & 0o777, 0o700, `folder mode ${(folderInfo.mode & 0o777).toString(8)}`)
assert.equal(workspaces.length, 1)
assert.equal(workspaces[0].title, 'No workspace')
assert.deepEqual(workspaces[0].sessionIds, [prepared.sessionId])
assert.equal(sessions.get(prepared.sessionId).cwd, prepared.path)
assert.equal((await ok('/status')).lastPick, 'scratch', 'a prepared scratch conversation is remembered')
step('prepare', 'folder 0700 + temporary workspace + blank session + remembered choice')

// idempotent request id
const again = await ok('/prepare', { requestId: 'r1', locale: 'en' })
assert.equal(again.sessionId, prepared.sessionId)
assert.equal(again.reused, false)
step('prepare (same requestId)', 'returns the same session')

// reuseBlank on a second click
const reused = await ok('/prepare', { requestId: 'r2', locale: 'en' })
assert.equal(reused.sessionId, prepared.sessionId)
assert.equal(reused.reused, true)
step('prepare (reuseBlank)', 'reuses the blank scratch conversation')

// settle on the first turn (host channel)
const settled = await ok('/settle', { sessionId: prepared.sessionId })
assert.equal(settled.settled, true)
assert.equal(workspaces.length, 0)
assert.ok(fs.existsSync(prepared.path), 'settle keeps the folder')
let status = await ok('/status')
assert.equal(status.staged.length, 0)
step('settle', 'workspace registration gone, folder kept')

// a no-op settle is idempotent
const settledAgain = await ok('/settle', { sessionId: prepared.sessionId })
assert.equal(settledAgain.settled, true)
assert.equal(settledAgain.noop, true)
step('settle (idempotent)', 'no-op reported, not an error')

// turn event settles by itself
const eventPrepared = await ok('/prepare', { requestId: 'r3', locale: 'zh-CN' })
assert.equal(workspaces.length, 1)
assert.equal(workspaces[0].title, '不指定工作区')
assert.ok(sessionEventListener !== null, 'session/event listener installed')
sessionEventListener({ id: eventPrepared.sessionId }, { type: 'turn/start' })
await new Promise(resolve => setTimeout(resolve, 120))
assert.equal(workspaces.length, 0, 'turn/start settles through the event channel')
step('session/event settle', 'zh title, settled on turn/start')

// abandon keeps the folder when trash is off
const abandoned = await ok('/abandon', { sessionId: prepared.sessionId })
assert.equal(abandoned.abandoned, false, 'already settled, nothing left to abandon')
const abandonTarget = await ok('/prepare', { requestId: 'r4', locale: 'en' })
const abandoned2 = await ok('/abandon', { sessionId: abandonTarget.sessionId })
assert.equal(abandoned2.abandoned, true)
assert.equal(workspaces.length, 0, 'the temporary registration is gone')
assert.ok(fs.existsSync(abandonTarget.path), 'trashOnDelete=false keeps the folder')
assert.ok(archived.has(abandonTarget.sessionId), 'the blank conversation is archived')
step('abandon', 'archives the session, keeps the folder when trash is off')

// archive/pin/rename through the management route
const managed = await ok('/session-op', { sessionId: prepared.sessionId, op: 'rename', title: 'Renamed scratch' })
assert.equal(managed.ok, true)
assert.equal(sessions.get(prepared.sessionId).title, 'Renamed scratch')
await ok('/session-op', { sessionId: prepared.sessionId, op: 'pin' })
assert.ok(pinned.has(prepared.sessionId))
await ok('/session-op', { sessionId: prepared.sessionId, op: 'unpin' })
assert.ok(!pinned.has(prepared.sessionId))
await ok('/session-op', { sessionId: prepared.sessionId, op: 'archive' })
assert.ok(archived.has(prepared.sessionId))
await ok('/session-op', { sessionId: prepared.sessionId, op: 'unarchive' })
assert.ok(!archived.has(prepared.sessionId))
sessions.get(prepared.sessionId).running = true
const runningArchive = await call('/session-op', { sessionId: prepared.sessionId, op: 'archive' })
assert.equal(runningArchive.payload.ok, true, 'a running turn is stopped and archived')
assert.ok(archived.has(prepared.sessionId))
sessions.get(prepared.sessionId).running = false
await ok('/session-op', { sessionId: prepared.sessionId, op: 'unarchive' })
step('session-op', 'rename, pin, archive (stop-and-archive), unarchive')

// delete = archive + Trash (archive only with the switch off)
const deleteTarget = await ok('/prepare', { requestId: 'r5', locale: 'en' })
const deleted = await ok('/trash', { sessionId: deleteTarget.sessionId })
assert.equal(deleted.archived, true, 'delete archives the conversation first')
assert.equal(deleted.trashed, false, 'trashOnDelete=false keeps the folder')
assert.equal(deleted.kept, true)
assert.ok(archived.has(deleteTarget.sessionId))
assert.ok(fs.existsSync(deleteTarget.path), 'folder kept when the switch is off')
sessions.get(deleteTarget.sessionId).running = true
const runningDelete = await call('/trash', { sessionId: deleteTarget.sessionId })
assert.equal(runningDelete.payload.ok, false)
assert.equal(runningDelete.payload.code, 'SESSION_RUNNING')
sessions.get(deleteTarget.sessionId).running = false
step('trash route', 'archives first, keeps the folder when the switch is off, refuses a running turn')

// inventory: sizes, orphans, missing detection
const orphanPath = path.join(root, `session-00000000-0000-4000-8000-000000000000`)
await fsp.mkdir(orphanPath, { recursive: true })
await fsp.writeFile(path.join(orphanPath, 'notes.md'), 'x'.repeat(2048))
const inventory = await ok('/inventory')
assert.equal(inventory.root, await fsp.realpath(root))
const orphanId = path.basename(orphanPath)
assert.ok(inventory.orphans.includes(orphanId), `orphans: ${inventory.orphans.join(',')}`)
const orphanFolder = inventory.folders.find(folder => folder.id === orphanId)
assert.equal(orphanFolder.bytes, 2048)
assert.equal(orphanFolder.files, 1)
step('inventory', 'byte counts and orphan detection')

// the working-path card probes a candidate directory without creating it
const probeRoot = await ok('/probe', { path: root })
assert.equal(probeRoot.exists, true)
assert.equal(probeRoot.writable, true)
const probeChild = await ok('/probe', { path: path.join(root, 'not-yet') })
assert.equal(probeChild.exists, false)
assert.equal(probeChild.writable, true, 'the parent is writable, so the directory can be created')
const probeRelative = await call('/probe', { path: 'relative/path' })
assert.equal(probeRelative.payload.ok, false)
assert.equal(probeRelative.payload.code, 'ROOT_INVALID')
step('probe', 'existence, writability, and absolute-path validation')

// a deleted folder is still listed, marked missing
await fsp.rm(prepared.path, { recursive: true, force: true })
const inventoryAfter = await ok('/inventory', { fresh: true })
const missingEntry = inventoryAfter.folders.find(folder => folder.id === path.basename(prepared.path))
assert.ok(missingEntry !== undefined, 'a session whose folder vanished still has a row')
assert.equal(missingEntry.exists, false)
assert.ok(!inventoryAfter.orphans.includes(path.basename(prepared.path)), 'a missing folder is not an orphan')
step('inventory (missing folder)', 'known session reported with exists:false')

// rebuild a missing folder
await fsp.rm(prepared.path, { recursive: true, force: true })
const rebuilt = await ok('/maintenance', { op: 'rebuildMissing', ids: [prepared.sessionId] })
assert.deepEqual(rebuilt.changed, [prepared.sessionId])
assert.ok(fs.existsSync(prepared.path), 'folder recreated')
step('maintenance rebuildMissing', 'folder recreated')

// trash route validates before it touches anything
await fsp.rm(prepared.path, { recursive: true, force: true })
const missingTrash = await call('/trash', { sessionId: prepared.sessionId })
assert.equal(missingTrash.payload.ok, false)
assert.equal(missingTrash.payload.code, 'FOLDER_MISSING')
const badId = await call('/trash', { sessionId: '../../etc' })
assert.equal(badId.payload.ok, false)
assert.equal(badId.payload.code, 'BAD_REQUEST')
step('trash validation', 'missing folder and traversal refused')

const revealedRoot = await ok('/reveal', { path: root })
assert.equal(revealedRoot.revealed, true)
const revealedSession = await ok('/reveal', { sessionId: deleteTarget.sessionId })
assert.equal(revealedSession.revealed, true)
const revealedOutside = await call('/reveal', { path: '/etc' })
assert.equal(revealedOutside.payload.ok, false)
assert.equal(revealedOutside.payload.code, 'OUT_OF_ROOT')
step('reveal', 'root and folder revealed, outside path refused')

// config write goes through the config editor
const written = await ok('/config', { patch: { rowBadge: false, autoReclaimHours: 6 } })
assert.equal(written.config.rowBadge, false)
assert.equal(configEditorCalls.length, 1)
assert.equal(configEditorCalls[0].rowBadge, false)
const badPatch = await call('/config', { patch: { nonsense: 1 } })
assert.equal(badPatch.payload.ok, false)
assert.equal(badPatch.payload.code, 'CONFIG_INVALID')
const relativeRoot = await call('/config', { patch: { workspaceRoot: 'relative/path' } })
assert.equal(relativeRoot.payload.ok, false)
assert.equal(relativeRoot.payload.code, 'ROOT_INVALID')
step('config write', 'patch persisted, unknown field and relative path refused')

// a rejected request never reaches a route
const trusted = makeRequest({})
const untrusted = makeResponse()
const adminHandler = routeHandlers.get('/api/session-autospace/status')
const originalGet = stubCtx.get
stubCtx.get = (name) => (name === 'connection' ? { admit: () => ({ rejection: 403 }) } : originalGet.call(stubCtx, name))
await adminHandler.handler(trusted, untrusted)
assert.equal(untrusted.statusCode, 403)
assert.equal(untrusted.body, '')
stubCtx.get = originalGet
step('trust fence', 'unadmitted request answered 403 with no body')

// activation sweep: a leftover registration with no session is removed, a
// blank one older than the threshold is reclaimed
routeHandlers = new Map()
workspaces.length = 0
sessions.clear()
const staleDir = path.join(root, `session-11111111-1111-4111-8111-111111111111`)
await fsp.mkdir(staleDir, { recursive: true })
workspaces.push({
  id: 'ws-stale', path: staleDir, title: 'No workspace', createdAt: new Date(Date.now() - 72 * 3600_000).toISOString(), updatedAt: new Date().toISOString(), sessionIds: [],
})
const oldDir = path.join(root, `session-22222222-2222-4222-8222-222222222222`)
await fsp.mkdir(oldDir, { recursive: true })
const oldSessionId = path.basename(oldDir)
sessions.set(oldSessionId, { id: oldSessionId, cwd: oldDir, blank: true, running: false, updatedAt: Date.now() })
workspaces.push({
  id: 'ws-old', path: oldDir, title: 'No workspace', createdAt: new Date(Date.now() - 72 * 3600_000).toISOString(), updatedAt: new Date().toISOString(), sessionIds: [oldSessionId],
})
currentConfig = normalizeConfig({ workspaceRoot: root, trashOnDelete: false, autoReclaimHours: 24 })
apply(stubCtx, currentConfig)
await new Promise(resolve => setTimeout(resolve, 250))
assert.equal(workspaces.length, 0, `sweep left registrations: ${workspaces.map(w => w.title).join(',')}`)
assert.ok(archived.has(oldSessionId), 'the expired blank conversation was archived')
step('activation sweep', 'stale registration removed, expired blank reclaimed')
assert.equal((await ok('/status')).lastPick, 'scratch', 'the remembered choice survives a restart')
step('memory (restart)', 'last choice reloaded from DSH_HOME')

// clean up the sandbox
await fsp.rm(workdir, { recursive: true, force: true })

console.log(results.map(([name, detail]) => `${name}: ${detail}`).join('\n'))
console.log('OK')
void os
