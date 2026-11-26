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

import { apply, normalizeConfig, configuredRoot, waitForSessionIdle } from '../index.js'

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
const failingWorkspaceDeletes = new Set()
const activityBySession = new Map()
const activityChecks = new Map()
const stopRequests = []
const archiveGates = new Map()
const archiveStarted = new Map()

/** Hold one durable archive write open so a concurrent prepare can be tested. */
function gateArchive(sessionId) {
  let release
  let markStarted
  const gate = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { markStarted = resolve })
  archiveGates.set(sessionId, gate)
  archiveStarted.set(sessionId, { promise: entered, resolve: markStarted })
  return { entered, release: () => { archiveGates.delete(sessionId); release() } }
}

const currentActivity = (sessionId) => {
  if (activityBySession.has(sessionId)) return activityBySession.get(sessionId)
  return sessions.get(sessionId)?.running === true ? [{ kind: 'turn' }] : []
}

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
  get archivedSessionIds() {
    return [...archived]
  },
  async delete(id) {
    if (failingWorkspaceDeletes.has(id)) throw new Error('registry is busy')
    const index = workspaces.findIndex(workspace => workspace.id === id)
    if (index < 0) return false
    workspaces.splice(index, 1)
    return true
  },
  async archiveSession(sessionId, options = {}) {
    const session = sessions.get(sessionId)
    assert.ok(session !== undefined, 'archive target must exist')
    if (archived.has(sessionId)) return
    const activity = currentActivity(sessionId)
    if (activity.length > 0 && options.stopActivity !== true) {
      const error = new Error('session still has running work')
      error.name = 'WorkspaceActiveSessionError'
      error.activity = activity
      throw error
    }
    const started = archiveStarted.get(sessionId)
    started?.resolve()
    const gate = archiveGates.get(sessionId)
    if (gate !== undefined) await gate
    archiveStarted.delete(sessionId)
    archived.add(sessionId)
    stopRequests.push({ sessionId, stopActivity: options.stopActivity === true })
    // Model a normal turn cancelling immediately. Explicit activity doubles
    // remain until their test clears them so post-archive settling is observable.
    if (options.stopActivity === true && !activityBySession.has(sessionId)) session.running = false
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
  async waterfall(event, payload, next) {
    assert.equal(event, 'workspace/session-activity')
    const sessionId = payload.sessionId
    activityChecks.set(sessionId, (activityChecks.get(sessionId) ?? 0) + 1)
    const rest = await next()
    return [...currentActivity(sessionId), ...rest]
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
assert.equal('rowBadge' in normalizeConfig({ rowBadge: false }), false, 'a legacy rowBadge patch is ignored, not resurrected')
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
assert.equal(runningArchive.payload.ok, false, 'an unconfirmed archive must refuse a running turn')
assert.equal(runningArchive.payload.code, 'SESSION_RUNNING')
const forcedArchive = await call('/session-op', { sessionId: prepared.sessionId, op: 'archive', stop: true })
assert.equal(forcedArchive.payload.ok, true, 'the confirmed stop archives the running turn')
assert.ok(archived.has(prepared.sessionId))
sessions.get(prepared.sessionId).running = false
await ok('/session-op', { sessionId: prepared.sessionId, op: 'unarchive' })
step('session-op', 'rename, pin, refuse/confirm stop-and-archive, unarchive')

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

// Quiet archive uses authoritative activity admission and must not claim that
// work was stopped. Hidden jobs/subagents/schedules are not in summary.running.
stopRequests.length = 0
await ok('/session-op', { sessionId: prepared.sessionId, op: 'archive' })
assert.equal(stopRequests.at(-1)?.stopActivity, false, 'quiet archive must not request stopActivity')
await ok('/session-op', { sessionId: prepared.sessionId, op: 'unarchive' })
const hiddenId = 'session-77777777-8888-4999-8aaa-bbbbbbbbbbbb'
const hiddenDir = path.join(root, hiddenId)
await fsp.mkdir(hiddenDir, { recursive: true })
sessions.set(hiddenId, { id: hiddenId, cwd: hiddenDir, blank: false, running: false, updatedAt: Date.now() })
activityBySession.set(hiddenId, [{ kind: 'job', items: [{ id: 'job-1', label: 'background work' }] }])
const hiddenArchive = await call('/session-op', { sessionId: hiddenId, op: 'archive' })
assert.equal(hiddenArchive.payload.ok, false)
assert.equal(hiddenArchive.payload.code, 'SESSION_RUNNING')
assert.equal(hiddenArchive.payload.activity[0].kind, 'job')
assert.ok(!archived.has(hiddenId), 'a refused archive must not mutate durable state')
const hiddenDelete = await call('/trash', { sessionId: hiddenId })
assert.equal(hiddenDelete.payload.code, 'SESSION_RUNNING')
assert.ok(fs.existsSync(hiddenDir), 'a refused delete must keep the folder')
activityBySession.delete(hiddenId)
// DSH short-circuits an already-archived id before its activity check. The
// plugin's post-archive barrier must still refuse to trash that cwd.
archived.add(hiddenId)
activityBySession.set(hiddenId, [{ kind: 'schedule' }])
const archivedActiveDelete = await call('/trash', { sessionId: hiddenId })
assert.equal(archivedActiveDelete.payload.code, 'SESSION_RUNNING')
assert.ok(fs.existsSync(hiddenDir), 'an already-archived active Session kept its folder')
activityBySession.delete(hiddenId)
archived.delete(hiddenId)
step('activity admission', 'quiet archive does not stop; hidden and already-archived activity is refused')

// Confirmed stop is asynchronous in DSH. The folder must stay until the
// activity waterfall becomes empty, and a timeout must fail safe.
activityBySession.set(hiddenId, [{ kind: 'job' }])
setTimeout(() => { activityBySession.delete(hiddenId) }, 15)
const waitedDelete = await ok('/trash', { sessionId: hiddenId, stop: true })
assert.equal(waitedDelete.archived, true)
assert.equal(waitedDelete.kept, true)
assert.ok((activityChecks.get(hiddenId) ?? 0) >= 2, 'delete did not wait for activity to settle')
const timeoutId = 'session-77777777-8888-4999-8aaa-cccccccccccc'
activityBySession.set(timeoutId, [{ kind: 'subagent' }])
const timeout = await waitForSessionIdle(stubCtx, timeoutId, { timeoutMs: 15, pollMs: 5 })
assert.equal(timeout.idle, false)
assert.equal(timeout.activity[0].kind, 'subagent')
activityBySession.delete(timeoutId)
const malformed = await waitForSessionIdle({ waterfall: async () => undefined }, timeoutId, { timeoutMs: 0 })
assert.equal(malformed.idle, false, 'a malformed activity response must not authorize folder removal')
step('archive settlement', 'Trash waits for activity; timeout or malformed state fails safe')

// A failed temporary Workspace cleanup must remain retryable instead of being
// forgotten after the Session has already been archived.
const deleteRetry = await ok('/prepare', { requestId: 'r7', locale: 'en' })
failingWorkspaceDeletes.add(deleteRetry.workspaceId)
const failedDelete = await call('/trash', { sessionId: deleteRetry.sessionId })
assert.equal(failedDelete.payload.ok, false)
assert.equal(failedDelete.payload.code, 'SETTLE_FAILED')
assert.ok(archived.has(deleteRetry.sessionId), 'archive is durable before cleanup')
assert.ok((await ok('/status')).staged.some(entry => entry.sessionId === deleteRetry.sessionId), 'failed cleanup lost its retry entry')
assert.ok(fs.existsSync(deleteRetry.path), 'failed cleanup must not trash the folder')
failingWorkspaceDeletes.delete(deleteRetry.workspaceId)
const retriedDelete = await ok('/trash', { sessionId: deleteRetry.sessionId })
assert.equal(retriedDelete.archived, true)
assert.ok(!(await ok('/status')).staged.some(entry => entry.sessionId === deleteRetry.sessionId), 'successful retry kept the staged entry')
step('trash cleanup retry', 'failed registration cleanup survives and succeeds on retry')

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

// a session outside the working path is not this plugin's conversation
const outsiderId = 'session-33333333-3333-4333-8333-333333333333'
const outsiderDir = path.join(workdir, 'outside')
await fsp.mkdir(outsiderDir, { recursive: true })
sessions.set(outsiderId, { id: outsiderId, cwd: outsiderDir, blank: true, running: false, updatedAt: Date.now() })
const outsiderRename = await call('/session-op', { sessionId: outsiderId, op: 'rename', title: 'x' })
assert.equal(outsiderRename.payload.ok, false, 'a foreign session must not be renamed')
assert.equal(outsiderRename.payload.code, 'NOT_SCRATCH')
const outsiderReclaim = await ok('/maintenance', { op: 'reclaimBlank', ids: [outsiderId] })
assert.deepEqual(outsiderReclaim.changed, [])
assert.ok(outsiderReclaim.skipped.includes(outsiderId), 'a foreign blank session is skipped by reclaim')
const outsiderRebuild = await ok('/maintenance', { op: 'rebuildMissing', ids: [outsiderId] })
assert.deepEqual(outsiderRebuild.changed, [])
assert.ok(outsiderRebuild.skipped.includes(outsiderId), 'a foreign session never gets a folder in this root')
const outsiderInventory = await ok('/inventory', { fresh: true })
assert.ok(!outsiderInventory.folders.some(folder => folder.id === outsiderId), 'a foreign session has no folder row')
sessions.delete(outsiderId)
step('scratch binding', 'foreign sessions refused by management, inventory, and maintenance')

// an existing read-only directory is not reported writable
const readOnlyDir = path.join(workdir, 'readonly')
await fsp.mkdir(readOnlyDir, { recursive: true, mode: 0o500 })
await fsp.chmod(readOnlyDir, 0o500)
const probeReadOnly = await ok('/probe', { path: readOnlyDir })
assert.equal(probeReadOnly.exists, true)
assert.equal(probeReadOnly.writable, false, 'a read-only directory must not inherit its parent permission')
await fsp.chmod(readOnlyDir, 0o700)
step('probe (read-only)', 'existing directory judged on its own permissions')

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
assert.equal(missingTrash.payload.ok, true, 'deleting an already-gone folder reaches the same end state')
assert.equal(missingTrash.payload.value.alreadyGone, true)
const badId = await call('/trash', { sessionId: '../../etc' })
assert.equal(badId.payload.ok, false)
assert.equal(badId.payload.code, 'BAD_REQUEST')
step('trash validation', 'already-gone folder is idempotent, traversal refused')

const revealedRoot = await ok('/reveal', { path: root })
assert.equal(revealedRoot.revealed, true)
const revealedSession = await ok('/reveal', { sessionId: deleteTarget.sessionId })
assert.equal(revealedSession.revealed, true)
const revealedOutside = await call('/reveal', { path: '/etc' })
assert.equal(revealedOutside.payload.ok, false)
assert.equal(revealedOutside.payload.code, 'OUT_OF_ROOT')
step('reveal', 'root and folder revealed, outside path refused')

// a failed registration cleanup keeps the staged entry so the sweep can retry
const retryTarget = await ok('/prepare', { requestId: 'r6', locale: 'en' })
failingWorkspaceDeletes.add(retryTarget.workspaceId)
const failedAbandon = await call('/abandon', { sessionId: retryTarget.sessionId })
assert.equal(failedAbandon.payload.ok, false, 'a registration that could not be deleted is reported')
assert.equal(failedAbandon.payload.code, 'SETTLE_FAILED')
assert.equal((await ok('/status')).staged.length, 1, 'the staged entry survives the failed cleanup')
failingWorkspaceDeletes.delete(retryTarget.workspaceId)
const retriedAbandon = await ok('/abandon', { sessionId: retryTarget.sessionId })
assert.equal(retriedAbandon.abandoned, true)
assert.equal((await ok('/status')).staged.length, 0)
step('abandon (retry)', 'a failed registration cleanup is reported and retryable')

// config write goes through the config editor
const written = await ok('/config', { patch: { pickerEntry: false, autoReclaimHours: 6 } })
assert.equal(written.config.pickerEntry, false)
assert.equal(configEditorCalls.length, 1)
assert.equal(configEditorCalls[0].pickerEntry, false)
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

// DSH 0.2.2+ admits a registered route itself and hands the handler the Peer;
// the local fence must stay out of the way there, because connection.admit now
// re-enters this plugin's Context for connection.authentication.
assert.equal(adminHandler.auth, 'required', 'routes declare the Host auth policy')
const peerAdmitted = makeResponse()
stubCtx.get = (name) => (name === 'connection'
  ? { admit() { throw new Error('cannot get property "connection.authentication" without inject') } }
  : originalGet.call(stubCtx, name))
await adminHandler.handler(makeRequest({}), peerAdmitted, { principal: { kind: 'owner' } })
stubCtx.get = originalGet
assert.equal(peerAdmitted.statusCode, 200, 'a Host-admitted request needs no local fence')
assert.equal(JSON.parse(peerAdmitted.body).ok, true)
step('host admission', 'the admitted Peer replaces the local fence')

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
sessions.set(oldSessionId, { id: oldSessionId, cwd: oldDir, blank: true, running: false, updatedAt: Date.now() - 72 * 3600_000 })
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

// a fresh instance: reuse and request-id idempotency stay honest
routeHandlers = new Map()
workspaces.length = 0
sessions.clear()
archived.clear()
pinned.clear()
const reuseRoot = path.join(workdir, 'reuse-root')
await fsp.mkdir(reuseRoot, { recursive: true })
currentConfig = normalizeConfig({ workspaceRoot: reuseRoot, trashOnDelete: false, autoReclaimHours: 0 })
apply(stubCtx, currentConfig)
const archivedBlank = await ok('/prepare', { requestId: 'reuse-1', locale: 'en' })
await ok('/session-op', { sessionId: archivedBlank.sessionId, op: 'archive' })
const afterArchive = await ok('/prepare', { requestId: 'reuse-1', locale: 'en' })
assert.notEqual(afterArchive.sessionId, archivedBlank.sessionId, 'an archived blank conversation must not be returned by a cached prepare')
assert.equal(afterArchive.reused, false)
await ok('/trash', { sessionId: afterArchive.sessionId })
const afterDelete = await ok('/prepare', { requestId: 'reuse-1', locale: 'en' })
assert.notEqual(afterDelete.sessionId, afterArchive.sessionId, 'a deleted Session must not be returned by a cached prepare')
assert.equal(afterDelete.reused, false)
step('prepare (archived/deleted reuse)', 'archive and delete invalidate request-id receipts')

// A cached prepare must not bypass the management chain while the archive
// write is still in flight. The retry queues, then receives a fresh Session.
const raceTarget = await ok('/prepare', { requestId: 'delete-race', locale: 'en' })
const archiveGate = gateArchive(raceTarget.sessionId)
const deleting = call('/trash', { sessionId: raceTarget.sessionId })
await archiveGate.entered
let prepareSettled = false
const preparing = call('/prepare', { requestId: 'delete-race', locale: 'en' })
  .then(result => { prepareSettled = true; return result })
await new Promise(resolve => setTimeout(resolve, 25))
archiveGate.release()
const [deletedRace, preparedRace] = await Promise.all([deleting, preparing])
assert.equal(prepareSettled, true)
assert.equal(deletedRace.payload.ok, true)
assert.equal(preparedRace.payload.ok, true)
assert.notEqual(preparedRace.payload.value.sessionId, raceTarget.sessionId, 'prepare returned a Session while its delete was in flight')
step('prepare/delete race', 'cached prepare queues behind an in-flight archive')

routeHandlers = new Map()
workspaces.length = 0
sessions.clear()
archived.clear()
pinned.clear()
const concurrentRoot = path.join(workdir, 'concurrent-root')
await fsp.mkdir(concurrentRoot, { recursive: true })
currentConfig = normalizeConfig({ workspaceRoot: concurrentRoot, trashOnDelete: false, autoReclaimHours: 0, reuseBlank: false })
apply(stubCtx, currentConfig)
const [dupOne, dupTwo] = await Promise.all([
  ok('/prepare', { requestId: 'double-click', locale: 'en' }),
  ok('/prepare', { requestId: 'double-click', locale: 'en' }),
])
assert.equal(dupOne.sessionId, dupTwo.sessionId, 'one requestId must produce one conversation')
assert.equal(workspaces.length, 1, 'one requestId must produce one registration')
step('prepare (concurrent)', 'one requestId maps to one conversation and one folder')

// clean up the sandbox
await fsp.rm(workdir, { recursive: true, force: true })

console.log(results.map(([name, detail]) => `${name}: ${detail}`).join('\n'))
console.log('OK')
void os
