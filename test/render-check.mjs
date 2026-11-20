/**
 * Render smoke test for client.js.
 *
 * The browser artifact is a `__ModuleLoader__.load({factory})` module, so it
 * cannot be imported directly. This harness loads the real file, injects an
 * export of the internal components, stubs `react` / `react-dom` with a tiny
 * recursive renderer, and renders every registered surface against fixtures.
 * It catches undefined identifiers, bad element trees, and hook-shape mistakes
 * without a browser. It is not a substitute for looking at the real GUI.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

const INJECT_MARKER = '    return {\n      inject: [\'slots\', \'locale\', \'sessions\'],'
if (!source.includes(INJECT_MARKER)) throw new Error('injection marker not found')
const instrumented = source.replace(
  INJECT_MARKER,
  `    globalThis.__DSA__ = { WorkspaceMenu, SettingsPage, ConfigEntry, RowBadge, RowMenu, Dialog, store, RUNTIME }\n${INJECT_MARKER}`,
)

// --------------------------------------------------------------- React stub ---

/**
 * One component instance's hook slots. State persists across the passes of a
 * single instance; effects are replayed once per pass.
 * @returns the hook runtime.
 */
function createHookRuntime() {
  const slots = []
  const runtime = {
    index: 0,
    dirty: false,
    pending: [],
    reset() {
      runtime.index = 0
      runtime.dirty = false
      runtime.pending.length = 0
    },
    useState(initial) {
      const index = runtime.index++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      const setter = (next) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next
        runtime.dirty = true
      }
      return [slots[index], setter]
    },
    useEffect(effect) {
      runtime.index += 1
      runtime.pending.push(effect)
    },
    useLayoutEffect(effect) {
      runtime.index += 1
      runtime.pending.push(effect)
    },
    useMemo(factory) {
      runtime.index += 1
      return factory()
    },
    useCallback(fn) {
      runtime.index += 1
      return fn
    },
    useRef(initial) {
      const index = runtime.index++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      runtime.index += 1
      return getSnapshot()
    },
    runEffects() {
      for (const effect of runtime.pending.splice(0)) effect()
    },
  }
  return runtime
}

let activeRuntime = createHookRuntime()

function createElement(type, props, ...children) {
  const merged = { ...(props ?? {}) }
  if (children.length === 1) merged.children = children[0]
  else if (children.length > 1) merged.children = children
  return { type, props: merged, key: merged.key }
}

const React = {
  createElement,
  Fragment: Symbol('Fragment'),
  useState: initial => activeRuntime.useState(initial),
  useEffect: effect => activeRuntime.useEffect(effect),
  useLayoutEffect: effect => activeRuntime.useLayoutEffect(effect),
  useMemo: factory => activeRuntime.useMemo(factory),
  useCallback: fn => activeRuntime.useCallback(fn),
  useRef: initial => activeRuntime.useRef(initial),
  useSyncExternalStore: (subscribe, getSnapshot) => activeRuntime.useSyncExternalStore(subscribe, getSnapshot),
}

const ReactDOM = {
  createPortal: node => node,
}

const moduleTable = {
  react: React,
  'react-dom': ReactDOM,
  'react/jsx-runtime': { jsx: createElement, jsxs: createElement, Fragment: React.Fragment },
}

let factory = null
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory: loaded }) => {
      if (id !== 'dsh-session-autospace') throw new Error(`unexpected module id ${id}`)
      factory = loaded
    },
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  innerWidth: 1440,
  innerHeight: 900,
  location: { href: 'http://127.0.0.1:49817/' },
  setTimeout,
  clearTimeout,
}
globalThis.document = {
  body: { appendChild: () => {} },
  visibilityState: 'visible',
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
}
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} }, language: 'en' },
  configurable: true,
})
globalThis.fetch = async () => { throw new Error('network disabled in the harness') }

// The module is one expression statement; evaluate it after the loader hook.
// eslint-disable-next-line no-new-func
new Function(instrumented)()
if (factory === null) throw new Error('factory was not registered')

