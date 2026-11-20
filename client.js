/**
 * Session autospace — browser half.
 *
 * Two registrations:
 * - `conversation.hero.workspace` (single): the workspace menu shown by the
 *   blank-session hero. It lists the real Workspaces, keeps the shipped
 *   "Add workspace…" action, and adds "No workspace", which asks the Host for a
 *   scratch session and opens it.
 * - `plugins.bundle.config` (keyed by the package name): the settings page —
 *   working path, feature switches, and the scratch-conversation manager.
 *
 * The page also owns the client-side settling channels: it watches each staged
 * conversation for its first turn (settle) and for the main view leaving it
 * (abandon). The Host owns the same state durably; both sides are idempotent.
 *
 * @module dsh-session-autospace/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-autospace',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const {
      useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
    } = React

    const PACKAGE_NAME = 'dsh-session-autospace'
    const ROUTE_PREFIX = '/api/session-autospace'
    const SESSION_ID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    const LOCALE_NS = 'sessionAutospace'
    const MAX_BULK = 100

    const EN = {
      'menu.section': 'Workspaces',
      'menu.add': 'Add workspace…',
      'menu.scratch': 'No workspace',
      'menu.loading': 'Loading workspaces…',
      'menu.empty': 'No workspaces yet',
      'menu.retry': 'Retry',
      'menu.preparing': 'Creating folder…',
      'menu.failed': 'Could not start the conversation',
      'menu.hostUnavailable': 'Plugin host channel unavailable',
      'menu.reveal': 'Show in Finder',
      'path.title': 'Working path',
      'path.desc': 'Every new conversation gets its own folder under this path, named after its session. That folder is the conversation\'s working directory and sandbox boundary.',
      'path.effective': 'In use',
      'path.default': 'Default',
      'path.placeholder': '~/DSH',
      'path.choose': 'Choose…',
      'path.save': 'Save',
      'path.reset': 'Restore default',
      'path.reveal': 'Show in Finder',
      'path.saving': 'Saving…',
      'path.saved': 'Saved',
      'path.invalid': 'Enter an absolute path.',
      'path.inherit': 'This folder sits inside a project. Its AGENTS.md applies to every conversation created here.',
      'path.createFailed': 'Could not use this path',
      'features.title': 'Features',
      'features.note': 'Each switch takes effect immediately.',
      'toggle.pickerEntry': 'Workspace menu entry',
      'toggle.pickerEntry.desc': 'Adds "No workspace" to the workspace menu. Turned off, the DSH menu comes back unchanged.',
      'toggle.rememberPick': 'Remember the last choice',
      'toggle.rememberPick.desc': 'After you pick "No workspace", New Session keeps opening scratch conversations until you pick a real workspace. A conversation that already belongs to a real workspace still keeps New Session there.',
      'toggle.management': 'Conversation manager',
      'toggle.management.desc': 'Shows the scratch-conversation manager on this page.',
      'toggle.trashOnDelete': 'Move folders to the Trash',
      'toggle.trashOnDelete.desc': 'Deleting or abandoning a conversation moves its empty folder to the system Trash instead of deleting it.',
      'toggle.reuseBlank': 'Reuse an untouched conversation',
      'toggle.reuseBlank.desc': 'Picking "No workspace" again reopens the blank scratch conversation instead of creating another folder.',
      'toggle.abandonOnSwitch': 'Discard on switching away',
      'toggle.abandonOnSwitch.desc': 'Leaving a blank scratch conversation archives it and cleans up its folder. Turned off, it stays in Ungrouped for you to handle here.',
      'toggle.autoReclaim': 'Reclaim untouched conversations',
      'toggle.autoReclaim.desc': 'Blank conversations older than this many hours are archived and cleaned up when the plugin starts. 0 keeps them forever.',
      'toggle.hours': 'hours',
      'manage.title': 'Scratch conversations',
      'manage.refresh': 'Refresh',
      'manage.search': 'Search title, session ID, or path',
      'manage.empty': 'No scratch conversations yet. Choose "No workspace" on the new-conversation screen to create one.',
      'manage.emptyFilter': 'Nothing matches this filter.',
      'manage.count': '{total} total · ≈ {size}{blank}{missing}',
      'manage.countBlank': ' · {n} new',
      'manage.countMissing': ' · {n} missing folder',
      'filter.all': 'All',
      'filter.active': 'Active',
      'filter.blank': 'New',
      'filter.archived': 'Archived',
      'filter.missing': 'Folder missing',
      'sort.updated': 'Recently updated',
      'sort.title': 'Title',
      'sort.size': 'Size',
      'group.today': 'Today',
      'group.yesterday': 'Yesterday',
      'group.week': 'This week',
      'group.earlier': 'Earlier',
      'row.new': 'New Session',
      'row.path': 'Path',
      'badge.running': 'Active',
      'badge.blank': 'New',
      'badge.archived': 'Archived',
      'badge.missing': 'Folder missing',
      'action.open': 'Open conversation',
      'action.rename': 'Rename',
      'action.pin': 'Pin',
      'action.unpin': 'Unpin',
      'action.archive': 'Archive',
      'action.unarchive': 'Unarchive',
      'action.reveal': 'Show in Finder',
      'action.copyPath': 'Copy path',
      'action.trash': 'Move to Trash',
      'action.more': 'More actions',
      'bulk.selected': '{n} selected',
      'bulk.archive': 'Archive',
      'bulk.unarchive': 'Unarchive',
      'bulk.trash': 'Move to Trash',
      'bulk.clear': 'Clear selection',
      'confirm.trash.title': 'Move to Trash?',
      'confirm.trash.body': 'The conversation is archived (restorable from the archive section) and its folder moves to the system Trash.',
      'confirm.trash.confirm': 'Move to Trash',
      'confirm.bulkTrash.title': 'Move {n} conversations to the Trash?',
      'confirm.bulkTrash.body': 'These conversations are archived (restorable from the archive section) and their folders move to the system Trash.',
      'confirm.rename.title': 'Rename conversation',
      'confirm.rename.save': 'Rename',
      'confirm.reclaim.title': 'Reclaim untouched conversations?',
      'confirm.reclaim.body': 'These blank conversations are archived and their empty folders are cleaned up.',
      'confirm.orphans.title': 'Clean orphan folders?',
      'confirm.orphans.body': 'These folders are named like a session but no conversation claims them. Each one moves to the system Trash.',
      'confirm.continue': 'Continue',
      'dialog.cancel': 'Cancel',
      'dialog.close': 'Close',
      'maintain.title': 'Maintenance',
      'maintain.reclaim': 'Reclaim new conversations',
      'maintain.reclaim.desc': 'Blank conversations older than the reclaim threshold.',
      'maintain.reclaim.empty': 'Nothing to reclaim.',
      'maintain.orphans': 'Clean orphan folders',
      'maintain.orphans.desc': 'Folders named like a session that no conversation claims.',
      'maintain.orphans.empty': 'No orphan folders.',
      'maintain.rebuild': 'Rebuild missing folders',
      'maintain.rebuild.desc': 'Recreate the working folder of a conversation whose folder was deleted.',
      'maintain.rebuild.empty': 'Every folder is present.',
      'maintain.result': '{changed} changed · {skipped} skipped',
      'status.title': 'Status',
      'status.version': 'DSH',
      'status.caps': 'Capabilities',
      'status.staged': 'Staged conversations',
      'status.pending': 'Pending cleanups',
      'status.sweep': 'Last sweep',
      'status.yes': 'available',
      'status.no': 'unavailable',
      'note.groups': 'While a conversation is staged, the sidebar shows a temporary "No workspace" group beside any Ungrouped group it already has. Both return to one on send, or when you switch away.',
      'note.workflow': 'DSH has no permanent delete: deleting archives the conversation and moves its folder to the system Trash. Enabled features are undone by turning them off or disabling the plugin; existing conversations and folders stay.',
      'error.load': 'Could not read the plugin state.',
      'error.host': 'The plugin host is unavailable. Reopen this page or check that the plugin is enabled.',
      'error.generic': 'Something went wrong.',
      'toast.copied': 'Path copied',
      'toast.revealed': 'Shown in Finder',
      'toast.done': 'Done',
      'toast.trashUnavailable': 'The system Trash is unavailable. Use "Show in Finder" instead.',
      'chip.hint': 'for this conversation',
      'misc.newTitle': 'New Session',
      'misc.none': '—',
      'row.untitled': "Untitled conversation",
      'page.loading': "Loading plugin state…",
      'menu.hostDown': "The plugin host channel is unavailable. Reload the page or check that the plugin is enabled.",
      'confirm.reclaim.confirm': "Archive and clean up",
      'confirm.orphans.confirm': "Move folders to Trash",
      'confirm.archiveRunning.title': "Stop and archive?",
      'confirm.archiveRunning.body': "This conversation is still running. Archiving stops the current turn.",
      'confirm.archiveRunning.confirm': "Stop and archive",
      'toast.trashLeft': "Archived. The folder stayed: {reason}",
      'toast.trashSkipped': "Archived. The folder was kept because \"move folders to the Trash\" is off.",
      'path.checking': "Checking…",
      'path.notWritable': "This path cannot be created; pick a writable folder.",
      'path.reveal': "Show in Finder",
      'path.readOnly': "Configuration cannot be saved in this profile, so these switches are read-only.",
      'manage.inventoryError': "Could not read the folders: {message}",
      'action.archiveRunning': "Archive (stops the running turn)",
      'time.now': 'just now',
      'time.minutes': '{n} min ago',
      'time.hours': '{n} h ago',
      'time.days': '{n} d ago',
    }

    const ZH = {
      'menu.section': '工作区',
      'menu.add': '添加工作区…',
      'menu.scratch': '不指定工作区',
      'menu.loading': '正在载入工作区…',
      'menu.empty': '还没有工作区',
      'menu.retry': '重试',
      'menu.preparing': '正在创建文件夹…',
      'menu.failed': '无法开始这次对话',
      'menu.hostUnavailable': '插件宿主通道不可用',
      'menu.reveal': '在访达中显示',
      'path.title': '工作路径',
      'path.desc': '每个新对话都在此路径下获得以 session ID 命名的独立文件夹，它就是该对话的工作目录与沙盒边界。',
      'path.effective': '当前生效',
      'path.default': '默认',
      'path.placeholder': '~/DSH',
      'path.choose': '选择目录…',
      'path.save': '保存',
      'path.reset': '恢复默认',
      'path.reveal': '在访达中显示',
      'path.saving': '正在保存…',
      'path.saved': '已保存',
      'path.invalid': '请输入绝对路径。',
      'path.inherit': '该目录位于项目内，项目自带的 AGENTS.md 会作用于在此创建的每个对话。',
      'path.createFailed': '无法使用该路径',
      'features.title': '功能开关',
      'features.note': '开关即时生效。',
      'toggle.pickerEntry': '工作区菜单入口',
      'toggle.pickerEntry.desc': '在工作区菜单里加入「不指定工作区」。关闭后 DSH 原菜单原样回来。',
      'toggle.rememberPick': '记住上次选择',
      'toggle.rememberPick.desc': '选过「不指定工作区」后，点「新建会话」会继续开一个临时会话，直到你重新选择普通工作区；当前对话本身属于某个工作区时，新建仍留在该工作区。',
      'toggle.management': '会话管理区',
      'toggle.management.desc': '在本页显示临时会话管理区。',
      'toggle.trashOnDelete': '删除时回收文件夹',
      'toggle.trashOnDelete.desc': '删除或放弃对话时把空文件夹移入系统废纸篓，而不是直接删除。',
      'toggle.reuseBlank': '复用未开始的会话',
      'toggle.reuseBlank.desc': '再次选择「不指定工作区」时回到当前空白的临时会话，而不是新建一个文件夹。',
      'toggle.abandonOnSwitch': '切换走时自动消失',
      'toggle.abandonOnSwitch.desc': '离开空白的临时会话时归档它并清理文件夹。关闭后它留在未分组里，由本页处置。',
      'toggle.autoReclaim': '自动回收未开始的会话',
      'toggle.autoReclaim.desc': '超过这么多小时的空白对话，在插件启动时归档并清理。0 表示不自动回收。',
      'toggle.hours': '小时',
      'manage.title': '临时会话',
      'manage.refresh': '刷新',
      'manage.search': '搜索标题、session ID 或路径',
      'manage.empty': '还没有临时会话。在新建对话页选择「不指定工作区」即可创建。',
      'manage.emptyFilter': '没有符合当前筛选的会话。',
      'manage.count': '共 {total} 个 · 占用 ≈ {size}{blank}{missing}',
      'manage.countBlank': ' · 未开始 {n}',
      'manage.countMissing': ' · 缺失 {n}',
      'filter.all': '全部',
      'filter.active': '进行中',
      'filter.blank': '未开始',
      'filter.archived': '已归档',
      'filter.missing': '文件夹缺失',
      'sort.updated': '最近更新',
      'sort.title': '标题',
      'sort.size': '占用空间',
      'group.today': '今天',
      'group.yesterday': '昨天',
      'group.week': '本周',
      'group.earlier': '更早',
      'row.new': '新会话',
      'row.path': '路径',
      'badge.running': '进行中',
      'badge.blank': '未开始',
      'badge.archived': '已归档',
      'badge.missing': '文件夹缺失',
      'action.open': '打开会话',
      'action.rename': '重命名',
      'action.pin': '置顶',
      'action.unpin': '取消置顶',
      'action.archive': '归档',
      'action.unarchive': '取消归档',
      'action.reveal': '在访达中显示',
      'action.copyPath': '复制路径',
      'action.trash': '移入废纸篓',
      'action.more': '更多操作',
      'bulk.selected': '已选 {n} 项',
      'bulk.archive': '归档',
      'bulk.unarchive': '取消归档',
      'bulk.trash': '移入废纸篓',
      'bulk.clear': '取消选择',
      'confirm.trash.title': '移入废纸篓？',
      'confirm.trash.body': '会话将被归档（可在侧栏归档区恢复），文件夹移入系统废纸篓。',
      'confirm.trash.confirm': '移入废纸篓',
      'confirm.bulkTrash.title': '将 {n} 个会话移入废纸篓？',
      'confirm.bulkTrash.body': '这些会话将被归档（可在侧栏归档区恢复），它们的文件夹移入系统废纸篓。',
      'confirm.rename.title': '重命名会话',
      'confirm.rename.save': '重命名',
      'confirm.reclaim.title': '回收未开始的会话？',
      'confirm.reclaim.body': '这些空白会话将被归档，其空文件夹会被清理。',
      'confirm.orphans.title': '清理孤立文件夹？',
      'confirm.orphans.body': '这些文件夹形如会话，但没有任何对话对应。它们将被移入系统废纸篓。',
      'confirm.continue': '继续',
      'dialog.cancel': '取消',
      'dialog.close': '关闭',
      'maintain.title': '维护',
      'maintain.reclaim': '清理未开始',
      'maintain.reclaim.desc': '超过阈值的空白对话。',
      'maintain.reclaim.empty': '没有可清理的会话。',
      'maintain.orphans': '清理孤立文件夹',
      'maintain.orphans.desc': '形如会话却没有任何对话对应的文件夹。',
      'maintain.orphans.empty': '没有孤立文件夹。',
      'maintain.rebuild': '重建缺失文件夹',
      'maintain.rebuild.desc': '为目录已被删除的对话重新创建目录。',
      'maintain.rebuild.empty': '所有文件夹都在。',
      'maintain.result': '已处理 {changed} 项 · 跳过 {skipped} 项',
      'status.title': '状态',
      'status.version': 'DSH',
      'status.caps': '能力探测',
      'status.staged': '暂存表',
      'status.pending': '待重试收尾',
      'status.sweep': '上次清扫',
      'status.yes': '可用',
      'status.no': '不可用',
      'note.groups': '暂存期间侧栏会临时多出「不指定工作区」分组；若已有未分组分组，两者并存。发送或切走即恢复为一个。',
      'note.workflow': 'DSH 没有永久删除：删除的含义是归档对话并把文件夹移入系统废纸篓。关闭开关或禁用插件即可复原对应界面，已产生的会话与目录保留。',
      'error.load': '无法读取插件状态。',
      'error.host': '插件宿主不可用。请重新打开本页，或确认插件已启用。',
      'error.generic': '操作失败。',
      'toast.copied': '已复制路径',
      'toast.revealed': '已在访达中显示',
      'toast.done': '已完成',
      'toast.trashUnavailable': '系统废纸篓不可用，请改用「在访达中显示」手动处理。',
      'chip.hint': '本次对话',
      'misc.newTitle': '新会话',
      'misc.none': '—',
      'row.untitled': "未命名对话",
      'page.loading': "正在载入插件状态…",
      'menu.hostDown': "插件宿主通道不可用。请刷新页面，或确认插件已启用。",
      'confirm.reclaim.confirm': "归档并清理",
      'confirm.orphans.confirm': "移入废纸篓",
      'confirm.archiveRunning.title': "停止并归档？",
      'confirm.archiveRunning.body': "这个对话还在运行，归档会停止当前这一轮。",
      'confirm.archiveRunning.confirm': "停止并归档",
      'toast.trashLeft': "已归档。文件夹保留：{reason}",
      'toast.trashSkipped': "已归档。因为「删除时回收文件夹」关闭，文件夹被保留。",
      'path.checking': "正在检查…",
      'path.notWritable': "该路径无法创建，请选一个可写的目录。",
      'path.reveal': "在访达中显示",
      'path.readOnly': "当前 profile 无法保存配置，这些开关只能查看。",
      'manage.inventoryError': "无法读取文件夹：{message}",
      'action.archiveRunning': "归档（会停止运行中的这一轮）",
      'time.now': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
      'time.days': '{n} 天前',
    }

    /** Mutable wiring installed by `apply`; components read it instead of props. */
    const RUNTIME = {
      ctx: null,
      t: key => key,
      refreshStatus: async () => {},
      refreshInventory: async () => {},
      saveConfig: async () => false,
      watchSession: () => {},
      syncSlots: () => {},
      notify: () => {},
      reveal: async () => {},
      op: async () => {},
      trash: async () => {},
      maintain: async () => {},
      rememberPick: async () => {},
      dispose: () => {},
    }

    // ---------------------------------------------------------------- store ---

    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        get: () => snapshot,
        set(patch) {
          const next = typeof patch === 'function' ? patch(snapshot) : patch
          snapshot = { ...snapshot, ...next }
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    const store = createStore({
      status: null,
      statusError: null,
      statusAt: 0,
      inventory: null,
      inventoryError: null,
      inventoryAt: 0,
      saving: false,
      configError: null,
      toast: null,
    })

    const useStore = () => useSyncExternalStore(store.subscribe, store.get)

    let toastTimer

    /**
     * Show one short confirmation line, replacing any previous one.
     * @param message - already localized text.
     */
    function notify(message) {
      store.set({ toast: { message, at: Date.now() } })
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => { store.set({ toast: null }) }, 2600)
    }

    // ------------------------------------------------------------- requests ---

    let inflightStatus
    let inflightInventory

    /**
     * Call one Host route and unwrap its `{ok, value}` envelope.
     * @param route - path below the plugin prefix.
     * @param body - JSON body.
     * @returns the route's value.
     */
    async function request(route, body) {
      const response = await fetch(ROUTE_PREFIX + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body ?? {}),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(response.ok ? 'Empty response' : `HTTP ${response.status}`)
      }
      if (payload === null || typeof payload !== 'object') throw new Error('Malformed response')
      if (payload.ok !== true) {
        const error = new Error(String(payload.message ?? payload.code ?? 'Request failed'))
        error.code = payload.code
        throw error
      }
      return payload.value
    }

    /**
     * Re-read the Host read model.
     * @returns the status value, or undefined when the Host is unreachable.
     */
    async function refreshStatus() {
      if (inflightStatus !== undefined) return inflightStatus
      inflightStatus = (async () => {
        try {
          const value = await request('/status')
          store.set({ status: value, statusError: null, statusAt: Date.now() })
          RUNTIME.syncSlots()
          for (const staged of value.staged ?? []) RUNTIME.watchSession(String(staged.sessionId))
          return value
        } catch (error) {
          store.set({ statusError: { message: messageOf(error), code: error?.code } })
          RUNTIME.syncSlots()
          return undefined
        } finally {
          inflightStatus = undefined
        }
      })()
      return inflightStatus
    }

    /**
     * Update this page's copy of the remembered choice without a request.
     * @param kind - `'scratch'` or `'workspace'`.
     */
    function setLastPick(kind) {
      const status = store.get().status
      if (status === null || status === undefined) return
      if (status.lastPick === kind) return
      store.set({ status: { ...status, lastPick: kind } })
    }

    /**
     * Record which kind of conversation the user just started, so the next
     * New Session can repeat it after a restart as well.
     * @param kind - `'scratch'` or `'workspace'`.
     */
    async function rememberPick(kind) {
      setLastPick(kind)
      // A Host that predates the field answers `/status` without it; keep the
      // page coherent but skip a write that would only 404.
      const status = store.get().status
      if (status !== null && status !== undefined && status.lastPick === undefined) return
      try {
        await request('/memory', { kind })
      } catch (error) {
        console.warn('session-autospace: could not save the last choice:', error)
      }
    }

    /**
     * Re-read the folder inventory (the Host caches it briefly).
     * @returns the inventory value, or undefined on failure.
     */
    async function refreshInventory(fresh = false) {
      if (inflightInventory !== undefined) return inflightInventory
      inflightInventory = (async () => {
        try {
          const value = await request('/inventory', fresh === true ? { fresh: true } : {})
          store.set({ inventory: value, inventoryError: null, inventoryAt: Date.now() })
          return value
        } catch (error) {
          store.set({ inventoryError: { message: messageOf(error), code: error?.code } })
          return undefined
        } finally {
          inflightInventory = undefined
        }
      })()
      return inflightInventory
    }

    /**
     * Poll the Host until its config reflects a patch (the write restarts the
     * plugin, so the response may never arrive).
     * @param patch - the fields that were written.
     * @param timeoutMs - how long to keep asking.
     * @returns true when the Host reports the new values.
     */
    async function waitForConfig(patch, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 220))
        try {
          const value = await request('/status')
          store.set({ status: value, statusError: null, statusAt: Date.now() })
          RUNTIME.syncSlots()
          if (Object.entries(patch).every(([key, expected]) => value.config?.[key] === expected)) return true
        } catch {
          // The plugin is restarting; ask again.
        }
      }
      return false
    }

    /**
     * Persist one config patch and confirm it landed.
     * @param patch - known config fields.
     * @returns true when the Host reports the new values.
     */
    async function saveConfig(patch) {
      store.set({ saving: true, configError: null })
      const current = store.get().status
      if (current !== null && current !== undefined) {
        // Optimistic: the switch flips now; the confirmation below restores the
        // Host's values if the write did not land.
        store.set({ status: { ...current, config: { ...current.config, ...patch } } })
      }
      let failure
      try {
        await request('/config', { patch })
      } catch (error) {
        failure = error
      }
      const landed = await waitForConfig(patch)
      if (landed) {
        store.set({ saving: false, configError: null })
        return true
      }
      store.set({ saving: false, configError: { message: messageOf(failure ?? new Error('not applied')) } })
      await refreshStatus()
      return false
    }

    RUNTIME.refreshStatus = refreshStatus
    RUNTIME.refreshInventory = refreshInventory
    RUNTIME.saveConfig = saveConfig
    RUNTIME.notify = notify

    // ----------------------------------------------------------------- i18n ---

    const DICTS = { en: EN, zh: ZH }

    /**
     * Resolve the active dictionary for one locale id.
     * @param active - DSH locale id.
     * @returns the dictionary (English when the language is unsupported).
     */
    function dictFor(active) {
      const language = String(active ?? 'en').toLowerCase().split(/[-_]/)[0]
      return DICTS[language] ?? EN
    }

    /**
     * Build the translator for one locale id.
     * @param active - DSH locale id.
     * @returns `t(key, params)`.
     */
    function makeT(active) {
      const dict = dictFor(active)
      return (key, params) => {
        const template = dict[key] ?? EN[key] ?? key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
      }
    }

    /**
     * Follow the Client locale without prop drilling.
     * @returns the active locale id.
     */
    function useLocaleId() {
      const ctx = RUNTIME.ctx
      const [active, setActive] = useState(() => (ctx === null ? 'en' : ctx.locale.getSnapshot().active))
      useEffect(() => {
        if (ctx === null) return undefined
        setActive(ctx.locale.getSnapshot().active)
        return ctx.locale.subscribe(() => setActive(ctx.locale.getSnapshot().active))
      }, [ctx])
      return active
    }

    /**
     * Translator plus the active id, re-rendering on a language switch.
     * @returns `[t, activeLocaleId]`.
     */
    function useT() {
      const active = useLocaleId()
      const t = useMemo(() => makeT(active), [active])
      return [t, active]
    }

    // --------------------------------------------------------------- helpers ---

    /**
     * Read a message from an unknown thrown value.
     * @param error - thrown value.
     * @returns a short message.
     */
    function messageOf(error) {
      if (error === null || error === undefined) return 'unknown error'
      if (typeof error === 'string') return error
      return String(error.message ?? error)
    }

    /**
     * Trim trailing slashes so path comparisons hold.
     * @param value - path.
     * @returns the trimmed path.
     */
    function trimPath(value) {
      return String(value ?? '').replace(/\/+$/, '')
    }

    /**
     * Final path segment.
     * @param value - path.
     * @returns the segment.
     */
    function baseName(value) {
      const trimmed = trimPath(value)
      return trimmed.slice(trimmed.lastIndexOf('/') + 1)
    }

    /**
     * Whether a cwd is a scratch folder directly under the root.
     * @param cwd - session working directory.
     * @param root - effective working path (may be unknown).
     * @returns true when it matches `<root>/session-<uuid>`.
     */
    function isScratchCwd(cwd) {
      if (typeof cwd !== 'string' || cwd === '') return false
      return SESSION_ID_PATTERN.test(baseName(cwd))
    }

    /**
     * The workspace the main view's conversation currently belongs to.
     * @returns `{workspaceId, scratch}`, or undefined when that conversation is
     *   ungrouped (a settled scratch conversation) or nothing is selected.
     */
    function currentWorkspace() {
      const ctx = RUNTIME.ctx
      const workspaces = ctx?.get?.('workspaces')
      const sessions = ctx?.sessions?.list?.getSnapshot?.()
      if (!workspaces?.list || sessions === undefined || sessions === null) return undefined
      const current = Object.values(sessions.byId ?? {})
        .find(row => (row?.retainedBy?.mainView ?? 0) > 0)
      if (current === undefined) return undefined
      const workspace = (workspaces.list.getSnapshot()?.items ?? [])
        .find(item => (item.sessionIds ?? []).includes(current.id))
      if (workspace === undefined) return undefined
      return { workspaceId: String(workspace.workspaceId), scratch: isScratchCwd(workspace.path) }
    }

    /**
     * Shorten one absolute path below the user's home to a `~/` form.
     * @param value - absolute path.
     * @param home - the user's home directory, when the Host reported it.
     * @returns the short form.
     */
    function shortPath(value, home) {
      const path = trimPath(value)
      const base = typeof home === 'string' ? trimPath(home) : ''
      if (base !== '' && path === base) return '~'
      if (base !== '' && path.startsWith(`${base}/`)) return `~${path.slice(base.length)}`
      return path
    }

    /**
     * Short, readable tail of a session id.
     * @param sessionId - full id.
     * @returns the first eight uuid characters.
     */
    function shortId(sessionId) {
      return String(sessionId).replace(/^session-/, '').slice(0, 8)
    }

    /**
     * Human byte size.
     * @param bytes - byte count.
     * @returns e.g. `1.2 MB`.
     */
    function formatBytes(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return `${value} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let size = value / 1024
      let index = 0
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024
        index += 1
      }
      return `${size >= 10 ? Math.round(size) : size.toFixed(1)} ${units[index]}`
    }

    /**
     * Relative time for a timestamp.
     * @param time - epoch milliseconds.
     * @param t - translator.
     * @returns e.g. `3 min ago`.
     */
    function relativeTime(time, t) {
      const value = Number(time)
      if (!Number.isFinite(value) || value <= 0) return t('misc.none')
      const seconds = Math.max(0, Math.round((Date.now() - value) / 1000))
      if (seconds < 60) return t('time.now')
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return t('time.minutes', { n: minutes })
      const hours = Math.round(minutes / 60)
      if (hours < 24) return t('time.hours', { n: hours })
      const days = Math.round(hours / 24)
      if (days < 30) return t('time.days', { n: days })
      return new Date(value).toLocaleDateString()
    }

    /**
     * Start of the day for a timestamp.
     * @param time - epoch milliseconds.
     * @returns midnight epoch milliseconds.
     */
    function startOfDay(time) {
      const date = new Date(time)
      date.setHours(0, 0, 0, 0)
      return date.getTime()
    }

    /**
     * Seed a stable id for one prepare request.
     * @returns a random id.
     */
    function requestId() {
      return `prep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }

    // -------------------------------------------------------------- artwork ---

    function glyph(children, size = 16, extra) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', flex: 'none', ...(extra ?? {}) },
      }, ...children)
    }

    const IconFolder = ({ size = 16 }) => glyph([
      h('path', { key: 'a', d: 'M3.5 7.2c0-.9.7-1.6 1.6-1.6h3.6c.4 0 .8.2 1.1.5l1.3 1.3h7.9c.9 0 1.6.7 1.6 1.6v8.4c0 .9-.7 1.6-1.6 1.6H5.1c-.9 0-1.6-.7-1.6-1.6V7.2Z' }),
    ], size)

    const IconPlus = ({ size = 16 }) => glyph([
      h('path', { key: 'a', d: 'M12 5.5v13M5.5 12h13' }),
    ], size)

    const IconCheck = ({ size = 16 }) => glyph([
      h('path', { key: 'a', d: 'm5.5 12.5 4.2 4.2 8.8-9' }),
    ], size)

    const IconSpark = ({ size = 16 }) => glyph([
      h('path', { key: 'a', d: 'M4.5 12.5c0-.6.4-1 1-1h3.1l1.2-1.2c.2-.2.4-.3.7-.3h3.9c.6 0 1 .4 1 1v2.2' }),
      h('rect', { key: 'b', x: 4.5, y: 9.4, width: 15, height: 8.2, rx: 2.2 }),
      h('circle', { key: 'c', cx: 9.4, cy: 13.5, r: 0.9, fill: 'currentColor', stroke: 'none' }),
      h('circle', { key: 'd', cx: 12, cy: 13.5, r: 0.9, fill: 'currentColor', stroke: 'none' }),
      h('circle', { key: 'e', cx: 14.6, cy: 13.5, r: 0.9, fill: 'currentColor', stroke: 'none' }),
    ], size)

    const IconMore = ({ size = 16 }) => h('svg', {
      width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false',
      style: { display: 'block', flex: 'none' },
    }, ...[5.6, 12, 18.4].map((cx, index) => h('circle', {
      key: String(index), cx, cy: 12, r: 1.5, fill: 'currentColor',
    })))

    const IconSearch = ({ size = 16 }) => glyph([
      h('circle', { key: 'a', cx: 10.6, cy: 10.6, r: 5.6 }),
      h('path', { key: 'b', d: 'm15 15 4.2 4.2' }),
    ], size)

    const IconRefresh = ({ size = 16 }) => glyph([
      h('path', { key: 'a', d: 'M19.5 12a7.5 7.5 0 1 1-2.3-5.4' }),
      h('path', { key: 'b', d: 'M19.8 5.2v4.4h-4.4' }),
    ], size)

    const IconTrash = ({ size = 16 }) => glyph([
      h('path', { key: 'a', d: 'M4.8 6.8h14.4M9.6 4.6h4.8M6.8 6.8l.9 12.2c.05.7.6 1.2 1.3 1.2h6c.7 0 1.25-.5 1.3-1.2l.9-12.2' }),
      h('path', { key: 'b', d: 'M10.4 10.4v6M13.6 10.4v6' }),
    ], size)

    const IconArchive = ({ size = 16 }) => glyph([
      h('rect', { key: 'a', x: 3.6, y: 5.2, width: 16.8, height: 4.2, rx: 1.2 }),
      h('path', { key: 'b', d: 'M5.2 9.4v8.2c0 .9.7 1.6 1.6 1.6h10.4c.9 0 1.6-.7 1.6-1.6V9.4' }),
      h('path', { key: 'c', d: 'M9.8 13.2h4.4' }),
    ], size)

    const IconPin = ({ size = 16 }) => glyph([
      h('path', { key: 'a', d: 'M9.2 3.9h5.6l-.7 4.3 3 3.3v1.4H6.9v-1.4l3-3.3-.7-4.3Z' }),
      h('path', { key: 'b', d: 'M12 12.9v7' }),
    ], size)

    const IconPencil = ({ size = 16 }) => glyph([
      h('path', { key: 'a', d: 'm5 19 .9-3.6L15.6 5.7a1.8 1.8 0 0 1 2.6 0l.9.9a1.8 1.8 0 0 1 0 2.6L8.6 18.1 5 19Z' }),
    ], size)

    const IconReveal = ({ size = 16 }) => glyph([
      h('path', { key: 'a', d: 'M4.4 9.2h6l1.9 1.9h7.3v7.3c0 .8-.6 1.4-1.4 1.4H5.8c-.8 0-1.4-.6-1.4-1.4V9.2Z' }),
      h('path', { key: 'b', d: 'm13.4 4.4 3.6 0 0 3.6M17 4.6l-3.6 3.6' }),
    ], size)

    const IconExternal = ({ size = 16 }) => glyph([
      h('path', { key: 'a', d: 'M13.6 5.2h5.2v5.2M18.6 5.4l-7 7' }),
      h('path', { key: 'b', d: 'M18.4 13.6v4c0 .9-.7 1.6-1.6 1.6H6.4c-.9 0-1.6-.7-1.6-1.6V7.2c0-.9.7-1.6 1.6-1.6h4' }),
    ], size)

    const IconCopy = ({ size = 16 }) => glyph([
      h('rect', { key: 'a', x: 8.4, y: 8.4, width: 11.2, height: 11.2, rx: 2 }),
      h('path', { key: 'b', d: 'M15.6 8.4V5.6c0-.6-.5-1.2-1.2-1.2H5.6c-.6 0-1.2.5-1.2 1.2v8.8c0 .6.5 1.2 1.2 1.2h2.8' }),
    ], size)

    // ------------------------------------------------------------------ css ---

    const MENU_CSS = `
.dsa-menu-root { position: fixed; z-index: 2147483000; }
.dsa-menu {
  min-width: 244px; max-width: 360px;
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px; padding: 4px;
  box-shadow: var(--dsw-shadow-lv2, 0 8px 24px rgba(0, 0, 0, .12));
  display: flex; flex-direction: column; gap: 1px;
  animation: dsa-menu-in 120ms ease-out;
}
@keyframes dsa-menu-in { from { opacity: 0; transform: translateY(-4px) } to { opacity: 1; transform: none } }
.dsa-menu-body { max-height: min(60vh, 420px); overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
.dsa-menu-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); padding: 4px 10px 2px; }
.dsa-menu-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  height: 32px; padding: 0 10px; border: 0; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; text-align: left; cursor: pointer;
}
.dsa-menu-item:hover, .dsa-menu-item[data-active="true"] { background: var(--dsw-alias-bg-layer-2) }
.dsa-menu-item:disabled { color: var(--dsw-alias-label-secondary); cursor: default }
.dsa-menu-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px }
.dsa-menu-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.dsa-menu-path { flex: 0 1 auto; max-width: 132px; font-size: 12px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.dsa-menu-check { flex: none; color: var(--dsw-alias-brand-primary); display: flex }
.dsa-menu-sep { height: 1px; background: var(--dsw-alias-border-l1); margin: 3px 6px }
.dsa-menu-error { display: flex; align-items: baseline; gap: 8px; padding: 3px 10px 5px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary) }
.dsa-menu-retry { border: 0; background: none; padding: 0; font: inherit; font-size: 12px; color: var(--dsw-alias-brand-primary); cursor: pointer }
`

    const PAGE_CSS = `
.dsa-page { display: flex; flex-direction: column; gap: 16px; padding: 2px 0 8px; max-width: 880px; }
.dsa-card {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-xl, 12px); padding: 16px;
  display: flex; flex-direction: column; gap: 12px;
}
.dsa-card-head { display: flex; align-items: center; gap: 8px }
.dsa-card-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary) }
.dsa-card-desc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary) }
.dsa-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap }
.dsa-grow { flex: 1 1 auto; min-width: 0 }
.dsa-input {
  height: 32px; padding: 0 10px; box-sizing: border-box; min-width: 0;
  border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; outline: none;
}
.dsa-input::placeholder { color: var(--dsw-alias-label-secondary) }
.dsa-input:focus-visible { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent) }
.dsa-input[data-invalid="true"] { border-color: var(--dsw-alias-state-error-primary) }
.dsa-input-num { width: 74px; text-align: right; font-variant-numeric: tabular-nums }
.dsa-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px;
  border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1);
  background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap;
}
.dsa-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2) }
.dsa-btn:disabled { opacity: .45; cursor: default }
.dsa-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px }
.dsa-btn[data-tone="primary"] {
  color: var(--dsw-alias-brand-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 42%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);
}
.dsa-btn[data-tone="danger"] {
  color: var(--dsw-alias-state-error-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 38%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
}
.dsa-btn[data-size="sm"] { height: 24px; font-size: 12px; padding: 0 8px }
.dsa-icon-btn {
  display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
  border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; padding: 0;
}
.dsa-icon-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary) }
.dsa-icon-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px }
.dsa-tag {
  display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 6px;
  border-radius: 4px; font-size: 11px; line-height: 18px; white-space: nowrap;
  background: color-mix(in srgb, var(--dsw-alias-state-idle-primary) 12%, transparent);
  color: var(--dsw-alias-state-idle-primary);
}
.dsa-tag[data-tone="success"] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); color: var(--dsw-alias-state-success-primary) }
.dsa-tag[data-tone="warn"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); color: var(--dsw-alias-state-warn-primary) }
.dsa-tag[data-tone="muted"] { background: color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent); color: var(--dsw-alias-label-secondary) }
.dsa-switch {
  position: relative; flex: none; width: 36px; height: 20px; padding: 0; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
  cursor: pointer; transition: background 120ms ease, border-color 120ms ease;
}
.dsa-switch::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: var(--dsw-alias-bg-overlay); box-shadow: var(--dsw-shadow-lv1, 0 1px 2px rgba(0, 0, 0, .28));
  transition: transform 120ms ease;
}
.dsa-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); border-color: transparent }
.dsa-switch[aria-checked="true"]::after { transform: translateX(16px) }
.dsa-switch:disabled { opacity: .45; cursor: default }
.dsa-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px }
.dsa-feature { display: flex; align-items: flex-start; gap: 12px; padding: 10px 0; border-top: 1px solid var(--dsw-alias-border-l1) }
.dsa-feature:first-of-type { border-top: 0; padding-top: 0 }
.dsa-feature-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px }
.dsa-feature-title { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary) }
.dsa-feature-desc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary) }
.dsa-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap }
.dsa-search { display: flex; align-items: center; gap: 6px; flex: 1 1 220px; min-width: 180px; height: 32px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary) }
.dsa-search input { flex: 1 1 auto; min-width: 0; border: 0; outline: none; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px }
.dsa-search:focus-within { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent) }
.dsa-segment { display: inline-flex; padding: 2px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1) }
.dsa-segment button {
  height: 24px; padding: 0 8px; border: 0; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.dsa-segment button[data-on="true"] { background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-shadow-lv1, 0 1px 2px rgba(0, 0, 0, .12)) }
.dsa-segment button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px }
.dsa-select {
  height: 32px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; cursor: pointer;
}
.dsa-list {
  display: flex; flex-direction: column; gap: 2px;
  max-height: min(52vh, 420px);
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-border-l2) transparent;
}
.dsa-list:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px }
.dsa-list::-webkit-scrollbar { width: 8px; height: 8px }
.dsa-list::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 28%, transparent);
  border: 2px solid transparent; border-radius: 999px; background-clip: padding-box;
}
.dsa-list::-webkit-scrollbar-track { background: transparent }
.dsa-list-head {
  position: sticky; top: 0; z-index: 2;
  background: var(--dsw-alias-bg-layer-1);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px 8px 0 0;
}
.dsa-list-head:hover { background: var(--dsw-alias-bg-layer-1) }
.dsa-group-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); padding: 10px 8px 4px }
.dsa-item-row {
  display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 0 8px;
  border-radius: 8px; color: var(--dsw-alias-label-primary);
}
.dsa-item-row:hover { background: var(--dsw-alias-bg-layer-2) }
.dsa-item-row[data-selected="true"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent) }
.dsa-check { width: 14px; height: 14px; margin: 0; accent-color: var(--dsw-alias-brand-primary); flex: none; cursor: pointer }
.dsa-item-title { flex: 1 1 200px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px }
.dsa-item-id { flex: none; font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; color: var(--dsw-alias-label-secondary) }
.dsa-item-size { flex: none; width: 72px; text-align: right; font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums }
.dsa-item-time { flex: none; width: 88px; text-align: right; font-size: 12px; color: var(--dsw-alias-label-secondary) }
.dsa-item-actions { flex: none; display: flex; align-items: center }
.dsa-empty { padding: 18px 8px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); text-align: center }
.dsa-bulk {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 10px; border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 26%, transparent);
  font-size: 12px; color: var(--dsw-alias-label-primary);
}
.dsa-error { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary) }
.dsa-note { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary) }
.dsa-details { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 10px }
.dsa-details summary { cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-secondary); list-style: none }
.dsa-details summary::-webkit-details-marker { display: none }
.dsa-details[open] summary { margin-bottom: 8px }
.dsa-facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary) }
.dsa-facts b { color: var(--dsw-alias-label-primary); font-weight: 500 }
.dsa-toast {
  position: sticky; bottom: 0; align-self: flex-start;
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 8px;
  background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1);
  font-size: 12px; color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-shadow-lv2, 0 6px 18px rgba(0, 0, 0, .12));
  animation: dsa-menu-in 120ms ease-out;
}
.dsa-overlay { position: fixed; inset: 0; z-index: 2147483100; background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, .28)); display: flex; align-items: center; justify-content: center; padding: 24px }
.dsa-dialog {
  width: min(420px, 100%); border-radius: 12px; padding: 18px;
  background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-shadow-lv2, 0 24px 60px rgba(0, 0, 0, .28)); display: flex; flex-direction: column; gap: 10px;
}
.dsa-dialog-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary) }
.dsa-dialog-body { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary) }
.dsa-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px }
.dsa-pop {
  position: fixed; z-index: 2147483000; min-width: 180px; padding: 4px;
  background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px; box-shadow: 0 8px 24px rgba(0, 0, 0, .12);
  display: flex; flex-direction: column; gap: 1px; animation: dsa-menu-in 120ms ease-out;
}
.dsa-pop-item {
  display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px;
  border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; text-align: left; width: 100%; cursor: pointer;
}
.dsa-pop-item:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2) }
.dsa-pop-item:disabled { color: var(--dsw-alias-label-secondary); cursor: default }
.dsa-pop-item[data-tone="danger"] { color: var(--dsw-alias-state-error-primary) }
.dsa-pop-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px }
@media (max-width: 720px) {
  .dsa-item-size, .dsa-item-time { display: none }
}
`

    // ---------------------------------------------------------------- atoms ---

    /**
     * A short semantic label chip.
     * @param props - `tone` and children.
     * @returns the chip.
     */
    function Tag({ tone, children }) {
      return h('span', { className: 'dsa-tag', 'data-tone': tone ?? 'idle' }, children)
    }

    /**
     * One switch row, keyboard and screen-reader complete.
     * @param props - `checked`, `disabled`, `onChange`, `label`.
     * @returns the switch button.
     */
    function Switch({ checked, disabled, onChange, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked === true,
        'aria-label': label,
        className: 'dsa-switch',
        disabled: disabled === true,
        onClick: () => { onChange(checked !== true) },
      })
    }

    /**
     * A modal confirmation/input dialog with Escape handling.
     * @param props - `title`, `body`, `confirmLabel`, `tone`, `onCancel`, `onConfirm`, `children`, `busy`.
     * @returns the dialog, or null.
     */
    function Dialog({ title, body, confirmLabel, tone, onCancel, onConfirm, children, busy }) {
      const dialogRef = useRef(null)
      const confirmRef = useRef(null)
      const cancelRef = useRef(null)
      const cancelLatest = useRef(onCancel)
      cancelLatest.current = onCancel
      useEffect(() => {
        const previous = document.activeElement
        const element = dialogRef.current
        const focusables = () => [...(element?.querySelectorAll('button, input, textarea, select, [href], [tabindex]:not([tabindex="-1"])') ?? [])]
          .filter(node => node.disabled !== true)
        // A field to fill wins over the buttons; a destructive dialog never
        // starts on its own confirm button.
        const field = element?.querySelector('input, textarea')
        if (field !== undefined && field !== null) field.focus()
        else if (tone === 'danger') cancelRef.current?.focus()
        else confirmRef.current?.focus()
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            cancelLatest.current()
            return
          }
          if (event.key !== 'Tab') return
          const items = focusables()
          if (items.length === 0) return
          const index = items.indexOf(document.activeElement)
          const next = event.shiftKey
            ? (index <= 0 ? items.length - 1 : index - 1)
            : (index === items.length - 1 || index < 0 ? 0 : index + 1)
          event.preventDefault()
          items[next]?.focus()
        }
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('keydown', onKey, true)
          if (previous !== null && previous !== undefined && typeof previous.focus === 'function') previous.focus()
        }
        // Mount-only: the owner recreates its callbacks on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      return ReactDOM.createPortal(h(React.Fragment, null,
        h('style', { key: 'style' }, PAGE_CSS),
        h('div', {
          key: 'overlay',
          className: 'dsa-overlay',
          onPointerDown: (event) => { if (event.target === event.currentTarget) onCancel() },
        }, h('div', {
          ref: dialogRef,
          className: 'dsa-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': title,
        },
        h('div', { className: 'dsa-dialog-title' }, title),
        body === undefined ? null : h('div', { className: 'dsa-dialog-body' }, body),
        children ?? null,
        h('div', { className: 'dsa-dialog-actions' },
          h('button', { ref: cancelRef, type: 'button', className: 'dsa-btn', onClick: onCancel }, RUNTIME.t('dialog.cancel')),
          h('button', {
            ref: confirmRef,
            type: 'button',
            className: 'dsa-btn',
            'data-tone': tone ?? 'primary',
            disabled: busy === true,
            onClick: onConfirm,
          }, confirmLabel),
        ),
        )),
      ), document.body)
    }

    /**
     * Position a popover against the chip, flipping above when the viewport is
     * short and clamping horizontally. Tracks scroll and resize.
     * @param anchor - anchor element (may be null).
     * @param open - whether the popover is open.
     * @param estimatedHeight - first-paint height estimate.
     * @param width - popover width.
     * @param onClose - called when the anchor leaves the viewport.
     * @returns `{top, left}` or null.
     */
    function useAnchoredBox(anchor, open, estimatedHeight, width, onClose) {
      const [box, setBox] = useState(null)
      useEffect(() => {
        if (!open || !anchor) {
          setBox(null)
          return undefined
        }
        const update = () => {
          const rect = anchor.getBoundingClientRect()
          if (rect.bottom < 4 || rect.top > window.innerHeight - 4 || rect.right < 4 || rect.left > window.innerWidth - 4) {
            setBox(null)
            onClose()
            return
          }
          const viewportWidth = window.innerWidth
          const viewportHeight = window.innerHeight
          const below = rect.bottom + 6
          const top = below + estimatedHeight > viewportHeight - 8
            ? Math.max(8, rect.top - 6 - estimatedHeight)
            : below
          const left = Math.max(8, Math.min(rect.left, viewportWidth - 8 - width))
          setBox({ top, left })
        }
        update()
        window.addEventListener('resize', update)
        window.addEventListener('scroll', update, true)
        return () => {
          window.removeEventListener('resize', update)
          window.removeEventListener('scroll', update, true)
        }
      }, [anchor, open, estimatedHeight, width, onClose])
      return box
    }

    /**
     * The blank-session workspace menu: real Workspaces, "Add workspace…", and
     * the plugin's "No workspace" entry.
     * @param props - slot owner props plus the standard workspace hook.
     * @returns the popover, or null while closed.
     */
    function distinguishingSuffixes(rows) {
      const groups = new Map()
      for (const row of rows) {
        const key = String(row.title || baseName(row.path) || '').toLowerCase()
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(row)
      }
      const suffixes = new Map()
      for (const group of groups.values()) {
        if (group.length < 2) continue
        const segments = new Map(group.map(row => [row.id, trimPath(row.path).split('/').filter(Boolean)]))
        for (const row of group) {
          const parts = segments.get(row.id) ?? []
          const others = group.filter(other => other !== row)
          let depth = 1
          let suffix = parts.slice(-depth).join('/')
          while (depth < parts.length && others.some(other => (segments.get(other.id) ?? []).slice(-depth).join('/') === suffix)) {
            depth += 1
            suffix = parts.slice(-depth).join('/')
          }
          suffixes.set(row.id, `…/${suffix}`)
        }
      }
      return suffixes
    }

    /**
     * The blank-session workspace menu: real Workspaces, "Add workspace…", and
     * the plugin's "No workspace" entry.
     * @param props - slot owner props plus the standard workspace hook.
     * @returns the popover, or null while closed.
     */
    function WorkspaceMenu(props) {
      const { open, anchorRef, selectedId, onPick, onClose } = props
      const [t, active] = useT()
      const storeState = useStore()
      const status = storeState.status
      const hostDown = status === null && storeState.statusError !== null
      const items = props.useWorkspaces(state => state.items)
      const phase = props.useWorkspaces(state => state.phase)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [activeIndex, setActiveIndex] = useState(0)
      const [anchorEl, setAnchorEl] = useState(null)
      const busyRef = useRef(false)
      const retryRef = useRef(null)
      const menuRef = useRef(null)

      const rows = useMemo(() => {
        const list = []
        for (const workspace of items) {
          if (isScratchCwd(workspace.path)) continue
          const title = workspace.title === '' ? baseName(workspace.path) : workspace.title
          list.push({
            kind: 'workspace',
            id: String(workspace.workspaceId),
            title,
            path: workspace.path,
            selected: selectedId !== undefined && String(selectedId) === String(workspace.workspaceId),
          })
        }
        const suffixes = distinguishingSuffixes(list)
        for (const row of list) row.suffix = suffixes.get(row.id)
        list.push({ kind: 'add', id: '::add' })
        list.push({ kind: 'scratch', id: '::scratch', root: status?.root ?? '', home: status?.home })
        return list
      }, [items, selectedId, status?.root, status?.home])

      const estimatedHeight = 8 + (rows.length + 1) * 33 + (error === null ? 0 : 26) + 14
      const box = useAnchoredBox(anchorEl, open === true, estimatedHeight, 336, onClose)

      useEffect(() => {
        setAnchorEl(open === true ? (anchorRef?.current ?? null) : null)
      }, [open, anchorRef])

      useEffect(() => {
        if (open !== true) return undefined
        setActiveIndex(0)
        setError(null)
        retryRef.current = null
        const timer = setTimeout(() => { menuRef.current?.focus?.() }, 0)
        return () => clearTimeout(timer)
      }, [open])

      useEffect(() => {
        if (open !== true) return undefined
        const onDown = (event) => {
          if (busyRef.current) return
          const target = event.target
          if (menuRef.current?.contains(target)) return
          if (anchorRef?.current?.contains?.(target) === true) return
          onClose()
        }
        document.addEventListener('pointerdown', onDown, true)
        return () => document.removeEventListener('pointerdown', onDown, true)
      }, [open, anchorRef, onClose])

      /**
       * Run one menu row: a workspace pick, the directory flow, or a scratch
       * conversation. Failures stay in the menu with the failing row kept for
       * the retry, so retrying never performs a different action.
       */
      const choose = useCallback(async (row) => {
        if (busyRef.current || row === undefined) return
        const ctx = RUNTIME.ctx
        if (row.kind === 'workspace') {
          void RUNTIME.rememberPick('workspace')
          onClose()
          onPick(row.id)
          return
        }
        busyRef.current = true
        setBusy(true)
        setError(null)
        try {
          if (row.kind === 'add') {
            const ui = ctx.get('uiWorkspace')
            const workspaces = ctx.get('workspaces')
            if (!ui || !workspaces) throw new Error(t('menu.hostUnavailable'))
            const path = await ui.pickDirectory()
            if (path === null || path === undefined) return
            const view = await workspaces.create({ path })
            void RUNTIME.rememberPick('workspace')
            onClose()
            onPick(String(view.workspaceId))
            return
          }
          // Navigate before dismissing: a failed open must stay visible.
          await RUNTIME.startScratch(active)
          onClose()
        } catch (cause) {
          retryRef.current = row
          setError(messageOf(cause))
        } finally {
          busyRef.current = false
          setBusy(false)
        }
      }, [active, onClose, onPick, t])

      const enabledRows = rows

      useEffect(() => {
        if (open !== true) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') {
            if (busyRef.current) return
            event.preventDefault()
            event.stopPropagation()
            onClose()
            anchorRef?.current?.focus?.()
            return
          }
          if (event.key === 'Tab') {
            if (!busyRef.current) onClose()
            return
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActiveIndex(index => (index + 1) % enabledRows.length)
            return
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActiveIndex(index => (index - 1 + enabledRows.length) % enabledRows.length)
            return
          }
          if (event.key === 'Home') {
            event.preventDefault()
            setActiveIndex(0)
            return
          }
          if (event.key === 'End') {
            event.preventDefault()
            setActiveIndex(enabledRows.length - 1)
            return
          }
          if (event.key === 'Enter') {
            event.preventDefault()
            void choose(enabledRows[activeIndex])
          }
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [open, activeIndex, enabledRows, choose, onClose, anchorRef])

      if (open !== true || box === null) return null

      const itemId = index => `dsa-menu-item-${index}`
      const body = []
      const scratchIndex = rows.findIndex(row => row.kind === 'scratch')
      const scratchAvailable = hostDown !== true
      const activeId = enabledRows.length === 0 ? undefined : itemId(Math.min(activeIndex, enabledRows.length - 1))

      if (phase !== 'ready' && items.length === 0) {
        body.push(h('div', { key: 'loading', className: 'dsa-menu-label' }, t('menu.loading')))
      }
      let workspaceCount = 0
      rows.forEach((row, index) => {
        if (row.kind !== 'workspace') return
        workspaceCount += 1
        body.push(h('button', {
          key: row.id,
          id: itemId(index),
          type: 'button',
          role: 'menuitem',
          className: 'dsa-menu-item',
          title: row.path,
          'data-active': index === activeIndex ? 'true' : undefined,
          disabled: busy,
          onPointerEnter: () => setActiveIndex(index),
          onClick: () => { void choose(row) },
        },
        h(IconFolder, { size: 16, key: 'i' }),
        h('span', { key: 't', className: 'dsa-menu-title' }, row.title),
        row.suffix === undefined
          ? null
          : h('span', { key: 's', className: 'dsa-menu-path' }, row.suffix),
        row.selected ? h('span', { key: 'c', className: 'dsa-menu-check' }, h(IconCheck, { size: 16 })) : null,
        ))
      })
      if (workspaceCount === 0 && phase === 'ready') {
        body.push(h('div', { key: 'empty', className: 'dsa-menu-label' }, t('menu.empty')))
      }

      const footer = []
      footer.push(h('div', { key: 'sep', className: 'dsa-menu-sep' }))
      footer.push(h('button', {
        key: 'add',
        id: itemId(rows.length - 2),
        type: 'button',
        role: 'menuitem',
        className: 'dsa-menu-item',
        'data-active': rows.length - 2 === activeIndex ? 'true' : undefined,
        disabled: busy,
        onPointerEnter: () => setActiveIndex(rows.length - 2),
        onClick: () => { void choose(rows[rows.length - 2]) },
      }, h(IconPlus, { size: 16, key: 'i' }), h('span', { key: 't', className: 'dsa-menu-title' }, t('menu.add'))))
      footer.push(h('button', {
        key: 'scratch',
        id: itemId(scratchIndex),
        type: 'button',
        role: 'menuitem',
        className: 'dsa-menu-item',
        'data-active': scratchIndex === activeIndex ? 'true' : undefined,
        disabled: busy || !scratchAvailable,
        title: hostDown ? t('menu.hostDown') : undefined,
        onPointerEnter: () => setActiveIndex(scratchIndex),
        onClick: () => { void choose(rows[scratchIndex]) },
      },
      h(IconSpark, { size: 16, key: 'i' }),
      h('span', { key: 't', className: 'dsa-menu-title' }, busy ? t('menu.preparing') : t('menu.scratch')),
      scratchAvailable && rows[scratchIndex].root !== ''
        ? h('span', { key: 'p', className: 'dsa-menu-path' }, shortPath(rows[scratchIndex].root, rows[scratchIndex].home))
        : null,
      ))

      return ReactDOM.createPortal(h(React.Fragment, null,
        h('style', { key: 'style' }, MENU_CSS),
        h('div', {
          key: 'root',
          className: 'dsa-menu-root',
          style: { top: `${box.top}px`, left: `${box.left}px` },
        }, h('div', {
          ref: menuRef,
          tabIndex: -1,
          className: 'dsa-menu',
          role: 'menu',
          'aria-label': t('menu.section'),
          'aria-activedescendant': activeId,
          style: { width: '336px' },
        },
        h('div', { className: 'dsa-menu-label' }, t('menu.section')),
        h('div', { className: 'dsa-menu-body' }, ...body),
        ...footer,
        hostDown
          ? h('div', { key: 'down', className: 'dsa-menu-error' }, h('span', { className: 'dsa-grow' }, t('menu.hostDown')))
          : null,
        error === null
          ? null
          : h('div', { key: 'err', className: 'dsa-menu-error' },
            h('span', { key: 'm', className: 'dsa-grow' }, error),
            h('button', {
              key: 'r',
              type: 'button',
              className: 'dsa-menu-retry',
              disabled: busy,
              onClick: () => { setError(null); void choose(retryRef.current ?? rows[scratchIndex]) },
            }, t('menu.retry')),
          ),
        )),
      ), document.body)
    }

    /**
     * Wait until the client workspace list shows the given session, so the hero
     * chip resolves its title on the first render after navigation.
     * @param sessionId - session that must appear in a workspace account.
     * @param timeoutMs - upper bound.
     * @returns resolution once seen or timed out.
     */
    function waitForWorkspace(sessionId, timeoutMs = 2500) {
      const ctx = RUNTIME.ctx
      const workspaces = ctx?.get?.('workspaces')
      if (!workspaces?.list) return Promise.resolve()
      return new Promise((resolve) => {
        let unsubscribe = null
        let timer = null
        let finished = false
        const finish = () => {
          if (finished) return
          finished = true
          if (timer !== null) clearTimeout(timer)
          if (unsubscribe !== null) unsubscribe()
          resolve()
        }
        const check = () => {
          const snapshot = workspaces.list.getSnapshot()
          if ((snapshot?.items ?? []).some(item => (item.sessionIds ?? []).includes(sessionId))) finish()
        }
        timer = setTimeout(finish, timeoutMs)
        unsubscribe = workspaces.list.subscribe(check)
        check()
      })
    }

    // ------------------------------------------------- remember last choice ---

    /**
     * Whether one workspace id is a temporary scratch registration.
     * @param workspaceId - workspace id passed to New Session.
     * @returns true when that workspace's folder is a scratch folder.
     */
    function isScratchWorkspace(workspaceId) {
      const workspaces = RUNTIME.ctx?.get?.('workspaces')
      const row = (workspaces?.list?.getSnapshot?.()?.items ?? [])
        .find(item => String(item.workspaceId) === String(workspaceId))
      return row !== undefined && isScratchCwd(row.path)
    }

    /**
     * Wrap the shared New Session action (sidebar button, titlebar button, ⌘N)
     * so the last choice survives into the next conversation. Only a plain
     * request — no draft options — is intercepted, and an explicit real
     * workspace always keeps DSH's "current workspace" order; a scratch
     * workspace id becomes a fresh conversation so two conversations never
     * share one folder. Any failure falls back to DSH's own order.
     * @param navigation - the `uiWorkspace` service.
     * @returns a disposer restoring the original method.
     */
    function installNewSessionDefault(navigation) {
      if (navigation === null || typeof navigation !== 'object') return () => {}
      const original = navigation.startSession
      if (typeof original !== 'function') return () => {}
      let starting = false

      /**
       * Run the scratch flow for one intercepted click.
       * @returns undefined, matching `startSession`'s void contract.
       */
      const beginScratch = () => {
        starting = true
        const locale = RUNTIME.ctx?.locale?.getSnapshot?.()?.active ?? 'en'
        void RUNTIME.startScratch(locale).catch((error) => {
          console.warn('session-autospace: scratch start failed, using the normal New Session:', error)
          original.call(navigation)
        }).finally(() => { starting = false })
        return undefined
      }

      const wrapped = function startSession(workspaceId, options) {
        try {
          const explicit = workspaceId !== undefined && workspaceId !== null
          if (explicit) {
            const scratch = typeof RUNTIME.startScratch === 'function' && isScratchWorkspace(workspaceId)
            if (scratch && options === undefined) {
              const status = store.get().status
              const config = status?.config
              const enabled = status !== null && status !== undefined
                && (config === undefined || (config.pickerEntry !== false && config.rememberPick !== false))
              if (enabled) return starting ? undefined : beginScratch()
            }
            if (!scratch) void RUNTIME.rememberPick('workspace')
            return original.call(this, workspaceId, options)
          }
          if (options !== undefined) return original.call(this, workspaceId, options)
          if (starting) return undefined
          const status = store.get().status
          if (status === null || status === undefined) return original.call(this, workspaceId, options)
          const config = status.config
          if (config !== undefined && (config.pickerEntry === false || config.rememberPick === false)) {
            return original.call(this, workspaceId, options)
          }
          if (typeof RUNTIME.startScratch !== 'function') return original.call(this, workspaceId, options)
          const current = currentWorkspace()
          if (current !== undefined && current.scratch !== true) return original.call(this, workspaceId, options)
          if (current === undefined && status.lastPick !== 'scratch') return original.call(this, workspaceId, options)
          return beginScratch()
        } catch (error) {
          starting = false
          console.warn('session-autospace: New Session default fell through:', error)
          return original.call(navigation, workspaceId, options)
        }
      }
      try {
        if (typeof Object.isExtensible === 'function' && !Object.isExtensible(navigation)) return () => {}
        navigation.startSession = wrapped
      } catch {
        return () => {}
      }
      return () => {
        // `navigation` is the service proxy: the own property landed on the
        // service object, so drop it and let the prototype method show again.
        const own = Object.getOwnPropertyDescriptor(navigation, 'startSession')
        if (own === undefined || own.value !== wrapped) return
        try {
          delete navigation.startSession
        } catch {
          navigation.startSession = original
        }
      }
    }

    // ------------------------------------------------------------ page atoms ---

    /**
     * One settings card.
     * @param props - `title`, `description`, `actions`, children.
     * @returns the card.
     */
    function Card({ title, description, actions, children }) {
      return h('section', { className: 'dsa-card' },
        h('div', { className: 'dsa-card-head' },
          h('div', { className: 'dsa-card-title dsa-grow' }, title),
          actions ?? null,
        ),
        description === undefined ? null : h('div', { className: 'dsa-card-desc' }, description),
        children,
      )
    }

    /**
     * One switch row inside the Features card.
     * @param props - `title`, `description`, `checked`, `disabled`, `onChange`.
     * @returns the row.
     */
    function FeatureRow({ title, description, checked, disabled, onChange }) {
      return h('div', { className: 'dsa-feature' },
        h('div', { className: 'dsa-feature-main' },
          h('div', { className: 'dsa-feature-title' }, title),
          h('div', { className: 'dsa-feature-desc' }, description),
        ),
        h(Switch, { checked, disabled, onChange, label: title }),
      )
    }

    // -------------------------------------------------------- scratch manager ---

    /**
     * Join the client session list with the Host folder inventory.
     * @param sessions - client session list state.
     * @param workspacesState - client workspace snapshot.
     * @param inventory - Host folder facts.
     * @returns rows sorted by updated time.
     */
    function buildRows(sessions, workspacesState, inventory) {
      const archived = new Set((workspacesState?.archivedSessionIds ?? []).map(String))
      const pinned = new Set((workspacesState?.pinnedSessionIds ?? []).map(String))
      const folders = new Map((inventory?.folders ?? []).map(folder => [String(folder.id), folder]))
      const rows = []
      for (const id of sessions.ids) {
        const summary = sessions.byId[id]
        if (summary === undefined) continue
        if (!isScratchCwd(summary.cwd)) continue
        const folder = folders.get(String(id))
        rows.push({
          id: String(id),
          title: typeof summary.title === 'string' && summary.title !== '' ? summary.title : undefined,
          displayTitle: summary.displayTitle,
          blank: summary.blank === true,
          running: summary.running === true,
          updatedAt: Number(summary.updatedAt) || 0,
          cwd: summary.cwd,
          archived: archived.has(String(id)),
          pinned: pinned.has(String(id)),
          folder,
          exists: folder === undefined ? undefined : folder.exists !== false,
        })
      }
      return rows
    }

    /**
     * One row's action popover.
     * @param props - `anchor`, `row`, `t`, `onClose`, `onSelect`.
     * @returns the popover.
     */
    function RowMenu({ anchor, row, t, onClose, onSelect }) {
      const popRef = useRef(null)
      const firstRef = useRef(null)
      const closeLatest = useRef(onClose)
      closeLatest.current = onClose
      const box = useAnchoredBox(anchor, true, 268, 208, onClose)
      useEffect(() => {
        const timer = setTimeout(() => { firstRef.current?.focus?.() }, 0)
        const onDown = (event) => {
          if (popRef.current?.contains(event.target)) return
          if (anchor?.contains?.(event.target) === true) return
          closeLatest.current()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            closeLatest.current()
            anchor?.focus?.()
            return
          }
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          const items = [...(popRef.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') ?? [])]
          if (items.length === 0) return
          event.preventDefault()
          const index = items.indexOf(document.activeElement)
          const next = event.key === 'ArrowDown'
            ? (index === items.length - 1 || index < 0 ? 0 : index + 1)
            : (index <= 0 ? items.length - 1 : index - 1)
          items[next]?.focus()
        }
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          clearTimeout(timer)
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
        // Mount-only: the owning page recreates its callbacks on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      if (box === null) return null
      const items = [
        { id: 'open', label: t('action.open'), icon: IconExternal },
        { id: 'rename', label: t('action.rename'), icon: IconPencil },
        { id: row.pinned ? 'unpin' : 'pin', label: row.pinned ? t('action.unpin') : t('action.pin'), icon: IconPin },
        {
          id: 'archive',
          label: row.archived
            ? t('action.unarchive')
            : row.running ? t('action.archiveRunning') : t('action.archive'),
          icon: IconArchive,
        },
        { id: 'reveal', label: t('action.reveal'), icon: IconReveal, disabled: row.exists === false },
        { id: 'copy', label: t('action.copyPath'), icon: IconCopy },
        { id: 'trash', label: t('action.trash'), icon: IconTrash, tone: 'danger', disabled: row.exists === false },
      ]
      return ReactDOM.createPortal(h(React.Fragment, null,
        h('style', { key: 'style' }, PAGE_CSS),
        h('div', {
          key: 'pop',
          ref: popRef,
          className: 'dsa-pop',
          role: 'menu',
          style: { top: `${box.top}px`, left: `${box.left}px` },
        }, ...items.map((item, index) => h('button', {
          key: item.id,
          ref: index === 0 ? firstRef : undefined,
          type: 'button',
          role: 'menuitem',
          className: 'dsa-pop-item',
          'data-tone': item.tone,
          disabled: item.disabled === true,
          onClick: () => { onSelect(item.id) },
        }, h(item.icon, { size: 16, key: 'i' }), h('span', { key: 'l' }, item.label)))),
      ), document.body)
    }

    /**
     * The bundle's settings entry: a one-line summary for the row, the full page
     * for the bundle page.
     * @param props - slot props (`view`).
     * @returns the requested view.
     */
    function ConfigEntry(props) {
      const [t] = useT()
      const state = useStore()
      const status = state.status
      if (props.view === 'summary') {
        if (status === null) return h(React.Fragment, null, t('path.title'))
        const root = status.configured ? status.root : status.defaultRoot
        return h(React.Fragment, null, `${t('path.title')}: ${root}`)
      }
      return h(SettingsPage, { useSessions: props.useSessions, useWorkspaces: props.useWorkspaces })
    }

    /**
     * The full settings page: working path, feature switches, and the manager.
     * @param props - standard slot hooks.
     * @returns the page.
     */
    function SettingsPage(props) {
      const [t] = useT()
      const state = useStore()
      const status = state.status
      const inventory = state.inventory
      const sessions = props.useSessions(snapshot => snapshot)
      const workspacesState = props.useWorkspaces(snapshot => snapshot)
      const root = status?.root
      const config = status?.config
      const hostDown = state.statusError !== null

      const [draftRoot, setDraftRoot] = useState(null)
      const [pathMessage, setPathMessage] = useState(null)
      const [draftProbe, setDraftProbe] = useState(null)
      const [pathError, setPathError] = useState(null)
      const [hoursDraft, setHoursDraft] = useState(null)
      const [query, setQuery] = useState('')
      const [filter, setFilter] = useState('all')
      const [sort, setSort] = useState('updated')
      const [selected, setSelected] = useState(() => new Set())
      const [dialog, setDialog] = useState(null)
      const [dialogBusy, setDialogBusy] = useState(false)
      const [menuFor, setMenuFor] = useState(null)
      const [maintenanceNote, setMaintenanceNote] = useState(null)
      const [busyAction, setBusyAction] = useState(false)

      useEffect(() => {
        void refreshStatus()
        void refreshInventory()
      }, [])

      useEffect(() => {
        if (config === undefined) return
        setDraftRoot(current => (current === null ? config.workspaceRoot : current))
        setHoursDraft(current => (current === null ? String(config.autoReclaimHours) : current))
      }, [config?.workspaceRoot, config?.autoReclaimHours])

      const rows = useMemo(
        () => buildRows(sessions, workspacesState, inventory),
        [sessions, workspacesState, inventory],
      )

      const searchTerm = useDebounced(query.trim().toLowerCase(), 250)

      const visible = useMemo(() => {
        const missing = rows.filter(row => row.exists === false).length
        let list = rows
        if (searchTerm !== '') {
          list = list.filter(row => row.title.toLowerCase().includes(searchTerm)
            || row.id.toLowerCase().includes(searchTerm)
            || String(row.cwd ?? '').toLowerCase().includes(searchTerm))
        }
        if (filter === 'active') list = list.filter(row => row.running && !row.archived)
        else if (filter === 'blank') list = list.filter(row => row.blank && !row.archived)
        else if (filter === 'archived') list = list.filter(row => row.archived)
        else if (filter === 'missing') list = list.filter(row => row.exists === false)
        const sorted = [...list]
        if (sort === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title))
        else if (sort === 'size') sorted.sort((a, b) => (b.folder?.bytes ?? 0) - (a.folder?.bytes ?? 0))
        else sorted.sort((a, b) => b.updatedAt - a.updatedAt)
        return { list: sorted, missing }
      }, [rows, searchTerm, filter, sort, t])

      const groups = useMemo(() => groupRows(visible.list, t), [visible.list, t])

      const totalBytes = useMemo(() => rows.reduce((sum, row) => sum + (row.folder?.bytes ?? 0), 0), [rows])
      const blankCount = useMemo(() => rows.filter(row => row.blank && !row.archived).length, [rows])

      const reclaimHours = config?.autoReclaimHours ?? 24
      const thresholdMs = (reclaimHours > 0 ? reclaimHours : 24) * 3_600_000
      const reclaimIds = useMemo(
        () => rows.filter(row => row.blank && !row.archived && Date.now() - row.updatedAt > thresholdMs).map(row => row.id),
        [rows, thresholdMs],
      )
      const orphans = useMemo(() => (inventory?.orphans ?? []).map(String), [inventory])
      const missingIds = useMemo(() => rows.filter(row => row.exists === false).map(row => row.id), [rows])

      /**
       * Write one config patch, confirming it landed before reporting success.
       * @param patch - fields to write.
       * @returns true when the Host reports the new values.
       */
      const applyPatch = useCallback(async (patch) => {
        const ok = await saveConfig(patch)
        if (ok) notify(t('toast.done'))
        return ok
      }, [t])

      /**
       * Commit the working-path input.
       */
      const commitPath = useCallback(async () => {
        const value = (draftRoot ?? '').trim()
        if (value !== '' && !value.startsWith('/') && !value.startsWith('~/')) {
          setPathError(t('path.invalid'))
          return
        }
        setPathError(null)
        if (value === (config?.workspaceRoot ?? '')) {
          setPathMessage(t('path.saved'))
          return
        }
        setPathMessage(t('path.saving'))
        try {
          await request('/config', { patch: { workspaceRoot: value } })
        } catch {
          // A config write restarts the plugin, so the response may be lost.
        }
        const landed = await waitForConfig({ workspaceRoot: value }, 6000)
        await refreshInventory(true)
        const fresh = await refreshStatus()
        if (landed) {
          setPathMessage(t('path.saved'))
          notify(t('path.saved'))
        } else {
          setPathMessage(null)
          const reason = store.get().configError?.message ?? fresh?.rootError?.message ?? ''
          setPathError(`${t('path.createFailed')}. ${reason}`.trim())
        }
      }, [config?.workspaceRoot, draftRoot, t])

      /**
       * Pick a directory for the working path.
       */
      const choosePath = useCallback(async () => {
        const ui = RUNTIME.ctx.get('uiWorkspace')
        if (!ui) {
          setPathError(t('menu.hostUnavailable'))
          return
        }
        try {
          const picked = await ui.pickDirectory()
          if (picked !== null && picked !== undefined) {
            setDraftRoot(picked)
            setPathError(null)
            setPathMessage(null)
          }
        } catch (error) {
          setPathError(messageOf(error))
        }
      }, [t])

      // Probe a candidate the user typed: existence, writability, and whether
      // project instructions above it would apply to every conversation.
      useEffect(() => {
        const value = (draftRoot ?? '').trim()
        if (value === '' || value === (config?.workspaceRoot ?? '')) {
          setDraftProbe(null)
          return undefined
        }
        let cancelled = false
        const timer = setTimeout(() => {
          void request('/probe', { path: value })
            .then((value) => { if (!cancelled) setDraftProbe(value) })
            .catch((error) => { if (!cancelled) setDraftProbe({ error: messageOf(error) }) })
        }, 350)
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [draftRoot, config?.workspaceRoot])

      /**
       * Reveal the effective working path in the desktop file manager.
       */
      const revealRoot = useCallback(async () => {
        try {
          await request('/reveal', { path: status?.root ?? '' })
          notify(t('toast.revealed'))
        } catch (error) {
          notify(messageOf(error))
        }
      }, [status?.root, t])

      /**
       * Flip one feature switch.
       * @param key - config field.
       * @param next - requested value.
       */
      const toggleFeature = useCallback(async (key, next) => {
        setBusyAction(true)
        await applyPatch({ [key]: next })
        setBusyAction(false)
      }, [applyPatch])

      /**
       * Commit the reclaim threshold.
       */
      const commitHours = useCallback(async () => {
        const parsed = Number(hoursDraft)
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 8760) {
          setHoursDraft(String(config?.autoReclaimHours ?? 24))
          return
        }
        if (Math.round(parsed) === config?.autoReclaimHours) return
        setBusyAction(true)
        await applyPatch({ autoReclaimHours: Math.round(parsed) })
        setBusyAction(false)
      }, [applyPatch, config?.autoReclaimHours, hoursDraft])

      /**
       * Human label for one row, matching the list cell.
       * @param row - row model.
       * @returns the label.
       */
      const labelOf = useCallback(
        row => (row.title ?? (row.blank ? t('row.new') : row.displayTitle)),
        [t],
      )

      /**
       * Report what a delete did: archived, folder moved, or folder kept.
       * @param result - the Host's delete value.
       */
      const reportDelete = useCallback((result) => {
        if (result === undefined) return
        if (result.trashed === true) { notify(t('toast.done')); return }
        if (result.kept === true) { notify(t('toast.trashSkipped')); return }
        if (typeof result.trashError === 'string') notify(t('toast.trashLeft', { reason: result.trashError }))
      }, [t])

      /**
       * Run the open confirmation dialog.
       */
      const runDialog = useCallback(async () => {
        if (dialog === null) return
        setDialogBusy(true)
        try {
          if (dialog.kind === 'rename') {
            const title = String(dialog.value ?? '').trim()
            if (title !== '' && title !== dialog.row.title) await RUNTIME.op(dialog.row.id, 'rename', title)
          } else if (dialog.kind === 'trash') {
            const result = await RUNTIME.trash(dialog.row.id)
            reportDelete(result)
            setSelected(current => without(current, dialog.row.id))
          } else if (dialog.kind === 'bulkTrash') {
            const deleted = []
            for (const id of dialog.ids) deleted.push(await RUNTIME.trash(id))
            setSelected(new Set())
            const kept = deleted.filter(result => result !== undefined && result.trashed !== true).length
            if (kept === 0) notify(t('toast.done'))
            else notify(t('toast.trashLeft', { reason: t('bulk.keptFolders', { n: kept }) }))
          } else if (dialog.kind === 'archiveRunning') {
            await RUNTIME.op(dialog.row.id, 'archive')
          } else if (dialog.kind === 'reclaim') {
            const result = await RUNTIME.maintain('reclaimBlank', dialog.ids)
            setMaintenanceNote(t('maintain.result', { changed: result.changed.length, skipped: result.skipped.length }))
          } else if (dialog.kind === 'orphans') {
            const result = await RUNTIME.maintain('orphans', dialog.ids)
            setMaintenanceNote(t('maintain.result', { changed: result.changed.length, skipped: result.skipped.length }))
          }
          setDialog(null)
        } catch (error) {
          notify(messageOf(error))
        } finally {
          setDialogBusy(false)
          void refreshStatus()
          void refreshInventory(true)
        }
      }, [dialog, reportDelete, t])

      /**
       * Apply one bulk operation without a confirmation step (both are reversible).
       * @param ids - selected ids.
       * @param op - archive or unarchive.
       */
      const runBulk = useCallback(async (ids, op) => {
        setBusyAction(true)
        try {
          for (const id of ids) await RUNTIME.op(id, op)
          setSelected(new Set())
          void refreshStatus()
        } catch (error) {
          notify(messageOf(error))
        } finally {
          setBusyAction(false)
        }
      }, [])

      /**
       * Run one row action.
       * @param row - row model.
       * @param action - action id.
       */
      const onRowAction = useCallback(async (row, action) => {
        setMenuFor(null)
        try {
          if (action === 'open') {
            RUNTIME.ctx.uiWorkspace.openSession(row.id)
            return
          }
          if (action === 'rename') {
            setDialog({ kind: 'rename', row, value: row.title ?? '' })
            return
          }
          if (action === 'reveal') {
            await RUNTIME.reveal(row.id)
            notify(t('toast.revealed'))
            return
          }
          if (action === 'copy') {
            try {
              await navigator.clipboard.writeText(String(row.cwd ?? ''))
              notify(t('toast.copied'))
            } catch {
              notify(String(row.cwd ?? ''))
            }
            return
          }
          if (action === 'trash') {
            setDialog({ kind: 'trash', row })
            return
          }
          if (action === 'archive') {
            if (row.archived) {
              await RUNTIME.op(row.id, 'unarchive')
              void refreshStatus()
              return
            }
            if (row.running) {
              setDialog({ kind: 'archiveRunning', row })
              return
            }
          }
          await RUNTIME.op(row.id, action)
          void refreshStatus()
        } catch (error) {
          notify(messageOf(error))
        }
      }, [t])

      const selectedIds = useMemo(
        () => [...selected].filter(id => rows.some(row => row.id === id)).slice(0, MAX_BULK),
        [selected, rows],
      )

      const allSelected = visible.list.length > 0 && visible.list.every(row => selected.has(row.id))

      const toggleSelected = useCallback((id) => {
        setSelected((current) => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else if (next.size < MAX_BULK) next.add(id)
          return next
        })
      }, [])

      const selectAllVisible = useCallback(() => {
        setSelected((current) => {
          const next = new Set(current)
          if (visible.list.every(row => next.has(row.id)) && visible.list.length > 0) {
            for (const row of visible.list) next.delete(row.id)
            return next
          }
          for (const row of visible.list) {
            if (next.size >= MAX_BULK) break
            next.add(row.id)
          }
          return next
        })
      }, [visible.list])

      if (status === null) {
        return h('div', { className: 'dsa-page' },
          h('style', { key: 'style' }, PAGE_CSS),
          h('section', { key: 'card', className: 'dsa-card' },
            h('div', { className: 'dsa-card-title' }, t('path.title')),
            h('div', { className: 'dsa-card-desc' }, state.statusError === null ? t('page.loading') : t('error.host')),
            state.statusError === null ? null : h('button', {
              type: 'button',
              className: 'dsa-btn',
              onClick: () => { void refreshStatus() },
            }, t('menu.retry')),
          ),
        )
      }

      const draftValue = draftRoot ?? config?.workspaceRoot ?? ''
      const pathDirty = draftValue !== (config?.workspaceRoot ?? '')
      const inheritWarning = (() => {
        const value = trimPath(draftValue)
        if (value === '') return false
        const probe = draftProbe !== null && draftProbe !== undefined && draftProbe.error === undefined
          ? draftProbe
          : undefined
        const project = probe === undefined
          ? (draftValue === (config?.workspaceRoot ?? '') ? status.projectRoot : null)
          : probe.projectRoot
        if (typeof project === 'string' && project !== '') {
          const projectPath = trimPath(project)
          return value === projectPath || value.startsWith(`${projectPath}/`)
        }
        return (workspacesState.items ?? []).some(item => value === trimPath(item.path))
      })()

      const pathCard = h(Card, {
        key: 'path',
        title: t('path.title'),
        description: t('path.desc'),
        actions: (config?.workspaceRoot ?? '') === '' ? h(Tag, { tone: 'muted' }, t('path.default')) : null,
      },
      h('div', { key: 'label', className: 'dsa-label' }, t('path.effective')),
      h('div', { key: 'row', className: 'dsa-row' },
        h('input', {
          className: 'dsa-input dsa-grow',
          value: draftValue,
          placeholder: status.defaultRoot,
          spellCheck: false,
          autoCapitalize: 'off',
          autoCorrect: 'off',
          'aria-label': t('path.title'),
          'data-invalid': pathError === null ? undefined : 'true',
          onChange: (event) => { setDraftRoot(event.target.value); setPathError(null); setPathMessage(null) },
          onKeyDown: (event) => {
            // Committing on Enter or Save only: a blur after clicking "Choose…"
            // must not write the half-typed path.
            if (event.key === 'Enter') { event.preventDefault(); void commitPath() }
          },
        }),
        h('button', { type: 'button', className: 'dsa-btn', onClick: () => { void choosePath() } }, t('path.choose')),
        h('button', {
          type: 'button',
          className: 'dsa-btn',
          disabled: hostDown === true,
          onClick: () => { void revealRoot() },
        }, h(IconReveal, { size: 14 }), t('path.reveal')),
        h('button', {
          type: 'button',
          className: 'dsa-btn',
          disabled: (config?.workspaceRoot ?? '') === '',
          onClick: () => {
            setDraftRoot('')
            setPathError(null)
            setPathMessage(t('path.saving'))
            void saveConfig({ workspaceRoot: '' }).then((ok) => {
              setPathMessage(ok ? t('path.saved') : null)
              if (ok) notify(t('path.saved'))
            })
          },
        }, t('path.reset')),
        h('button', {
          type: 'button',
          className: 'dsa-btn',
          'data-tone': 'primary',
          disabled: !pathDirty || state.saving,
          onClick: () => { void commitPath() },
        }, state.saving ? t('path.saving') : t('path.save')),
      ),
      pathError === null ? null : h('div', { key: 'err', className: 'dsa-error' }, pathError),
      pathMessage === null ? null : h('div', { key: 'msg', className: 'dsa-note' }, pathMessage),
      draftProbe?.error === undefined ? null : h('div', { key: 'probeErr', className: 'dsa-error' }, draftProbe.error),
      draftProbe !== null && draftProbe !== undefined && draftProbe.error === undefined && draftProbe.writable === false
        ? h('div', { key: 'probeWarn', className: 'dsa-error' }, t('path.notWritable'))
        : null,
      inheritWarning ? h('div', { key: 'inherit', className: 'dsa-note' }, t('path.inherit')) : null,
      status.rootError === undefined || status.rootError === null
        ? null
        : h('div', { key: 'rootErr', className: 'dsa-error' }, status.rootError.message),
      )

      const featuresCard = h(Card, {
        key: 'features',
        title: t('features.title'),
        description: t('features.note'),
      },
      status.caps?.configEditor === false
        ? h('div', { key: 'readonly', className: 'dsa-note' }, t('path.readOnly'))
        : null,
      h(FeatureRow, {
        key: 'pickerEntry',
        title: t('toggle.pickerEntry'),
        description: t('toggle.pickerEntry.desc'),
        checked: config?.pickerEntry !== false,
        disabled: busyAction || state.saving || status.caps?.configEditor === false,
        onChange: (next) => { void toggleFeature('pickerEntry', next) },
      }),
      // An older Host does not know the field yet: hide the row until both
      // halves match instead of offering a switch whose write would fail.
      config === undefined || config.rememberPick !== undefined
        ? h(FeatureRow, {
          key: 'rememberPick',
          title: t('toggle.rememberPick'),
          description: t('toggle.rememberPick.desc'),
          checked: config?.rememberPick !== false,
          disabled: busyAction || state.saving || config?.pickerEntry === false || status.caps?.configEditor === false,
          onChange: (next) => { void toggleFeature('rememberPick', next) },
        })
        : null,
      h(FeatureRow, {
        key: 'management',
        title: t('toggle.management'),
        description: t('toggle.management.desc'),
        checked: config?.management !== false,
        disabled: busyAction || state.saving || status.caps?.configEditor === false,
        onChange: (next) => { void toggleFeature('management', next) },
      }),
      h(FeatureRow, {
        key: 'trashOnDelete',
        title: t('toggle.trashOnDelete'),
        description: t('toggle.trashOnDelete.desc'),
        checked: config?.trashOnDelete !== false,
        disabled: busyAction || state.saving || status.caps?.trash === false || status.caps?.configEditor === false,
        onChange: (next) => { void toggleFeature('trashOnDelete', next) },
      }),
      h(FeatureRow, {
        key: 'reuseBlank',
        title: t('toggle.reuseBlank'),
        description: t('toggle.reuseBlank.desc'),
        checked: config?.reuseBlank !== false,
        disabled: busyAction || state.saving || status.caps?.configEditor === false,
        onChange: (next) => { void toggleFeature('reuseBlank', next) },
      }),
      h(FeatureRow, {
        key: 'abandonOnSwitch',
        title: t('toggle.abandonOnSwitch'),
        description: t('toggle.abandonOnSwitch.desc'),
        checked: config?.abandonOnSwitch !== false,
        disabled: busyAction || state.saving || status.caps?.configEditor === false,
        onChange: (next) => { void toggleFeature('abandonOnSwitch', next) },
      }),
      h('div', { key: 'reclaim', className: 'dsa-feature' },
        h('div', { className: 'dsa-feature-main' },
          h('div', { className: 'dsa-feature-title' }, t('toggle.autoReclaim')),
          h('div', { className: 'dsa-feature-desc' }, t('toggle.autoReclaim.desc')),
        ),
        h('div', { className: 'dsa-row', style: { flexWrap: 'nowrap' } },
          h('input', {
            className: 'dsa-input dsa-input-num',
            type: 'number',
            min: 0,
            max: 8760,
            step: 1,
            value: hoursDraft ?? String(config?.autoReclaimHours ?? 24),
            disabled: busyAction || state.saving,
            'aria-label': t('toggle.autoReclaim'),
            onChange: (event) => setHoursDraft(event.target.value),
            onBlur: () => { void commitHours() },
            onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } },
          }),
          h('span', { className: 'dsa-note' }, t('toggle.hours')),
        ),
      ),
      )

      const configErrorLine = state.configError === null || state.configError === undefined
        ? null
        : h('div', { key: 'cfgErr', className: 'dsa-error' }, state.configError.message)

      const managerCard = h(Card, {
        key: 'manager',
        title: t('manage.title'),
        description: t('manage.count', {
          total: rows.length,
          size: formatBytes(totalBytes),
          blank: blankCount === 0 ? '' : t('manage.countBlank', { n: blankCount }),
          missing: visible.missing === 0 ? '' : t('manage.countMissing', { n: visible.missing }),
        }),
        actions: h('div', { className: 'dsa-row', style: { flexWrap: 'nowrap' } },
          inventory === null ? null : h('span', { className: 'dsa-note' }, relativeTime(state.inventoryAt, t)),
          h('button', {
            type: 'button',
            className: 'dsa-btn',
            'data-size': 'sm',
            onClick: () => { void refreshStatus(); void refreshInventory(true) },
          }, h(IconRefresh, { size: 14 }), t('manage.refresh')),
        ),
      },
      state.inventoryError === null || state.inventoryError === undefined
        ? null
        : h('div', { key: 'invErr', className: 'dsa-error' },
          h('span', { className: 'dsa-grow' }, t('manage.inventoryError', { message: state.inventoryError.message })),
          h('button', {
            type: 'button',
            className: 'dsa-btn',
            'data-size': 'sm',
            onClick: () => { void refreshInventory(true) },
          }, t('menu.retry')),
        ),
      h('div', { key: 'toolbar', className: 'dsa-toolbar' },
        h('label', { className: 'dsa-search' },
          h(IconSearch, { size: 14 }),
          h('input', {
            value: query,
            placeholder: t('manage.search'),
            onChange: event => setQuery(event.target.value),
            'aria-label': t('manage.search'),
          }),
        ),
        h('div', { className: 'dsa-segment', role: 'group' }, ...[
          ['all', t('filter.all')],
          ['active', t('filter.active')],
          ['blank', t('filter.blank')],
          ['archived', t('filter.archived')],
          ['missing', t('filter.missing')],
        ].map(([id, label]) => h('button', {
          key: id,
          type: 'button',
          'data-on': filter === id ? 'true' : 'false',
          'aria-pressed': filter === id,
          onClick: () => setFilter(id),
        }, label))),
        h('select', {
          className: 'dsa-select',
          value: sort,
          onChange: event => setSort(event.target.value),
          'aria-label': t('sort.updated'),
        },
        h('option', { value: 'updated' }, t('sort.updated')),
        h('option', { value: 'title' }, t('sort.title')),
        h('option', { value: 'size' }, t('sort.size')),
        ),
      ),
      visible.list.length === 0
        ? h('div', { key: 'empty', className: 'dsa-empty' }, rows.length === 0 ? t('manage.empty') : t('manage.emptyFilter'))
        : h('div', {
          key: 'list',
          className: 'dsa-list',
          tabIndex: 0,
          role: 'region',
          'aria-label': t('manage.title'),
        },
          h('div', { key: 'head', className: 'dsa-item-row dsa-list-head', style: { minHeight: '28px' } },
            h('input', {
              type: 'checkbox',
              className: 'dsa-check',
              checked: allSelected,
              'aria-label': t('filter.all'),
              onChange: selectAllVisible,
            }),
            h('span', { className: 'dsa-item-title dsa-note' }, t('manage.title')),
            h('span', { className: 'dsa-item-size dsa-note' }, t('sort.size')),
            h('span', { className: 'dsa-item-time dsa-note' }, t('sort.updated')),
          ),
          ...groups.flatMap(group => [
            h('div', { key: `g-${group.id}`, className: 'dsa-group-label' }, group.label),
            ...group.rows.map(row => h('div', {
              key: row.id,
              className: 'dsa-item-row',
              'data-selected': selected.has(row.id) ? 'true' : 'false',
            },
            h('input', {
              type: 'checkbox',
              className: 'dsa-check',
              checked: selected.has(row.id),
              'aria-label': row.title ?? (row.blank ? t('row.new') : row.displayTitle),
              onChange: () => toggleSelected(row.id),
            }),
            h('span', {
              key: 'folder',
              style: { display: 'flex', color: 'var(--dsw-alias-label-secondary)' },
              'aria-hidden': 'true',
            }, h(IconFolder, { size: 14 })),
            h('span', { key: 'title', className: 'dsa-item-title', title: row.cwd ?? '' },
              row.title ?? (row.blank ? t('row.new') : row.displayTitle)),
            h('span', { key: 'id', className: 'dsa-item-id' }, shortId(row.id)),
            h('span', { key: 'size', className: 'dsa-item-size' }, row.folder === undefined ? t('misc.none') : formatBytes(row.folder.bytes)),
            h('span', { key: 'time', className: 'dsa-item-time', title: new Date(row.updatedAt).toLocaleString() }, relativeTime(row.updatedAt, t)),
            row.archived ? h(Tag, { key: 'arch', tone: 'muted' }, t('badge.archived')) : null,
            row.exists === false ? h(Tag, { key: 'miss', tone: 'warn' }, t('badge.missing')) : null,
            row.running && !row.archived ? h(Tag, { key: 'run', tone: 'success' }, t('badge.running')) : null,
            !row.archived && !row.running && row.blank ? h(Tag, { key: 'blank' }, t('badge.blank')) : null,
            h('span', { key: 'actions', className: 'dsa-item-actions' },
              h('button', {
                type: 'button',
                className: 'dsa-icon-btn',
                'aria-label': t('action.more'),
                onClick: (event) => {
                  const element = event.currentTarget
                  setMenuFor(current => (current !== null && current.row.id === row.id ? null : { row, anchor: element }))
                },
              }, h(IconMore, { size: 16 })),
            ),
            )),
          ]),
        ),
      selectedIds.length === 0
        ? null
        : h('div', { key: 'bulk', className: 'dsa-bulk' },
          h('span', { className: 'dsa-grow' }, t('bulk.selected', { n: selectedIds.length })),
          h('button', {
            type: 'button',
            className: 'dsa-btn',
            'data-size': 'sm',
            disabled: busyAction || state.saving,
            onClick: () => { void runBulk(selectedIds, 'archive') },
          }, t('bulk.archive')),
          h('button', {
            type: 'button',
            className: 'dsa-btn',
            'data-size': 'sm',
            disabled: busyAction || state.saving,
            onClick: () => { void runBulk(selectedIds, 'unarchive') },
          }, t('bulk.unarchive')),
          h('button', {
            type: 'button',
            className: 'dsa-btn',
            'data-size': 'sm',
            'data-tone': 'danger',
            disabled: busyAction || state.saving,
            onClick: () => setDialog({ kind: 'bulkTrash', ids: selectedIds }),
          }, t('bulk.trash')),
          h('button', {
            type: 'button',
            className: 'dsa-btn',
            'data-size': 'sm',
            onClick: () => setSelected(new Set()),
          }, t('bulk.clear')),
        ),
      h('div', { key: 'maint', className: 'dsa-details' },
        h('div', { key: 'title', className: 'dsa-card-title', style: { fontSize: '13px', marginBottom: '6px' } }, t('maintain.title')),
        h('div', { key: 'actions', className: 'dsa-row' },
          h('button', {
            type: 'button',
            className: 'dsa-btn',
            'data-size': 'sm',
            disabled: reclaimIds.length === 0 || state.saving,
            onClick: () => setDialog({ kind: 'reclaim', ids: reclaimIds }),
          }, t('maintain.reclaim'), h('span', { className: 'dsa-note' }, `(${reclaimIds.length})`)),
          h('button', {
            type: 'button',
            className: 'dsa-btn',
            'data-size': 'sm',
            disabled: orphans.length === 0 || state.saving,
            onClick: () => setDialog({ kind: 'orphans', ids: orphans }),
          }, t('maintain.orphans'), h('span', { className: 'dsa-note' }, `(${orphans.length})`)),
          h('button', {
            type: 'button',
            className: 'dsa-btn',
            'data-size': 'sm',
            disabled: missingIds.length === 0 || state.saving,
            onClick: async () => {
              setBusyAction(true)
              try {
                const result = await RUNTIME.maintain('rebuildMissing', missingIds)
                setMaintenanceNote(t('maintain.result', { changed: result.changed.length, skipped: result.skipped.length }))
                void refreshInventory()
              } catch (error) {
                notify(messageOf(error))
              } finally {
                setBusyAction(false)
              }
            },
          }, t('maintain.rebuild'), h('span', { className: 'dsa-note' }, `(${missingIds.length})`)),
        ),
        h('div', { key: 'help', className: 'dsa-note', style: { marginTop: '6px' } },
          reclaimIds.length === 0 ? t('maintain.reclaim.empty') : t('maintain.reclaim.desc'),
        ),
        maintenanceNote === null ? null : h('div', { key: 'note', className: 'dsa-note', style: { marginTop: '4px' } }, maintenanceNote),
      ),
      h('details', { key: 'status', className: 'dsa-details' },
        h('summary', null, t('status.title')),
        h('div', { className: 'dsa-facts' },
          h('span', null, t('status.version')),
          h('b', null, status.version ?? t('misc.none')),
          h('span', null, t('path.effective')),
          h('b', { style: { fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)', fontSize: '11px', wordBreak: 'break-all' } }, root ?? t('misc.none')),
          h('span', null, t('status.staged')),
          h('b', null, String((status.staged ?? []).length)),
          h('span', null, t('status.pending')),
          h('b', null, String(status.pendingSettles ?? 0)),
          h('span', null, t('status.sweep')),
          h('b', null, status.lastSweep === null || status.lastSweep === undefined
            ? t('misc.none')
            : `${new Date(status.lastSweep.at).toLocaleTimeString()} · ${status.lastSweep.settled}/${status.lastSweep.abandoned}/${status.lastSweep.kept}`),
          h('span', null, t('status.caps')),
          h('b', null, Object.entries(status.caps ?? {})
            .filter(([key]) => key !== 'trashMethod')
            .map(([key, value]) => `${key}: ${value === true ? t('status.yes') : t('status.no')}`)
            .join(' · ')),
        ),
      ),
      h('div', { key: 'noteGroups', className: 'dsa-note' }, t('note.groups')),
      h('div', { key: 'noteWorkflow', className: 'dsa-note' }, t('note.workflow')),
      )

      const dialogKind = dialog === null ? null : dialog.kind
      const dialogElement = dialog === null ? null : h(Dialog, {
        key: 'dialog',
        title: dialogKind === 'rename'
          ? t('confirm.rename.title')
          : dialogKind === 'trash'
            ? t('confirm.trash.title')
            : dialogKind === 'bulkTrash'
              ? t('confirm.bulkTrash.title', { n: dialog.ids.length })
              : dialogKind === 'archiveRunning'
                ? t('confirm.archiveRunning.title')
                : dialogKind === 'reclaim'
                  ? t('confirm.reclaim.title')
                  : dialogKind === 'orphans'
                    ? t('confirm.orphans.title')
                    : t('dialog.close'),
        body: dialogKind === 'rename'
          ? undefined
          : dialogKind === 'trash'
            ? t('confirm.trash.named', { name: labelOf(dialog.row) })
            : dialogKind === 'bulkTrash'
              ? t('confirm.bulkTrash.body')
              : dialogKind === 'archiveRunning'
                ? t('confirm.archiveRunning.body')
                : dialogKind === 'reclaim'
                  ? t('confirm.reclaim.body')
                  : dialogKind === 'orphans'
                    ? t('confirm.orphans.body')
                    : undefined,
        confirmLabel: dialogKind === 'rename'
          ? t('confirm.rename.save')
          : dialogKind === 'trash' || dialogKind === 'bulkTrash'
            ? t('confirm.trash.confirm')
            : dialogKind === 'archiveRunning'
              ? t('confirm.archiveRunning.confirm')
              : dialogKind === 'reclaim'
                ? t('confirm.reclaim.confirm')
                : dialogKind === 'orphans'
                  ? t('confirm.orphans.confirm')
                  : t('confirm.continue'),
        tone: dialogKind === 'trash' || dialogKind === 'bulkTrash' || dialogKind === 'orphans' || dialogKind === 'archiveRunning'
          ? 'danger'
          : 'primary',
        busy: dialogBusy,
        onCancel: () => setDialog(null),
        onConfirm: () => { void runDialog() },
      },
      dialogKind === 'rename'
        ? h('input', {
          key: 'rename',
          className: 'dsa-input',
          value: dialog.value ?? '',
          'aria-label': t('confirm.rename.title'),
          onChange: event => setDialog(current => (current === null ? null : { ...current, value: event.target.value })),
          onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); void runDialog() } },
        })
        : null,
      )

      return h('div', { className: 'dsa-page' },
        h('style', { key: 'style' }, PAGE_CSS),
        pathCard,
        featuresCard,
        configErrorLine,
        config?.management === false ? null : managerCard,
        state.toast === null ? null : h('div', { key: 'toast', className: 'dsa-toast', role: 'status', 'aria-live': 'polite' }, state.toast.message),
        dialogElement,
        menuFor === null ? null : h(RowMenu, {
          key: 'rowmenu',
          anchor: menuFor.anchor,
          row: menuFor.row,
          t,
          onClose: () => setMenuFor(null),
          onSelect: (action) => { void onRowAction(menuFor.row, action) },
        }),
      )
    }

    /**
     * Debounce one value.
     * @param value - current value.
     * @param ms - delay.
     * @returns the delayed value.
     */
    function useDebounced(value, ms) {
      const [debounced, setDebounced] = useState(value)
      useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), ms)
        return () => clearTimeout(timer)
      }, [value, ms])
      return debounced
    }

    /**
     * Split rows into Today / Yesterday / This week / Earlier groups.
     * @param rows - sorted rows.
     * @param t - translator.
     * @returns groups in display order.
     */
    function groupRows(rows, t) {
      const today = startOfDay(Date.now())
      const yesterday = today - 86_400_000
      const week = today - 6 * 86_400_000
      const buckets = [
        { id: 'today', label: t('group.today'), rows: [] },
        { id: 'yesterday', label: t('group.yesterday'), rows: [] },
        { id: 'week', label: t('group.week'), rows: [] },
        { id: 'earlier', label: t('group.earlier'), rows: [] },
      ]
      for (const row of rows) {
        if (row.updatedAt >= today) buckets[0].rows.push(row)
        else if (row.updatedAt >= yesterday) buckets[1].rows.push(row)
        else if (row.updatedAt >= week) buckets[2].rows.push(row)
        else buckets[3].rows.push(row)
      }
      return buckets.filter(bucket => bucket.rows.length > 0)
    }

    /**
     * Remove one id from a selection set.
     * @param set - current selection.
     * @param id - id to remove.
     * @returns a new set.
     */
    function without(set, id) {
      const next = new Set(set)
      next.delete(id)
      return next
    }

    // ---------------------------------------------------------------- apply ---

    /**
     * Install the browser half: slot registrations, the status poll, and the
     * staged-conversation watcher.
     * @param ctx - the Client plugin context.
     */
    function apply(ctx) {
      RUNTIME.ctx = ctx

      try {
        ctx.locale.register(LOCALE_NS, { en: EN, zh: ZH })
      } catch {
        // A registration clash only costs dictionary sharing; the built-in
        // tables above keep rendering the same text.
      }

      const handles = { picker: null, page: null }
      const watched = new Map()

      /**
       * Reconcile the feature-gated slot registrations with the Host config.
       */
      function syncSlots() {
        const config = store.get().status?.config
        const wantPicker = config === undefined || config.pickerEntry !== false

        if (wantPicker && handles.picker === null) {
          handles.picker = ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register({
            name: 'conversation.hero.workspace',
            id: 'session-autospace',
          }, WorkspaceMenu))
        } else if (!wantPicker && handles.picker !== null) {
          handles.picker()
          handles.picker = null
        }
      }

      /**
       * Unsubscribe one watched conversation.
       * @param sessionId - watched id.
       */
      function unwatch(sessionId) {
        const record = watched.get(sessionId)
        if (record === undefined) return
        for (const dispose of record.unsubs) {
          try {
            dispose()
          } catch {
            // Disposal is best effort.
          }
        }
        watched.delete(sessionId)
      }

      /**
       * Call the Host's idempotent settle route.
       * @param sessionId - staged id.
       * @param record - watcher record.
       */
      async function settleRemote(sessionId, record) {
        try {
          await request('/settle', { sessionId })
        } catch {
          // The Host settles on its own channel too; a failure here is retried
          // by the next activation sweep.
        } finally {
          record.busy = false
          unwatch(sessionId)
          void refreshStatus()
        }
      }

      /**
       * Abandon a staged conversation the user left, once another conversation
       * holds the main view — opening Settings must not destroy a draft.
       * @param sessionId - staged id.
       * @param record - watcher record.
       */
      async function maybeAbandon(sessionId, record) {
        setTimeout(() => {
          const config = store.get().status?.config
          if (config !== undefined && config.abandonOnSwitch === false) {
            record.busy = false
            unwatch(sessionId)
            return
          }
          const mainViewAgain = ctx.sessions.retainInfo(sessionId).getSnapshot()?.retainedBy?.mainView ?? 0
          if (mainViewAgain > 0) {
            record.busy = false
            return
          }
          const list = ctx.sessions.list.getSnapshot()
          const row = list?.byId?.[sessionId]
          if (row === undefined || row.blank !== true) {
            record.busy = false
            return
          }
          const elsewhere = Object.values(list.byId).some(other => other.id !== sessionId && (other.retainedBy?.mainView ?? 0) > 0)
          if (!elsewhere) {
            record.busy = false
            return
          }
          void (async () => {
            try {
              await request('/abandon', { sessionId })
            } catch {
              // Retried by the activation sweep.
            } finally {
              record.busy = false
              unwatch(sessionId)
              void refreshStatus()
            }
          })()
        }, 450)
      }

      /**
       * Watch one staged conversation for settling and abandoning.
       * @param sessionId - staged id.
       */
      function watchSession(sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '' || watched.has(sessionId)) return
        const record = { armed: false, busy: false, unsubs: [] }
        watched.set(sessionId, record)
        try {
          const info = ctx.sessions.retainInfo(sessionId)
          const checkRetain = () => {
            const count = info.getSnapshot()?.retainedBy?.mainView ?? 0
            if (count > 0) {
              record.armed = true
              return
            }
            if (record.armed && !record.busy) {
              record.busy = true
              void maybeAbandon(sessionId, record)
            }
          }
          record.unsubs.push(info.subscribe(checkRetain))
          checkRetain()
        } catch {
          // Without retainInfo the Host still settles on the first turn.
        }
        try {
          const checkList = () => {
            const row = ctx.sessions.list.getSnapshot()?.byId?.[sessionId]
            if (row === undefined) return
            if (row.blank === false && !record.busy) {
              record.busy = true
              void settleRemote(sessionId, record)
            }
          }
          record.unsubs.push(ctx.sessions.list.subscribe(checkList))
          checkList()
        } catch {
          // The list source is optional for the watcher.
        }
      }

      /**
       * Ask the Host for a scratch conversation and open it. One implementation
       * behind both entries: the workspace menu and the sidebar button.
       * @param locale - UI locale, for the temporary Workspace title.
       * @returns the Host value.
       */
      async function startScratchConversation(locale) {
        const value = await request('/prepare', { requestId: requestId(), locale })
        // The Host persisted the choice; keep this page's copy in step before
        // the next New Session can read it.
        setLastPick('scratch')
        await waitForWorkspace(value.sessionId)
        watchSession(String(value.sessionId))
        const ui = ctx.get('uiWorkspace')
        if (!ui) throw new Error('the plugin host channel is unavailable')
        // Navigate before anything else can fail: a broken open stays visible.
        ui.openSession(value.sessionId)
        return value
      }

      RUNTIME.syncSlots = syncSlots
      RUNTIME.watchSession = watchSession
      RUNTIME.startScratch = startScratchConversation
      RUNTIME.rememberPick = rememberPick
      RUNTIME.t = makeT(ctx.locale.getSnapshot().active)
      RUNTIME.reveal = async (sessionId) => { await request('/reveal', { sessionId }) }
      RUNTIME.op = async (sessionId, op, title) => {
        const value = await request('/session-op', { sessionId, op, ...(title === undefined ? {} : { title }) })
        return value
      }
      RUNTIME.trash = async (sessionId) => request('/trash', { sessionId })
      RUNTIME.maintain = async (op, ids) => request('/maintenance', { op, ids })

      RUNTIME.dispose = () => {
        for (const sessionId of [...watched.keys()]) unwatch(sessionId)
        for (const key of Object.keys(handles)) {
          if (handles[key] !== null) {
            handles[key]()
            handles[key] = null
          }
        }
      }

      ctx.effect(() => RUNTIME.dispose, 'session-autospace: client runtime')

      ctx.effect(() => ctx.locale.subscribe(() => {
        RUNTIME.t = makeT(ctx.locale.getSnapshot().active)
      }), 'session-autospace: locale binding')

      // The bundle page renders this entry whenever the package page opens.
      handles.page = ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: PACKAGE_NAME,
      }, ConfigEntry))

      syncSlots()

      // Optional: the New Session action lives on the workspace UI service.
      // Injecting rather than requiring it keeps the plugin usable (menu,
      // badge, page) in a composition without that service.
      if (typeof ctx.inject === 'function') {
        ctx.inject(['uiWorkspace'], (scope) => {
          const install = () => installNewSessionDefault(scope.uiWorkspace ?? ctx.get('uiWorkspace'))
          if (typeof scope.effect === 'function') scope.effect(install, 'session-autospace: New Session default')
          else install()
        })
      }

      ctx.effect(() => {
        const onFocus = () => { void refreshStatus() }
        const onVisibility = () => {
          if (document.visibilityState === 'visible') {
            void refreshStatus()
            void refreshInventory()
          }
        }
        window.addEventListener('focus', onFocus)
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          window.removeEventListener('focus', onFocus)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, 'session-autospace: refresh on focus')

      void refreshStatus()
      void refreshInventory()
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply,
    }
  },
})
