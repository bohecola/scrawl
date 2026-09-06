import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { EditorHandle } from '@/components/Editor'
import type { Confirm } from './useConfirm'
import type { T } from '@/i18n/context'
import type { ActiveFile } from '@/types'

/** 上次激活的文件，刷新后接上 */
export const ACTIVE_KEY = 'scrawl:activeKey'

interface UseTabsOptions {
  editorRef: RefObject<EditorHandle | null>
  confirm: Confirm
  t: T
  /** 最后一个标签也关掉之后调用：App 用它开一份新的未命名文件 */
  onEmpty: () => void
  /** 一批标签真的关掉了（确认过、model 已 close）。App 用它清掉未命名文件的持久化记录 */
  onClosed?: (keys: string[]) => void
  /**
   * 关闭脏标签时选了「保存」。返回 true 表示文件已经干净、可以接着关；
   * false 表示没保存成或者保存还在路上（未命名文件要先在侧栏里起名），这次关闭到此为止
   */
  onSave?: (file: ActiveFile) => Promise<boolean>
  /**
   * 这个文件「保存」是不是真的能落到某个地方（本地文件写盘、未命名存进已打开的目录）。
   * 能才给「保存 / 不保存 / 取消」；不能（保存等于下载）就只问「关闭？确认 / 取消」——
   * 关标签的时候冒出一个下载，不是用户想要的
   */
  canSave?: (file: ActiveFile) => boolean
}

