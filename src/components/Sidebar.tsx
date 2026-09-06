import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clamp, groupBy, map } from 'lodash-es'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { FileIcon } from '@/components/FileIcon'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { startPointerDrag } from '@/lib/pointer-drag'
import { isMac } from '@/lib/platform'
import { MAX_ENTRIES_PER_DIR, languageOf, type Entry, type FileEntry } from '@/lib/fs-access'
import { translate, useI18n, type T } from '@/i18n/context'
import { rootAsEntry, type Workspace, type WorkspaceRoot } from '@/hooks/useWorkspace'
import type { Draft, FileDraft } from '@/hooks/useFileDraft'

/*
  左侧文件栏：上半是用户的本地目录（可以同时开多个，懒展开），下半是内置 Demo。

  宽度用手写的拖拽把手，没有引入 react-resizable-panels：整个界面只有这一条分隔线
  需要拖，而引入它意味着把编辑器/控制台那套本来没人抱怨的 flex 布局也一起改掉。
*/

const WIDTH_KEY = 'scrawl:sidebarWidth'
/**
 * Demo 那一段的展开状态。
 *
 * 键名从 `scrawl:templatesCollapsed` 换成了这个，不是为了好看：那一版的默认值是「展开」，
 * 而持久化的 effect 每次挂载都会写一遍，于是所有老用户本地都存着「展开」——
 * 沿用同一个键的话，「默认收起」这件事对他们永远不会生效。
 */
const TEMPLATES_KEY = 'scrawl:templatesOpen'
/** 上一版的键。语义正好相反，留在 localStorage 里只会让人读错，见一次清一次。 */
const LEGACY_TEMPLATES_KEY = 'scrawl:templatesCollapsed'
const MIN_WIDTH = 180
const MAX_WIDTH = 480
const DEFAULT_WIDTH = 264

/**
 * 刷新的最短转圈时长。读盘通常几毫秒就回来，转不满一圈就停，看着和没点一样。
 * 数值要和图标上的 animation-duration 一致：正好转满一整圈，收尾时不会从半圈跳回原位。
 */
const REFRESH_SPIN_MS = 500

/**
 * 每层缩进的宽度。每一行都是「箭头列 + 图标 + 名字」三段（文件行的箭头列留空，同 VS Code），
 * 子项整体相对父项右移这么多。VS Code 默认 8px；这里是等宽字体、行内又多一列图标，
 * 取 12px 层级更容易看清，又不至于把最窄 180px 的侧栏吃光。
 */
const INDENT = 12

/** 一行的左内边距。根目录行是 depth 0，它下面的第一层是 1。 */
const padOf = (depth: number) => 8 + depth * INDENT

/* 全局选中行 id 的拼法。文件/模板行直接用打开 key（local:… / builtin:…）；
   目录与根没有对应的打开 key，各带前缀，避免和同名文件撞 id。 */
const dirSelId = (path: string) => `dir:${path}`
const rootSelId = (id: string) => `root:${id}`

/**
 * 行首那个图标槽（折叠箭头 / 文件图标都放这里）。
 *
 * `flex` 不是装饰：图标是 inline-block、按基线对齐，而这个 <span> 作为 flex item
 * 的高度跟着 line-height 走（13px 字号 → 19.5px），14px 的图标于是被顶到基线上方，
 * 中线比文字高出 1.75px —— 看着就是「箭头没和文字居中」。让槽自己先居中一次，
 * 图标就只按自身高度参与外层那个 items-center，两边中线才真正对齐。
 */
const ICON_SLOT = 'flex shrink-0 items-center text-[var(--text-muted)] [&>[data-slot=icon]]:size-3.5'
/** 箭头列：目录行放展开 / 收起箭头，文件行留空占位，让图标和名字在同一层里对齐 */
const TWISTIE_SLOT =
  'flex size-3.5 shrink-0 items-center justify-center text-[var(--text-muted)] [&>[data-slot=icon]]:size-3.5'

/**
 * 平滑推进的进度条。
 *
 * 底层的真实进度是异步一步步跳上来的（demo 文件都很小，每个文件通常只报一两次），
 * 直接拿来渲染会把 50% 一步弹到 70%。这里用 rAF 把「显示的百分比」以固定速度追向
 * 真实值，看起来就是下载管理器那种连续推进，而不是一格格跳。
 */
function SmoothProgressBar({ value }: { value: number }) {
  const [shown, setShown] = useState(0)
  const shownRef = useRef(0)
  // 每次 rAF 最多推进多少个百分点。太快不「平滑」，太慢会显得很拖。
  const SPEED = 1.2

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const cur = shownRef.current
      if (Math.abs(value - cur) < 0.01) {
        shownRef.current = value
        setShown(value)
        return
      }
      const next =
        cur < value ? Math.min(cur + SPEED, value) : Math.max(cur - SPEED, value)
      shownRef.current = next
      setShown(next)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])

  return (
    <>
      <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--panel-hover)]">
        <div className="h-full bg-[var(--primary)]/70" style={{ width: `${shown}%` }} />
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-faint)]">
        {Math.round(shown)}%
      </span>
    </>
  )
}

/**
 * 内置 Demo 按所在目录分组：路径提到分组标题上，条目里只留文件名。
 *
 * t 是传进来的而不是在函数里取的 —— 这是个纯函数，不是组件，钩子在这里用不了。
 */
function groupTemplates(paths: readonly string[], t: T) {
  const byDir = groupBy(paths, (path) => {
    const rel = path.replace('../template/', '')
    const slash = rel.lastIndexOf('/')
    return slash === -1 ? t('sidebar.uncategorized') : rel.slice(0, slash)
  })
  return map(byDir, (items, dir) => ({
    dir,
    items: items.map((path) => ({ path, label: path.slice(path.lastIndexOf('/') + 1) })),
  }))
}

function readWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(raw) && raw >= MIN_WIDTH && raw <= MAX_WIDTH ? raw : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

/**
 * 树里的一行。
 *
 * 剩下的 props（含 ref）原样透传到那个 <button>：右键菜单要把事件和 ref 挂在
 * 这个可聚焦元素上，键盘的 Shift+F10 / 菜单键才打得开菜单。
 * React 19 里 ref 就是普通 prop，不用 forwardRef。
 */
