import { useEffect, useRef, useState } from 'react'
import {
  formatSize,
  languageOf,
  validateEntryName,
  writeTextFile,
  type Entry,
  type FileEntry,
} from '@/lib/fs-access'
import { messageOf, useI18n, type T } from '@/i18n/context'
import type { Problem } from '@/lib/app-error'
import type { Workspace } from './useWorkspace'
import { parentOf } from './useWorkspace'
import type { Confirm } from './useConfirm'

/*
  「起个名字」这一步的状态机，新建和改名共用。

  为什么不放在 Sidebar 里：进入命名状态有三个入口 —— 侧边栏的新建按钮、草稿的「保存」
  （没有 handle 可写，改为让用户给它起个名存进目标目录）、树里右键的「重命名」。
  三个入口共用同一个输入框，所以状态得放在它们的共同祖先（App）里。

  校验分两层：这里做同步的、能立刻回显在输入框下面的（名字合法性、同层重名、
  后缀能不能打开）；真正的落盘失败（权限、竞态、外部改动）由 useWorkspace
  写进 workspace.error，走侧边栏那条已有的提示条。

  改名和新建的差别全在 submit 里：重名比对要排除自己、名字没变就当取消、
  目录改名还要先过一道确认 —— 它实际是「整棵复制 + 删掉原目录」。
*/

export type DraftKind = 'file' | 'directory'

export interface Draft {
  /** create：在 parentPath 下新建；rename：改 target 的名字 */
  mode: 'create' | 'rename'
  /** 新建落在哪个目录 / 被改名的那一项在哪个目录里 */
  parentPath: string
  kind: DraftKind
  /** rename 时是被改名的那一项，create 时是 null */
  target: Entry | null
  /** 输入框的受控值 */
  name: string
  /**
   * 行内校验错误。有错时输入框不关，用户接着改就行。
   *
   * 存的是描述符而不是现成的句子：这一条会一直挂在 state 里，
   * 切语言时它得跟着变 —— 所以翻译留到渲染那一刻（Sidebar 的 DraftRow）。
   */
  error: Problem | null
  /** 草稿转正：文件建好后要写进去的内容 */
  content?: string
}

export interface FileDraft {
  draft: Draft | null
  /** 提交中：磁盘那边还没回来，这期间不接受第二次回车 */
  busy: boolean
  /**
   * 开一个新建输入框。parentPath 默认是当前的「目标目录」；
   * 根目录行的菜单要显式传 —— 它刚调过 select()，而那是个异步的 state 更新，
   * 同一个 tick 里 workspace.target 读到的还是上一个目录。
   */
  start: (
    kind: DraftKind,
    opts?: { defaultName?: string; content?: string; parentPath?: string }
  ) => void
  /** 改名：输入框就地替换掉树里的那一行，默认值是原名 */
  startRename: (entry: Entry) => void
  setName: (name: string) => void
  cancel: () => void
  submit: () => void
}

interface Callbacks {
  /** 文件建好后打开它。savedFromScratch 为 true 时内容来自草稿，调用方要收拾旧 model */
  onOpenFile: (entry: FileEntry, savedFromScratch: boolean) => void
  /** 改名成功：把编辑器里的 model、脏状态、handle 从旧 key 搬到新 key */
  onRenamed: (from: Entry, to: Entry) => void
  onNotice: (notice: { tone: 'info' | 'warn' | 'error'; text: string }) => void
}

/*
  新建时预填的名字。它会真的落到磁盘上，所以跟着界面语言走 ——
  英文界面下建出来的就该叫 Untitled.js，而不是硬留一个中文名（VS Code 也是这样）。
  写成函数是因为 t 只有在组件里才拿得到。
*/
const defaultName = (kind: DraftKind, t: T): string =>
  kind === 'file' ? t('file.untitled', { ext: 'js' }) : t('file.newDir')

