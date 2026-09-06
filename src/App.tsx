import { useRef, useEffect, useState, useCallback, type ChangeEvent } from 'react'
import { uniq } from 'lodash-es'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import Editor, { EditorHandle, type CursorStatus } from './components/Editor'
import Console, { ConsoleHandle } from './components/Console'
import { HeaderBar } from './components/HeaderBar'
import { NoticeBar } from './components/NoticeBar'
import { StatusBar } from './components/StatusBar'
import { TabStrip } from './components/TabStrip'
import { useNotice } from './hooks/useNotice'
import { useTabs, ACTIVE_KEY } from './hooks/useTabs'
import { useUntitled, untitledKey, isUntitledKey } from './hooks/useUntitled'
import { useDemoSaver } from './hooks/useDemoSaver'
import { useExternalChangeWatcher } from './hooks/useExternalChangeWatcher'
import type { ActiveFile, Language, LocalMeta } from './types'
import Sidebar from './components/Sidebar'
import ConfirmDialog from './components/ConfirmDialog'
import { listTemplates, loadTemplate } from './hooks'
import { useWorkspace, type WorkspaceRoot } from './hooks/useWorkspace'
import { useFileDraft } from './hooks/useFileDraft'
import { useConfirm } from './hooks/useConfirm'
import {
  getLastModified,
  isRunnable,
  languageOf,
  readTextFile,
  writeTextFile,
  type Entry,
  type FileEntry,
} from './lib/fs-access'
import { codeRunner } from './lib/runner'
import type { ModuleHost } from './lib/module-graph'
import { startPointerDrag } from './lib/pointer-drag'
import { shortcut, isRtl } from './lib/platform'
import { useMediaQuery } from './hooks/useMediaQuery'
import { useSidebarCollapsed } from './hooks/useSidebarCollapsed'
import { messageOf, useI18n } from '@/i18n/context'

// 编辑器 / Console 分栏
const CONSOLE_MIN = 220 // px，任何一侧至少保住的宽度
const SNAP = 20 // px：距正中 50% 这么近就会被磁吸住
const SNAP_RELEASE = 32 // px：已经吸在正中间后，得拖开这么远才挣脱（更强的顿感）
// 按文件后缀猜语言（导入 .ts 文件时自动切到 TS，否则代码不会经过 TS 编译）
function languageFromFilename(name: string): Language {
  return /\.(ts|tsx|mts|cts)$/i.test(name) ? 'typescript' : 'javascript'
}

// 让下载的文件后缀与当前语言一致：TS 代码存成 .js 打开就是坏的
function withLanguageExt(filename: string, language: string): string {
  const ext = language === 'typescript' ? 'ts' : 'js'
  return filename.replace(/\.(js|mjs|cjs|jsx|ts|tsx|mts|cts)$/i, `.${ext}`)
}