interface RowProps extends React.ComponentProps<'button'> {
  depth: number
  label: string
  /** 是否命中全局选中（同 VS Code：同一时刻侧栏只有一行是选中态）。
      命中则整行无圆角平铺 --list-active 底色 + 一圈细的焦点描边。 */
  selected?: boolean
  /** 与 selected 同义，历史遗留名：当前打开文件也当选中处理。调用来统一传 selected */
  active?: boolean
  dirty?: boolean
  /** 命中忽略名单的目录、以及非文本文件：显示为淡色，但照样可点 */
  dimmed?: boolean
  icon: React.ReactNode
  /** 箭头列的内容（目录行的展开 / 收起箭头）；文件行不传，留空占位 */
  twistie?: React.ReactNode
}

/** 缩进走 padding 而不是嵌套 margin，hover 背景才能铺满整行。 */
function Row({
  depth,
  label,
  active,
  dirty,
  selected,
  dimmed,
  icon,
  twistie,
  className,
  style,
  ...rest
}: RowProps) {
  const { t } = useI18n()
  const isSelected = selected || active
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={isSelected}
      title={label}
      // style 要和外面传进来的合并：ContextMenuTrigger asChild 会往下塞一个
      // style（WebkitTouchCallout），直接 {...rest} 会把这里的缩进整个顶掉
      style={{ paddingInlineStart: padOf(depth), ...style }}
      className={cn(
        // 不加圆角：VS Code 的选中 / hover 是贴边的整行矩形
        // 预留 1px 透明边框：选中时改成主色细框，四周都画得出来、且不造成布局跳动
        'relative flex w-full items-center gap-1.5 border border-transparent py-1 pe-2 text-start text-[13px] text-[var(--text-body)]',
        // hover 只加在非选中行上，避免悬停时把选中底色盖成普通 hover
        !isSelected && 'hover:bg-[var(--panel-hover)]',
        // 选中行：整行平铺半透明底色 + 四周 1px 细框（同 VS Code 的焦点描边）
        isSelected &&
          'bg-[var(--list-active)] border-[var(--list-active-ring)]',
        dimmed && !isSelected && 'text-[var(--text-faint)]',
        className
      )}
      {...rest}
    >
      <span className={TWISTIE_SLOT}>{twistie}</span>
      <span className={ICON_SLOT}>{icon}</span>
      <span className="truncate font-mono">{label}</span>
      {dirty && (
        <span
          aria-label={t('sidebar.unsaved')}
          className="ms-auto size-1.5 shrink-0 rounded-full bg-[var(--accent-symbol)]"
        />
      )}
    </button>
  )
}

/**
 * 文件行 / 目录行的右键菜单。
 *
 * trigger 用 asChild 直接套在行本身那个 <button> 上，而不是外面包一层 <div>：
 * 落在可聚焦元素上，键盘的 Shift+F10 / 菜单键才能打开它。
 * 根目录行刻意不套 —— 那一行右边的 × 是「关闭目录」（不动磁盘），
 * 把「删掉整个目录」放在同一行上太危险。
 */
