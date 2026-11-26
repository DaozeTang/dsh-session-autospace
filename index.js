/**
 * Session Autospace — Host half.
 *
 * Gives "no workspace" first-class treatment: for a new conversation the plugin
 * mints a real session id, creates `<working path>/<session id>` as a directory,
 * registers that directory as a temporary workspace titled "No workspace", and
 * creates the blank session inside it. The session's immutable header cwd — and
 * therefore its `workspace-write` sandbox boundary — is that directory. On the
 * first `turn/start` the temporary workspace registration is deleted, so the
 * conversation falls into the sidebar's own Ungrouped section while its cwd,
 * folder, and history stay exactly where they are.
 *
 * Everything is registered inside `apply` behind `ctx.effect`/`ctx.inject`, so
 * disabling the plugin (or switching a feature off) removes the routes, the
 * listener, and the sweep without touching DSH configuration, session logs, or
 * existing workspace records. The only durable effects are the ones a user
 * action asks for: one directory, one workspace registration, one session.
 *
 * @module dsh-session-autospace
 */

import { execFile } from 'node:child_process'
import { constants as FS_CONSTANTS } from 'node:fs'
import { access, lstat, mkdir, readdir, readFile, realpath, rename, rmdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { homedir } from 'node:os'

/** URL prefix shared by every route this plugin serves. */
export const ROUTE_PREFIX = '/api/session-autospace'

/** Directory names are session ids; anything else under the root is left alone. */
const SESSION_ID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Request bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

/** Localized titles the temporary workspace may carry; used to recognize leftovers. */
const SCRATCH_TITLES = ['No workspace', '不指定工作区', 'No workspace for this conversation', '本次对话不指定工作区']

/** Inventory walk bounds: a scratch folder holds a conversation's files, not a backup. */
const MEASURE_ENTRY_LIMIT = 20_000
const MEASURE_DEPTH_LIMIT = 8

/** Retry backoff for the post-send cleanup (milliseconds). */
const SETTLE_BACKOFF = [200, 800, 2000]

/** Confirmed stop-and-archive must settle before its working folder is trashed. */
const ARCHIVE_SETTLE_TIMEOUT_MS = 5_000
const ARCHIVE_SETTLE_POLL_MS = 50

/** `/prepare` idempotency window for a repeated request id. */
const PREPARE_IDEMPOTENCY_MS = 30_000

/** `/inventory` cache lifetime. */
const INVENTORY_TTL_MS = 10_000

/** A folder younger than this may still be waiting for its session; never treat it as an orphan. */
const ORPHAN_GRACE_MS = 15_000

/** Activating the plugin must not settle a conversation prepared in the same moment. */
const SWEEP_GRACE_MS = 10_000

/** The last new-conversation choice this plugin remembers. */
const PICK_KINDS = ['scratch', 'workspace']

/** Documented defaults; a row config only needs to carry the fields it changes. */
const DEFAULTS = {
  workspaceRoot: '',
  pickerEntry: true,
  rememberPick: true,
  management: true,
  trashOnDelete: true,
  reuseBlank: true,
  abandonOnSwitch: true,
  autoReclaimHours: 24,
}

/**
 * Build one structured failure.
 * @param code - stable machine code the browser reports.
 * @param message - short message safe to show; never another path.
 * @returns the error with its code attached.
 */
function fail(code, message) {
  const error = new Error(message ?? code)
  error.code = code
  return error
}

/**
 * Read a message out of an unknown thrown value.
 * @param error - thrown value.
 * @returns a short message.
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'unknown error'
}

/**
 * Wait for a delay.
 * @param ms - milliseconds.
 * @returns resolution after the delay.
 */
function delay(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Wait until DSH's authoritative activity providers report no running work for
 * one Session. Archive stop requests are intentionally not settlement awaits,
 * so a caller that removes the Session's cwd must observe this boundary itself.
 * @param ctx - Cordis context exposing the workspace activity waterfall.
 * @param sessionId - Session whose work is stopping.
 * @param options - bounded timeout and polling interval for tests/deployments.
 * @returns whether activity settled and the last reported activity.
 */
export async function waitForSessionIdle(ctx, sessionId, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(0, Number(options.timeoutMs))
    : ARCHIVE_SETTLE_TIMEOUT_MS
  const pollMs = Number.isFinite(Number(options.pollMs))
    ? Math.max(1, Number(options.pollMs))
    : ARCHIVE_SETTLE_POLL_MS
  // Older/composed Hosts without the waterfall still retain the summary-based
  // admission check in the caller; there is no stronger signal to poll there.
  if (typeof ctx.waterfall !== 'function') return { idle: true, activity: [], observed: false }
  const deadline = Date.now() + timeoutMs
  let activity = []
  while (true) {
    activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    if (!Array.isArray(activity)) return { idle: false, activity: [], observed: true }
    if (activity.length === 0) return { idle: true, activity, observed: true }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { idle: false, activity, observed: true }
    await delay(Math.min(pollMs, remaining))
  }
}

/**
 * Coerce a row config into the documented shape, clamping numbers and ignoring
 * unknown fields so an older/newer patch cannot break activation.
 * @param raw - the row's `config` value.
 * @returns the effective config.
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const hours = Number(source.autoReclaimHours)
  return {
    workspaceRoot: typeof source.workspaceRoot === 'string' ? source.workspaceRoot.trim() : DEFAULTS.workspaceRoot,
    pickerEntry: bool(source.pickerEntry, DEFAULTS.pickerEntry),
    rememberPick: bool(source.rememberPick, DEFAULTS.rememberPick),
    management: bool(source.management, DEFAULTS.management),
    trashOnDelete: bool(source.trashOnDelete, DEFAULTS.trashOnDelete),
    reuseBlank: bool(source.reuseBlank, DEFAULTS.reuseBlank),
    abandonOnSwitch: bool(source.abandonOnSwitch, DEFAULTS.abandonOnSwitch),
    autoReclaimHours: Number.isFinite(hours) ? Math.min(8760, Math.max(0, Math.round(hours))) : DEFAULTS.autoReclaimHours,
  }
}

/**
 * Validate a config patch coming from the settings page.
 * @param patch - raw patch object.
 * @returns only the known, well-typed fields.
 */
function validateConfigPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw fail('CONFIG_INVALID', 'expected an object')
  const next = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) throw fail('CONFIG_INVALID', `unknown field: ${key}`)
    if (key === 'workspaceRoot') {
      if (typeof value !== 'string') throw fail('CONFIG_INVALID', 'workspaceRoot must be a string')
      const trimmed = value.trim()
      if (trimmed.includes('\0')) throw fail('CONFIG_INVALID', 'workspaceRoot contains a NUL byte')
      if (trimmed !== '' && !isAbsolute(trimmed) && !trimmed.startsWith('~/')) {
        throw fail('ROOT_INVALID', 'The working path must be absolute')
      }
      next.workspaceRoot = trimmed
      continue
    }
    if (key === 'autoReclaimHours') {
      const hours = Number(value)
      if (!Number.isFinite(hours) || hours < 0 || hours > 8760) throw fail('CONFIG_INVALID', 'autoReclaimHours must be 0-8760')
      next.autoReclaimHours = Math.round(hours)
      continue
    }
    if (typeof value !== 'boolean') throw fail('CONFIG_INVALID', `${key} must be a boolean`)
    next[key] = value
  }
  return next
}

