import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { useI18n } from '@/i18n/context'
import { startPointerDrag } from '@/lib/pointer-drag'
import { isRtl, shortcut } from '@/lib/platform'
import type { ActiveFile } from '@/types'
import { FileIcon } from '@/components/FileIcon'
import { useSettings } from '@/settings/context'

// Blink 下 RTL 溢出容器的 scrollLeft 是负区间 [-max, 0]（0=起点/最右，-max=尽头/最左），
// LTR 才是 [0, max]。把它归一成「0=起点、1=尽头」的进度，避免各处各自猜符号。
// 只读 DOM、不碰组件状态，放在模块级，effect 依赖里就不用列它们。isRtl 见 lib/platform。
const tabProgress = (el: HTMLElement) => {
  const max = el.scrollWidth - el.clientWidth
  if (max <= 0) return 0
  return isRtl() ? -el.scrollLeft / max : el.scrollLeft / max
}
const tabSetProgress = (el: HTMLElement, p: number) => {
  const max = el.scrollWidth - el.clientWidth
  el.scrollLeft = isRtl() ? -p * max : p * max
}


interface TabStripProps {
  tabs: ActiveFile[]
  activeKey: string | null
  dirtyKeys: Set<string>
  onSwitch: (key: string) => void
  onClose: (key: string) => void
  onCloseOthers: (key: string) => void
  onCloseToRight: (key: string) => void
  onCloseAll: () => void
  /** 标签栏末尾的「+」和 Alt+N：新开一份未命名文件 */
  onNew: () => void
}

/**
 * 编辑器头部的标签条（同 VS Code）：可横向滚动、原生滚动条隐藏、悬停时浮现一根细进度条，
 * 可按住拖拽；右键菜单提供关闭本标签 / 其他 / 右侧 / 全部；左右方向键在标签间切换。
 * 标签数据与开关逻辑都在 hooks/useTabs，这里只管展示与滚动。
 */