function EntryMenu({
  entry,
  onRename,
  onDelete,
  onCopyPath,
  onCreate,
  children,
}: {
  entry: Entry
  onRename: (entry: Entry) => void
  onDelete: (entry: Entry) => void
  onCopyPath: (path: string) => void
  /** 目录行才有：在这个目录里新建文件 / 文件夹（与根目录菜单里的一致） */
  onCreate?: (kind: 'file' | 'directory') => void
  children: React.ReactNode
}) {
  const { t } = useI18n()
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        className="min-w-[10rem]"
        // 菜单关掉时不要把焦点还给那一行：重命名 / 新建会当场在树里插一个输入框，
        // 焦点被抢回去等于触发输入框的失焦取消，这次操作就没了
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {onCreate && (
          <>
            <ContextMenuItem onSelect={() => onCreate('file')}>
              <Icon className="icon-[codicon--new-file]" />
              {t('menu.newFile')}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onCreate('directory')}>
              <Icon className="icon-[codicon--new-folder]" />
              {t('menu.newDir')}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onSelect={() => onCopyPath(entry.path)}>
          <Icon className="icon-[lucide--copy]" />
          {t('menu.copyPath')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onRename(entry)}>
          <Icon className="icon-[codicon--edit]" />
          {t('menu.rename')}
          {/* 快捷键：macOS 回车、其它平台 F2 */}
          <ContextMenuShortcut>
            {isMac ? 'Enter' : 'F2'}
          </ContextMenuShortcut>
        </ContextMenuItem>
        {/* 图标显式给 text-destructive：菜单项里没写颜色的图标会被统一压成 muted，
            这一项的文字是红的，图标得跟着 */}
        <ContextMenuItem variant="destructive" onSelect={() => onDelete(entry)}>
          <Icon className="icon-[codicon--trash] text-destructive" />
          {t('menu.delete')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * 行内命名输入。新建时插在子列表第一行，重命名时就地替换掉原来那一行。
 * 样式刻意照抄 Row：它应该看着就是树里的一行，
 * 而不是一个凭空插进来的表单控件（这也是没用 shadcn 的 Input 的原因，
 * 它自带的高度和 padding 和树行对不齐）。
 */
function DraftRow({ depth, draft, value }: { depth: number; draft: FileDraft; value: Draft }) {
  const { t } = useI18n()
  const renaming = value.mode === 'rename'
  return (
    <li>
      <div
        style={{ paddingInlineStart: padOf(depth) }}
        className="flex w-full items-center gap-1.5 py-1 pe-2"
      >
        <span className={TWISTIE_SLOT}>
          {value.kind === 'directory' && <Icon className="icon-[lucide--chevron-right] rtl:rotate-180" />}
        </span>
        {/* 图标跟着输入的名字变（同 VS Code）：敲完后缀就能看到它会是什么文件 */}
        <span className={ICON_SLOT}>
          <FileIcon kind={value.kind} name={value.name} />
        </span>
        <input
          // 输入框是点击「新建」/「重命名」后当场出现的，焦点必须跟过来，
          // 否则得再点一下才能打字
          autoFocus
          value={value.name}
          disabled={draft.busy}
          aria-label={
            renaming
              ? t('sidebar.renameAria')
              : value.kind === 'file'
                ? t('sidebar.newFileAria')
                : t('sidebar.newDirAria')
          }
          onChange={(e) => draft.setName(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') draft.submit()
            else if (e.key === 'Escape') draft.cancel()
          }}
          // 失焦取消而不是提交：新建和改名都是有副作用的动作，点到别处顺手建出一个
          // 「未命名.js」比丢掉几个字更烦人
          onBlur={draft.cancel}
          className="min-w-0 flex-1 rounded-sm border border-[var(--primary)]/60 bg-[var(--panel-bg)] px-1 font-mono text-[13px] text-[var(--text-primary)] outline-none"
        />
      </div>
      {value.error && (
        <p
          style={{ paddingInlineStart: padOf(depth + 1) }}
          className="pb-1 pe-2 text-[12px] leading-snug text-[var(--accent-error)]"
        >
          {translate(value.error, t)}
        </p>
      )}
    </li>
  )
}

/**
 * 根目录那一行。和普通目录行的差别：名字加粗，右边挂一个「操作」菜单，
 * 没授权时整行变成「点我恢复」。它自己不缩进，子层从 depth 1 起 ——
 * 同时开好几个目录时，缩进是唯一能看出「这堆文件属于哪个根」的线索。
 *
 * 那些动作（新建、刷新、移除）都收进一个菜单里，而不是在行尾摊开成一排图标：
 * 行尾常驻一个 × 太像「删掉这个目录」，而它其实只是从列表里去掉。
 * 菜单同时挂在 ⋯ 按钮和整行的右键上 —— 右键是 VS Code 的习惯，
 * ⋯ 是给不知道有右键这回事的人留的入口。
 */
function RootRow({
  root,
  workspace,
  draft,
  onClose,
  selected,
  onSelect,
}: {
  root: WorkspaceRoot
  workspace: Workspace
  draft: FileDraft
  onClose: (root: WorkspaceRoot) => void
  /** 是否全局选中（同 VS Code：整行高亮） */
  selected: boolean
  /** 点这一行时把它设为全局选中 */
  onSelect: () => void
}) {
  const { t } = useI18n()
  const open = workspace.expanded.has(root.id)
  // locked / missing 都读不出内容：点一下去恢复，菜单只留「移除」
  const locked = root.status !== 'ready'
  const missing = root.status === 'missing'
  // 菜单是受控的：⋯ 按钮和整行的右键要打开同一个菜单
  const [menuOpen, setMenuOpen] = useState(false)

  /*
    菜单项的动作一律等菜单关完再执行，而不是在 onSelect 里当场做。

    Radix 关菜单有退出动画，它的 FocusScope 要等动画播完才拆；在 onSelect 里就把
    输入框插进树里的话，输入框 autoFocus 拿到的焦点会被随后的 FocusScope 拆除
    甩回 <body>（实测就是这样），用户得再点一次才能打字。
    onCloseAutoFocus 正好是「已经关完、焦点还没归位」的那一刻。

    赋值都写在各个 onSelect 里，而不是抽一个 afterClose(fn) helper ——
    helper 是在渲染期间被调用的，react-hooks/refs 会把它当成「渲染时读 ref」。
  */
  const afterCloseRef = useRef<(() => void) | null>(null)

  // 新建落在这个根上，而不是当前的「目标目录」。select 是异步的，
  // start 读到的还是旧 target，所以父目录显式传进去
  const startIn = (kind: 'file' | 'directory') => {
    workspace.select(root.id)
    draft.start(kind, { parentPath: root.id })
  }

  return (
    // 选中 / hover 的底色和描边画在整行（含右端的 ⋯）上，而不是只画在名字那个 button 上：
    // 否则 ⋯ 会露在高亮区外面，像是行没铺满。行内动作叠在高亮上，同 VS Code 的资源管理器
    <div
      className={cn(
        // 预留 1px 透明边框：选中时改成主色细框，四周都画得出来、不造成布局跳动
        'group relative flex items-center border border-transparent pe-1',
        selected
          ? 'bg-[var(--list-active)] border-[var(--list-active-ring)]'
          : 'hover:bg-[var(--panel-hover)]'
      )}
    >
      <button
        role="treeitem"
        aria-expanded={open}
        aria-selected={selected}
        type="button"
        title={
          missing
            ? t('sidebar.rootMissing', { name: root.name })
            : locked
              ? t('sidebar.rootLocked', { name: root.name })
              : t('sidebar.rootHint', { name: root.name })
        }
        // 没授权时点击就是去要权限：requestPermission 只能在用户手势里发起，
        // 而这一行本身就是那个手势最自然的落点
        onClick={() => {
          if (locked) {
            void workspace.restore(root.id)
            return
          }
          workspace.select(root.id)
          void workspace.toggle(rootAsEntry(root))
          onSelect()
        }}
        // 右键落在行上，菜单开在 ⋯ 那个位置（Radix 的 DropdownMenu 是贴着
        // trigger 定位的）。位置固定反而比跟着指针跑好认。
        onContextMenu={(e) => {
          e.preventDefault()
          setMenuOpen(true)
        }}
        style={{ paddingInlineStart: padOf(0) }}
        className="relative flex min-w-0 flex-1 items-center gap-1.5 py-1 pe-1 text-start text-[13px]"
      >
        <span className={TWISTIE_SLOT}>
          {missing ? (
            <Icon className="icon-[lucide--triangle-alert]" />
          ) : locked ? (
            <Icon className="icon-[lucide--lock]" />
          ) : open ? (
            <Icon className="icon-[lucide--chevron-down]" />
          ) : (
            <Icon className="icon-[lucide--chevron-right] rtl:rotate-180" />
          )}
        </span>
        <span className={ICON_SLOT}>
          <FileIcon kind="directory" root name={root.name} expanded={open && !locked} />
        </span>
        <span
          className={cn(
            'truncate font-mono',
            locked ? 'text-[var(--text-faint)]' : 'font-medium text-[var(--text-primary)]'
          )}
        >
          {root.name}
        </span>
        {locked && (
          <span className="ms-auto shrink-0 text-[11px] text-[var(--text-faint)]">
            {missing ? t('sidebar.missing') : t('sidebar.needAuth')}
          </span>
        )}
      </button>
      {/* ⋯ 在悬停 / 聚焦 / 选中 / 菜单开着时露出来：目录多了之后，一排常驻的图标全是噪音；
          选中行常显一枚，提示「当前目录有动作可做」 */}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={t('sidebar.rootMenu', { name: root.name })}
            aria-label={t('sidebar.rootMenu', { name: root.name })}
            className={cn(
              'shrink-0 rounded-sm p-0.5 text-[var(--text-faint)] transition-opacity hover:bg-[var(--panel-hover)] hover:text-[var(--text-body)] focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100',
              selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
          >
            <Icon className="icon-[lucide--ellipsis] size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-[9rem]"
          onCloseAutoFocus={(e) => {
            // 焦点不要回到 ⋯：新建的输入框马上就要用它，
            // 回到 ⋯ 再被输入框抢走，等于给输入框来一次失焦（= 取消）
            e.preventDefault()
            const run = afterCloseRef.current
            afterCloseRef.current = null
            run?.()
          }}
        >
          {/* 没授权的目录读不出内容，新建和刷新都没有意义，但「移除」得留着 ——
              否则一个待授权的目录就再也去不掉了 */}
          {!locked && (
            <>
              <DropdownMenuItem
                onSelect={() => {
                  afterCloseRef.current = () => startIn('file')
                }}
              >
                <Icon className="icon-[codicon--new-file]" />
                {t('menu.newFile')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  afterCloseRef.current = () => startIn('directory')
                }}
              >
                <Icon className="icon-[codicon--new-folder]" />
                {t('menu.newDir')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {/* 图标显式给 text-destructive：菜单项里没写颜色的图标会被统一压成 muted */}
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => {
              afterCloseRef.current = () => onClose(root)
            }}
          >
            <Icon className="icon-[codicon--close] text-destructive" />
            {t('menu.removeRoot')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

interface TreeProps {
  path: string
  depth: number
  workspace: Workspace
  draft: FileDraft
  activeKey: string | null
  dirtyKeys: Set<string>
  /** 全局选中的行 id（见 Sidebar 里 selectedId 的说明） */
  selectedId: string | null
  /** 点某一行时把它设为全局选中。行 id 的拼法见 dirSelId / rootSelId / 打开 key */
  onSelect: (id: string) => void
  onOpenFile: (entry: FileEntry) => void
  onRenameEntry: (entry: Entry) => void
  onDeleteEntry: (entry: Entry) => void
  onCopyPath: (path: string) => void
  /** 某一行被点击/选中时回调，用于记住「最近操作的是谁」供重命名快捷键用 */
  onSelectEntry: (entry: Entry) => void
}

/** 递归渲染一层目录。没有缓存到 childrenByPath 的层不渲染（还没展开过）。 */
function Tree({
  path,
  depth,
  workspace,
  draft,
  activeKey,
  dirtyKeys,
  selectedId,
  onSelect,
  onOpenFile,
  onRenameEntry,
  onDeleteEntry,
  onCopyPath,
  onSelectEntry,
}: TreeProps) {
  const { t } = useI18n()
  const listing = workspace.childrenByPath.get(path)
  if (!listing) return null

  const editing = draft.draft
  // 新建的输入框插在这一层的第一行；重命名的输入框在下面就地替换掉那一行
  const drafting = editing?.mode === 'create' && editing.parentPath === path ? editing : null

  const rowFor = (entry: Entry) => {
    if (editing?.mode === 'rename' && editing.target?.path === entry.path) {
      return <DraftRow key={entry.path} depth={depth} draft={draft} value={editing} />
    }

    if (entry.kind === 'directory') {
      const open = workspace.expanded.has(entry.path)
      return (
        <li key={entry.path}>
          <EntryMenu
            entry={entry}
            onRename={onRenameEntry}
            onDelete={onDeleteEntry}
            onCopyPath={onCopyPath}
            // 在这个目录里新建：先把它设为新建目标（draft.start 会顺手展开它）
            onCreate={(kind) => {
              workspace.select(entry.path)
              onSelect(dirSelId(entry.path))
              draft.start(kind, { parentPath: entry.path })
            }}
          >
            <Row
              depth={depth}
              label={entry.name}
              aria-expanded={open}
              dimmed={entry.ignored}
              selected={selectedId === dirSelId(entry.path)}
              twistie={
                open ? (
                  <Icon className="icon-[lucide--chevron-down]" />
                ) : (
                  <Icon className="icon-[lucide--chevron-right] rtl:rotate-180" />
                )
              }
              icon={<FileIcon kind="directory" name={entry.name} expanded={open} />}
              // 一次点击同时做两件事：展开/收起，并把它设为新建目标 + 全局选中。
              // 不拆成「点箭头展开、点名字选中」——这条侧栏最窄只有 180px，
              // 两个命中区挤在一起只会点错。
              onClick={() => {
                workspace.select(entry.path)
                void workspace.toggle(entry)
                onSelect(dirSelId(entry.path))
                onSelectEntry(entry)
              }}
            />
          </EntryMenu>
          {open && (
            <Tree
              path={entry.path}
              depth={depth + 1}
              workspace={workspace}
              draft={draft}
              activeKey={activeKey}
              dirtyKeys={dirtyKeys}
              selectedId={selectedId}
              onSelect={onSelect}
              onOpenFile={onOpenFile}
              onRenameEntry={onRenameEntry}
              onDeleteEntry={onDeleteEntry}
              onCopyPath={onCopyPath}
              onSelectEntry={onSelectEntry}
            />
          )}
        </li>
      )
    }

    const key = `local:${entry.path}`
    const language = languageOf(entry.name)
    return (
      <li key={entry.path}>
        <EntryMenu
          entry={entry}
          onRename={onRenameEntry}
          onDelete={onDeleteEntry}
          onCopyPath={onCopyPath}
        >
          <Row
            depth={depth}
            label={entry.name}
            selected={selectedId === key}
            dirty={dirtyKeys.has(key)}
            // 认不出后缀的文件点开会被拒（可能是二进制），先在视觉上说明它不一样
            dimmed={language === null}
            icon={<FileIcon kind="file" name={entry.name} language={language} />}
            onClick={() => {
              onOpenFile(entry)
              onSelect(key)
              onSelectEntry(entry)
            }}
          />
        </EntryMenu>
      </li>
    )
  }

  return (
    <ul role="group">
      {drafting && <DraftRow depth={depth} draft={draft} value={drafting} />}
      {listing.entries.map(rowFor)}
      {listing.entries.length === 0 && !drafting && (
        <li
          style={{ paddingInlineStart: padOf(depth + 1) }}
          className="py-1 text-[12px] text-[var(--text-faint)]"
        >
          {t('sidebar.emptyDir')}
        </li>
      )}
      {listing.truncated && (
        <li
          style={{ paddingInlineStart: padOf(depth + 1) }}
          className="py-1 text-[12px] text-[var(--text-faint)]"
        >
          {/* 上限从常量取，不写在句子里：否则中英两份字典各自记一个 500，改的时候准漏 */}
          {t('sidebar.truncated', { max: MAX_ENTRIES_PER_DIR })}
        </li>
      )}
    </ul>
  )
}

export interface SidebarProps {
  workspace: Workspace
  draft: FileDraft
  /** 内置 Demo 的 glob 路径列表 */
  templates: readonly string[]
  activeKey: string | null
  dirtyKeys: Set<string>
  /** 收起时整个面板不渲染；开关在顶栏上（HeaderBar），状态由 hooks/useSidebarCollapsed 管 */
  collapsed: boolean
  onOpenTemplate: (path: string) => void
  onOpenLocalFile: (entry: FileEntry) => void
  /** 「把全部 Demo 存到本地文件夹」。选文件夹、落盘、接管成根都在 App 那边 */
  onSaveDemos: () => void
  /** 写入进行中时点「取消」：停止写入并清理已写残留 */
  onCancelSave: () => void
  /** 是否正在执行取消（点了确认、在清理残留），用于把取消按钮置灰防重复 */
  cancelling: boolean
  /** 正在把 Demo 存到本地的写入进度（文件级 + 字节级）；null 表示当前没有正在进行的保存 */
  saveProgress: {
    file: string
    doneFiles: number
    totalFiles: number
    writtenBytes: number
    totalBytes: number
  } | null
  /** 右键菜单里的两项。都只作用在树里的项上，根目录行不给（那一行的 × 是「关闭目录」） */
  onRenameEntry: (entry: Entry) => void
  onDeleteEntry: (entry: Entry) => void
  /** 右键「复制路径」：复制应用内相对路径到剪贴板 */
  onCopyPath: (path: string) => void
  /** 根目录菜单里的「移除目录」。不动磁盘，但要确认、并且要清掉这棵树里打开过的文件 */
  onCloseRoot: (root: WorkspaceRoot) => void
}

export default function Sidebar({
  workspace,
  draft,
  templates,
  activeKey,
  dirtyKeys,
  collapsed,
  onOpenTemplate,
  onOpenLocalFile,
  onSaveDemos,
  onCancelSave,
  cancelling,
  saveProgress,
  onRenameEntry,
  onDeleteEntry,
  onCopyPath,
  onCloseRoot,
}: SidebarProps) {
  const { t } = useI18n()
  const [width, setWidth] = useState(readWidth)
  // Demo 这一段默认收起：它是「要用的时候才翻开」的东西，
  // 首屏摊开一堆别人的文件名，会把上面真正在用的本地目录挤下去
  const [templatesOpen, setTemplatesOpen] = useState(() => {
    try {
      return localStorage.getItem(TEMPLATES_KEY) === '1'
    } catch {
      return false
    }
  })
  const [refreshing, setRefreshing] = useState(false)
  /** 正在拖动侧栏宽度：拖动全程把手会整条加粗变亮（同 VS Code 拖分栏） */
  const [dragging, setDragging] = useState(false)
  // 边界 hover 高亮做「延迟」：鼠标刚移到边界先不高亮（否则想在边界旁拖滚动条时会立刻
  // 弹粗线干扰），要停留一小会儿才亮（VS Code 同款）。拖动开始则立即亮。
  const [resizeHover, setResizeHover] = useState(false)
  const resizeHoverTimer = useRef<number | null>(null)
  const clearResizeHoverTimer = () => {
    if (resizeHoverTimer.current !== null) {
      window.clearTimeout(resizeHoverTimer.current)
      resizeHoverTimer.current = null
    }
  }
  const armResizeHover = () => {
    clearResizeHoverTimer()
    resizeHoverTimer.current = window.setTimeout(() => setResizeHover(true), 180)
  }
  const disarmResizeHover = () => {
    clearResizeHoverTimer()
    setResizeHover(false)
  }

  // ---- 目录列表竖向悬浮滚动条（同 VS Code：原生隐藏、不占宽，鼠标移到列表上才浮现）----
  const vScrollRef = useRef<HTMLDivElement | null>(null)
  /** thumb 几何：y=距容器顶偏移、h=高度（px），overflow 表示内容是否溢出 */
  const [vBar, setVBar] = useState({ y: 0, h: 0, overflow: false })
  /** 正在拖 thumb：拖拽中即使鼠标移出列表，滚动条也保持显示（同 VS Code 的按住态） */
  const [vBarDragging, setVBarDragging] = useState(false)
  const updateVBar = useCallback(() => {
    const el = vScrollRef.current
    if (!el) return
    const sh = el.scrollHeight
    const ch = el.clientHeight
    const h = Math.max(30, (ch * ch) / sh)
    // 只有当内容真的多到值得滚（thumb 还能明显移动，而不只是差几个像素）才显示滚动条，
    // 否则树收短后剩点边角余量也要弹一根几乎满高的条，很怪。
    const overflow = sh - ch > 12 && ch - h > 16
    if (!overflow) {
      setVBar((p) => (p.overflow ? { y: 0, h: 0, overflow: false } : p))
      return
    }
    const maxScroll = sh - ch
    const y = (el.scrollTop / maxScroll) * (ch - h)
    setVBar((p) => (p.y === y && p.h === h && p.overflow ? p : { y, h, overflow: true }))
  }, [])
  useEffect(() => {
    updateVBar()
    const el = vScrollRef.current
    if (!el) return
    const ro = new ResizeObserver(updateVBar)
    ro.observe(el)
    el.addEventListener('scroll', updateVBar, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', updateVBar)
    }
  }, [updateVBar])
  // 树内容增删会让 scrollHeight 变化但不触发上面的 ResizeObserver（容器本身没变大），
  // 所以每次渲染提交后都重算一次（带守卫，值没变就不 set，避免多余渲染）。
  useLayoutEffect(() => {
    updateVBar()
  })

  // 竖向悬浮 thumb 可拖拽滚动（同 VS Code）：按住 thumb 上下拖，把 scrollTop 带过去。
  // thumb 位移 → scrollTop 的换算按「可滚动余量 / thumb 可走空间」的比值来。
  const vDragRef = useRef<{ startY: number; startTop: number } | null>(null)
  const startVBarDrag = (e: React.PointerEvent) => {
    const el = vScrollRef.current
    if (!el) return
    e.preventDefault()
    vDragRef.current = { startY: e.clientY, startTop: el.scrollTop }
    setVBarDragging(true)
    const move = (ev: PointerEvent) => {
      const el2 = vScrollRef.current
      const st = vDragRef.current
      if (!el2 || !st) return
      const sh = el2.scrollHeight
      const ch = el2.clientHeight
      const ratio = (sh - ch) / Math.max(ch - vBar.h, 1)
      el2.scrollTop = st.startTop + (ev.clientY - st.startY) * ratio
    }
    // 全屏遮罩：拖动期间指针划过别处不触发 hover / 选中文本。不加手型光标（同 VS Code）
    startPointerDrag({
      onMove: move,
      onEnd: () => {
        setVBarDragging(false)
        vDragRef.current = null
      },
      overlay: true,
    })
  }

  // 最近一次在侧边栏点击的条目（目录或文件）。重命名快捷键（F2 / Mac 回车）作用于它。
  const selectedEntryRef = useRef<Entry | null>(null)
  // 侧栏根元素：重命名快捷键只在焦点落在侧栏里时响应
  const panelRef = useRef<HTMLDivElement | null>(null)

  // 全局选中行 id（同 VS Code：同一时刻整条侧栏只有一行高亮）。
  // 文件 / 模板行的 id 就是它们的打开 key（local:… / builtin:…），目录 / 根是带前缀的
  // 合成 id（dir:… / root:…），三者互不撞名。目录点击不影响 activeKey，所以这里独立存一份。
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // 打开某个文件/模板（activeKey 变化）视为选中了那一行；目录选中不触发 activeKey，
  // 靠各行的 onClick 显式 set，这里不用管
  useEffect(() => {
    if (activeKey) setSelectedId(activeKey)
  }, [activeKey])

  // macOS 上「回车」进入重命名，其它平台回车另有他用，F2 全平台通用（isMac 见 lib/platform）

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'F2' && !(e.key === 'Enter' && isMac)) return
      // 只在焦点落在侧栏里时响应。之前是全局的：点过一次树里的条目之后，焦点落在
      // 任何按钮上（确认框的「删除」、运行、标签页）按回车都会被这里吞掉去改名。
      const el = document.activeElement
      if (!el || !panelRef.current?.contains(el)) return
      // 输入框聚焦时不响应：重命名框里回车=保存、Escape=取消
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      const entry = selectedEntryRef.current
      if (!entry) return
      // 条目可能已经被删掉 / 所在根已移除：树里找不到就不再对它改名
      const root = workspace.rootOf(entry.path)
      const parentPath = entry.path.slice(0, entry.path.lastIndexOf('/'))
      const listing = workspace.childrenByPath.get(parentPath)
      const stillThere =
        root !== null && (listing ? listing.entries.some((x) => x.path === entry.path) : entry.path === root.id)
      if (!stillThere) {
        selectedEntryRef.current = null
        return
      }
      e.preventDefault()
      onRenameEntry(entry)
    }
    // 用捕获阶段：树里的行是 button，某些组件会在冒泡阶段 stopPropagation，捕获阶段最稳
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onRenameEntry, workspace])

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width))
      localStorage.setItem(TEMPLATES_KEY, templatesOpen ? '1' : '0')
      localStorage.removeItem(LEGACY_TEMPLATES_KEY)
    } catch {
      // 记不住就记不住
    }
  }, [width, templatesOpen])

  // 转圈至少持续 REFRESH_SPIN_MS，否则「点了刷新」这件事用户根本看不见。
  // 期间再点直接忽略，免得转圈被下一次点击打断又重来。
  async function handleRefresh() {
    if (refreshing) return
    setRefreshing(true)
    try {
      await Promise.all([
        workspace.refresh(workspace.target),
        new Promise((resolve) => setTimeout(resolve, REFRESH_SPIN_MS)),
      ])
    } finally {
      // refresh 抛错也要把转圈停下来，否则 `if (refreshing) return` 会把按钮永久锁死
      setRefreshing(false)
    }
  }

  // 手写拖拽：pointer 事件挂在 window 上，指针移出把手甚至移出窗口也不会中断。
  // 起始宽度从 DOM 上量，省掉一个「把 state 镜像到 ref」的中间层。
  const startDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const panel = e.currentTarget.parentElement
    if (!panel) return
    e.preventDefault()
    const startX = e.clientX
    const startWidth = panel.getBoundingClientRect().width
    // RTL（阿拉伯语）下面板贴右侧、把手在其 inline-end（左）缘，拖动的方向与 LTR 相反，
    // 所以把增量取反：往左拖变宽时 clientX 减小，-deltaX 才对应增宽。
    const sign = document.documentElement.dir === 'rtl' ? -1 : 1
    setDragging(true)
    clearResizeHoverTimer()
    setResizeHover(true)
    // 拖动期间锁住光标和选区，否则鼠标划过编辑器会选中一大片文字
    startPointerDrag({
      onMove: (ev) => {
        setWidth(clamp(startWidth + sign * (ev.clientX - startX), MIN_WIDTH, MAX_WIDTH))
      },
      onEnd: () => {
        setDragging(false)
        clearResizeHoverTimer()
        setResizeHover(false)
      },
      cursor: 'col-resize',
    })
  }, [])

  // 收起就整个不渲染，展开的开关在顶栏上
  if (collapsed) return null

  const groups = groupTemplates(templates, t)
  // 收起后 Demo 里的未保存改动就看不见了，在标题上留一个点顶上
  const templatesDirty = [...dirtyKeys].some((key) => key.startsWith('builtin:'))
  // 新建按钮的 title 要说清「建到哪」，否则用户看不出目标是哪个目录。
  // 多根之后路径里带的是内部 id，得先换成目录名。
  const targetLabel = workspace.displayPath(workspace.target)
  const anyLocked = workspace.roots.some((root) => root.status === 'locked')

  return (
    <div
      ref={panelRef}
      style={{ width }}
      // 不裁剪横向溢出：右缘的拖拽把手要跨在面板边界上（一半在面板外），
      // hover 时的高亮条往外长而不是往里压，才不会盖住选中行的描边
      className="relative flex shrink-0 flex-col bg-[var(--panel-bg)]"
    >
      {/* 竖向悬浮滚动条：相对定位一个外层，内层才是真正滚动区（原生隐藏），
          overlay 贴右、悬停浮现、不占宽度 */}
      <div className="group relative min-h-0 flex-1">
        <div
          ref={vScrollRef}
          // pe-px：面板右缘那根发丝线由下面的拖拽把手画在最后 1px 上，列表让出这 1px，
          // 选中行的描边才不会被它盖住（否则右边框看不见）
          className="v-scrollbar h-full min-h-0 overflow-y-auto pb-3 pe-px"
        >
        {/* ---- 本地目录 ---- */}
        {/* 分组标题吸顶（sticky），滚动时标题留在顶部、只有下面内容滚走（同 VS Code
            的分组区）。铺面板底色盖住滑过下方的条目，悬停浮现的竖向滚动条在它右侧。
            h-9：和右边的标签栏、Console 头部同高，底下那根发丝线才能跨过分栏连成一条 */}
        <div className="sticky top-0 z-10 flex h-9 items-center gap-0.5 border-b border-[var(--border)] bg-[var(--panel-bg)] px-2">
          <span className="me-auto text-[11px] tracking-wide text-[var(--text-faint)]">
            {t('sidebar.localDirs')}
          </span>
          {workspace.supported && (
            <>
              {/* 这一排用的是 codicon —— VS Code 自己那套图标，「新建文件 / 新建文件夹」
                  就是它最有辨识度的两个。它是 16px 网格上的实心画法，和别处 lucide 的
                  24px 描边混在同一行会明显更粗，所以整排统一成 codicon，
                  并且显式给到 size-3.5：icon-xs 默认的 12px 会把角上那个小加号糊掉 */}
              {/* 新建 / 刷新都作用在「目标目录」上，所以一个目录都没开时它们没有意义 */}
              {workspace.hasRoot && (
                <>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title={t('sidebar.newFileIn', { target: targetLabel })}
                    aria-label={t('sidebar.newFileIn', { target: targetLabel })}
                    className="text-[var(--text-muted)]"
                    onClick={() => draft.start('file')}
                  >
                    <Icon className="icon-[codicon--new-file] size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title={t('sidebar.newDirIn', { target: targetLabel })}
                    aria-label={t('sidebar.newDirIn', { target: targetLabel })}
                    className="text-[var(--text-muted)]"
                    onClick={() => draft.start('directory')}
                  >
                    <Icon className="icon-[codicon--new-folder] size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title={t('sidebar.refreshTarget', { target: targetLabel })}
                    aria-label={t('sidebar.refreshTarget', { target: targetLabel })}
                    className="text-[var(--text-muted)]"
                    onClick={() => void handleRefresh()}
                  >
                    <Icon
                      className={cn(
                        'icon-[codicon--refresh] size-3.5',
                        refreshing && 'animate-spin [animation-duration:500ms]'
                      )}
                    />
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                title={t('sidebar.openAnother')}
                aria-label={t('sidebar.openAnother')}
                className="text-[var(--text-muted)]"
                onClick={() => void workspace.pick()}
              >
                <Icon className="icon-[codicon--folder-opened] size-3.5" />
              </Button>
            </>
          )}
        </div>

        {!workspace.supported ? (
          <p className="px-2 pb-2 text-[12px] leading-relaxed text-[var(--text-faint)]">
            {/* 句子里要提顶栏那个按钮的名字，所以把标签当参数传进去 ——
                按钮改名时这段说明跟着变，不会脱节 */}
            {t('sidebar.unsupported', { label: t('header.import') })}
          </p>
        ) : workspace.roots.length === 0 ? (
          <div className="px-2 pb-2 pt-2">
            <Button variant="secondary" size="sm" onClick={() => void workspace.pick()}>
              <Icon className="icon-[codicon--folder-opened]" />
              {t('sidebar.openFolder')}
            </Button>
          </div>
        ) : (
          <div role="tree" aria-label={t('sidebar.localDirs')}>
            {workspace.roots.map((root) => (
              <div key={root.id}>
                <RootRow
                  root={root}
                  workspace={workspace}
                  draft={draft}
                  onClose={onCloseRoot}
                  selected={selectedId === rootSelId(root.id)}
                  onSelect={() => setSelectedId(rootSelId(root.id))}
                />
                {root.status === 'ready' && workspace.expanded.has(root.id) && (
                  <Tree
                    path={root.id}
                    depth={1}
                    workspace={workspace}
                    draft={draft}
                    activeKey={activeKey}
                    dirtyKeys={dirtyKeys}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onOpenFile={onOpenLocalFile}
                    onRenameEntry={onRenameEntry}
                    onDeleteEntry={onDeleteEntry}
                    onCopyPath={onCopyPath}
                    onSelectEntry={(entry) => {
                      selectedEntryRef.current = entry
                    }}
                  />
                )}
              </div>
            ))}
            {/* 重新授权必须发生在用户手势里，所以只能由用户点那一行把目录带回来 */}
            {anyLocked && (
              <p className="px-2 pb-1 pt-0.5 text-[12px] leading-relaxed text-[var(--text-faint)]">
                {/* 同上：引用的是行尾那个角标的文字 */}
                {t('sidebar.reauthHint', { label: t('sidebar.needAuth') })}
              </p>
            )}
          </div>
        )}

        {saveProgress && (
          <div className="mx-2 mb-2 mt-2 flex flex-col gap-1.5 rounded-md border border-[var(--border)] bg-[var(--panel-bg)] px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[12px] leading-snug text-[var(--text-faint)]">
                {saveProgress.file
                  ? t('sidebar.savingDemosFile', {
                      name: saveProgress.file.slice(saveProgress.file.lastIndexOf('/') + 1),
                      done: saveProgress.doneFiles,
                      total: saveProgress.totalFiles,
                    })
                  : t('sidebar.savingDemos', {
                      done: saveProgress.doneFiles,
                      total: saveProgress.totalFiles,
                    })}
              </span>
              <button
                type="button"
                onClick={onCancelSave}
                disabled={cancelling}
                title={cancelling ? t('sidebar.cancellingSave') : t('sidebar.cancelSave')}
                aria-label={cancelling ? t('sidebar.cancellingSave') : t('sidebar.cancelSave')}
                className="flex shrink-0 items-center gap-0.5 text-[var(--text-muted)] hover:text-[var(--text-body)] disabled:pointer-events-none disabled:opacity-60"
              >
                <Icon
                  className={`size-3.5 ${cancelling ? 'icon-[lucide--loader-circle] animate-spin' : 'icon-[lucide--x]'}`}
                />
                {cancelling && (
                  <span className="text-[11px] text-[var(--text-faint)]">{t('sidebar.cancellingSave')}</span>
                )}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <SmoothProgressBar
                value={
                  saveProgress.totalBytes > 0
                    ? (saveProgress.writtenBytes / saveProgress.totalBytes) * 100
                    : 0
                }
              />
            </div>
          </div>
        )}
        {workspace.busy && !saveProgress && (
          <p className="px-2 py-1 text-[12px] text-[var(--text-faint)]">{t('sidebar.loading')}</p>
        )}

        {workspace.error && (
          <div className="mx-2 mb-2 flex items-start gap-1 rounded-md border border-[var(--accent-error)]/40 bg-[var(--accent-error)]/10 px-2 py-1.5">
            <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-[var(--accent-error)]">
              {workspace.error}
            </p>
            <button
              type="button"
              onClick={workspace.clearError}
              aria-label={t('notice.close')}
              className="shrink-0 text-[var(--accent-error)]"
            >
              <Icon className="icon-[lucide--x] size-3.5" />
            </button>
          </div>
        )}

        {/* ---- Demo 片段 ---- */}
        <div className="mt-3 flex items-center gap-0.5 pb-1 pe-2">
          <button
            type="button"
            onClick={() => setTemplatesOpen((open) => !open)}
            aria-expanded={templatesOpen}
            className="flex min-w-0 flex-1 items-center gap-1 px-2 text-start text-[11px] tracking-wide text-[var(--text-faint)] hover:text-[var(--text-body)]"
          >
            {/* 和 ICON_SLOT 同一个道理，只是这里的图标更小、颜色跟着标题走 */}
            <span className="flex shrink-0 items-center [&>[data-slot=icon]]:size-3">
              {templatesOpen ? (
                <Icon className="icon-[lucide--chevron-down]" />
              ) : (
                <Icon className="icon-[lucide--chevron-right] rtl:rotate-180" />
              )}
            </span>
            {t('sidebar.demos')}
            {!templatesOpen && templatesDirty && (
              <span
                aria-label={t('sidebar.demosDirty')}
                className="ms-auto size-1.5 shrink-0 rounded-full bg-[var(--accent-symbol)]"
              />
            )}
          </button>
          {/* 这些 Demo 打开后改得动，但存不回去（它们是打包进来的字符串，不是磁盘上的文件）。
              存到本地文件夹之后就是普通的本地文件了，改完 Ctrl+S 直接写回 —— 所以这个
              按钮才是「真的要用它们」的入口，不支持目录 API 的浏览器上没有意义，直接不显示 */}
          {workspace.supported && (
            <Button
              variant="ghost"
              size="icon-xs"
              title={t('sidebar.saveDemos')}
              aria-label={t('sidebar.saveDemos')}
              className="text-[var(--text-muted)]"
              onClick={onSaveDemos}
              // 正在写入时禁用：重复触发会并发写、弹多个确认框、生成重复目录
              disabled={saveProgress !== null}
            >
              <Icon className="icon-[codicon--desktop-download] size-3.5" />
            </Button>
          )}
        </div>
        {templatesOpen &&
          groups.map(({ dir, items }) => (
            <div key={dir}>
              {/* 分组名和「Demo 片段」四个字对齐（越过标题上那个 12px 箭头和 4px 间距）：
                  它们是这一段的子目录，不能比根的文字还靠左 */}
              <div className="py-0.5 pe-2 ps-6 font-mono text-[12px] text-[var(--text-muted)]">{dir}</div>
              <ul>
                {items.map((item) => {
                  const key = `builtin:${item.path}`
                  return (
                    <li key={item.path}>
                      <Row
                        depth={1}
                        label={item.label}
                        selected={selectedId === key}
                        dirty={dirtyKeys.has(key)}
                        icon={
                          <FileIcon kind="file" name={item.path.slice(item.path.lastIndexOf('/') + 1)} />
                        }
                        onClick={() => {
                          onOpenTemplate(item.path)
                          setSelectedId(key)
                        }}
                      />
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
        {/* 竖向悬浮进度条：贴容器右缘、方形直角、不占宽度，悬停列表才浮现（同 VS Code）。
            浮现后可按住 thumb 上下拖拽滚动（同 VS Code）—— 平时整条 pointer-events-none 不挡
            行点击，列表 hover 时才把命中交给这一列的拖拽条 */}
        {vBar.overflow && (
          <div
            aria-hidden
            onPointerDown={startVBarDrag}
            className={cn(
              'absolute inset-y-0 end-0 w-[18px] touch-none',
              vBarDragging
                ? 'opacity-100'
                : 'pointer-events-none opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100'
            )}
          >
            <div
              className="pointer-events-none absolute end-[2px] w-[12px] bg-[var(--border-strong)]/60"
              style={{ top: vBar.y, height: vBar.h }}
            />
          </div>
        )}
      </div>

      {/* 拖拽把手：命中区 6px 好抓，跨在面板边界上（-end-[3px]：一半在面板里、一半在主区里，
          同 VS Code 的 sash）。侧栏朝主区那缘的发丝线由它承担（容器不再画 border），
          落在面板最后 1px 上；hover / 拖动时加粗到 4px 并亮主色，但只往主区那侧长，
          面板内仍只占那 1px —— 选中行的描边紧挨着它，不会被盖住。
          end-/start- 都是逻辑方向，RTL 自动镜像。 */}
      <div
        role="separator"
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={startDrag}
        // 键盘也能调：左右方向键每次挪 16px（RTL 下方向反过来）
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
          e.preventDefault()
          const rtl = document.documentElement.dir === 'rtl'
          const sign = (e.key === 'ArrowRight') === !rtl ? 1 : -1
          setWidth((w) => clamp(w + sign * 16, MIN_WIDTH, MAX_WIDTH))
        }}
        onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
        onMouseEnter={armResizeHover}
        onMouseLeave={disarmResizeHover}
        title={t('sidebar.resize')}
        className="absolute inset-y-0 -end-[3px] z-10 w-[6px] cursor-col-resize outline-none focus-visible:bg-[var(--primary)]/30"
      >
        <span
          className={cn(
            'absolute inset-y-0 start-[2px] transition-[width,background-color] duration-100',
            dragging || resizeHover
              ? 'w-[4px] bg-[var(--primary)]/70'
              : 'w-px bg-[var(--border)]'
          )}
        />
      </div>
    </div>
  )
}
