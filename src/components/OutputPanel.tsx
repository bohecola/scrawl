import { useCallback, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/context'
import { startPointerDrag } from '@/lib/pointer-drag'
import { isRtl } from '@/lib/platform'
import Console, { type ConsoleHandle } from './Console'
import PreviewPanel, { PreviewActions } from './PreviewPanel'
import {
  placeView,
  useOutputLayout,
  type DropZone,
  type OutputLayout,
  type OutputView,
  type SplitDirection,
} from '@/hooks/useOutputLayout'

/*
  右栏输出区：Console 与预览。

  借 VS Code 编辑器组的交互：每个视图是一张标签，标签栏右端是这个视图的动作。
  - tabs 模式：一条标签栏切换两个视图（同 DevTools 的抽屉）。
  - split 模式：两格同时可见，上下或左右，各带自己的标签栏；中间的分隔线可拖。
  - 拖标签：拖到区域的四边 → 往那一边分栏（半透明落点框预告结果）；拖到另一张标签上 →
    换序 / 换格；split 模式下拖到中央或另一格的标签栏 → 并回一条标签栏。
  - 拖拽本身看不出来能拖，所以叠三层提示：悬停标签浮出抓手、标签右键菜单把每个落点列成文字
    （向上 / 向下 / 向左 / 向右分栏、并回标签页、交换位置）、title 说明手势。
    右端的布局菜单是同一组状态的按钮入口，也放着「交换位置」。

  Console 与预览 iframe 在两种模式下都不卸载：日志历史和页面状态都活在组件里，
  形态只靠 CSS（hidden / order / flex-grow）切换。
*/

export interface OutputPanelProps {
  consoleRef: RefObject<ConsoleHandle | null>
  /** tabs 模式下当前显示的视图（切文件时由 App 决定默认值） */
  view: OutputView
  onViewChange: (view: OutputView) => void
  previewDoc: string | null
  previewMode: 'page' | 'document'
  previewDirty: boolean
  onRefreshPreview: () => void
}

/** 指针移动超过这个距离才算开始拖标签，不然是点击切换 */
const DRAG_THRESHOLD = 4
/** 距离某条边不到区域尺寸的这个比例，就算落在那条边（其余是中央） */
const EDGE = 0.3
/** 标签影子的估计宽度上限（px），用来判断它会不会撞出视口右缘 */
const GHOST_MAX_W = 96

interface DragState {
  view: OutputView
  zone: DropZone | null
  /** 最近一次有落点框的 zone：zone 短暂变 null 时框淡出而不是跳没，再进来时从原位过渡 */
  box: Exclude<DropZone, 'tab'>
  x: number
  y: number
}

// 落点框：目标半区（或整块）
const OVERLAY: Record<DragState['box'], CSSProperties> = {
  left: { left: 0, top: 0, width: '50%', height: '100%' },
  right: { left: '50%', top: 0, width: '50%', height: '100%' },
  top: { left: 0, top: 0, width: '100%', height: '50%' },
  bottom: { left: 0, top: '50%', width: '100%', height: '50%' },
  center: { left: 0, top: 0, width: '100%', height: '100%' },
}

/** 右键菜单里的四个方向：落点 → 文案键 / 图标。left / right 是物理方向，和拖拽落点一致 */
const MOVE_ITEMS = [
  { zone: 'top', key: 'output.splitUp', icon: 'icon-[lucide--panel-top]' },
  { zone: 'bottom', key: 'output.splitDown', icon: 'icon-[lucide--panel-bottom]' },
  { zone: 'left', key: 'output.splitLeft', icon: 'icon-[lucide--panel-left]' },
  { zone: 'right', key: 'output.splitRight', icon: 'icon-[lucide--panel-right]' },
] as const satisfies readonly { zone: DropZone; key: string; icon: string }[]

const LAYOUT_ICON: Record<'tabs' | SplitDirection, string> = {
  tabs: 'icon-[lucide--square]',
  vertical: 'icon-[lucide--rows-2]',
  horizontal: 'icon-[lucide--columns-2]',
}

/**
 * 指针此刻对应的落点。先看指针下的元素（另一张标签 / 另一格的标签栏），
 * 再按几何分四边和中央；最后用 placeView 过滤掉「落下去也没变化」的位置。
 */
function zoneAt(section: HTMLElement, layout: OutputLayout, view: OutputView, x: number, y: number): DropZone | null {
  const r = section.getBoundingClientRect()
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null
  const hit = document.elementFromPoint(x, y)
  let zone: DropZone
  const tab = hit?.closest('[data-output-tab]')?.getAttribute('data-output-tab')
  const strip = hit?.closest('[data-output-tabstrip]')?.getAttribute('data-output-tabstrip')
  if (tab) {
    if (tab === view) return null
    zone = 'tab'
  } else if (strip) {
    // 标签栏的空白处：split 模式下另一格的标签栏 = 并回去；自己那格 / tabs 模式没有意义
    if (strip === view || strip === 'tabs') return null
    zone = 'center'
  } else {
    const fx = (x - r.left) / Math.max(r.width, 1)
    const fy = (y - r.top) / Math.max(r.height, 1)
    const edges: [DropZone, number][] = [
      ['left', fx],
      ['right', 1 - fx],
      ['top', fy],
      ['bottom', 1 - fy],
    ]
    const [edge, d] = edges.reduce((a, b) => (b[1] < a[1] ? b : a))
    zone = d < EDGE ? edge : 'center'
  }
  return placeView(layout, view, zone, isRtl()) ? zone : null
}

export default function OutputPanel({
  consoleRef,
  view,
  onViewChange,
  previewDoc,
  previewMode,
  previewDirty,
  onRefreshPreview,
}: OutputPanelProps) {
  const { t } = useI18n()
  const { layout, layoutRef, setMode, swap, setRatio, drop } = useOutputLayout()
  const split = layout.mode === 'split'
  const vertical = layout.direction === 'vertical'
  const sectionRef = useRef<HTMLElement | null>(null)

  const label = (v: OutputView) => (v === 'console' ? 'Console' : t('panel.preview'))

  // ---- 分隔线：沿分栏方向拖，改的是第一格的占比 ----
  const [resizing, setResizing] = useState(false)
  const startResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const el = sectionRef.current
      if (!el) return
      const { direction, ratio: startRatio } = layoutRef.current
      const vert = direction === 'vertical'
      const rect = el.getBoundingClientRect()
      const size = Math.max(vert ? rect.height : rect.width, 1)
      const start = vert ? e.clientY : e.clientX
      // 左右分栏在 RTL 下镜像：第一格在右，指针往左拖是把它拉大
      const sign = vert || !isRtl() ? 1 : -1
      setResizing(true)
      startPointerDrag({
        onMove: (ev) => setRatio(startRatio + (sign * ((vert ? ev.clientY : ev.clientX) - start)) / size),
        onEnd: () => setResizing(false),
        cursor: vert ? 'row-resize' : 'col-resize',
      })
    },
    [layoutRef, setRatio]
  )
  // 键盘也能调：沿分栏方向的方向键每次挪 5%
  const onResizeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = vertical ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']
    const i = keys.indexOf(e.key)
    if (i === -1) return
    e.preventDefault()
    const forward = (i === 1) !== (!vertical && isRtl())
    setRatio(layout.ratio + (forward ? 0.05 : -0.05))
  }

  // ---- 拖标签 ----
  // 状态走 ref：pointer 回调不在 React 事件里，onEnd 要读最新的落点
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  // 拖完松手时浏览器可能还派发一次 click（按下和松开落在同一元素上），别让它误切标签
  const suppressClickRef = useRef(false)
  const startTabDrag = (view: OutputView) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const sx = e.clientX
    const sy = e.clientY
    let started = false
    const update = (next: DragState | null) => {
      dragRef.current = next
      setDrag(next)
    }
    startPointerDrag({
      onMove: (ev) => {
        if (!started) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD) return
          started = true
          // startPointerDrag 在按下时记的是原光标，结束时会照样还原
          document.body.style.cursor = 'grabbing'
        }
        const el = sectionRef.current
        const zone = el ? zoneAt(el, layoutRef.current, view, ev.clientX, ev.clientY) : null
        const prev = dragRef.current
        update({
          view,
          zone,
          box: zone && zone !== 'tab' ? zone : (prev?.box ?? 'center'),
          x: ev.clientX,
          y: ev.clientY,
        })
      },
      onEnd: () => {
        const cur = dragRef.current
        update(null)
        if (!started) return
        suppressClickRef.current = true
        // click 不一定来（松手时指针多半已不在标签上），下一个任务就把标记清掉
        setTimeout(() => (suppressClickRef.current = false), 0)
        if (cur?.zone) drop(view, cur.zone, isRtl())
      },
    })
  }

  // ---- 头部：标签 + 该视图的动作 + 布局菜单 ----
  const actionsFor = (v: OutputView): ReactNode =>
    v === 'console' ? (
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => consoleRef.current?.clear()}
        title={t('console.clear')}
        aria-label={t('console.clear')}
      >
        <Icon className="icon-[lucide--ban]" />
      </Button>
    ) : (
      // 刷新是 page 模式的语义（重跑页面）；document 模式自动刷新，按钮没有意义
      previewMode === 'page' && <PreviewActions dirty={previewDirty} onRefresh={onRefreshPreview} />
    )

  const layoutValue: 'tabs' | SplitDirection = split ? layout.direction : 'tabs'
  const layoutMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('output.layout')}
          aria-label={t('output.layout')}
          className="text-[var(--text-muted)] data-[state=open]:bg-[var(--panel-hover)] data-[state=open]:text-[var(--text-primary)]"
        >
          <Icon className={LAYOUT_ICON[layoutValue]} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuRadioGroup
          value={layoutValue}
          onValueChange={(v) => (v === 'tabs' ? setMode('tabs') : setMode('split', v as SplitDirection))}
        >
          <DropdownMenuRadioItem value="tabs">
            <Icon className={LAYOUT_ICON.tabs} />
            {t('output.layout.tabs')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="vertical">
            <Icon className={LAYOUT_ICON.vertical} />
            {t('output.layout.stacked')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="horizontal">
            <Icon className={LAYOUT_ICON.horizontal} />
            {t('output.layout.sideBySide')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={swap}>
          <Icon className={split && vertical ? 'icon-[lucide--arrow-up-down]' : 'icon-[lucide--arrow-left-right]'} />
          {t('output.swap')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  /**
   * 一条标签栏。strip 标出它属于谁（tabs 模式 'tabs'，split 模式是那一格的视图），
   * 拖拽时靠这个属性判断落点。高度、底边线和编辑器头部对齐，两栏才像一整块
   */
  const header = (strip: 'tabs' | OutputView, tabs: OutputView[], active: OutputView) => (
    <div
      data-output-tabstrip={strip}
      className="flex h-9 shrink-0 items-stretch border-b border-[var(--border)] bg-[var(--tab-bar-bg)]"
    >
      <div role="tablist" aria-orientation="horizontal" className="flex min-w-0 flex-1 items-stretch overflow-hidden">
        {tabs.map((v) => {
          const on = v === active
          const dragging = drag?.view === v
          const dropTarget = !!drag && drag.zone === 'tab' && drag.view !== v
          const rtl = isRtl()
          return (
            <ContextMenu key={v}>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  role="tab"
                  aria-selected={on}
                  data-output-tab={v}
                  onPointerDown={startTabDrag(v)}
                  onClick={() => {
                    if (!suppressClickRef.current) onViewChange(v)
                  }}
                  title={t('output.dragHint')}
                  className={cn(
                    // 同编辑器标签：激活顶部主色横线 + 正文色底，行末一条细线作分隔（border-e 跟随 RTL）。
                    // 起始侧多留一点内边距给悬停时浮出的抓手，文字位置不随悬停跳动
                    'group/tab relative flex shrink-0 touch-none select-none items-center border-e border-e-[var(--border)] ps-[22px] pe-3 text-[12.5px] transition-colors',
                    on
                      ? 'border-t-2 border-t-[var(--primary)] bg-[var(--tab-active-bg)] text-[var(--text-body)]'
                      : 'border-t-2 border-t-transparent bg-[var(--tab-inactive-bg)] text-[var(--text-muted)] hover:text-[var(--text-body)]',
                    dragging && 'opacity-40',
                    dropTarget && 'bg-[var(--list-active)] text-[var(--text-primary)]'
                  )}
                >
                  {/* 抓手：悬停才浮现，告诉人这张标签能拖。触屏没有悬停，常显 */}
                  <Icon
                    className={cn(
                      'icon-[lucide--grip-vertical] absolute start-[7px] size-3 cursor-grab text-[var(--text-faint)] opacity-0 transition-opacity group-hover/tab:opacity-100 pointer-coarse:opacity-100',
                      drag && 'opacity-100'
                    )}
                  />
                  {label(v)}
                </button>
              </ContextMenuTrigger>
              {/* 拖拽能做的事都在这里有一条文字入口，不会拖也能完成；已经在那个位置的项灰掉 */}
              <ContextMenuContent className="min-w-[160px]" onCloseAutoFocus={(e) => e.preventDefault()}>
                {MOVE_ITEMS.map((item) => (
                  <ContextMenuItem
                    key={item.zone}
                    disabled={!placeView(layout, v, item.zone, rtl)}
                    onSelect={() => drop(v, item.zone, rtl)}
                  >
                    <Icon className={item.icon} />
                    {t(item.key)}
                  </ContextMenuItem>
                ))}
                <ContextMenuSeparator />
                {split && (
                  <ContextMenuItem onSelect={() => drop(v, 'center', rtl)}>
                    <Icon className={LAYOUT_ICON.tabs} />
                    {t('output.merge')}
                  </ContextMenuItem>
                )}
                <ContextMenuItem onSelect={swap}>
                  <Icon className={split && vertical ? 'icon-[lucide--arrow-up-down]' : 'icon-[lucide--arrow-left-right]'} />
                  {t('output.swap')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        })}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 px-1.5">
        {actionsFor(active)}
        {layoutMenu}
      </div>
    </div>
  )

  // split 模式两格按 order 排、按 ratio 分；tabs 模式激活者 flex-1、另一个 hidden
  const paneStyle = (v: OutputView): CSSProperties | undefined => {
    if (!split) return undefined
    const first = layout.order[0] === v
    return { order: first ? 1 : 3, flexGrow: first ? layout.ratio : 1 - layout.ratio, flexBasis: 0 }
  }

  return (
    <section
      ref={sectionRef}
      className={cn(
        'relative flex min-h-0 flex-1 overflow-hidden bg-[var(--panel-bg)] max-md:min-h-[180px] max-md:border-t max-md:border-[var(--border)] md:min-w-[220px]',
        split && !vertical ? 'flex-row' : 'flex-col',
        // 拖标签时预览 iframe 得让路：指针进了 iframe，外面就收不到 pointermove
        drag && '[&_iframe]:pointer-events-none'
      )}
    >
      {!split && header('tabs', layout.order, view)}
      {(['console', 'preview'] as const).map((v) => (
        <div
          key={v}
          data-output-pane={v}
          style={paneStyle(v)}
          className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden', !split && (view === v ? 'flex-1' : 'hidden'))}
        >
          {split && header(v, [v], v)}
          <div className="min-h-0 flex-1">
            {v === 'console' ? (
              <Console ref={consoleRef} />
            ) : (
              <PreviewPanel srcDoc={previewDoc} mode={previewMode} />
            )}
          </div>
        </div>
      ))}
      {/* 分隔线（同编辑器分栏的 sash）：布局里只占 1px 线，两格贴着它；5px 命中区悬浮跨在线两侧，
          悬停 / 拖动时线加粗到 4px 亮主色 */}
      <div
        role="separator"
        aria-orientation={vertical ? 'horizontal' : 'vertical'}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={onResizeKey}
        title={t('output.resize')}
        aria-label={t('output.resize')}
        style={{ order: 2 }}
        className={cn(
          'group relative z-10 shrink-0 touch-none select-none bg-[var(--border)] outline-none',
          !split && 'hidden',
          vertical ? 'h-px cursor-row-resize' : 'w-px cursor-col-resize'
        )}
      >
        {/* 命中区：比线宽，向两侧各伸 2px */}
        <span className={cn('absolute', vertical ? 'inset-x-0 -inset-y-[2px]' : '-inset-x-[2px] inset-y-0')} />
        <span
          className={cn(
            'absolute bg-[var(--primary)]/70 transition-opacity duration-100',
            vertical ? 'inset-x-0 top-1/2 h-[4px] -translate-y-1/2' : 'inset-y-0 left-1/2 w-[4px] -translate-x-1/2',
            resizing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-40'
          )}
        />
      </div>
      {/* 落点框：预告松手后那格会占的位置。换区时从上一个位置滑过去；没有落点时淡出 */}
      {drag && (
        <div
          aria-hidden
          style={OVERLAY[drag.box]}
          className={cn(
            'pointer-events-none absolute z-20 border-2 border-[var(--primary)]/60 bg-[var(--primary)]/15 transition-[left,top,width,height,opacity] duration-100',
            (!drag.zone || drag.zone === 'tab') && 'opacity-0'
          )}
        />
      )}
      {/* 跟着指针走的标签影子。挂到 body：section 是 overflow-hidden，影子得能出界；
          贴近视口右缘时别被截断，退到指针左侧 */}
      {drag &&
        createPortal(
          <div
            aria-hidden
            style={{
              left: drag.x + 14 + GHOST_MAX_W > window.innerWidth ? drag.x - 14 : drag.x + 14,
              top: drag.y + 12,
              transform: drag.x + 14 + GHOST_MAX_W > window.innerWidth ? 'translateX(-100%)' : undefined,
            }}
            className="pointer-events-none fixed z-[60] whitespace-nowrap rounded-md border border-[var(--border-strong)] bg-[var(--panel-bg)] px-2.5 py-1 text-[12px] text-[var(--text-body)] shadow-md"
          >
            {label(drag.view)}
          </div>,
          document.body
        )}
    </section>
  )
}