export function TabStrip({
  tabs,
  activeKey,
  dirtyKeys,
  onSwitch,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
  onNew,
}: TabStripProps) {
  const { t } = useI18n()
  const { settings } = useSettings()
  // ---- 标签栏横向滚动（同 VS Code：原生滚动条隐藏、不占高度，用悬浮细条替代）----
  const tabScrollRef = useRef<HTMLDivElement | null>(null)
  /** 悬浮进度条几何：x/w 是 thumb 相对 track 的 inline-start 的距离/宽（px）。x 是「距起点」，
      渲染端用逻辑 insetInlineStart 定位，因此 LTR（起点在左）和 RTL（起点在右）都对。 */
  const [tabBar, setTabBar] = useState({ x: 0, w: 0, overflow: false })
  /** 正在拖 thumb：拖拽中即使鼠标移出标签区，进度条也保持显示（同 VS Code 的按住态） */
  const [tabBarDragging, setTabBarDragging] = useState(false)
  const updateTabScrollState = useCallback(() => {
    const el = tabScrollRef.current
    if (!el) return
    const maxScroll = el.scrollWidth - el.clientWidth
    const track = el.clientWidth
    const overflow = maxScroll > 0
    if (!overflow) {
      setTabBar({ x: 0, w: 0, overflow: false })
      return
    }
    // thumb 宽 ≈ track × (track / scrollWidth)，保个下限好抓
    const w = Math.max(36, (track * track) / Math.max(el.scrollWidth, 1))
    const x = tabProgress(el) * (track - w)
    setTabBar({ x, w, overflow: true })
  }, [])
  // 底部悬浮 thumb 可拖拽横滚（同 VS Code）：按住左右拖，把 scrollLeft 带过去。
  const tabBarDragRef = useRef<{ startX: number; startProgress: number } | null>(null)
  const startTabBarDrag = (e: React.PointerEvent) => {
    const el = tabScrollRef.current
    if (!el) return
    e.preventDefault()
    // 记录起点归一化进度 + 指针物理 x。拖动中把「thumb 移动的物理像素」换算成内容像素，
    // 用 tabSetProgress 写回 —— LTR/RTL 的符号都由它统一（thumb 从 inline-start 起算）。
    tabBarDragRef.current = { startX: e.clientX, startProgress: tabProgress(el) }
    setTabBarDragging(true)
    const move = (ev: PointerEvent) => {
      const el2 = tabScrollRef.current
      const st = tabBarDragRef.current
      if (!el2 || !st) return
      const track = el2.clientWidth
      const maxPx = el2.scrollWidth - track
      // 物理拖动增量 → 「toward-end」像素增量：LTR 前进方向=右(+)，RTL 前进方向=左(-)。
      const towardEndPx = (isRtl() ? -1 : 1) * (ev.clientX - st.startX)
      const pxPerThumb = maxPx / Math.max(track - tabBar.w, 1)
      const next = st.startProgress * maxPx + towardEndPx * pxPerThumb
      tabSetProgress(el2, maxPx <= 0 ? 0 : Math.min(1, Math.max(0, next / maxPx)))
    }
    // 全屏遮罩：拖动期间指针划过别处不触发 hover / 选中文本。不加手型光标（同 VS Code）
    startPointerDrag({
      onMove: move,
      onEnd: () => {
        setTabBarDragging(false)
        tabBarDragRef.current = null
      },
      overlay: true,
    })
  }
  useEffect(() => {
    updateTabScrollState()
    const el = tabScrollRef.current
    if (!el) return
    const ro = new ResizeObserver(updateTabScrollState)
    ro.observe(el)
    el.addEventListener('scroll', updateTabScrollState, { passive: true })
    // 标签溢出时把普通鼠标滚轮转成横向滚动（同 VS Code：滚轮直接翻 tab，不滚页面）。
    // 非 passive 才能 preventDefault 挡住页面纵向滚动。
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return // 没溢出就交给页面正常滚动
      e.preventDefault()
      // 用「距尽头的像素（0..max）」做增量，方向符号交给归一化 helper：
      // LTR 下等价于 scrollLeft += deltaY + deltaX；RTL 下自动取对符号。
      const max = el.scrollWidth - el.clientWidth
      const cur = tabProgress(el) * max
      const next = Math.min(max, Math.max(0, cur + e.deltaY + e.deltaX))
      tabSetProgress(el, max <= 0 ? 0 : next / max)
      updateTabScrollState()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', updateTabScrollState)
      el.removeEventListener('wheel', onWheel)
    }
  }, [updateTabScrollState, tabs.length])
  // 切换激活标签时把它滚到可见（VS Code 行为）
  useEffect(() => {
    const el = tabScrollRef.current
    if (!el || !activeKey) return
    const act = el.querySelector('[data-active-tab="true"]') as HTMLElement | null
    act?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    updateTabScrollState()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, tabs.length])

  return (
    <div className="group/tabs relative min-w-0 flex-1">
      <div
        ref={tabScrollRef}
        role="tablist"
        aria-orientation="horizontal"
        // 左右方向键在标签间切换（tablist 的标准键盘行为）
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
          const cur = tabs
          const i = cur.findIndex((x) => x.key === activeKey)
          if (i === -1) return
          const dir = (e.key === 'ArrowRight') === !isRtl() ? 1 : -1
          const next = cur[(i + dir + cur.length) % cur.length]
          e.preventDefault()
          onSwitch(next.key)
          ;(e.currentTarget.querySelector('[data-active-tab] [role=tab]') as HTMLElement | null)?.focus()
        }}
        className="tabs-scrollbar absolute inset-0 flex items-stretch overflow-x-auto"
      >
    {tabs.map((tab) => {
      const isActive = tab.key === activeKey
      const dirtyTab = dirtyKeys.has(tab.key)
      const tabName = tab.name
      return (
        <ContextMenu key={tab.key}>
          <ContextMenuTrigger asChild>
            <div
              data-active-tab={isActive ? 'true' : undefined}
              className={cn(
                // 激活：顶部主色横线 + 正文色底（向下融入编辑器）；非激活：浅一档底、
                // 顶部无横线。每个 tab 行末都留一条细线作相邻分隔（含激活）。
                // 用 border-e：RTL（阿拉伯语）时该分隔自动落在正确一侧
                'group flex min-w-0 shrink-0 items-stretch border-e border-e-[var(--border)]',
                isActive
                  ? 'border-t-2 border-t-[var(--primary)] bg-[var(--tab-active-bg)]'
                  : 'border-t-2 border-t-transparent bg-[var(--tab-inactive-bg)]'
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                onClick={() => onSwitch(tab.key)}
                title={tabName}
                className={cn(
                  'flex min-w-0 items-center gap-1.5 py-1.5 ps-2 pe-1 font-mono text-[12.5px]',
                  isActive
                    ? 'text-[var(--text-body)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-body)]'
                )}
              >
                {settings.tabIcons && (
                  <FileIcon kind="file" name={tab.name} language={tab.language} className="size-3.5" />
                )}
                <span className="max-w-[140px] truncate">{tabName}</span>
                {dirtyTab && (
                  <span
                    title={t('editor.dirty')}
                    className="size-2 shrink-0 rounded-full bg-[var(--accent-symbol)]"
                  />
                )}
              </button>
              <button
                type="button"
                aria-label={t('tab.closeAria', { name: tabName })}
                title={isActive ? `${t('tab.close')} (${shortcut.closeTab})` : t('tab.close')}
                onClick={() => onClose(tab.key)}
                className={cn(
                  // 20px 正方形、圆角略大、四周留白，hover 底色不贴着 tab 的顶线 / 底边 / 右侧分隔线
                  'my-auto me-1 flex size-5 shrink-0 items-center justify-center rounded-md text-[var(--text-faint)] transition-opacity hover:bg-[var(--panel-hover)] hover:text-[var(--text-body)]',
                  isActive
                    ? 'opacity-100'
                    : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100'
                )}
              >
                <Icon className="icon-[lucide--x] size-3.5" />
              </button>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent
            className="min-w-[160px]"
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <ContextMenuItem onSelect={() => onClose(tab.key)}>
              {t('tab.ctx.close')}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onCloseOthers(tab.key)}>
              {t('tab.ctx.closeOthers')}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onCloseToRight(tab.key)}>
              {t('tab.ctx.closeRight')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              onSelect={() => onCloseAll()}
            >
              {t('tab.ctx.closeAll')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )
    })}
      {/* 新建未命名文件。贴在最后一个标签后面（同浏览器的「+」），跟着标签一起横滚 */}
      <button
        type="button"
        onClick={onNew}
        title={`${t('tab.new')} (${shortcut.newFile})`}
        aria-label={t('tab.new')}
        className="my-auto ms-1 flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--panel-hover)] hover:text-[var(--text-body)]"
      >
        <Icon className="icon-[lucide--plus] size-4" />
      </button>
      </div>
      {/* 悬浮进度条：绝对贴容器底部、不占高度，方形直角、3px 半透明（同 VS Code），
          悬停标签栏才浮现；只在标签溢出时出现。浮现后可按住 thumb 左右拖拽横滚 */}
      {tabBar.overflow && (
        <div
          aria-hidden
          onPointerDown={startTabBarDrag}
          className={cn(
            'absolute inset-x-0 bottom-0 h-[10px] touch-none',
            tabBarDragging
              ? 'opacity-100'
              : 'pointer-events-none opacity-0 transition-opacity duration-150 group-hover/tabs:pointer-events-auto group-hover/tabs:opacity-100'
          )}
        >
          <div
            className="pointer-events-none absolute bottom-0 h-[3px] bg-[var(--border-strong)]/60"
            style={{ width: tabBar.w, insetInlineStart: tabBar.x }}
          />
        </div>
      )}
    </div>
  )
}