/*
  多标签数据模型（VS Code 式）。

  打开的标签按顺序存一份，当前激活的是哪一个用 activeKey 记；`active` 是从它们派生的
  「当前文件」。脏标记（dirtyKeys）也归这里：它是「标签上的那个点」，和标签同生共死。

  异步流程里（关了标签、未命名转正之类）读 state 会拿到旧值，所以 tabs / activeKey /
  active / dirtyKeys 各同步一份到 ref 供回调用。写 ref 放在 effect 里而不是渲染中：
  渲染阶段写 ref 会被 react-hooks 规则拦下，而这些 ref 只有用户交互时才读，晚一个 commit 也没关系。
*/
export function useTabs({ editorRef, confirm, t, onEmpty, onClosed, onSave, canSave }: UseTabsOptions) {
  const [tabs, setTabs] = useState<ActiveFile[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const active = tabs.find((x) => x.key === activeKey) ?? null
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set())

  const tabsLiveRef = useRef<ActiveFile[]>([])
  const activeKeyLiveRef = useRef<string | null>(null)
  const activeRef = useRef<ActiveFile | null>(null)
  const dirtyRef = useRef(dirtyKeys)
  useEffect(() => {
    tabsLiveRef.current = tabs
    activeKeyLiveRef.current = activeKey
    activeRef.current = active
  }, [tabs, activeKey, active])
  useEffect(() => {
    dirtyRef.current = dirtyKeys
  }, [dirtyKeys])

  // onEmpty 走 ref：App 那边它依赖 openUntitled，而 openUntitled 又依赖这里的 openOrActivate，
  // 直接放进依赖数组会绕成环
  const onEmptyRef = useRef(onEmpty)
  const onClosedRef = useRef(onClosed)
  const onSaveRef = useRef(onSave)
  const canSaveRef = useRef(canSave)
  useEffect(() => {
    onEmptyRef.current = onEmpty
    onClosedRef.current = onClosed
    onSaveRef.current = onSave
    canSaveRef.current = canSave
  })

  // 让 Editor 保住所有打开标签的 model（不被 LRU 淘汰），这样切标签时不重读盘、不丢光标。
  const tabsKeys = useMemo(() => tabs.map((x) => x.key), [tabs])
  useEffect(() => {
    editorRef.current?.setPinnedKeys(tabsKeys)
  }, [editorRef, tabsKeys])

  // 记住上次激活的文件，刷新后接上
  useEffect(() => {
    if (!active) return
    try {
      localStorage.setItem(ACTIVE_KEY, active.key)
    } catch {
      // 记不住就记不住
    }
  }, [active])

  const handleDirtyChange = useCallback((key: string, dirty: boolean) => {
    setDirtyKeys((prev) => {
      if (prev.has(key) === dirty) return prev
      const next = new Set(prev)
      if (dirty) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  // Editor 该切到哪个 model 由调用方在之前/之后用 editorRef.open 处理（见各 open 函数）。
  const openOrActivate = useCallback((file: ActiveFile) => {
    setTabs((prev) => {
      const i = prev.findIndex((x) => x.key === file.key)
      if (i === -1) return [...prev, file]
      const next = [...prev]
      next[i] = file
      return next
    })
    setActiveKey(file.key)
  }, [])

  // 关闭某标签（供标签栏 × 用）。脏的且能保存，问「保存 / 不保存 / 取消」（同 VS Code）；
  // 脏的但保存无处可去，问「关闭？确认 / 取消」。关闭激活标签则切到相邻标签；
  // 关到最后一个就调 onEmpty（App 用它开一份新的未命名文件，与删除当前文件后一致）。
  // 注意读的都是 live ref / 本处可拿到的稳定量 —— 关闭确认可能跨 await，不能吃旧 state。
  const closeTab = useCallback(
    async (key: string) => {
      const curTabs = tabsLiveRef.current
      const file = curTabs.find((x) => x.key === key)
      if (!file) return
      if (dirtyRef.current.has(key)) {
        if (onSaveRef.current && canSaveRef.current?.(file)) {
          const choice = await confirm.choose({
            title: t('confirm.closeTab.title', { name: file.name }),
            lines: [t('confirm.closeTab.unsaved')],
            confirmText: t('confirm.closeTab.save'),
            alt: { text: t('confirm.closeTab.discard'), tone: 'danger' },
          })
          if (choice === 'cancel') return
          if (choice === 'confirm' && !(await onSaveRef.current(file))) return
        } else {
          const ok = await confirm.ask({
            title: t('confirm.discardTab.title', { name: file.name }),
            // 未命名的从来没保存过，丢的是全部内容；其它的丢的是改动
            lines: [t(file.kind === 'untitled' ? 'confirm.discardTab.untitled' : 'confirm.discardTab.unsaved')],
            confirmText: t('confirm.ok'),
            tone: 'danger',
          })
          if (!ok) return
        }
      }
      editorRef.current?.close(key)
      handleDirtyChange(key, false)
      onClosedRef.current?.([key])
      const idx = curTabs.findIndex((x) => x.key === key)
      const next = curTabs.filter((x) => x.key !== key)
      setTabs(next)
      if (activeKeyLiveRef.current === key) {
        if (next.length === 0) {
          setActiveKey(null)
          onEmptyRef.current() // 全关完 → 由调用方决定落脚点
        } else {
          // 优先右边邻居，到头了用左边
          const pick = next[Math.min(idx, next.length - 1)] ?? next[next.length - 1]
          setActiveKey(pick.key)
          editorRef.current?.open({ key: pick.key, value: '', language: pick.language })
        }
      }
    },
    [editorRef, confirm, t, handleDirtyChange]
  )

  // 从标签里移除一批 key（目录删除 / 移除根目录时用），并从 tabs / activeKey 里同步清掉。
  // 返回「被移除的标签里是否包含当前激活的」，调用方据此决定要不要开一份新的未命名文件兜底。
  const dropTabsByKeys = useCallback((keys: string[]) => {
    const kset = new Set(keys)
    const cur = activeKeyLiveRef.current
    const removedActive = !!cur && kset.has(cur)
    if (removedActive) setActiveKey(null)
    setTabs((prev) => prev.filter((x) => !kset.has(x.key)))
    return removedActive
  }, [])

  // 切换到已打开的标签（点标签栏）：把 Editor 切到那个 model，不重读内容
  const switchTab = useCallback((key: string) => {
    if (key === activeKeyLiveRef.current) return
    const file = tabsLiveRef.current.find((x) => x.key === key)
    if (!file) return
    setActiveKey(key)
    editorRef.current?.open({ key, value: '', language: file.language })
  }, [editorRef])

  // 批量关闭一批标签（标签右键菜单：关闭其他/右侧/全部）。只要这批里含未保存的脏标签，
  // 就先问一次带过整批：脏的全是本地文件时给「全部保存 / 不保存 / 取消」，
  // 否则（有未命名的得逐个起名，批量存不了；内置 / 导入的存了也只是下载）问「关闭？确认 / 取消」；
  // 然后逐个 editor.close 并从 tabs 里移除；若删掉了当前激活的，
  // 就在剩余里选一个激活（优先 prefer，其次最左），一个不剩就调 onEmpty。
  const closeMany = useCallback(
    async (keysToClose: string[], prefer?: string) => {
      const curTabs = tabsLiveRef.current
      const kset = new Set(keysToClose)
      const targets = curTabs.filter((x) => kset.has(x.key))
      if (targets.length === 0) return
      const dirtyTargets = targets.filter((x) => dirtyRef.current.has(x.key))
      if (dirtyTargets.length > 0) {
        const canSaveAll = !!onSaveRef.current && dirtyTargets.every((x) => x.kind === 'local' && x.handle)
        // 复数键：单复数由 count 经 CLDR 规则选择
        const count = dirtyTargets.length
        if (canSaveAll) {
          const choice = await confirm.choose({
            title: t('confirm.closeMany.title', { count }),
            lines: [t('confirm.closeMany.unsaved')],
            confirmText: t('confirm.closeMany.saveAll'),
            alt: { text: t('confirm.closeTab.discard'), tone: 'danger' },
          })
          if (choice === 'cancel') return
          if (choice === 'confirm') {
            for (const x of dirtyTargets) {
              if (!(await onSaveRef.current!(x))) return
            }
          }
        } else {
          const ok = await confirm.ask({
            title: t('confirm.discardMany.title', { count }),
            lines: [t('confirm.discardMany.body')],
            confirmText: t('confirm.ok'),
            tone: 'danger',
          })
          if (!ok) return
        }
      }
      for (const x of targets) {
        editorRef.current?.close(x.key)
        handleDirtyChange(x.key, false)
      }
      onClosedRef.current?.(targets.map((x) => x.key))
      const remaining = curTabs.filter((x) => !kset.has(x.key))
      setTabs(remaining)
      const curActive = activeKeyLiveRef.current
      if (curActive && kset.has(curActive)) {
        if (remaining.length === 0) {
          setActiveKey(null)
          onEmptyRef.current()
        } else {
          const pick = remaining.find((x) => x.key === prefer) ?? remaining[0]
          setActiveKey(pick.key)
          editorRef.current?.open({ key: pick.key, value: '', language: pick.language })
        }
      }
    },
    [editorRef, confirm, t, handleDirtyChange]
  )

  // 标签右键菜单命令（同 VS Code）：
  // 关闭本标签 / 关闭其他 / 关闭右侧 / 关闭全部
  const menuCloseOthers = useCallback(
    (key: string) => closeMany(tabsLiveRef.current.filter((x) => x.key !== key).map((x) => x.key), key),
    [closeMany]
  )
  const menuCloseToRight = useCallback(
    (key: string) => {
      const cur = tabsLiveRef.current
      const i = cur.findIndex((x) => x.key === key)
      if (i === -1) return
      closeMany(cur.slice(i + 1).map((x) => x.key), key)
    },
    [closeMany]
  )
  const menuCloseAll = useCallback(
    () => closeMany(tabsLiveRef.current.map((x) => x.key)),
    [closeMany]
  )



  return {
    tabs,
    setTabs,
    activeKey,
    setActiveKey,
    active,
    dirtyKeys,
    tabsLiveRef,
    activeKeyLiveRef,
    activeRef,
    dirtyRef,
    handleDirtyChange,
    openOrActivate,
    switchTab,
    dropTabsByKeys,
    closeTab,
    closeMany,
    menuCloseOthers,
    menuCloseToRight,
    menuCloseAll,
  }
}