/**
 * Collect a bounded request body as UTF-8 text.
 * @param req - incoming request.
 * @returns the text, or null when the ceiling was exceeded (stream drained).
 */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Write one JSON response.
 * @param res - server response.
 * @param status - HTTP status.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Decide whether one request may run.
 *
 * DSH admits a registered route before its handler: the WebServer applies the
 * browser-trust fence and the composed authentication, then hands the admitted
 * Peer to the handler. A request that arrived with a Peer was therefore checked
 * by the Host itself, and asking again would fail — the connection service
 * re-enters this plugin's Context for `connection.authentication`, a service a
 * route plugin does not inject. Hosts that pass no Peer still get the local
 * fence below.
 * @param connection - the composition's connection service, read lazily.
 * @param req - incoming request (only headers are read).
 * @param peer - the Peer the Host admitted for this request, when it passes one.
 * @returns a rejection status, or undefined when admitted.
 */
function admissionRejection(connection, req, peer) {
  if (peer !== undefined && peer !== null) return undefined
  return rejectionOf(connection, req)
}

/**
 * Fallback fence for a Host that hands the handler no Peer and leaves admission
 * to the plugin.
 * @param connection - the composition's connection service.
 * @param req - incoming request (only headers are read).
 * @returns a rejection status, or undefined when admitted.
 */
function rejectionOf(connection, req) {
  if (connection === undefined || connection === null) return 503
  const admit = connection.admit
  if (typeof admit === 'function') {
    try {
      const admission = admit.call(connection, req)
      if (admission !== null && typeof admission === 'object') {
        if ('rejection' in admission) return admission.rejection
        if ('peer' in admission) return undefined
      }
      return 503
    } catch {
      return 503
    }
  }
  const reject = connection.requestRejection
  if (typeof reject !== 'function') return 503
  try {
    return reject.call(connection, req) ?? undefined
  } catch {
    return 503
  }
}

/**
 * Resolve the configured working path without touching the filesystem.
 * @param config - effective config.
 * @returns the absolute path that will be used.
 */
export function configuredRoot(config) {
  const value = config.workspaceRoot
  if (value === '') return join(homedir(), 'DSH')
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve the working path and make sure it is a writable, real directory.
 * @param config - effective config.
 * @returns its `fs.realpath`, created recursively when missing.
 */
async function ensureRoot(config) {
  const target = configuredRoot(config)
  if (!isAbsolute(target)) throw fail('ROOT_INVALID', 'The working path must be an absolute path')
  if (target.includes('\0')) throw fail('ROOT_INVALID', 'The working path contains a NUL byte')
  try {
    await mkdir(target, { recursive: true })
  } catch (error) {
    throw fail('ROOT_UNWRITABLE', messageOf(error))
  }
  let real
  try {
    real = await realpath(target)
  } catch (error) {
    throw fail('ROOT_INVALID', messageOf(error))
  }
  const info = await lstat(real)
  if (!info.isDirectory()) throw fail('ROOT_INVALID', 'The working path is not a directory')
  try {
    await access(real, FS_CONSTANTS.W_OK | FS_CONSTANTS.X_OK)
  } catch (error) {
    throw fail('ROOT_UNWRITABLE', messageOf(error))
  }
  return real
}

/**
 * Whether one path is a scratch folder directly under the root.
 * @param path - candidate path.
 * @param root - resolved root.
 * @returns true for `<root>/session-<uuid>`.
 */
function isScratchPath(path, root) {
  const trimmed = String(path)
  if (!SESSION_ID_PATTERN.test(basename(trimmed))) return false
  return dirname(trimmed) === root
}

/**
 * Nearest ancestor, including the path itself, that holds a `.git` entry. DSH
 * stops walking up for project instructions at `.git`, so a conversation created
 * below one inherits that tree's AGENTS.md.
 * @param path - resolved working path.
 * @returns the project root, or null when no ancestor has `.git`.
 */
async function detectProjectRoot(path) {
  let current = path
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      await lstat(join(current, '.git'))
      return current
    } catch {
      // No .git here; keep walking up.
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/**
 * Measure one directory within fixed bounds.
 * @param path - directory path.
 * @returns byte and entry counts.
 */
async function measure(path) {
  let bytes = 0
  let files = 0
  let entries = 0
  const queue = [{ path, depth: 0 }]
  for (let cursor = 0; cursor < queue.length && entries < MEASURE_ENTRY_LIMIT; cursor += 1) {
    const current = queue[cursor]
    let dirents
    try {
      dirents = await readdir(current.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      entries += 1
      if (entries > MEASURE_ENTRY_LIMIT) break
      const child = join(current.path, dirent.name)
      if (dirent.isDirectory()) {
        if (current.depth < MEASURE_DEPTH_LIMIT) queue.push({ path: child, depth: current.depth + 1 })
        continue
      }
      files += 1
      try {
        const info = await lstat(child)
        bytes += Number(info.size) || 0
      } catch {
        // A file that vanished mid-walk contributes nothing.
      }
    }
  }
  return { bytes, files }
}

/**
 * Whether a directory currently holds no entries at all.
 * @param path - directory path.
 * @returns true when it is readable and empty.
 */
async function isEmptyDir(path) {
  try {
    const dirents = await readdir(path)
    return dirents.length === 0
  } catch {
    return false
  }
}

/**
 * Remove one directory only when it is already empty.
 * @param path - directory path.
 * @returns true when it was removed.
 */
async function removeIfEmpty(path) {
  try {
    await rmdir(path)
    return true
  } catch {
    return false
  }
}

/**
 * Which mechanism this process can use to move a folder to the system Trash.
 * @returns `electron`, `osascript`, `gio`, `powershell`, or `none`.
 */
export function trashMethod() {
  try {
    const electron = createRequire(import.meta.url)('electron')
    if (electron !== null && typeof electron === 'object' && typeof electron.shell?.trashItem === 'function') return 'electron'
  } catch {
    // Not running inside Electron (or the module cannot be resolved here).
  }
  if (process.platform === 'darwin') return 'osascript'
  if (process.platform === 'linux') return 'gio'
  if (process.platform === 'win32') return 'powershell'
  return 'none'
}

/**
 * Run one helper command and reject on a non-zero exit.
 * @param file - executable.
 * @param args - arguments.
 * @returns the command's stdout.
 */
function run(file, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, { timeout: 20_000 }, (error, stdout) => {
      if (error) rejectPromise(error)
      else resolvePromise(String(stdout))
    })
  })
}