const plugin = factory((name) => {
  if (moduleTable[name] === undefined) throw new Error(`unexpected require(${name})`)
  return moduleTable[name]
})

// ------------------------------------------------------------------ render ---

const rendered = { host: 0, components: new Map(), passes: 0 }

function renderNode(node, depth = 0) {
  if (depth > 200) throw new Error('render depth exceeded')
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(child => renderNode(child, depth + 1))
  if (node.type === React.Fragment) return renderNode(node.props?.children ?? null, depth + 1)
  if (typeof node.type === 'function') {
    const name = node.type.name || 'anonymous'
    rendered.components.set(name, (rendered.components.get(name) ?? 0) + 1)
    const runtime = createHookRuntime()
    const previous = activeRuntime
    const props = { ...(node.props ?? {}) }
    let tree = null
    for (let pass = 0; pass < 5; pass += 1) {
      rendered.passes += 1
      runtime.reset()
      activeRuntime = runtime
      tree = node.type(props)
      activeRuntime = previous
      runtime.runEffects()
      if (runtime.dirty !== true) break
    }
    activeRuntime = previous
    return renderNode(tree, depth + 1)
  }
  rendered.host += 1
  const props = node.props ?? {}
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'function' && !/^on[A-Z]/.test(key) && key !== 'ref' && key !== 'children') {
      console.warn(`prop ${key} on <${String(node.type)}> is a function`)
    }
  }
  return { tag: node.type, props, children: renderNode(props.children ?? null, depth + 1) }
}

/**
 * Collect every text node below a rendered tree.
 * @param tree - rendered node.
 * @param out - collector.
 * @returns the collector.
 */
function collectText(tree, out = []) {
  if (tree === null || tree === undefined) return out
  if (typeof tree === 'string') { out.push(tree); return out }
  if (Array.isArray(tree)) { for (const child of tree) collectText(child, out); return out }
  collectText(tree.children, out)
  return out
}

// ---------------------------------------------------------------- fixtures ---

const now = Date.now()
const SESSION_A = 'session-11111111-2222-3333-4444-555555555555'
const SESSION_B = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const ROOT = '/Users/example/DSH'

const sessionsFixture = {
  ids: [SESSION_A, SESSION_B],
  byId: {
    [SESSION_A]: {
      id: SESSION_A,
      displayTitle: 'How the sandbox boundary works',
      cwd: `${ROOT}/${SESSION_A}`,
      blank: false,
      running: false,
      updatedAt: now - 90_000,
      retainedBy: { mainView: 1 },
      projectionValues: {},
    },
    [SESSION_B]: {
      id: SESSION_B,
      displayTitle: 'New Session',
      cwd: `${ROOT}/${SESSION_B}`,
      blank: true,
      running: false,
      updatedAt: now - 3_600_000,
      retainedBy: {},
      projectionValues: {},
    },
  },
  phase: 'ready',
  projectionsBySession: {},
}

const workspacesFixture = {
  items: [
    { workspaceId: 'ws-real', path: '/Users/example/projects/demo', title: 'demo', sessionIds: [], createdAt: '', updatedAt: '' },
    { workspaceId: 'ws-other', path: '/Users/example/projects/demo-2', title: 'demo', sessionIds: [], createdAt: '', updatedAt: '' },
    { workspaceId: 'ws-scratch', path: `${ROOT}/${SESSION_B}`, title: 'No workspace', sessionIds: [SESSION_B], createdAt: '', updatedAt: '' },
  ],
  archivedSessionIds: [],
  pinnedSessionIds: [],
  state: 'ready',
  phase: 'ready',
  error: null,
}