export function useFileDraft(
  workspace: Workspace,
  confirm: Confirm,
  callbacks: Callbacks
): FileDraft {
  const { t } = useI18n()
  const [pending, setPending] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)

  // 回调只在用户交互时读，晚一个 commit 无所谓；放 effect 里写是为了不在渲染阶段改 ref
  const callbacksRef = useRef(callbacks)
  useEffect(() => {
    callbacksRef.current = callbacks
  })

  // 目录被关掉（或者变成「需要授权」）时输入框不能留在那儿悬着。
  // 这里直接在渲染时算掉，而不是用 effect 去清 state —— 少一轮渲染，也不用管时序。
  const parentRoot = pending ? workspace.rootOf(pending.parentPath) : null
  const draft = parentRoot && parentRoot.status === 'ready' ? pending : null
  const setDraft = setPending

  const fail = (error: Problem) => setDraft((prev) => (prev ? { ...prev, error } : prev))

  const start: FileDraft['start'] = (kind, opts = {}) => {
    if (busy) return // 上一次提交还在写盘：runCreate 收尾的 setDraft(null) 会把新开的输入框抹掉
    const parentPath = opts.parentPath ?? workspace.target
    if (!parentPath) return // 一个可用目录都没有，没地方建
    setDraft({
      mode: 'create',
      parentPath,
      kind,
      target: null,
      name: opts.defaultName ?? defaultName(kind, t),
      error: null,
      content: opts.content,
    })
    // 目标目录可能被收起过、甚至还没读过。expandDir 是幂等的，已展开时这一步什么都不做
    void workspace.expandDir(parentPath)
  }

  const startRename: FileDraft['startRename'] = (entry) => {
    if (busy) return
    setDraft({
      mode: 'rename',
      parentPath: parentOf(entry.path),
      kind: entry.kind,
      target: entry,
      name: entry.name,
      error: null,
    })
  }

  /** 同步校验，有问题返回一条待翻译的描述符，没问题返回 null。新建和改名的规则差异都在这里。 */
  const validate = (value: Draft, name: string): Problem | null => {
    const invalid = validateEntryName(name)
    if (invalid) return invalid

    // 同层重名先在本地列表里查一遍：不区分大小写，因为 Windows / macOS 的文件系统
    // 也不区分 —— 建 Foo.js 时 foo.js 已经存在，那就是同一个文件。
    // 改名时把自己排掉，顺带也就放过了「只改大小写」那种情况 ——
    // 那种能不能改由 fs-access 那层说（只有它知道文件系统区不区分大小写）
    const siblings = workspace.childrenByPath.get(value.parentPath)?.entries ?? []
    const clash = siblings.some(
      (entry) => entry.name.toLowerCase() === name.toLowerCase() && entry.path !== value.target?.path
    )
    if (clash) return { key: 'validate.exists', params: { name } }

    if (value.kind !== 'file') return null
    // 新建：只让建能打开的文本类型 —— 建出一个编辑器打不开的文件毫无意义，
    // 草稿转正时更糟：内容写进去了，却没法在界面上看见它。
    // 改名：只在原名本来就能打开时才要求（别拦住给 .png 改名），
    // 但不许把一个文本文件改成打不开的后缀 —— 那等于把它从界面上弄丢了
    const openable = value.mode === 'create' || languageOf(value.target?.name ?? '') !== null
    if (openable && languageOf(name) === null) {
      return value.mode === 'create'
        ? { key: 'validate.createExt' }
        : { key: 'validate.renameExt' }
    }
    return null
  }

  const runCreate = async (value: Draft, name: string) => {
    const { parentPath, kind, content } = value
    const entry = await workspace.createEntry(parentPath, name, kind)
    if (!entry) return // 失败原因已经在 workspace.error 里了，输入框留着让用户改名重试
    setDraft(null)

    if (entry.kind === 'directory') {
      // 建完就展开并选中它：紧接着的「新建文件」正好落在这个新目录里
      await workspace.expandDir(entry.path)
      workspace.select(entry.path)
      return
    }

    if (content !== undefined) {
      try {
        await writeTextFile(entry.handle, content)
      } catch (err) {
        callbacksRef.current.onNotice({
          tone: 'error',
          text: t('notice.createdButEmpty', { name, message: messageOf(err, t) }),
        })
      }
    }
    callbacksRef.current.onOpenFile(entry, content !== undefined)
  }

  const runRename = async (value: Draft, name: string) => {
    const target = value.target
    if (!target) return

    if (target.kind === 'directory') {
      // 关键顺序：先把输入框收掉，再弹确认框。DraftRow 的失焦就是取消，
      // 弹窗一开就抢焦点，不先收的话这次改名会被自己的 onBlur 取消掉
      setDraft(null)
      const size = await workspace.measureDirectory(target)
      if (!size) return // 太大 / 树里有 node_modules，原因已经在 workspace.error 里
      const ok = await confirm.ask({
        title: t('confirm.renameDir.title', { from: target.name, to: name }),
        lines: [
          t('confirm.renameDir.how'),
          // 复数文案：数量走 count，files 保留给文案本身用
          t('confirm.renameDir.size', { count: size.files, files: size.files, size: formatSize(size.bytes) }),
          t('confirm.renameDir.risk'),
        ],
        confirmText: t('confirm.renameDir.ok'),
      })
      if (!ok) return
    }

    const next = await workspace.renameEntry(target, name)
    // 失败原因已经在 workspace.error 里。文件改名时输入框还开着，改个名字就能再试
    if (!next) return
    setDraft(null)
    callbacksRef.current.onRenamed(target, next)
  }

  const submit = () => {
    if (!draft || busy) return
    const name = draft.name.trim()
    // 名字没动就当取消：改名输入框的默认值就是原名，回车是最顺手的「算了」
    if (draft.mode === 'rename' && name === draft.target?.name) return setDraft(null)

    const invalid = validate(draft, name)
    if (invalid) return fail(invalid)

    setBusy(true)
    void (async () => {
      try {
        if (draft.mode === 'rename') await runRename(draft, name)
        else await runCreate(draft, name)
      } finally {
        setBusy(false)
      }
    })()
  }

  return {
    draft,
    busy,
    start,
    startRename,
    setName: (name) => setDraft((prev) => (prev ? { ...prev, name, error: null } : prev)),
    // 提交中不响应取消：目录改名会弹确认框抢焦点，输入框的 onBlur 会跟着调 cancel，
    // 用户在确认框里点「取消」后草稿已经没了、没法重试
    cancel: () => {
      if (!busy) setDraft(null)
    },
    submit,
  }
}