/**
 * Move one absolute path to the system Trash. Never hard-deletes: when no
 * mechanism answers, the caller reports TRASH_UNAVAILABLE and the UI falls back
 * to revealing the folder.
 * @param path - absolute directory path.
 * @returns the mechanism used.
 */
export async function trashPath(path) {
  try {
    const electron = createRequire(import.meta.url)('electron')
    if (electron !== null && typeof electron === 'object' && typeof electron.shell?.trashItem === 'function') {
      await electron.shell.trashItem(path)
      return 'electron'
    }
  } catch {
    // Fall through to the platform commands.
  }
  if (process.platform === 'darwin') {
    await run('osascript', ['-e', `tell application "Finder" to delete POSIX file ${JSON.stringify(path)}`])
    return 'osascript'
  }
  if (process.platform === 'linux') {
    await run('gio', ['trash', path])
    return 'gio'
  }
  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName Microsoft.VisualBasic',
      `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(${JSON.stringify(path)},'OnlyErrorDialogs','SendToRecycleBin')`,
    ].join('; ')
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
    return 'powershell'
  }
  throw fail('TRASH_UNAVAILABLE', 'No Trash mechanism is available on this platform')
}

/**
 * Register the Host half.
 * @param ctx - the plugin's Cordis context.
 * @param rawConfig - the row config from the bundle patch or the user's patch.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = typeof ctx.logger === 'function' ? ctx.logger('session-autospace') : console
  /** sessionId -> { workspaceId, path, createdAt, locale, attempts } */
  const staged = new Map()
  const recentPrepares = new Map()
  const inflightPrepares = new Map()
  let inventoryCache
  let sweepReport = null
  /** Serialize prepare and management so deletion cannot race an in-flight prepare. */
  let chain = Promise.resolve()
  /** Last new-conversation choice: `'scratch'`, `'workspace'`, or null. */
  let lastPick = null
  let lastPickAt = 0
  /** Read once at activation; every route that touches the choice awaits it. */
  let memoryReady = Promise.resolve()
  /** One durable write chain for the remembered choice. */
  let lastPickWrite = Promise.resolve()

  /**
   * The plugin's own state file. It stays outside the profile and outside the
   * working path, so a root change or a profile rebuild keeps the preference.
   * @returns the absolute path.
   */
  function memoryFile() {
    const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME.trim()
      : join(homedir(), '.dsh')
    const profile = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.trim() !== ''
      ? process.env.DSH_PROFILE.trim().replace(/[^A-Za-z0-9._-]+/g, '-')
      : 'default'
    return join(home, 'session-autospace', `last-pick-${profile}.json`)
  }

  /**
   * Read the saved choice. A missing or unreadable file simply means "no
   * memory", never an activation failure.
   * @returns resolution after `lastPick` reflects the file.
   */
  async function loadMemory() {
    try {
      const value = JSON.parse(await readFile(memoryFile(), 'utf8'))
      lastPick = PICK_KINDS.includes(value?.kind) ? value.kind : null
      lastPickAt = Number.isFinite(Number(value?.at)) ? Number(value.at) : 0
    } catch {
      lastPick = null
      lastPickAt = 0
    }
  }

  /**
   * Remember one new-conversation choice. The in-memory value wins even when
   * the write fails, so this page's behavior stays consistent.
   * @param kind - `'scratch'` or `'workspace'`.
   * @returns the stored choice.
   */
  async function rememberPick(kind) {
    if (!PICK_KINDS.includes(kind)) throw fail('MEMORY_INVALID', 'expected "scratch" or "workspace"')
    await memoryReady.catch(() => {})
    const at = Date.now()
    lastPick = kind
    lastPickAt = at
    const file = memoryFile()
    lastPickWrite = lastPickWrite.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.${at}.tmp`
      await writeFile(temporary, `${JSON.stringify({ version: 1, kind, at })}\n`, { mode: 0o600 })
      await rename(temporary, file)
    }).catch((error) => {
      log.warn?.(`could not save the last choice: ${messageOf(error)}`)
    })
    await lastPickWrite
    return { kind, at }
  }

  memoryReady = loadMemory()

  /**
   * Run a task after the previously queued one, keeping the chain alive on failure.
   * @param task - async task.
   * @returns the task's result.
   */
  function serial(task) {
    const run = chain.then(task, task)
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Forget every prepare receipt that could hand out one archived/deleted
   * Session. Without this, a repeated request id bypasses reusableEntry's
   * archived-session check for the whole idempotency window.
   * @param sessionId - Session that must never be returned by a cached prepare.
   */
  function forgetPreparedSession(sessionId) {
    const id = String(sessionId)
    for (const [requestId, record] of recentPrepares) {
      if (String(record.value?.sessionId ?? '') === id) recentPrepares.delete(requestId)
    }
  }

  /**
   * Archive through the authoritative registry, preserving its activity refusal
   * as a stable Session-running error and invalidating prepare receipts only
   * after the archive is durable.
   * @param sessionId - Session to archive.
   * @param options - whether the user confirmed stopping current work.
   */
  async function archiveSession(sessionId, options = {}) {
    const wr = ctx.get('workspaceRegistry')
    if (wr === undefined) throw fail('HOST_UNAVAILABLE', 'The workspace registry is unavailable')
    // Revoke the receipt before the durable write begins. A prepare retry that
    // arrives while this archive is awaiting must queue behind management, not
    // observe the old receipt and return a Session that is being deleted.
    forgetPreparedSession(sessionId)
    try {
      await wr.archiveSession(sessionId, options.stopActivity === true ? { stopActivity: true } : {})
    } catch (error) {
      const activity = Array.isArray(error?.activity) ? error.activity : []
      if (activity.length > 0 || error?.name === 'WorkspaceActiveSessionError') {
        const refusal = fail('SESSION_RUNNING', messageOf(error))
        refusal.activity = activity
        throw refusal
      }
      throw fail('ARCHIVE_FAILED', messageOf(error))
    }
  }

  /**
   * Read every visible session summary once.
   * @returns a map keyed by session id.
   */
  async function summaries() {
    const sc = ctx.get('sessionController')
    if (sc === undefined) throw fail('HOST_UNAVAILABLE', 'The session controller is unavailable')
    const value = await sc.list({}, new AbortController().signal)
    const map = new Map()
    for (const item of value?.items ?? []) map.set(String(item.sessionId), item)
    return map
  }

  /**
   * Load one session that must live directly in the current working path.
   * Session and folder are bound here, before any management route acts, so a
   * browser-supplied id can never address another workspace's conversation.
   * @param sessionId - candidate id.
   * @returns the summary, root, and folder path.
   */
  function assertScratch(summary, root, sessionId) {
    if (summary === undefined) throw fail('SESSION_MISSING', 'The session no longer exists')
    if (typeof summary.cwd !== 'string' || summary.cwd !== join(root, sessionId)) {
      throw fail('NOT_SCRATCH', 'The session does not live in the working path')
    }
    return summary
  }

  async function scratchSession(sessionId) {
    const id = String(sessionId)
    if (!SESSION_ID_PATTERN.test(id)) throw fail('BAD_REQUEST', 'not a session id')
    const root = await ensureRoot(config)
    const map = await summaries()
    const summary = assertScratch(map.get(id), root, id)
    return { summary, root, path: join(root, id) }
  }

  /**
   * Delete one temporary workspace registration, retrying the transient failures.
   * @param workspaceId - registration id.
   * @returns true when the registration is gone.
   */
  async function deleteWorkspace(workspaceId) {
    const wr = ctx.get('workspaceRegistry')
    if (wr === undefined) throw fail('HOST_UNAVAILABLE', 'The workspace registry is unavailable')
    let lastError
    for (let attempt = 0; attempt <= SETTLE_BACKOFF.length; attempt += 1) {
      try {
        await wr.delete(workspaceId)
        return true
      } catch (error) {
        lastError = error
        if (attempt < SETTLE_BACKOFF.length) await delay(SETTLE_BACKOFF[attempt])
      }
    }
    throw fail('SETTLE_FAILED', messageOf(lastError))
  }

  /**
   * Drop one staged entry's temporary workspace registration.
   * @param sessionId - staged session id.
   * @returns the settled flag; a no-op reports `noop: true`.
   */
  async function settle(sessionId) {
    const entry = staged.get(sessionId)
    if (entry === undefined) return { settled: true, noop: true }
    entry.attempts += 1
    await deleteWorkspace(entry.workspaceId)
    staged.delete(sessionId)
    log.info?.(`settled ${sessionId}`)
    return { settled: true }
  }

  /**
   * Put one still-blank scratch conversation away: archive the session, remove
   * the temporary registration, and move an empty folder to the Trash.
   * @param sessionId - staged session id.
   * @param options - `trash: false` keeps the folder.
   * @returns what happened.
   */
  async function abandon(sessionId, options = {}, preload) {
    const entry = staged.get(sessionId)
    if (entry === undefined) return { abandoned: false, noop: true }
    let summary = preload?.summary
    if (summary === undefined) {
      const map = await summaries()
      summary = map.get(sessionId)
    }
    if (summary !== undefined && summary.blank !== true) {
      await settle(sessionId)
      return { abandoned: false, settled: true }
    }
    const wr = ctx.get('workspaceRegistry')
    if (summary !== undefined && wr !== undefined) {
      try {
        await archiveSession(sessionId, { stopActivity: true })
      } catch (error) {
        entry.attempts += 1
        throw error
      }
    }
    try {
      await deleteWorkspace(entry.workspaceId)
    } catch (error) {
      // Keeping the entry is what makes the cleanup retryable: the next
      // activation sweep sees a staged conversation whose registration is
      // still there, instead of a sidebar group nothing can remove.
      entry.attempts += 1
      throw fail('SETTLE_FAILED', messageOf(error))
    }
    staged.delete(sessionId)
    let trashed = false
    let trashError
    if (options.trash !== false && config.trashOnDelete && await isEmptyDir(entry.path)) {
      try {
        await trashPath(entry.path)
        trashed = true
      } catch (error) {
        trashError = messageOf(error)
      }
    }
    inventoryCache = undefined
    return { abandoned: true, trashed, ...(trashError === undefined ? {} : { trashError }) }
  }

  /**
   * Find a still-blank staged conversation to reuse instead of creating another.
   * @returns the newest blank entry, or undefined.
   */
  async function reusableEntry() {
    if (!config.reuseBlank || staged.size === 0) return undefined
    const wr = ctx.get('workspaceRegistry')
    if (wr === undefined) return undefined
    const archived = new Set((wr.archivedSessionIds ?? []).map(String))
    const map = await summaries()
    let root
    try {
      root = await ensureRoot(config)
    } catch {
      return undefined
    }
    const candidates = []
    for (const [sessionId, entry] of staged) {
      if (archived.has(String(sessionId))) continue
      const summary = map.get(String(sessionId))
      // DSH's own reuse rule excludes archived conversations; a running one or
      // one whose folder is gone must not be handed back as a fresh start.
      if (summary === undefined || summary.blank !== true || summary.running === true) continue
      if (typeof summary.cwd !== 'string' || summary.cwd !== join(root, String(sessionId))) continue
      try {
        const info = await lstat(summary.cwd)
        if (info.isSymbolicLink() || !info.isDirectory()) continue
      } catch {
        continue
      }
      candidates.push([sessionId, entry])
    }
    if (candidates.length === 0) return undefined
    candidates.sort((a, b) => b[1].createdAt - a[1].createdAt)
    const [sessionId, entry] = candidates[0]
    // Reopening counts as using it: restart the reclaim clock for this run.
    entry.createdAt = Date.now()
    return { sessionId, workspaceId: entry.workspaceId, path: entry.path }
  }

  /**
   * Mint a session id, its folder, and the temporary workspace registration, then
   * create the blank session inside it.
   * @param locale - the requesting UI locale, for the workspace title.
   * @returns the created identities.
   */
  async function createScratch(locale) {
    const sc = ctx.get('sessionController')
    const wr = ctx.get('workspaceRegistry')
    if (sc === undefined || wr === undefined) throw fail('HOST_UNAVAILABLE', 'Session or workspace service unavailable')
    const root = await ensureRoot(config)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sessionId = `session-${randomUUID()}`
      const path = join(root, sessionId)
      try {
        await mkdir(path, { mode: 0o700 })
      } catch (error) {
        if (error?.code === 'EEXIST' && attempt === 0) continue
        throw fail('ROOT_UNWRITABLE', messageOf(error))
      }
      let workspace
      try {
        const title = String(locale).toLowerCase().startsWith('zh') ? '不指定工作区' : 'No workspace'
        workspace = await wr.create(path, title)
        const created = await sc.create({ sessionId, workspaceId: workspace.id })
        const settledId = String(created.sessionId)
        // The folder is named after the requested id; a service that mints a
        // different one would leave that folder unaddressable, so refuse here
        // and let the retry allocate a fresh pair instead.
        if (settledId !== sessionId) {
          await archiveSession(settledId, { stopActivity: true }).catch(() => {})
          throw fail('SESSION_CONFLICT', 'The Session service did not accept the requested id')
        }
        staged.set(settledId, {
          workspaceId: String(workspace.id),
          path,
          createdAt: Date.now(),
          locale: String(locale),
          attempts: 0,
        })
        inventoryCache = undefined
        return { sessionId: settledId, workspaceId: String(workspace.id), path, reused: false }
      } catch (error) {
        if (workspace !== undefined) await wr.delete(workspace.id).catch(() => {})
        await removeIfEmpty(path)
        if (attempt === 0) continue
        throw fail('WORKSPACE_CREATE_FAILED', messageOf(error))
      }
    }
    throw fail('SESSION_CONFLICT', 'Could not allocate a fresh session id')
  }

  /**
   * Rebuild the staged table from durable registrations after a restart, and
   * classify every known scratch conversation.
   */
  async function sweep() {
    const wr = ctx.get('workspaceRegistry')
    const sc = ctx.get('sessionController')
    if (wr === undefined || sc === undefined) return
    let root
    try {
      root = await ensureRoot(config)
    } catch (error) {
      log.warn?.(`sweep skipped: ${messageOf(error)}`)
      return
    }
    for (const workspace of [...wr.list()]) {
      let path
      try {
        path = String(workspace.path)
      } catch {
        continue
      }
      if (!isScratchPath(path, root)) continue
      const title = String(workspace.title ?? '')
      if (!SCRATCH_TITLES.includes(title)) continue
      const sessionIds = (workspace.sessionIds ?? []).map(String)
      if (sessionIds.length === 0) {
        await wr.delete(workspace.id).catch(() => {})
        continue
      }
      for (const sessionId of sessionIds) {
        if (staged.has(sessionId)) continue
        staged.set(sessionId, {
          workspaceId: String(workspace.id),
          path,
          createdAt: Date.parse(String(workspace.createdAt)) || Date.now(),
          locale: '',
          attempts: 0,
        })
      }
    }
    let map
    try {
      map = await summaries()
    } catch (error) {
      log.warn?.(`sweep could not read sessions: ${messageOf(error)}`)
      return
    }
    const cutoff = config.autoReclaimHours > 0 ? Date.now() - config.autoReclaimHours * 3_600_000 : -Infinity
    const report = { at: Date.now(), settled: 0, abandoned: 0, kept: 0 }
    for (const [sessionId, entry] of [...staged.entries()]) {
      // A conversation prepared while this sweep was reading the session list
      // is not a leftover; leave it to its own settle/abandon channels.
      if (Date.now() - entry.createdAt < SWEEP_GRACE_MS) {
        report.kept += 1
        continue
      }
      const summary = map.get(sessionId)
      if (summary === undefined || summary.blank !== true) {
        try {
          await settle(sessionId)
          report.settled += 1
        } catch (error) {
          log.warn?.(`sweep settle failed for ${sessionId}: ${messageOf(error)}`)
        }
        continue
      }
      // Reusing a blank conversation restarts the entry clock; a session's own
      // updatedAt can be older than that, so take the later of the two.
      const touchedAt = Math.max(Number(summary.updatedAt) || 0, entry.createdAt)
      if (config.autoReclaimHours > 0 && touchedAt < cutoff) {
        try {
          await abandon(sessionId)
          report.abandoned += 1
        } catch (error) {
          log.warn?.(`sweep abandon failed for ${sessionId}: ${messageOf(error)}`)
        }
        continue
      }
      report.kept += 1
    }
    sweepReport = report
    if (report.settled + report.abandoned > 0) {
      inventoryCache = undefined
      log.info?.(`sweep: settled ${report.settled}, reclaimed ${report.abandoned}, kept ${report.kept}`)
    }
  }

  /**
   * Read the folder facts for every scratch directory under the root.
   * @returns per-folder sizes and the orphan list.
   */
  async function inventory(fresh = false) {
    const sc = ctx.get('sessionController')
    if (sc === undefined) throw fail('HOST_UNAVAILABLE', 'The session controller is unavailable')
    const root = await ensureRoot(config)
    if (!fresh && inventoryCache !== undefined && inventoryCache.root === root && Date.now() - inventoryCache.at < INVENTORY_TTL_MS) {
      return inventoryCache.value
    }
    let dirents
    try {
      dirents = await readdir(root, { withFileTypes: true })
    } catch (error) {
      throw fail('ROOT_INVALID', messageOf(error))
    }
    const folders = []
    for (const dirent of dirents) {
      if (!SESSION_ID_PATTERN.test(dirent.name)) continue
      const path = join(root, dirent.name)
      let info
      try {
        info = await lstat(path)
      } catch {
        continue
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        folders.push({ id: dirent.name, exists: false, bytes: 0, files: 0, mtimeMs: 0 })
        continue
      }
      const size = await measure(path)
      folders.push({ id: dirent.name, exists: true, bytes: size.bytes, files: size.files, mtimeMs: info.mtimeMs })
    }
    const known = await summaries()
    const listed = new Set(folders.map(folder => folder.id))
    // A deleted folder leaves no entry in readdir; the conversations that lost
    // theirs still need a row, or the missing-folder filter could never match.
    for (const summary of known.values()) {
      const cwd = typeof summary.cwd === 'string' ? summary.cwd : ''
      // A conversation left in an earlier working path is not a missing folder
      // of this one: its directory still exists, just elsewhere, and rebuilding
      // it here would create a folder its immutable cwd can never use.
      if (cwd === '' || dirname(cwd) !== root) continue
      const id = basename(cwd)
      if (!SESSION_ID_PATTERN.test(id) || listed.has(id)) continue
      folders.push({ id, exists: false, bytes: 0, files: 0, mtimeMs: 0 })
      listed.add(id)
    }
    folders.sort((left, right) => left.id.localeCompare(right.id))
    const orphans = folders.filter(folder => folder.exists !== false && !known.has(folder.id)).map(folder => folder.id)
    const value = { root, folders, orphans }
    inventoryCache = { at: Date.now(), root, value }
    return value
  }

  /**
   * Verify one scratch directory and return its resolved path.
   * @param sessionId - session id whose folder is addressed.
   * @returns the `fs.realpath` of the folder.
   */
  async function scratchPath(sessionId) {
    const id = String(sessionId)
    if (!SESSION_ID_PATTERN.test(id)) throw fail('BAD_REQUEST', 'not a session id')
    const root = await ensureRoot(config)
    const path = join(root, id)
    let info
    try {
      info = await lstat(path)
    } catch {
      throw fail('FOLDER_MISSING', 'The folder no longer exists')
    }
    if (info.isSymbolicLink()) throw fail('SYMLINK_REJECTED', 'The folder is a symbolic link')
    if (!info.isDirectory()) throw fail('SYMLINK_REJECTED', 'The path is not a directory')
    const real = await realpath(path)
    if (dirname(real) !== root) throw fail('OUT_OF_ROOT', 'The folder is outside the working path')
    return real
  }

  /**
   * Delete one scratch conversation: archive it (stopping a running turn is
   * refused here — the browser asks first), drop any temporary registration,
   * then move the folder to the system Trash. With the `trashOnDelete` switch
   * off the folder stays, and the conversation is only archived.
   * @param sessionId - session id whose folder is deleted.
   * @returns what happened, including a Trash failure the browser reports.
   */
  async function deleteScratch(sessionId, options = {}) {
    const { summary, path } = await scratchSession(sessionId)
    if (summary.running === true && options.stop !== true) {
      throw fail('SESSION_RUNNING', 'This conversation is still running')
    }
    // Without confirmation the registry performs the authoritative activity
    // check (turn, job, subagent, and schedule). Passing stopActivity here just
    // because the main Agent looks idle would silently kill hidden work.
    await archiveSession(sessionId, { stopActivity: options.stop === true })
    const archived = true
    inventoryCache = undefined

    // Archive admission and the durable write are not an activity barrier,
    // and an already-archived id is a no-op before DSH rechecks activity. Always
    // observe the providers before removing the cwd. A confirmed stop gets a
    // bounded settlement wait; an unconfirmed delete fails safe immediately.
    const settled = await waitForSessionIdle(ctx, sessionId, {
      timeoutMs: options.stop === true ? ARCHIVE_SETTLE_TIMEOUT_MS : 0,
    })
    if (!settled.idle) {
      if (options.stop !== true) {
        const refusal = fail('SESSION_RUNNING', 'This conversation still has running work')
        refusal.activity = settled.activity
        throw refusal
      }
      return { archived, trashed: false, activityPending: true, activity: settled.activity, path }
    }

    const entry = staged.get(sessionId)
    if (entry !== undefined) {
      // Keep the staged record when cleanup fails. It is the retry handle for
      // both this route and the activation sweep; dropping it can strand a
      // temporary Workspace registration in the sidebar.
      await deleteWorkspace(entry.workspaceId)
      staged.delete(sessionId)
    }
    // A retry after the folder already moved must reach the same end state,
    // not fail with FOLDER_MISSING.
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw fail('FOLDER_MISSING', messageOf(error))
      return { archived, trashed: false, alreadyGone: true }
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw fail('SYMLINK_REJECTED', 'The path is not a folder')
    }
    if (!config.trashOnDelete) return { archived, trashed: false, kept: true }
    try {
      const method = await trashPath(path)
      return { archived, trashed: true, method }
    } catch (error) {
      return { archived, trashed: false, trashError: messageOf(error), path }
    }
  }

  /**
   * Read the facts the working-path card needs about a candidate directory,
   * without creating it: whether it exists, whether it could be created, and
   * whether project instructions above it would apply.
   * @param request - `{path}`.
   * @returns existence, writability, and the nearest `.git` ancestor.
   */
  async function probePath(request) {
    const raw = String(request.path ?? '').trim()
    if (raw === '') return { path: '', exists: false, writable: false, projectRoot: null }
    const target = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
    if (!isAbsolute(target) || target.includes('\0')) throw fail('ROOT_INVALID', 'The working path must be absolute')
    let resolved = target
    let exists = false
    try {
      const info = await lstat(target)
      exists = info.isDirectory()
      if (exists) resolved = await realpath(target)
    } catch {
      // Missing: writability is decided by the nearest existing ancestor.
    }
    let writable = false
    let nearestExisting = null
    if (exists) {
      // An existing directory is judged on its own permissions: a writable
      // parent does not make it writable.
      nearestExisting = resolved
      try {
        await access(resolved, FS_CONSTANTS.W_OK | FS_CONSTANTS.X_OK)
        writable = true
      } catch {
        writable = false
      }
    } else {
      // A missing path is judged by its nearest existing ancestor, which must
      // itself be a directory.
      let ancestor = dirname(resolved)
      for (let depth = 0; depth < 40; depth += 1) {
        let info
        try {
          info = await lstat(ancestor)
        } catch {
          info = undefined
        }
        if (info !== undefined) {
          nearestExisting = ancestor
          if (!info.isDirectory()) break
          try {
            await access(ancestor, FS_CONSTANTS.W_OK | FS_CONSTANTS.X_OK)
            writable = true
          } catch {
            writable = false
          }
          break
        }
        const parent = dirname(ancestor)
        if (parent === ancestor) break
        ancestor = parent
      }
    }
    // A path that does not exist yet inherits whatever project holds the
    // nearest existing ancestor, so the warning is accurate before saving.
    const projectBase = exists ? resolved : nearestExisting
    return {
      path: resolved,
      exists,
      writable,
      projectRoot: projectBase === null ? null : await detectProjectRoot(projectBase),
    }
  }

  /**
   * Run one management operation on a session.
   * @param request - `{sessionId, op, title?}`.
   * @returns acknowledgement.
   */
  async function sessionOperation(request) {
    const sessionId = String(request.sessionId ?? '')
    const op = String(request.op ?? '')
    const sc = ctx.get('sessionController')
    const wr = ctx.get('workspaceRegistry')
    if (sc === undefined || wr === undefined) throw fail('HOST_UNAVAILABLE', 'Session services unavailable')
    const { summary } = await scratchSession(sessionId)
    const archived = (wr.archivedSessionIds ?? []).map(String).includes(sessionId)
    switch (op) {
      case 'rename': {
        const title = String(request.title ?? '').trim()
        if (title === '' || title.length > 200) throw fail('BAD_REQUEST', 'title must be 1-200 characters')
        await sc.rename({ sessionId, title })
        return { ok: true }
      }
      case 'pin':
        if (archived) throw fail('SESSION_ARCHIVED', 'Unarchive the conversation before pinning it')
        await wr.pinSession(sessionId)
        return { ok: true }
      case 'unpin':
        await wr.unpinSession(sessionId)
        return { ok: true }
      case 'archive': {
        // `stopActivity` is the documented stop-and-archive verb; the browser
        // asks before using it on a running turn.
        if (summary.running === true && request.stop !== true) {
          throw fail('SESSION_RUNNING', 'This conversation is still running')
        }
        await archiveSession(sessionId, { stopActivity: request.stop === true })
        return { ok: true }
      }
      case 'unarchive':
        await wr.unarchiveSession(sessionId)
        return { ok: true }
      default:
        throw fail('BAD_OP', `unknown operation: ${op}`)
    }
  }

  /**
   * Execute one maintenance action over an explicit id list.
   * @param request - `{op, ids}`.
   * @returns what changed and what was skipped.
   */
  async function maintenance(request) {
    const op = String(request.op ?? '')
    const raw = Array.isArray(request.ids) ? request.ids.map(String) : []
    const ids = raw.slice(0, 100)
    // Everything the request named but cannot act on is reported, never
    // silently dropped.
    const changed = []
    const skipped = raw.slice(100)
    if (op === 'reclaimBlank') {
      // One list read for the whole batch: reclaim can address up to 100
      // conversations, and each one must still be validated against this root.
      const root = await ensureRoot(config)
      const known = await summaries()
      for (const sessionId of ids) {
        try {
          const preload = {
            summary: assertScratch(known.get(sessionId), root, sessionId),
            root,
            path: join(root, sessionId),
          }
          const result = staged.has(sessionId)
            ? await abandon(sessionId, {}, preload)
            : await abandonDetached(sessionId, preload)
          if (result.abandoned || result.settled) changed.push(sessionId)
          else skipped.push(sessionId)
        } catch (error) {
          log.warn?.(`reclaim failed for ${sessionId}: ${messageOf(error)}`)
          skipped.push(sessionId)
        }
      }
      inventoryCache = undefined
      return { changed, skipped }
    }
    if (op === 'orphans') {
      // Re-read the session list immediately before deleting: a folder that
      // gained a conversation since the inventory was cached is not an orphan.
      const known = await summaries()
      for (const sessionId of ids) {
        if (!SESSION_ID_PATTERN.test(sessionId)) {
          skipped.push(sessionId)
          continue
        }
        if (known.has(sessionId)) {
          skipped.push(sessionId)
          continue
        }
        try {
          const path = await scratchPath(sessionId)
          const info = await lstat(path)
          if (Date.now() - Number(info.mtimeMs) < ORPHAN_GRACE_MS) {
            skipped.push(sessionId)
            continue
          }
          try {
            await trashPath(path)
          } catch (error) {
            // No Trash mechanism: an empty orphan may still be removed cleanly.
            if (!await removeIfEmpty(path)) throw error
          }
          changed.push(sessionId)
        } catch (error) {
          log.warn?.(`orphan cleanup failed for ${sessionId}: ${messageOf(error)}`)
          skipped.push(sessionId)
        }
      }
      inventoryCache = undefined
      return { changed, skipped }
    }
    if (op === 'rebuildMissing') {
      const root = await ensureRoot(config)
      const known = await summaries()
      for (const sessionId of ids) {
        if (!SESSION_ID_PATTERN.test(sessionId)) {
          skipped.push(sessionId)
          continue
        }
        // Only rebuild the folder of a known conversation whose immutable cwd
        // is exactly this path; anything else would create a folder nobody uses.
        const summary = known.get(sessionId)
        if (summary === undefined || summary.cwd !== join(root, sessionId)) {
          skipped.push(sessionId)
          continue
        }
        const path = join(root, sessionId)
        try {
          const info = await lstat(path)
          if (info.isDirectory()) {
            skipped.push(sessionId)
            continue
          }
          throw fail('SYMLINK_REJECTED', 'The path is not a folder')
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            skipped.push(sessionId)
            continue
          }
        }
        try {
          await mkdir(path, { mode: 0o700 })
          changed.push(sessionId)
        } catch (mkdirError) {
          log.warn?.(`rebuild failed for ${sessionId}: ${messageOf(mkdirError)}`)
          skipped.push(sessionId)
        }
      }
      inventoryCache = undefined
      return { changed, skipped }
    }
    throw fail('BAD_OP', `unknown maintenance operation: ${op}`)
  }

  /**
   * Archive and clean one blank scratch session that has no staged entry left
   * (for example after a crash): remove any matching registration, archive it,
   * and reclaim an empty folder.
   * @param sessionId - session id.
   * @returns what happened.
   */
  async function abandonDetached(sessionId, preload) {
    const { summary, root, path } = preload ?? await scratchSession(sessionId)
    if (summary.blank !== true) return { abandoned: false }
    const wr = ctx.get('workspaceRegistry')
    if (wr === undefined) throw fail('HOST_UNAVAILABLE', 'The workspace registry is unavailable')
    await archiveSession(sessionId, { stopActivity: true })
    for (const workspace of [...wr.list()]) {
      if (!isScratchPath(String(workspace.path), root)) continue
      if (!(workspace.sessionIds ?? []).map(String).includes(sessionId)) continue
      await wr.delete(workspace.id).catch(() => {})
    }
    if (config.trashOnDelete && await isEmptyDir(path)) {
      await trashPath(path).catch((error) => {
        log.warn?.(`trash failed for ${sessionId}: ${messageOf(error)}`)
      })
    }
    inventoryCache = undefined
    return { abandoned: true }
  }

  /**
   * Write one config patch through the config editor.
   * @param request - `{patch}`.
   * @returns the effective config.
   */
  async function writeConfig(request) {
    const patch = validateConfigPatch(request.patch)
    const editor = ctx.get('configEditor')
    const entry = ctx.fiber?.entry
    if (editor === undefined || entry === undefined) throw fail('CONFIG_UNAVAILABLE', 'Configuration cannot be saved in this profile')
    const merged = { ...config, ...patch }
    if (patch.workspaceRoot !== undefined) await ensureRoot({ ...config, ...patch })
    try {
      await editor.edit(entry, current => ({ ...current, ...patch }))
    } catch (error) {
      throw fail('CONFIG_WRITE_FAILED', messageOf(error))
    }
    inventoryCache = undefined
    return { config: merged }
  }

  /**
   * Build the settings page's read model.
   * @returns root, config, capabilities, and staged facts.
   */
  async function status() {
    await memoryReady.catch(() => {})
    const method = trashMethod()
    let root
    let rootError
    try {
      root = await ensureRoot(config)
    } catch (error) {
      root = configuredRoot(config)
      rootError = { code: String(error?.code ?? 'ROOT_INVALID'), message: messageOf(error) }
    }
    return {
      root,
      home: homedir(),
      defaultRoot: join(homedir(), 'DSH'),
      configured: config.workspaceRoot !== '',
      rootError,
      projectRoot: rootError === undefined ? await detectProjectRoot(root) : null,
      config,
      caps: {
        webServer: ctx.get('webServer') !== undefined,
        connection: ctx.get('connection') !== undefined,
        sessionController: ctx.get('sessionController') !== undefined,
        workspaceRegistry: ctx.get('workspaceRegistry') !== undefined,
        configEditor: ctx.get('configEditor') !== undefined,
        events: typeof ctx.on === 'function',
        trash: method !== 'none',
        trashMethod: method,
      },
      staged: [...staged.entries()].map(([sessionId, entry]) => ({
        sessionId,
        workspaceId: entry.workspaceId,
        path: entry.path,
        createdAt: entry.createdAt,
      })),
      pendingSettles: [...staged.values()].filter(entry => entry.attempts > 0).length,
      lastSweep: sweepReport,
      lastPick,
      version: detectVersion(),
    }
  }

  /** Route table: every entry is a POST that answers `{ok, value}` or `{ok: false, code, message}`. */
  const routeTable = [
    { path: '/status', run: async () => status() },
    { path: '/config', run: async (body) => writeConfig(body) },
    { path: '/memory', run: async (body) => rememberPick(String(body.kind ?? '')) },
    {
      path: '/prepare',
      run: async (body) => {
        const requestId = typeof body.requestId === 'string' ? body.requestId.slice(0, 120) : ''
        if (requestId !== '') {
          // A double click sends both requests before either finishes; sharing
          // the in-flight promise keeps one requestId on one conversation.
          const inflight = inflightPrepares.get(requestId)
          if (inflight !== undefined) return inflight
        }
        const task = serial(async () => {
          // Receipt admission belongs to the same chain as archive/delete. A
          // cache hit while deletion is in flight would otherwise bypass the
          // chain and hand out the Session currently being removed.
          if (requestId !== '') {
            const remembered = recentPrepares.get(requestId)
            if (remembered !== undefined && Date.now() - remembered.at < PREPARE_IDEMPOTENCY_MS) return remembered.value
          }
          const reusable = await reusableEntry()
          const value = reusable !== undefined
            ? { ...reusable, reused: true }
            : await createScratch(typeof body.locale === 'string' ? body.locale : 'en')
          // Asking for a scratch conversation is itself the choice to remember.
          await rememberPick('scratch').catch(() => {})
          return value
        })
        if (requestId === '') return task
        const shared = task.then((value) => {
          recentPrepares.set(requestId, { at: Date.now(), value })
          for (const [key, record] of recentPrepares) {
            if (Date.now() - record.at >= PREPARE_IDEMPOTENCY_MS) recentPrepares.delete(key)
          }
          return value
        }).finally(() => {
          if (inflightPrepares.get(requestId) === shared) inflightPrepares.delete(requestId)
        })
        inflightPrepares.set(requestId, shared)
        return shared
      },
    },
    {
      path: '/settle',
      run: async (body) => settle(String(body.sessionId ?? '')),
    },
    {
      path: '/abandon',
      run: async (body) => serial(() => abandon(String(body.sessionId ?? ''), { trash: body.trash !== false })),
    },
    { path: '/inventory', run: async (body) => inventory(body.fresh === true) },
    { path: '/session-op', run: async (body) => serial(() => sessionOperation(body)) },
    { path: '/probe', run: async (body) => probePath(body) },
    {
      path: '/trash',
      run: async (body) => serial(() => deleteScratch(String(body.sessionId ?? ''), { stop: body.stop === true })),
    },
    {
      path: '/reveal',
      run: async (body) => {
        const sc = ctx.get('sessionController')
        if (sc === undefined || typeof sc.openWorkspacePath !== 'function') throw fail('HOST_UNAVAILABLE', 'Reveal is unavailable')
        let target
        if (body.sessionId !== undefined) {
          target = await scratchPath(body.sessionId)
        } else {
          const raw = String(body.path ?? '')
          const expanded = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
          if (!isAbsolute(expanded)) throw fail('ROOT_INVALID', 'The path must be absolute')
          let real
          try {
            real = await realpath(expanded)
          } catch {
            throw fail('FOLDER_MISSING', 'The folder no longer exists')
          }
          const root = await ensureRoot(config)
          const inside = relative(root, real)
          if (inside === '' ? false : (inside.startsWith('..') || isAbsolute(inside))) {
            throw fail('OUT_OF_ROOT', 'The folder is outside the working path')
          }
          target = real
        }
        await sc.openWorkspacePath({ path: target, action: 'reveal' }, new AbortController().signal)
        return { revealed: true }
      },
    },
    { path: '/maintenance', run: async (body) => maintenance(body) },
  ]

  // The browser half talks over same-origin POST routes. `auth: 'required'`
  // declares them to the WebServer, which applies its own browser-trust fence
  // and authentication before the handler runs and passes the admitted Peer as
  // the third argument; a Host without that contract still reaches the local
  // fence through `admissionRejection`. Registering needs nothing but the HTTP
  // carrier: without it the browser half reports the Host offline.
  ctx.inject(['webServer'], (sctx) => {
    const server = sctx.get('webServer')
    for (const route of routeTable) {
      sctx.effect(() => server.register({
        kind: 'exact',
        path: ROUTE_PREFIX + route.path,
        auth: 'required',
        handler: async (req, res, peer) => {
          try {
            const rejection = admissionRejection(ctx.get('connection'), req, peer)
            if (rejection !== undefined) {
              res.statusCode = rejection
              res.end()
              return
            }
            if (req.method !== 'POST') {
              res.statusCode = 405
              res.setHeader('allow', 'POST')
              res.end()
              return
            }
            const text = await readBoundedBody(req)
            if (text === null) {
              sendJson(res, 413, { ok: false, code: 'BODY_TOO_LARGE', message: 'request body too large' })
              return
            }
            let body = {}
            if (text.trim() !== '') {
              try {
                body = JSON.parse(text)
              } catch {
                sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'invalid JSON body' })
                return
              }
            }
            if (body === null || typeof body !== 'object' || Array.isArray(body)) {
              sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'expected a JSON object' })
              return
            }
            const value = await route.run(body)
            sendJson(res, 200, { ok: true, value })
          } catch (error) {
            log.warn?.(`${route.path} failed: ${messageOf(error)}`)
            sendJson(res, 200, {
              ok: false,
              code: typeof error?.code === 'string' ? error.code : 'INTERNAL',
              message: messageOf(error),
              ...(Array.isArray(error?.activity) ? { activity: error.activity } : {}),
            })
          }
        },
      }), `session-autospace: POST ${route.path}`)
    }
  })

  // Primary settle channel: the first turn of a staged conversation.
  if (typeof ctx.on === 'function') {
    const dispose = ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/start') return
      const sessionId = String(session?.id ?? '')
      if (sessionId === '' || !staged.has(sessionId)) return
      void settle(sessionId).catch((error) => {
        log.warn?.(`settle after turn/start failed for ${sessionId}: ${messageOf(error)}`)
      })
    })
    ctx.effect(() => dispose, 'session-autospace: settle on first turn')
  }

  // Activation sweep: rebuild the staged table from durable registrations, then
  // settle or reclaim whatever a crash or a closed window left behind.
  ctx.inject(['workspaceRegistry', 'sessionController'], () => {
    void sweep().catch((error) => {
      log.warn?.(`activation sweep failed: ${messageOf(error)}`)
    })
  })
}

/**
 * Best-effort DSH version for the settings page's status footer.
 * @returns the desktop app version, or null when unknown.
 */
function detectVersion() {
  try {
    const electron = createRequire(import.meta.url)('electron')
    if (electron !== null && typeof electron === 'object' && typeof electron.app?.getVersion === 'function') {
      return String(electron.app.getVersion())
    }
  } catch {
    // Not an Electron main process.
  }
  return null
}