const statusFixture = {
  root: ROOT,
  home: '/Users/example',
  defaultRoot: ROOT,
  configured: false,
  rootError: null,
  projectRoot: null,
  config: {
    workspaceRoot: '',
    pickerEntry: true,
    rememberPick: true,
    management: true,
    trashOnDelete: true,
    rowBadge: true,
    reuseBlank: true,
    abandonOnSwitch: true,
    autoReclaimHours: 24,
  },
  caps: {
    webServer: true,
    connection: true,
    sessionController: true,
    workspaceRegistry: true,
    configEditor: true,
    events: true,
    trash: true,
    trashMethod: 'electron',
  },
  staged: [{ sessionId: SESSION_B, workspaceId: 'ws-scratch', path: `${ROOT}/${SESSION_B}`, createdAt: now }],
  pendingSettles: 0,
  lastSweep: { at: now - 5_000, settled: 1, abandoned: 0, kept: 0 },
  lastPick: 'scratch',
  version: '0.2.2-rc.3',
}

const inventoryFixture = {
  root: ROOT,
  folders: [
    { id: SESSION_A, exists: true, bytes: 12_345, files: 4, mtimeMs: now },
    { id: SESSION_B, exists: true, bytes: 0, files: 0, mtimeMs: now },
  ],
  orphans: [],
}

// ------------------------------------------------------------------- apply ---

const registered = []
const navigationCalls = []
const uiWorkspace = {
  openSession: () => {},
  pickDirectory: async () => null,
  startSession: (...args) => { navigationCalls.push(args) },
}
const stubCtx = {
  locale: {
    getSnapshot: () => ({ active: 'en', revision: 0 }),
    subscribe: () => () => {},
    register: () => () => {},
  },
  sessions: {
    retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 0, retainedBy: {} }), subscribe: () => () => {} }),
    list: { getSnapshot: () => sessionsFixture, subscribe: () => () => {} },
  },
  slots: {
    inject: (_key, callback) => {
      const disposer = callback()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    register: (options, component) => {
      registered.push({ key: options.name, keyed: options.key, id: options.id, order: options.order, component })
      return () => {}
    },
  },
  inject: (_deps, callback) => {
    const disposer = callback(stubCtx)
    return () => { if (typeof disposer === 'function') disposer() }
  },
  effect: (callback) => { callback(); return () => {} },
  uiWorkspace,
  get: (name) => {
    if (name === 'workspaces') {
      return {
        list: { getSnapshot: () => workspacesFixture, subscribe: () => () => {} },
        create: async () => ({ workspaceId: 'ws-new' }),
      }
    }
    if (name === 'uiWorkspace') return uiWorkspace
    return undefined
  },
}

plugin.apply(stubCtx)
const internal = globalThis.__DSA__
if (internal === undefined) throw new Error('internal export was not installed')

internal.store.set({ status: statusFixture, inventory: inventoryFixture, inventoryAt: now })

const results = []