function App() {
  const templates = listTemplates()
  const workspace = useWorkspace()
  // 这两个方法在 effect / useCallback 里用，摘出来当依赖：整个 workspace 当依赖的话
  // 每次目录树变动都会重跑，而这两处只关心「路径怎么解析」
  const { resolveFilePath, displayPath } = workspace
  const { t } = useI18n()
  const confirm = useConfirm()
  // 窄屏（手机竖屏）：编辑器与 Console 上下堆叠，分栏把手隐藏，侧栏默认收起（useSidebarCollapsed 里判断）
  const narrow = useMediaQuery('(max-width: 767px)')
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarCollapsed()

  const editorRef = useRef<EditorHandle>(null)
  const consoleRef = useRef<ConsoleHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const localMetaRef = useRef(new Map<string, LocalMeta>())
  // 「打开文件」的序号。读盘是异步的，快速连点两个文件时先点的可能后返回，
  // 回来时对一下序号，过期的那次就别再往编辑器里塞了
  const openSeqRef = useRef(0)

  // ---- 多标签数据模型（见 hooks/useTabs）----
  // `active` 是「当前激活那个文件」；handleSave / 状态栏 / 运行等大量代码读它。
  const {
    tabs,
    setTabs,
    activeKey,
    setActiveKey,
    active,
    dirtyKeys,
    activeRef,
    dirtyRef,
    handleDirtyChange,
    openOrActivate,
    switchTab,
    dropTabsByKeys,
    closeTab,
    menuCloseOthers,
    menuCloseToRight,
    menuCloseAll,
  } = useTabs({
    editorRef,
    confirm,
    t,
    onEmpty: () => openUntitled(),
    // 关掉的未命名文件从 IndexedDB 里删掉，不然下次刷新它又回来了
    onClosed: (keys) => keys.filter(isUntitledKey).forEach((key) => untitled.remove(key)),
    // 关闭脏标签时点了「保存」；只有保存真能落地时才给这个选项（否则保存 = 下载）
    onSave: (file) => saveFile(file),
    canSave: (file) => (file.kind === 'local' && !!file.handle) || (file.kind === 'untitled' && workspace.hasRoot),
  })
  const untitled = useUntitled()

  // Alt+W：关掉当前激活的标签（⌘W / Ctrl+W 归浏览器，拦不住）
  const closeActiveTab = useCallback(() => {
    const key = activeRef.current?.key
    if (key) void closeTab(key)
  }, [activeRef, closeTab])

  // ---- 编辑器 / 控制台 水平分栏 ----
  // editorW 为 null 表示未拖过：两栏各占一半（编辑器与输出都 flex-1）。
  // 一旦拖过，就按像素记住编辑器宽度。两侧都可被拖小（不再锁编辑器 >= 一半），
  // 各留一个可读下限；拖到正中间 50% 附近时有「吸附」的顿感，方便停在正中。
  const mainRef = useRef<HTMLElement | null>(null)
  const [editorW, setEditorW] = useState<number | null>(null)
  /** 正在拖动分栏（用于给分隔带一个明显的“拖动中”高亮） */
  const [splitting, setSplitting] = useState(false)
  const startSplitDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const wrap = mainRef.current
    if (!wrap) return
    const wrapW = wrap.getBoundingClientRect().width
    const startX = e.clientX
    const startW = wrap.querySelector('[data-editor-pane]')?.getBoundingClientRect().width ?? wrapW / 2
    const minW = CONSOLE_MIN // 编辑器可拖到较小
    const maxW = Math.round(wrapW - CONSOLE_MIN) // 给另一侧留出可读下限
    const half = Math.round(wrapW / 2)
    // 磁吸锁：一旦被吸到正中，需要拖出 SNAP_RELEASE 才解开，制造明显的“顿”感
    let latched = false

    setSplitting(true)
    // RTL（阿拉伯语）下 main 内的左右分栏会镜像：编辑器到右侧、输出到左侧，
    // 拖动方向与 LTR 相反，故增量取反（符号只在 RTL 下翻）。
    const sign = document.documentElement.dir === 'rtl' ? -1 : 1

    const onMove = (ev: PointerEvent) => {
      const raw = startW + sign * (ev.clientX - startX)
      const d = raw - half
      let target = raw
      if (latched) {
        // 已吸住：拖出释放带之前保持正中
        if (Math.abs(d) > SNAP_RELEASE) {
          latched = false
        } else {
          target = half
        }
      } else if (Math.abs(d) <= SNAP) {
        latched = true
        target = half
      }
      const w = Math.min(Math.max(target, minW), Math.max(minW, maxW))
      setEditorW(Math.round(w))
    }
    startPointerDrag({ onMove, onEnd: () => setSplitting(false), cursor: 'col-resize' })
  }, [])



  // 底部状态栏的「Ln, Col / Spaces: N」来源，由 Editor 上报（光标移动 / 换文件时刷新）
  const [cursor, setCursor] = useState<CursorStatus | null>(null)
  const [running, setRunning] = useState(false)
  const { notice, setNotice } = useNotice()
  const { saveProgress, cancelling, saveDemos, cancelSave } = useDemoSaver({
    workspace,
    confirm,
    t,
    setNotice,
  })
  /** 单个文件保存的防重入锁：写入中再按 Ctrl+S 直接忽略，避免叠加/排队 */
  const savingRef = useRef(false)
  /** 是否正在保存当前文件。用于禁用保存按钮并显示「保存中…」，避免用户以为卡死 */
  const [saving, setSaving] = useState(false)



  /*
    runner 是模块级单例，拿不到 hook，报错文案只能由这里注入。

    注入的是「读 ref 的函数」而不是 t 本身：这样切语言之后 runner 手里不会还攥着
    旧字典，而且注册只发生一次（依赖是空数组），不用每次换语言重挂一遍。
    已经打印在 Console 里的旧行不跟着变 —— 那是历史记录，按当时的语言留着。
  */
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  })
  useEffect(() => {
    codeRunner.setTranslator(() => tRef.current)
    return () => codeRunner.setTranslator(null)
  }, [])

  const language = active?.language ?? 'javascript'
  const runnable = isRunnable(language)

  useEffect(() => () => codeRunner.destroy(), [])

  useEffect(() => {
    codeRunner.setOnDone(() => setRunning(false))
    return () => codeRunner.setOnDone(null)
  }, [])



  const openTemplate = useCallback(
    async (path: string) => {
      const key = `builtin:${path}`
      const name = path.replace('../template/', '')
      const seq = ++openSeqRef.current
      try {
        // Demo 源码是打包进来的字符串，重复读代价忽略不计；
        // model 已经存在时 open() 会忽略 value，用户改过的内容不会被冲掉
        const code = await loadTemplate(path)
        if (seq !== openSeqRef.current) return // 期间用户又打开了别的
        const language = languageFromFilename(name)
        editorRef.current?.open({ key, value: code, language })
        openOrActivate({ key, kind: 'builtin', name, language, encoding: 'UTF-8' })
        consoleRef.current?.clear()
      } catch (err) {
        setNotice({
          tone: 'error',
          text: t('notice.demoLoadFailed', { message: messageOf(err, t) }),
        })
      }
    },
    [setNotice, t, openOrActivate]
  )

  const openLocalFile = useCallback(
    async (entry: FileEntry) => {
      const language = languageOf(entry.name)
      if (!language) {
        setNotice({ tone: 'warn', text: t('notice.notTextFile', { name: entry.name }) })
        return
      }
      const key = `local:${entry.path}`
      const seq = ++openSeqRef.current
      try {
        if (editorRef.current?.has(key)) {
          // model 还在（可能有未保存改动），只切过去，不重新读盘
          editorRef.current.open({ key, value: '', language })
          if (!localMetaRef.current.has(key)) {
            const lastModified = await getLastModified(entry.handle)
            if (seq !== openSeqRef.current) return
            localMetaRef.current.set(key, { handle: entry.handle, lastModified })
          }
        } else {
          const { text, lastModified, encoding } = await readTextFile(entry.handle)
          if (seq !== openSeqRef.current) return // 期间用户又点开了别的文件，这次作废
          editorRef.current?.open({ key, value: text, language })
          localMetaRef.current.set(key, { handle: entry.handle, lastModified, encoding })
        }
        openOrActivate({
          key,
          kind: 'local',
          name: entry.name,
          language,
          encoding: localMetaRef.current.get(key)?.encoding ?? 'UTF-8',
          handle: entry.handle,
        })
        consoleRef.current?.clear()
        editorRef.current?.focus()
      } catch (err) {
        setNotice({ tone: 'error', text: messageOf(err, t) })
      }
    },
    [setNotice, t, openOrActivate]
  )

  /**
   * 未命名文件（Untitled-N）。不落在任何目录里，可以开多份，内容存在 IndexedDB 里（见 hooks/useUntitled）。
   * openUntitled 新建一份并切过去；restoreUntitled 在启动时把上次的全部开成标签（不激活）。
   * 首屏默认、标签全关掉后的兜底、上次的文件恢复失败，都走 openUntitled。
   */
  const openUntitled = useCallback(() => {
    const row = untitled.create()
    const key = untitledKey(row.n)
    editorRef.current?.open({ key, value: '', language: row.language })
    openOrActivate({
      key,
      kind: 'untitled',
      name: t('file.untitled', { n: row.n }),
      language: row.language,
      encoding: 'UTF-8',
    })
    consoleRef.current?.clear()
    editorRef.current?.focus()
  }, [untitled, t, openOrActivate])

  const restoreUntitled = useCallback((): ActiveFile[] => {
    const files: ActiveFile[] = []
    for (const row of untitled.all()) {
      const key = untitledKey(row.n)
      // 有内容的恢复出来就是脏的：它还没落过盘，标签上的点得亮着
      editorRef.current?.open({ key, value: row.content, language: row.language, dirty: row.content !== '' })
      files.push({ key, kind: 'untitled', name: t('file.untitled', { n: row.n }), language: row.language, encoding: 'UTF-8' })
    }
    setTabs((prev) => [...prev, ...files.filter((f) => !prev.some((x) => x.key === f.key))])
    return files
  }, [untitled, t, setTabs])

  /*
    删除 / 改名的收尾工作。

    编辑器里的 model、未保存标记、写回磁盘用的 handle 都挂在 `local:<path>` 这个 key 上，
    路径一变（或者整棵没了）就得把这些一起处理掉。目录操作还要连子树里打开过的文件一起，
    所以先按前缀把受影响的 key 找出来。
  */

  /** 一个路径牵连到的所有 key：它自己，以及 `<path>/` 下面的全部后代。 */
  const affectedKeys = (path: string): string[] => {
    const prefix = `local:${path}`
    const hit = (key: string) => key === prefix || key.startsWith(`${prefix}/`)
    // 打开过的文件都会在 localMeta 里留一条记录，脏的那些和当前这个再兜一遍。
    // Set / Map 先摊平成数组再交给 lodash：lodash 4 不认识它们的迭代器
    const keys = [
      ...localMetaRef.current.keys(),
      ...dirtyKeys,
      ...tabs.map((x) => x.key),
    ]
    return uniq(keys.filter(hit))
  }

  async function handleDelete(entry: Entry) {
    const keys = affectedKeys(entry.path)
    const unsaved = keys.filter((key) => dirtyKeys.has(key)).length
    const ok = await confirm.ask({
      title: t('confirm.delete.title', { name: entry.name }),
      lines: [
        entry.kind === 'directory'
          ? t('confirm.delete.dir', { path: displayPath(entry.path) })
          : t('confirm.delete.file', { path: displayPath(entry.path) }),
        ...(unsaved > 0
          ? [
              entry.kind === 'directory'
                ? t('confirm.delete.unsavedInDir', { count: unsaved })
                : t('confirm.delete.unsavedFile'),
            ]
          : []),
        t('confirm.delete.irreversible'),
      ],
      confirmText: t('confirm.delete.ok'),
      tone: 'danger',
    })
    if (!ok) return
    // 失败原因已经在 workspace.error 里，走侧边栏那条提示条
    if (!(await workspace.deleteEntry(entry))) return

    for (const key of keys) {
      editorRef.current?.close(key)
      handleDirtyChange(key, false) // close 不触发 onDirtyChange
      localMetaRef.current.delete(key)
    }
    // 标签栏里同步移除这些文件的标签；删掉的正是激活的那个就开一份新的未命名文件。
    // 不引入「一个都没打开」这种没验证过的状态（其它没删的标签仍在栏里，不影响）。
    if (dropTabsByKeys(keys)) openUntitled()
    setNotice({ tone: 'info', text: t('notice.deleted', { name: entry.name }) })
  }

  /**
   * 根目录菜单里的「移除目录」：只是把这个目录从列表里去掉，磁盘上什么都不动。
   *
   * 但它不是「看一眼再点回来」那种操作 —— roots 会同步写回 IndexedDB，
   * 重开页面也回不来，得再走一次系统的文件夹选择框（授权只能由用户手势发起）。
   * 而且这棵树里打开着的文件得跟着关掉：它们的 key 里带着这个根的 id，
   * 目录一移除就没有对应的树了，留着只会变成一堆指不回去的孤立 model。
   * 所以照删除那套先问一句，未保存的改动数量写进文案里。
   */
  async function handleCloseRoot(root: WorkspaceRoot) {
    const keys = affectedKeys(root.id)
    const unsaved = keys.filter((key) => dirtyKeys.has(key)).length
    const ok = await confirm.ask({
      title: t('confirm.closeRoot.title', { name: root.name }),
      lines: [
        t('confirm.closeRoot.listOnly'),
        ...(keys.length > 0
          ? [
              unsaved > 0
                ? t('confirm.closeRoot.openFilesUnsaved', { count: keys.length, unsaved })
                : t('confirm.closeRoot.openFiles', { count: keys.length }),
            ]
          : []),
        t('confirm.closeRoot.reauth'),
      ],
      confirmText: t('confirm.closeRoot.ok'),
      tone: unsaved > 0 ? 'danger' : 'default',
    })
    if (!ok) return

    workspace.forget(root.id)
    for (const key of keys) {
      editorRef.current?.close(key)
      handleDirtyChange(key, false) // close 不触发 onDirtyChange
      localMetaRef.current.delete(key)
    }
    // 标签栏同步移除；激活的那个就在这棵树里则开一份新的未命名文件（和删除时一致）
    if (dropTabsByKeys(keys)) openUntitled()
    setNotice({ tone: 'info', text: t('notice.rootRemoved', { name: root.name }) })
  }

  /**
   * 新 handle 只能重新从磁盘取：目录改名实际是「整棵复制一份 + 删掉原来的」，
   * 缓存里那些 handle 指向的都是已经被删掉的旧目录。
   * 文件改名（真正的 move）内容和 mtime 都没变，lastModified 基线保留；
   * 目录改名是复制出来的新文件，mtime 是「现在」，得重新取一次，
   * 否则下次窗口 focus 对比 mtime 时整棵子树都会误报一次「外部修改」。
   */
  async function handleRenamed(from: Entry, to: Entry) {
    // 收集「改名后每个旧 key → 新信息」的映射，最后统一刷一次 tabs / activeKey。
    // 一个目录改名可能连带改多个已打开文件的 key（子树里的）。
    const oldActive = active?.key
    const tabUpdates = new Map<string, ActiveFile>()
    for (const oldKey of affectedKeys(from.path)) {
      const newPath = to.path + oldKey.slice(`local:${from.path}`.length)
      const newKey = `local:${newPath}`
      const name = newPath.slice(newPath.lastIndexOf('/') + 1)
      const language = languageOf(name) ?? undefined
      // rekey 会为新 key 报一次脏状态；旧 key 那边和 close 一样不发通知，这里自己清
      editorRef.current?.rekey(oldKey, newKey, language)
      handleDirtyChange(oldKey, false)

      const meta = localMetaRef.current.get(oldKey)
      localMetaRef.current.delete(oldKey)
      const handle = to.kind === 'file' ? to.handle : await resolveFilePath(newPath)
      if (handle && meta) {
        const lastModified =
          to.kind === 'file' ? meta.lastModified : await getLastModified(handle).catch(() => meta.lastModified)
        localMetaRef.current.set(newKey, { handle, lastModified, encoding: meta.encoding })
      }
      const existing = tabs.find((x) => x.key === oldKey)
      if (existing) {
        tabUpdates.set(oldKey, {
          ...existing,
          key: newKey,
          name,
          language: language ?? existing.language,
          handle: handle ?? existing.handle,
        })
      }
    }
    if (tabUpdates.size > 0) {
      setTabs((prev) =>
        prev.map((x) => {
          const upd = tabUpdates.get(x.key)
          return upd ? upd : x
        })
      )
      if (oldActive && tabUpdates.has(oldActive)) {
        setActiveKey(tabUpdates.get(oldActive)!.key)
      }
    }
    setNotice({ tone: 'info', text: t('notice.renamed', { name: to.name }) })
  }

  // 新建文件 / 新建目录 / 未命名转正，都走侧边栏里那一个行内命名输入框。
  // 状态放在这里而不是 Sidebar 里：未命名转正是从这边的「保存」发起的，两个入口共用它。
  /** 正在转正的那份未命名文件的 key：handleSave 发起，onOpenFile 收尾时要知道关哪一份 */
  const promotingKeyRef = useRef<string | null>(null)
  const fileDraft = useFileDraft(workspace, confirm, {
    onOpenFile: (entry, savedFromUntitled) => {
      void openLocalFile(entry).then(() => {
        const key = promotingKeyRef.current
        promotingKeyRef.current = null
        if (!savedFromUntitled || !key) return
        // 未命名转正：内容已经在新 model 里了。旧 model 留着的话，
        // 侧边栏和标题上会一直挂着一个「未保存」的点。
        // 撤销历史跟着它一起没 —— 换 model 就留不住，这里认了。
        editorRef.current?.close(key)
        handleDirtyChange(key, false) // close 不会触发 onDirtyChange
        untitled.remove(key)
        // 标签栏里那张也撤掉 —— 它对应的 model 已关，留着会指到一个空标签。
        // 新保存的本地文件此刻已是激活标签（openLocalFile 把它激活了），activeKey 不用动
        setTabs((prev) => prev.filter((x) => x.key !== key))
        setNotice({ tone: 'info', text: t('notice.saved', { name: entry.name }) })
      })
    },
    onRenamed: (from, to) => void handleRenamed(from, to),
    onNotice: setNotice,
  })

  // 首屏：先把上次的未命名文件全部恢复成标签，再决定激活哪个 —— 优先接上次那个，
  // 接不上就落到恢复出来的第一份未命名上，一份都没有才新开一张白纸。
  // 等 workspace.ready 是因为上次那个可能是本地文件，得先知道目录到底恢复没恢复；
  // 等 untitled.ready 是因为未命名的内容在 IndexedDB 里。
  const bootedRef = useRef(false)
  useEffect(() => {
    if (bootedRef.current || !workspace.ready || !untitled.ready) return
    bootedRef.current = true

    let saved: string | null = null
    try {
      saved = localStorage.getItem(ACTIVE_KEY)
    } catch {
      // 读不到就按默认来
    }

    const restored = restoreUntitled()
    // 不走 switchTab：它查的是 tabsLiveRef，而 restoreUntitled 刚 setTabs、ref 要下一个 commit 才跟上。
    // model 在 restoreUntitled 里已经建好了，这里只需要把它设成激活并切过去
    const activate = (file: ActiveFile) => {
      setActiveKey(file.key)
      editorRef.current?.open({ key: file.key, value: '', language: file.language })
    }
    const fallback = () => {
      const first = restored[0]
      if (first) activate(first)
      else openUntitled()
    }

    const savedUntitled = saved && isUntitledKey(saved) ? restored.find((x) => x.key === saved) : undefined
    if (savedUntitled) {
      activate(savedUntitled)
      return
    }
    // 上次那个本地文件：path 的第一段是根 id，resolveFilePath 自己会判断
    // 那个根这次在不在、有没有权限，拿不到就走兜底
    if (saved?.startsWith('local:')) {
      const path = saved.slice('local:'.length)
      void resolveFilePath(path)
        .then((handle) =>
          handle ? openLocalFile({ kind: 'file', name: handle.name, path, handle }) : fallback()
        )
        // 解析失败（目录已失效之类）也得有个能落脚的标签，别停在一个标签都没有的状态
        .catch(fallback)
      return
    }
    // 上次在看某个 Demo 就接上（前提是它还在）。其余情况一律空白 ——
    // 首屏塞一份别人的代码，用户第一件事得先把它删掉
    const builtin = saved?.startsWith('builtin:') ? saved.slice('builtin:'.length) : null
    if (builtin && templates.includes(builtin)) {
      void openTemplate(builtin)
      return
    }
    fallback()
  }, [workspace.ready, untitled.ready, resolveFilePath, templates, openTemplate, openLocalFile, openUntitled, restoreUntitled, setActiveKey])

  // 正在写 demo、或有文件改了还没保存时离开/刷新：尽力弹一次确认。浏览器可能淡化甚至
  // 不显示自定义文案，但这是唯一不需要持久化就能拦一下的手段；
  // demo 那边真正的兜底在下面那条「上次没存完」提示。
  // 未命名文件不算：它们的内容存在 IndexedDB 里，刷新不丢，不该为它拦人
  const blockingDirty = [...dirtyKeys].some((key) => !isUntitledKey(key))
  useEffect(() => {
    if (saveProgress === null && !blockingDirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // 一些浏览器要求设置了 returnValue 才会弹
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [saveProgress, blockingDirty])

  function handleImport() {
    fileInputRef.current?.click()
  }

  // 复制条目的应用内相对路径（如 `test/jotter-demos`）。浏览器拿不到真实绝对路径，
  // 所以只能给这个；用户可自行在资源管理器 / Finder 里按路径定位。
  function handleCopyPath(path: string) {
    const label = workspace.displayPath(path)
    // 非安全上下文（http 局域网地址）没有 clipboard，之前 ?. 一短路就什么都不说
    if (!navigator.clipboard) {
      setNotice({ tone: 'error', text: t('notice.copyFailed') })
      return
    }
    navigator.clipboard
      .writeText(label)
      .then(() => setNotice({ tone: 'info', text: t('notice.pathCopied', { path: label }) }))
      .catch(() => setNotice({ tone: 'error', text: t('notice.copyFailed') }))
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const key = `imported:${file.name}`
    const language = languageFromFilename(file.name)
    file
      .text()
      .then((text) => {
        editorRef.current?.open({ key, value: text, language })
        // 同名文件再导入一次时内容可能不一样，而 open 不会覆盖已有 model
        editorRef.current?.replace(key, text)
        openOrActivate({ key, kind: 'imported', name: file.name, language, encoding: 'UTF-8' })
        consoleRef.current?.clear()
      })
      .catch((err) =>
        setNotice({ tone: 'error', text: t('notice.fileReadFailed', { message: messageOf(err, t) }) })
      )
    // 重置 input，允许再次导入同一文件
    e.target.value = ''
  }

  function downloadCode(file: ActiveFile, code: string) {
    const ext = file.language === 'typescript' ? 'ts' : 'js'
    // 内置 Demo 的 name 是带目录的相对路径，下载文件名不能有斜杠
    const base = file.name.split('/').pop() || `code.${ext}`
    // 未命名的名字没有后缀（「未命名-1」），按语言补一个
    const filename = file.kind === 'untitled' ? `${file.name}.${ext}` : withLanguageExt(base, file.language)

    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleDownload() {
    if (!active) return
    downloadCode(active, editorRef.current?.getValue(active.key) ?? '')
  }

  /**
   * 保存一个文件：本地文件写回磁盘；未命名文件在开着本地目录时存进选中的目录；其余退回下载。
   * 返回「现在可以当它已经保存了吗」：写盘成功 / 已下载为 true；写盘失败为 false；
   * 未命名进了起名流程也是 false —— 真正的落盘在用户回车之后（见 fileDraft.onOpenFile）。
   * Ctrl+S 和关闭脏标签时的「保存」都走这里。
   */
  const saveFile = useCallback(
    async (file: ActiveFile): Promise<boolean> => {
      const code = editorRef.current?.getValue(file.key) ?? ''

      if (file.kind !== 'local' || !file.handle) {
        // 未命名 + 已经打开了本地目录：它缺的只是一个名字和一个位置，
        // 让用户在侧边栏里补上，比丢进下载目录有用得多
        if (file.kind === 'untitled' && workspace.hasRoot) {
          promotingKeyRef.current = file.key
          fileDraft.start('file', {
            content: code,
            defaultName: `${file.name}.${file.language === 'typescript' ? 'ts' : 'js'}`,
          })
          setNotice({
            tone: 'info',
            text: t('notice.draftWillSaveTo', { path: displayPath(workspace.target) }),
          })
          return false
        }
        downloadCode(file, code)
        setNotice({ tone: 'info', text: t('notice.noWriteTarget') })
        return true
      }
      // 防重入：上一次还没写完就不要再排一个。用 ref 而不是 state —— 保存可能很快，
      // state 更新是异步的，两个连续的 Ctrl+S 会读不到刚 set 的 true
      if (savingRef.current) return false
      savingRef.current = true
      setSaving(true)
      try {
        const lastModified = await writeTextFile(file.handle, code)
        localMetaRef.current.set(file.key, { handle: file.handle, lastModified })
        editorRef.current?.markSaved(file.key)
        setNotice({ tone: 'info', text: t('notice.saved', { name: file.name }) })
        return true
      } catch (err) {
        setNotice({ tone: 'error', text: t('notice.saveFailed', { message: messageOf(err, t) }) })
        return false
      } finally {
        savingRef.current = false
        setSaving(false)
      }
      // fileDraft 每次渲染都是新对象，这个 useCallback 实际不再缓存 —— 无所谓：
      // Editor 是通过 ref 读 onSave 的，换个函数身份不会让它重建
    },
    [setNotice, workspace.hasRoot, workspace.target, displayPath, fileDraft, t]
  )

  /** Ctrl+S：保存当前激活的文件 */
  const handleSave = useCallback(async () => {
    const file = activeRef.current
    if (file) await saveFile(file)
  }, [activeRef, saveFile])


  useExternalChangeWatcher({ activeRef, dirtyRef, localMetaRef, editorRef, setTabs, setNotice, t })

  // 运行：在 Web Worker 里执行用户代码，主线程不卡，死循环也能用「停止」强制终止。
  // TS 代码先由 Monaco 的 TS worker 转成 JS（见 lib/compile.ts）。
  function runCode() {
    if (!active || !runnable) return
    consoleRef.current?.clear()
    void codeRunner.run(
      editorRef.current?.getValue(active.key) ?? '',
      language,
      active.key,
      moduleHost(active)
    )
    setRunning(true)
  }

  // 跨文件 import 需要的能力（见 lib/module-graph.ts 的 ModuleHost）：只有本地目录里的文件
  // 才有「所在目录」可以解析相对路径；未命名 / 内置示例 / 导入的文件传 null，runner 会报清楚
  function moduleHost(file: ActiveFile): ModuleHost | null {
    if (file.kind !== 'local') return null
    return {
      entryPath: file.key.slice('local:'.length),
      exists: async (path) => (await workspace.resolveFilePath(path)) !== null,
      readSource: async (path) => {
        const name = path.slice(path.lastIndexOf('/') + 1)
        const lang = languageOf(name) ?? 'javascript'
        // 已在编辑器里打开的文件用缓冲区（未保存的改动也算），和用户眼前看到的一致
        const key = `local:${path}`
        const ed = editorRef.current
        if (ed?.has(key)) return { code: ed.getValue(key), language: lang }
        const handle = await workspace.resolveFilePath(path)
        if (!handle) return null
        return { code: (await readTextFile(handle)).text, language: lang }
      },
      displayName: (path) => displayPath(path),
    }
  }

  // 停止：terminate worker，立即终止运行（包括 while(true) 死循环）
  function stopCode() {
    codeRunner.stop()
    setRunning(false)
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)]">
      {/* 顶部工具栏 */}
      <HeaderBar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
        showImport={!workspace.supported}
        onImport={handleImport}
      />

      {/* warn / error 的右下角浮层通知；info 类反馈显示在底部状态栏 */}
      <NoticeBar notice={notice} onClose={() => setNotice(null)} />

      <div className="flex min-h-0 flex-1">
        <Sidebar
          workspace={workspace}
          draft={fileDraft}
          templates={templates}
          activeKey={active?.key ?? null}
          dirtyKeys={dirtyKeys}
          collapsed={sidebarCollapsed}
          onOpenTemplate={(path) => void openTemplate(path)}
          onOpenLocalFile={(entry) => void openLocalFile(entry)}
          onSaveDemos={() => void saveDemos()}
          onCancelSave={() => void cancelSave()}
          cancelling={cancelling}
          saveProgress={saveProgress}
          onRenameEntry={fileDraft.startRename}
          onDeleteEntry={(entry) => void handleDelete(entry)}
          onCopyPath={handleCopyPath}
          onCloseRoot={(root) => void handleCloseRoot(root)}
        />

        {/* 主区域：编辑器 + 输出。铺满剩余空间，中间/外边不留距，两者可拖拽分栏 */}
        <main
          ref={mainRef}
          className="flex min-h-0 min-w-0 flex-1 overflow-hidden max-md:flex-col"
        >
          {/* 左：编辑器（窄屏时在上） */}
          <section
            data-editor-pane
            style={editorW === null || narrow ? undefined : { width: editorW, flex: '0 0 auto' }}
            className={cn(
              'flex min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--panel-bg)]',
              (editorW === null || narrow) && 'flex-1'
            )}
          >
            {/* 编辑器头部（单行，与 Console 头部同高同线）：左=可滚动标签区，右=动作簇。
                动作不再单独叠一行，直接并进标签这行 —— 顶部只有一条，两块才显得是一整块 */}
            {/* 头部单行，底边与 Console 头部同一根发丝线，两栏才像一整块。
                激活 tab 用正文色底（--tab-active-bg），紧贴这条线向上与其连成一片 */}
            <div className="flex h-9 shrink-0 items-stretch border-b border-[var(--border)] bg-[var(--tab-bar-bg)]">
              {/* 标签区（无左右箭头，滚动靠滚轮 / 悬浮进度条，同 VS Code）。
                  外层用命名 group/tabs 控进度条浮现，避免它作为裸 .group 把每个 tab
                  的 group-hover 一并点亮（那样整排关闭按钮会一起出现） */}
              <TabStrip
                tabs={tabs}
                activeKey={activeKey}
                dirtyKeys={dirtyKeys}
                onSwitch={switchTab}
                onClose={(key) => void closeTab(key)}
                onCloseOthers={(key) => void menuCloseOthers(key)}
                onCloseToRight={(key) => void menuCloseToRight(key)}
                onCloseAll={() => void menuCloseAll()}
                onNew={openUntitled}
              />
              {/* 动作簇：保存/下载、停止、运行，针对当前激活文件，固定在一端。用 border-s：
                  RTL 下该分隔自动落在朝向标签区的一侧 */}
              <div className="flex shrink-0 items-center gap-0.5 border-s border-[var(--border)] px-1.5">
              <div className="flex items-center gap-1">
                {/* 未命名文件在开着本地目录时也能「保存」——存到侧边栏选中的那个目录里 */}
                {active?.kind === 'local' || (active?.kind === 'untitled' && workspace.hasRoot) ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void handleSave()}
                    disabled={saving}
                    title={saving ? t('editor.saving') : t('editor.save')}
                    aria-label={saving ? t('editor.saving') : t('editor.save')}
                  >
                    <Icon className={`${saving ? 'icon-[lucide--loader-circle] animate-spin' : 'icon-[lucide--save]'}`} />
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={handleDownload}
                    disabled={!active}
                    title={t('editor.download')}
                    aria-label={t('editor.download')}
                  >
                    <Icon className="icon-[lucide--download]" />
                  </Button>
                )}
                {/* 停止绝大多数时间是禁用态，用实心 destructive 会在工具栏里凭空压出一块
                    红色；改成 ghost + 红字，只在真的能点时才抢注意力 */}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-[var(--accent-error)] hover:bg-[var(--accent-error)]/10 hover:text-[var(--accent-error)]"
                  onClick={stopCode}
                  disabled={!running}
                  title={`${t('editor.stop')} (${shortcut.stop})`}
                  aria-label={t('editor.stop')}
                >
                  <Icon className="icon-[lucide--square]" />
                </Button>
                {/* Run 禁用时按钮是 pointer-events-none，title 不弹；用外层 span 承载说明 */}
                <span
                  className="inline-flex"
                  title={runnable ? `${t('editor.run')} (${shortcut.run})` : t('editor.runDisabled')}
                >
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-[var(--primary)] hover:bg-[var(--primary)]/12 hover:text-[var(--primary)]"
                    onClick={runCode}
                    disabled={!runnable}
                    aria-label={t('editor.run')}
                  >
                    <Icon className="icon-[lucide--play] [&_[data-slot=icon]]:size-3.5" />
                  </Button>
                </span>
                </div>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              <Editor
                ref={editorRef}
                onRun={runCode}
                onStop={stopCode}
                onCloseTab={closeActiveTab}
                onNewFile={openUntitled}
                onDirtyChange={handleDirtyChange}
                onChange={(key, value) => {
                  if (isUntitledKey(key)) untitled.update(key, value)
                }}
                onSave={handleSave}
                onCursorStatus={setCursor}
              />
            </div>
          </section>

          {/* 右：输出。Console 头部与编辑器头部同为 h-9 + 一条 border-b，两条底边落在
              同一水平线，配合下方紧贴的分栏，两栏看起来像被中间一条发丝线分成的一整块 */}
          {/* 拖拽分栏：命中区本身铺面板色，因此不露 app 背景、没有“暗缝”；两栏基本紧贴，
              平时只留一根细缝线，鼠标放上去加粗到 4px 并亮主色，拖动时保持 hover 那个亮度 */}
          <div
            role="separator"
            aria-orientation="vertical"
            tabIndex={0}
            onPointerDown={startSplitDrag}
            // 键盘也能调：左右方向键每次挪 24px（RTL 下方向反过来）
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
              const wrap = mainRef.current
              if (!wrap) return
              e.preventDefault()
              const wrapW = wrap.getBoundingClientRect().width
              const cur = wrap.querySelector('[data-editor-pane]')?.getBoundingClientRect().width ?? wrapW / 2
              const sign = (e.key === 'ArrowRight') === !isRtl() ? 1 : -1
              const next = Math.min(Math.max(cur + sign * 24, CONSOLE_MIN), Math.max(CONSOLE_MIN, wrapW - CONSOLE_MIN))
              setEditorW(Math.round(next))
            }}
            title={t('panes.resize')}
            aria-label={t('panes.resize')}
            className="group relative w-[5px] shrink-0 cursor-col-resize touch-none select-none bg-[var(--panel-bg)] outline-none focus-visible:bg-[var(--primary)]/30 max-md:hidden"
          >
            <span
              className={cn(
                'absolute inset-y-0 left-1/2 -translate-x-1/2 transition-[width,background-color] duration-100',
                splitting
                  ? 'w-[4px] bg-[var(--primary)]/70'
                  : 'w-px bg-[var(--border)] group-hover:w-[4px] group-hover:bg-[var(--primary)]/70'
              )}
            />
          </div>
          <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--panel-bg)] max-md:min-h-[180px] max-md:border-t max-md:border-[var(--border)] md:min-w-[220px]">
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--border)] ps-3 pe-1.5 text-[12.5px] tracking-wide text-[var(--text-muted)]">
              <span>Console</span>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => consoleRef.current?.clear()}
                title={t('console.clear')}
                aria-label={t('console.clear')}
              >
                <Icon className="icon-[lucide--ban]" />
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <Console ref={consoleRef} />
            </div>
          </section>
        </main>
      </div>

      <StatusBar
        active={active}
        cursor={cursor}
        language={language}
        displayPath={displayPath}
        message={notice?.tone === 'info' ? notice.text : null}
      />

      {/* 隐藏的文件选择框，用于「导入」按钮读取本地代码文件（那个按钮只在不支持
          目录 API 的浏览器上出现）。
          不收 .jsx/.tsx：运行环境是没有 DOM 的 Web Worker，JSX 编译出来也没法渲染 */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".js,.mjs,.cjs,.ts,.mts,.txt"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* 删除、目录改名的二次确认。自己不持有状态，内容由发起方拼好传进来 */}
      <ConfirmDialog confirm={confirm} />
    </div>
  )
}

export default App
