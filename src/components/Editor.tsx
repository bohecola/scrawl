import { useRef, useEffect, useImperativeHandle, forwardRef, useMemo } from 'react'
import { monaco, modelUri } from '@/monaco/setup'
import type { editor as MonacoEditorType, IDisposable } from 'monaco-editor'
import { debounce, sortBy } from 'lodash-es'
import { useTheme } from '@/theme/index'
import { useSettings, fontFamilyOf, type EditorSettings } from '@/settings/context'
import { resolveEditorTheme } from '@/monaco/themes'

/*
  一个编辑器实例 + 每个文件一个 model。

  为什么不是「切文件就 setValue」：那样撤销历史、光标、折叠、滚动位置全都跟着串台 ——
  在 A 文件里按 Ctrl+Z 会撤销到 B 文件的内容。Monaco 的设计本来就是一个 model 一个文件，
  切换靠 setModel + restoreViewState，撤销栈天然挂在 model 上。
*/

/** 一次「打开文件」需要的信息。value 只在第一次为这个 key 建 model 时用得上。 */
export interface OpenFileSpec {
  key: string
  value: string
  language: string
  /**
   * 新建 model 时就算脏，直到 markSaved / replace 才干净。
   * 给刷新后恢复的未命名文件用：内容从 IndexedDB 来，但它还没落过盘，
   * 标签上的点得接着亮，不能因为「和恢复出来的基线一样」就当已保存。
   */
  dirty?: boolean
}

/**
 * 编辑器的「光标 + 缩进 + 换行符」快照，App 拿去塞底部状态栏（Ln, Col / Spaces: N / LF）。
 * position 在没 model 时为 undefined —— 状态栏自然不显示光标那两格。
 * useTabs / indentSize 反映当前 model 实际的缩进配置（Monaco 会按文件内容自动推断）。
 */
export interface CursorStatus {
  position?: { line: number; column: number }
  /** true = 用 Tab 缩进；false = 用空格 */
  useTabs: boolean
  /** 缩进宽度（tabSize） */
  indentSize: number
  /** 换行符：LF 或 CRLF */
  eol: 'LF' | 'CRLF'
}

export interface EditorHandle {
  /** 打开（必要时新建）某个 key 对应的 model 并切过去 */
  open: (file: OpenFileSpec) => void
  /** 这个 key 的 model 还在不在（可能已被 LRU 淘汰）。在的话内容不必重新读一遍。 */
  has: (key: string) => boolean
  /**
   * 声明一批「钉住」的 key：这些 model 不会被 LRU 淘汰。
   * 用于顶部多标签 —— 每个打开的标签都要常驻，切回去时内容、光标才都在，
   * 不会因为 model 被淘汰而重读盘 / 丢视图状态。App 在标签集合变化时调用。
   */
  setPinnedKeys: (keys: string[]) => void
  /** 整体替换内容并把「已保存」基线重置到此刻（用于新建清空、从磁盘重载） */
  replace: (key: string, value: string) => void
  getValue: (key?: string) => string
  setLanguage: (key: string, language: string) => void
  /** 保存成功后调用：把当前版本记为基线，脏标记归零 */
  markSaved: (key: string) => void
  close: (key: string) => void
  /**
   * 改名：把内容、脏状态、光标 / 滚动搬到新 key 上，旧 model 丢掉。
   * 撤销历史留不住 —— model 的 URI 改不了，只能新建一个（和「未命名转正」一样的取舍）。
   * 和 close 一样不为旧 key 发 onDirtyChange，由调用方自己清。
   */
  rekey: (oldKey: string, newKey: string, language?: string) => void
  focus: () => void
}

interface EditorProps {
  onDirtyChange?: (key: string, dirty: boolean) => void
  /** 内容变了（用户编辑；replace 之类的程序性替换不算）。未命名文件靠它持久化 */
  onChange?: (key: string, value: string) => void
  onSave?: () => void
  /** Ctrl/Cmd+Enter */
  onRun?: () => void
  /** Shift+F5（VS Code 的「停止调试」） */
  onStop?: () => void
  /** Alt+W：关闭当前标签。⌘W / Ctrl+W 被浏览器保留，见 platform.ts 的 shortcut.closeTab */
  onCloseTab?: () => void
  /** Alt+N：新建未命名文件。⌘N / Ctrl+N 同样归浏览器 */
  onNewFile?: () => void
  /** 光标位置或 model（切换文件）变化时上报当前光标 + 缩进，驱动状态栏 */
  onCursorStatus?: (status: CursorStatus) => void
}