// --------------------------------------------- New Session default (memory) ---
const realFetch = globalThis.fetch
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, value: { kind: 'workspace' } }) })
const scratchStarts = []
const realStartScratch = internal.RUNTIME.startScratch
internal.RUNTIME.startScratch = async () => { scratchStarts.push(1) }
const originalStatus = internal.store.get().status
// The fixture's main view is an ungrouped (settled scratch) conversation, so
// "no workspace" is current and the remembered scratch choice applies.
uiWorkspace.startSession()
if (scratchStarts.length !== 1 || navigationCalls.length !== 0) {
  throw new Error(`remembered scratch was not used: scratch=${scratchStarts.length} original=${navigationCalls.length}`)
}
await new Promise(resolve => setTimeout(resolve, 0))
uiWorkspace.startSession('ws-real')
if (navigationCalls.length !== 1 || navigationCalls[0][0] !== 'ws-real') {
  throw new Error('an explicit workspace choice must stay with DSH')
}
if (internal.store.get().status.lastPick !== 'workspace') throw new Error('picking a workspace did not clear the memory')
// The temporary group's own New Session button must not put a second
// conversation into the scratch folder.
uiWorkspace.startSession('ws-scratch')
if (scratchStarts.length !== 2 || navigationCalls.length !== 1) {
  throw new Error('an explicit scratch workspace must start a fresh scratch conversation')
}
await new Promise(resolve => setTimeout(resolve, 0))
uiWorkspace.startSession()
if (navigationCalls.length !== 2) throw new Error('a workspace memory must leave New Session to DSH')
internal.store.set({ status: { ...originalStatus, lastPick: 'scratch', config: { ...statusFixture.config, rememberPick: false } } })
uiWorkspace.startSession()
if (navigationCalls.length !== 3) throw new Error('the switch did not restore DSH behavior')
// A scratch workspace as the current one must never host a second conversation.
sessionsFixture.byId[SESSION_A].retainedBy = { mainView: 1 }
workspacesFixture.items.find(item => item.workspaceId === 'ws-scratch').sessionIds.push(SESSION_A)
internal.store.set({ status: { ...originalStatus, lastPick: 'workspace', config: { ...statusFixture.config } } })
await new Promise(resolve => setTimeout(resolve, 0))
uiWorkspace.startSession()
if (scratchStarts.length !== 3) throw new Error('New Session from a scratch workspace must start a scratch conversation')
workspacesFixture.items.find(item => item.workspaceId === 'ws-scratch').sessionIds.pop()
internal.store.set({ status: originalStatus })
internal.RUNTIME.startScratch = realStartScratch
globalThis.fetch = realFetch
results.push(['New Session default', 'scratch remembered, explicit pick clears it, switch restores DSH'])

const slotsByName = new Map(registered.map(entry => [entry.key, entry]))
for (const name of ['conversation.hero.workspace', 'sidebar.session.row.trailing', 'plugins.bundle.config']) {
  if (!slotsByName.has(name)) throw new Error(`missing slot registration: ${name}`)
}

/**
 * Render one stored slot entry with the harness's standard hooks.
 * @param slotName - slot key.
 * @param props - owner props.
 * @returns the rendered tree.
 */
function renderSlotEntry(slotName, props) {
  const entry = slotsByName.get(slotName)
  return renderNode(createElement(entry.component, {
    useSessions: selector => selector(sessionsFixture),
    useWorkspaces: selector => selector(workspacesFixture),
    ...props,
  }))
}

/**
 * Collect every rendered button with a role, in document order.
 * @param tree - rendered tree.
 * @param role - aria role to keep.
 * @returns the matching nodes.
 */
function collectButtons(tree, role, out = []) {
  if (tree === null || tree === undefined || typeof tree === 'string') return out
  if (Array.isArray(tree)) { for (const child of tree) collectButtons(child, role, out); return out }
  if (tree.tag === 'button' && (role === undefined || tree.props?.role === role)) out.push(tree)
  const children = tree.children === undefined ? [] : (Array.isArray(tree.children) ? tree.children : [tree.children])
  for (const child of children) collectButtons(child, role, out)
  return out
}

const anchor = {
  getBoundingClientRect: () => ({ top: 200, bottom: 232, left: 600, right: 780, width: 180, height: 32 }),
  contains: () => false,
  focus: () => {},
}

const menuClosed = renderSlotEntry('conversation.hero.workspace', {
  open: false,
  anchorRef: { current: null },
  selectedId: undefined,
  onPick: () => {},
  onClose: () => {},
})
results.push(['menu (closed)', menuClosed === null ? 'nothing rendered' : 'unexpected render'])

const menuOpen = renderSlotEntry('conversation.hero.workspace', {
  open: true,
  anchorRef: { current: anchor },
  selectedId: undefined,
  onPick: () => {},
  onClose: () => {},
})
const menuText = collectText(menuOpen).join(' | ')
if (!menuText.includes('No workspace')) throw new Error(`menu is missing the scratch row: ${menuText}`)
if (!menuText.includes('Add workspace')) throw new Error(`menu is missing the add row: ${menuText}`)
if (menuText.includes('ws-scratch')) throw new Error('the transient workspace leaked into the list')
const workspaceRows = collectText(menuOpen).filter(text => text === 'demo').length
if (workspaceRows !== 2) throw new Error(`expected two workspace rows, saw ${workspaceRows}`)
results.push(['menu (open)', '2 workspaces + add + scratch'])