/**
 * 同时保留多少个 model。切文件要保住撤销历史和光标位置，所以 model 不能随手 dispose；
 * 但每个 model 都占着内存、还在 TS 语言服务里算一份文件，也不能无限攒。
 * 12 个足够覆盖「在几个文件间来回切」的实际用法。
 */
const MAX_MODELS = 12

interface ModelRecord {
  model: MonacoEditorType.ITextModel
  viewState: MonacoEditorType.ICodeEditorViewState | null
  /** 「已保存」那一刻的 alternativeVersionId；脏标记就是拿它和当前值比 */
  savedVersionId: number
  dirty: boolean
  listener: IDisposable
  /** 单调递增的访问序号，用于 LRU 淘汰 */
  lastUsed: number
}

/** 设置面板里那几项对应的 Monaco 选项（主题单独走 setTheme） */
function editorOptions(s: EditorSettings): MonacoEditorType.IEditorOptions {
  return {
    fontSize: s.fontSize,
    fontFamily: fontFamilyOf(s.fontFamily),
    fontLigatures: s.fontLigatures,
    wordWrap: s.wordWrap ? 'on' : 'off',
    minimap: { enabled: s.minimap },
    lineNumbers: s.lineNumbers ? 'on' : 'off',
  }
}

const Editor = forwardRef<EditorHandle, EditorProps>(
  ({ onDirtyChange, onChange, onSave, onRun, onStop, onCloseTab, onNewFile, onCursorStatus }, ref) => {
  const editorRef = useRef<MonacoEditorType.IStandaloneCodeEditor | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const modelsRef = useRef(new Map<string, ModelRecord>())
  const activeKeyRef = useRef<string | null>(null)
  // 顶部标签对应的 key 集合：这些 model 常驻、不被 LRU 淘汰。App 每次改标签集合都会同步
  const pinnedRef = useRef(new Set<string>())
  // 挂载 effect 跑之前 App 就可能调 open（父组件的 effect 后于子组件），先记下来。
  // 是个队列而不是一个：启动时恢复多份未命名文件会连着 open 好几次，每一份的内容都得建成 model，
  // 只留最后一次的话，其余的在之后切过去时会被当成空文件重建
  const pendingOpenRef = useRef<OpenFileSpec[]>([])
  const { effective } = useTheme()
  const { settings } = useSettings()

  // 回调走 ref：Monaco 命令和 window 监听都只注册一次，
  // 直接闭包捕获 prop 会永远调用首次渲染那一版
  const callbacksRef = useRef({ onDirtyChange, onChange, onSave, onRun, onStop, onCloseTab, onNewFile, onCursorStatus })
  callbacksRef.current = { onDirtyChange, onChange, onSave, onRun, onStop, onCloseTab, onNewFile, onCursorStatus }

  // 创建 effect 刻意不依赖主题，用 ref 读当前值 —— 主题变化由下面的 effect 增量应用，
  // 放进依赖数组会让编辑器被重建
  const themeRef = useRef(effective)
  themeRef.current = effective
  // 同上：创建时读一次，之后由 updateOptions 增量应用
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // 保持同一个 debounce 实例，避免每次渲染新建导致 effect 重跑、Monaco 被反复 dispose
  const handleResize = useMemo(() => debounce(() => editorRef.current?.layout(), 100), [])

  const api = useMemo<EditorHandle>(() => {
    let clock = 0
    // setValue 会同步触发 onDidChangeContent，而此刻基线还没更新，
    // 会先报一次「脏」再报「干净」。用它把那次通知吃掉。
    let applying = false

    const notifyDirty = (key: string, dirty: boolean) => {
      const rec = modelsRef.current.get(key)
      if (!rec || rec.dirty === dirty) return
      rec.dirty = dirty
      callbacksRef.current.onDirtyChange?.(key, dirty)
    }

    const drop = (key: string, rec: ModelRecord) => {
      rec.listener.dispose()
      rec.model.dispose()
      modelsRef.current.delete(key)
    }

    // 只淘汰到刚好不超上限，且只挑「干净 + 非当前 + 非钉住」的：
    // 脏 model 一旦 dispose，用户没保存的内容就没了，宁可暂时超出上限；
    // 钉住的（顶部打开标签）要常驻，不能因为开得多了被挤掉
    const evict = () => {
      const models = modelsRef.current
      const victims = sortBy(
        [...models.entries()].filter(
          ([key, rec]) =>
            key !== activeKeyRef.current && !rec.dirty && !pinnedRef.current.has(key)
        ),
        ([, rec]) => rec.lastUsed
      )
      for (const [key, rec] of victims) {
        if (models.size <= MAX_MODELS) break
        drop(key, rec)
      }
    }

    const ensure = (file: OpenFileSpec): ModelRecord => {
      const existing = modelsRef.current.get(file.key)
      if (existing) return existing

      const model = monaco.editor.createModel(file.value, file.language, modelUri(file.key))
      const rec: ModelRecord = {
        model,
        viewState: null,
        // dirty 的 model 基线给一个永远对不上的版本号：怎么改都是脏，直到 markSaved / replace 重置
        savedVersionId: file.dirty ? -1 : model.getAlternativeVersionId(),
        dirty: false,
        listener: model.onDidChangeContent(() => {
          if (applying) return
          notifyDirty(file.key, model.getAlternativeVersionId() !== rec.savedVersionId)
          callbacksRef.current.onChange?.(file.key, model.getValue())
        }),
        lastUsed: 0,
      }
      modelsRef.current.set(file.key, rec)
      if (file.dirty) notifyDirty(file.key, true)
      return rec
    }

    const resolve = (key?: string) => {
      const k = key ?? activeKeyRef.current
      return k === null ? undefined : modelsRef.current.get(k)
    }

    return {
      open: (file) => {
        const editor = editorRef.current
        if (!editor) {
          pendingOpenRef.current.push(file)
          return
        }
        // 先把离开的那个文件的视图状态收好（光标、滚动、折叠）
        const leaving = resolve()
        if (leaving) leaving.viewState = editor.saveViewState()

        const rec = ensure(file)
        rec.lastUsed = ++clock
        activeKeyRef.current = file.key
        if (editor.getModel() !== rec.model) editor.setModel(rec.model)
        if (rec.viewState) editor.restoreViewState(rec.viewState)
        evict()
      },

      has: (key) => modelsRef.current.has(key),

      setPinnedKeys: (keys) => {
        pinnedRef.current = new Set(keys)
      },

      replace: (key, value) => {
        const rec = modelsRef.current.get(key)
        if (!rec) return
        applying = true
        // setValue 会清空撤销栈，这正是「内容来自外部」想要的：
        // 留着旧的撤销历史，用户一按 Ctrl+Z 就回到和磁盘不一致的状态
        rec.model.setValue(value)
        applying = false
        rec.savedVersionId = rec.model.getAlternativeVersionId()
        notifyDirty(key, false)
      },

      getValue: (key) => resolve(key)?.model.getValue() ?? '',

      setLanguage: (key, language) => {
        const rec = modelsRef.current.get(key)
        if (rec) monaco.editor.setModelLanguage(rec.model, language)
      },

      markSaved: (key) => {
        const rec = modelsRef.current.get(key)
        if (!rec) return
        rec.savedVersionId = rec.model.getAlternativeVersionId()
        notifyDirty(key, false)
      },

      close: (key) => {
        const rec = modelsRef.current.get(key)
        if (!rec) return
        if (activeKeyRef.current === key) {
          editorRef.current?.setModel(null)
          activeKeyRef.current = null
        }
        pinnedRef.current.delete(key)
        drop(key, rec)
      },

      rekey: (oldKey, newKey, language) => {
        const rec = modelsRef.current.get(oldKey)
        if (!rec || oldKey === newKey) return
        const editor = editorRef.current
        const wasActive = activeKeyRef.current === oldKey
        // 当前文件的光标 / 滚动要从编辑器上现取：rec.viewState 是上次切走时存的
        const viewState = wasActive ? (editor?.saveViewState() ?? rec.viewState) : rec.viewState

        const next = ensure({
          key: newKey,
          value: rec.model.getValue(),
          language: language ?? rec.model.getLanguageId(),
        })
        next.viewState = viewState
        next.lastUsed = ++clock
        // 钉住关系跟着 key 走：改名后新的 key 要接替旧的继续常驻
        if (pinnedRef.current.has(oldKey)) {
          pinnedRef.current.delete(oldKey)
          pinnedRef.current.add(newKey)
        }
        // 脏状态要原样带过去：磁盘上那份是改名前保存的内容，未保存的改动确实还没落盘，
        // 侧边栏那个点不能掉。-1 和任何真实的 alternativeVersionId（从 1 起）都不相等。
        if (rec.dirty) {
          next.savedVersionId = -1
          notifyDirty(newKey, true)
        }

        // 先把编辑器挂到新 model 上再 dispose 旧的：反过来会让编辑器短暂持有一个已销毁的 model。
        // 也因此不能走 close()，它在 active 时会先把 model 置空，屏幕会闪一下
        if (wasActive) {
          activeKeyRef.current = newKey
          editor?.setModel(next.model)
          if (viewState) editor?.restoreViewState(viewState)
        }
        drop(oldKey, rec)
        evict()
      },

      focus: () => editorRef.current?.focus(),
    }
  }, [])

  // 只在挂载时创建 Monaco 实例。model: null —— 内容一律由 open() 提供，
  // 让 create 自己造一个匿名 model 只会多出一个没人管的 model。
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    // 拿到本次挂载用的那张表，供 cleanup 使用（清理时不能再去读 ref）
    const models = modelsRef.current

    const editor = monaco.editor.create(container, {
      model: null,
      theme: resolveEditorTheme(settingsRef.current.editorTheme, themeRef.current),
      automaticLayout: true,
      ...editorOptions(settingsRef.current),
    })
    editorRef.current = editor

    // 编辑器有焦点时的 Ctrl/Cmd+S 由 Monaco 的 keybinding 接住，
    // 它会 preventDefault，浏览器的「保存网页」不会弹出来
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      callbacksRef.current.onSave?.()
    })
    // 运行 / 停止也接在编辑器上：写完代码手不用离开键盘。
    // Ctrl+Enter 原本是 Monaco 的「在下方插入一行」，playground 里运行更常用
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      callbacksRef.current.onRun?.()
    })
    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F5, () => {
      callbacksRef.current.onStop?.()
    })
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyW, () => {
      callbacksRef.current.onCloseTab?.()
    })
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyN, () => {
      callbacksRef.current.onNewFile?.()
    })

    // 状态栏的「Ln, Col / 缩进」：光标动了或换 model 就上报一次。缩进配置在 model 上
    // （Monaco 会按文件内容自动推断空格 / Tab 和宽度），随 model 一起读即可。
    const reportStatus = () => {
      const pos = editorRef.current?.getPosition()
      const model = editorRef.current?.getModel()
      const opts = model?.getOptions()
      if (!opts) return
      callbacksRef.current.onCursorStatus?.({
        position: pos ? { line: pos.lineNumber, column: pos.column } : undefined,
        useTabs: !opts.insertSpaces,
        indentSize: opts.tabSize,
        eol: model?.getEOL() === '\r\n' ? 'CRLF' : 'LF',
      })
    }
    editor.onDidChangeCursorPosition(reportStatus)
    editor.onDidChangeModel(reportStatus)
    reportStatus()

    const pending = pendingOpenRef.current
    pendingOpenRef.current = []
    for (const file of pending) api.open(file)

    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      handleResize.cancel()
      editor.dispose()
      editorRef.current = null
      for (const [key, rec] of models) {
        rec.listener.dispose()
        rec.model.dispose()
        models.delete(key)
      }
      activeKeyRef.current = null
    }
  }, [api, handleResize])

  // 焦点不在编辑器里时（比如刚在侧边栏点了文件）也要能 Ctrl+S / Ctrl+Enter / Shift+F5。
  // hasTextFocus 的判断是为了不和上面 Monaco 的命令重复触发；
  // 输入框里（改名框、对话框）不抢：那里的回车另有含义。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (editorRef.current?.hasTextFocus()) return
      const el = document.activeElement
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey
      // Alt+W 用 e.code 判断：Mac 上 Option+W 的 e.key 是「∑」
      const altOnly = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
      let action: (() => void) | undefined
      if (mod && e.key.toLowerCase() === 's') action = callbacksRef.current.onSave
      else if (mod && e.key === 'Enter') action = callbacksRef.current.onRun
      else if (e.shiftKey && e.key === 'F5') action = callbacksRef.current.onStop
      else if (altOnly && e.code === 'KeyW') action = callbacksRef.current.onCloseTab
      else if (altOnly && e.code === 'KeyN') action = callbacksRef.current.onNewFile
      if (!action) return
      e.preventDefault()
      action()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // 主题切换只改 Monaco 主题，不重建编辑器。设置里选了具体主题就用它，'auto' 跟随界面明暗
  useEffect(() => {
    monaco.editor.setTheme(resolveEditorTheme(settings.editorTheme, effective))
  }, [effective, settings.editorTheme])

  // 字号 / 字体 / 换行等：增量应用，不重建编辑器
  useEffect(() => {
    editorRef.current?.updateOptions(editorOptions(settings))
  }, [settings])

  useImperativeHandle(ref, () => api, [api])

  return <div ref={containerRef} className="h-full min-h-0" />
})

export default Editor