const badge = renderSlotEntry('sidebar.session.row.trailing', { sessionId: SESSION_A })
results.push(['row badge', badge === null ? 'nothing rendered' : 'folder mark'])

const summary = renderSlotEntry('plugins.bundle.config', { view: 'summary' })
const summaryText = collectText(summary).join('')
if (!summaryText.includes(ROOT)) throw new Error(`summary is missing the path: ${summaryText}`)
results.push(['config summary', summaryText])

const page = renderSlotEntry('plugins.bundle.config', { view: 'page' })
const pageText = collectText(page).join(' | ')
for (const expected of ['Working path', 'Features', 'Remember the last choice', 'Scratch conversations', 'How the sandbox boundary works', 'Recently updated']) {
  if (!pageText.includes(expected)) throw new Error(`settings page is missing "${expected}": ${pageText.slice(0, 600)}`)
}
results.push(['config page', 'path + features (7 switches) + manager rows'])

internal.store.set({
  status: { ...statusFixture, config: { ...statusFixture.config, management: false } },
})
const pageNoManager = renderSlotEntry('plugins.bundle.config', { view: 'page' })
const noManagerText = collectText(pageNoManager).join(' | ')
if (noManagerText.includes('Scratch conversations')) throw new Error('the management switch did not hide the manager')
results.push(['config page (management off)', 'manager hidden'])

internal.store.set({ status: null, statusError: { message: 'offline' } })
const pageOffline = renderSlotEntry('plugins.bundle.config', { view: 'page' })
const offlineText = collectText(pageOffline).join(' | ')
if (!offlineText.includes('Retry')) throw new Error(`offline page has no retry: ${offlineText}`)
results.push(['config page (host offline)', 'retry shown'])

// A missing folder must surface the "Folder missing" filter entry and badge.
internal.store.set({
  status: statusFixture,
  inventory: { root: ROOT, folders: [{ id: SESSION_B, exists: true, bytes: 0, files: 0, mtimeMs: now }], orphans: [] },
})
const pageMissing = renderSlotEntry('plugins.bundle.config', { view: 'page' })
const missingText = collectText(pageMissing).join(' | ')
if (!missingText.includes('Folder missing')) throw new Error('missing-folder state did not render')
results.push(['config page (folder missing)', 'missing badge shown'])

const rowMenu = renderNode(createElement(internal.RowMenu, {
  anchor,
  row: { id: SESSION_A, title: 'How the sandbox boundary works', pinned: false, archived: false, exists: true, folder: { bytes: 12 }, cwd: `${ROOT}/${SESSION_A}` },
  t: key => key,
  onClose: () => {},
  onSelect: () => {},
}))
const rowMenuText = collectText(rowMenu).join(' | ')
for (const expected of ['action.open', 'action.rename', 'action.pin', 'action.archive', 'action.reveal', 'action.copyPath', 'action.trash']) {
  if (!rowMenuText.includes(expected)) throw new Error(`row menu is missing ${expected}`)
}
results.push(['row menu', 'seven actions'])

const dialog = renderNode(createElement(internal.Dialog, {
  title: 'Move to Trash?',
  body: 'The conversation is archived.',
  confirmLabel: 'Move to Trash',
  tone: 'danger',
  busy: false,
  onCancel: () => {},
  onConfirm: () => {},
}, createElement('input', { key: 'i', className: 'dsa-input' })))
const dialogText = collectText(dialog).join(' | ')
if (!dialogText.includes('Move to Trash?')) throw new Error('dialog did not render its title')
results.push(['dialog', 'title + body + confirm'])

// The scratch entry is disabled while the Host channel is down, and the menu
// says so instead of failing after the click.
internal.store.set({ status: null, statusError: { message: 'offline' } })
const menuDown = renderSlotEntry('conversation.hero.workspace', {
  open: true,
  anchorRef: { current: anchor },
  selectedId: undefined,
  onPick: () => {},
  onClose: () => {},
})
const downText = collectText(menuDown).join(' | ')
if (!downText.includes('host channel is unavailable')) throw new Error(`menu did not report the dead host: ${downText}`)
const scratchButton = collectButtons(menuDown, 'menuitem')
  .find(node => collectText(node).join(' ').includes('No workspace'))
if (scratchButton === undefined || scratchButton.props?.disabled !== true) throw new Error('the scratch row is not disabled while the host is down')
results.push(['menu (host down)', 'scratch row disabled with an explicit reason'])

// A live Host shows where the new folder will live.
internal.store.set({ status: statusFixture, inventory: inventoryFixture, inventoryAt: now })
const menuLive = renderSlotEntry('conversation.hero.workspace', {
  open: true,
  anchorRef: { current: anchor },
  selectedId: undefined,
  onPick: () => {},
  onClose: () => {},
})
const liveText = collectText(menuLive).join(' | ')
if (!liveText.includes('~/DSH')) throw new Error(`menu did not show the working path: ${liveText}`)
results.push(['menu (live host)', 'working path shown on the scratch row'])

// A failed config write is reported, and a read-only profile disables the switches.
internal.store.set({
  status: { ...statusFixture, caps: { ...statusFixture.caps, configEditor: false } },
  configError: { message: 'entry is overridden' },
})
const pageReadOnly = renderSlotEntry('plugins.bundle.config', { view: 'page' })
const readOnlyText = collectText(pageReadOnly).join(' | ')
if (!readOnlyText.includes('read-only')) throw new Error('read-only profile is not explained')
if (!readOnlyText.includes('entry is overridden')) throw new Error('the failed write is not reported')
const switches = []
const walk = (node) => {
  if (node === null || node === undefined || typeof node === 'string') return
  if (Array.isArray(node)) { node.forEach(walk); return }
  if (node.tag === 'button' && node.props?.role === 'switch') switches.push(node)
  const children = node.children === undefined ? [] : (Array.isArray(node.children) ? node.children : [node.children])
  children.forEach(walk)
}
walk(pageReadOnly)
if (switches.length !== 7) throw new Error(`expected 7 switches, saw ${switches.length}`)
if (switches.some(node => node.props.disabled !== true)) throw new Error('a switch stayed enabled on a read-only profile')
results.push(['config page (read-only)', '7 switches disabled, write error shown'])

// A Host that predates the field hides the row rather than offering a switch
// whose write would be rejected.
internal.store.set({
  status: { ...statusFixture, config: { ...statusFixture.config, rememberPick: undefined } },
  configError: null,
})
const pageOldHost = renderSlotEntry('plugins.bundle.config', { view: 'page' })
const oldHostSwitches = collectButtons(pageOldHost, 'switch')
if (oldHostSwitches.length !== 6) throw new Error(`an old Host must hide the new switch, saw ${oldHostSwitches.length}`)
results.push(['config page (old Host)', 'new switch hidden, no failing write offered'])

// A long session list must scroll inside the card instead of stretching it.
// The stub renderer has no layout engine, so assert the shipped CSS contract.
const listRule = source.match(/\.dsa-list \{[^}]*\}/)?.[0] ?? ''
if (!listRule.includes('max-height') || !listRule.includes('overflow-y: auto')) {
  throw new Error(`the manager list is not a bounded scroll area: ${listRule}`)
}
const headRule = source.match(/\.dsa-list-head \{[^}]*\}/)?.[0] ?? ''
if (!headRule.includes('position: sticky')) throw new Error('the list header does not stay visible while scrolling')
results.push(['manager list', 'height-capped scroll area with sticky header'])

console.log(results.map(([name, detail]) => `${name}: ${detail}`).join('\n'))
console.log(`host elements rendered: ${rendered.host}`)
console.log(`components rendered: ${[...rendered.components.keys()].join(', ')}`)
console.log('OK')
