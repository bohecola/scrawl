import { useCallback, useEffect, useRef, useState } from 'react'

/*
  右栏输出区（Console / 预览）的布局模型。

  借 VS Code 编辑器组的那套心智：两个视图要么挤在一个标签栏里（tabs），要么各占一格
  同时可见（split）。二分可以上下也可以左右，顺序可交换，分隔线位置可拖。
  所有变化都归结为一个动作 ——「把某个视图放到某个位置」（placeView）：
  拖标签落到边缘 = 往那边分栏，落到中央 = 并回标签栏，落到另一个标签上 = 换序；
  布局菜单只是同一组状态的按钮入口。
*/

export type OutputView = 'console' | 'preview'
export type OutputMode = 'tabs' | 'split'
/** vertical = 上下二分，horizontal = 左右二分 */
export type SplitDirection = 'vertical' | 'horizontal'

export interface OutputLayout {
  mode: OutputMode
  direction: SplitDirection
  /** tabs 模式下是标签的先后顺序；split 模式下是从 inline-start / 顶部数起的格子顺序 */
  order: [OutputView, OutputView]
  /** 二分时第一格占的比例，0.2 ~ 0.8 */
  ratio: number
}

/**
 * 拖放的落点。left / right 是物理方向（RTL 下 left 是 inline-end）；
 * center = 并回标签栏；tab = 落在另一个标签上（换序）
 */
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center' | 'tab'

const STORAGE_KEY = 'scrawl:outputLayout'
export const OUTPUT_RATIO_MIN = 0.2
export const OUTPUT_RATIO_MAX = 0.8

const DEFAULT_LAYOUT: OutputLayout = { mode: 'tabs', direction: 'vertical', order: ['console', 'preview'], ratio: 0.5 }

const isView = (v: unknown): v is OutputView => v === 'console' || v === 'preview'
const clampRatio = (r: number) => Math.min(OUTPUT_RATIO_MAX, Math.max(OUTPUT_RATIO_MIN, r))

function readLayout(): OutputLayout {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '') as Partial<OutputLayout> | null
    if (!raw || (raw.mode !== 'tabs' && raw.mode !== 'split')) return DEFAULT_LAYOUT
    const order = Array.isArray(raw.order) ? raw.order.filter(isView) : []
    // 两个视图都得在、且不重复，否则这份记录不可信
    if (order.length !== 2 || order[0] === order[1]) return DEFAULT_LAYOUT
    const ratio = Number(raw.ratio)
    return {
      mode: raw.mode,
      // 早期版本没有 direction 字段（只有上下二分）
      direction: raw.direction === 'horizontal' ? 'horizontal' : 'vertical',
      order: [order[0]!, order[1]!],
      ratio: Number.isFinite(ratio) ? clampRatio(ratio) : 0.5,
    }
  } catch {
    return DEFAULT_LAYOUT
  }
}

export const otherView = (view: OutputView): OutputView => (view === 'console' ? 'preview' : 'console')

/**
 * 「把 view 放到 zone」之后的布局。返回 null 表示这次落点没有意义（和现状一样）。
 * rtl 只影响左右：flex 行在 RTL 下镜像，order[0] 在物理右侧。
 */
export function placeView(layout: OutputLayout, view: OutputView, zone: DropZone, rtl: boolean): OutputLayout | null {
  const other = otherView(view)
  let next: OutputLayout
  switch (zone) {
    case 'tab':
      // 标签换序（tabs 模式）/ 交换格子（split 模式，把标签拖到另一格的标签栏上）
      next = { ...layout, order: [layout.order[1], layout.order[0]] }
      break
    case 'center':
      // 并回标签栏。tabs 模式下落在中央什么都不发生
      if (layout.mode === 'tabs') return null
      next = { ...layout, mode: 'tabs' }
      break
    case 'top':
      next = { ...layout, mode: 'split', direction: 'vertical', order: [view, other] }
      break
    case 'bottom':
      next = { ...layout, mode: 'split', direction: 'vertical', order: [other, view] }
      break
    case 'left':
    case 'right': {
      const atStart = (zone === 'left') !== rtl
      next = { ...layout, mode: 'split', direction: 'horizontal', order: atStart ? [view, other] : [other, view] }
      break
    }
  }
  return sameLayout(layout, next) ? null : next
}

function sameLayout(a: OutputLayout, b: OutputLayout): boolean {
  return (
    a.mode === b.mode &&
    a.ratio === b.ratio &&
    // tabs 模式下方向无所谓，别因为它判成「变了」
    (a.mode === 'tabs' || a.direction === b.direction) &&
    a.order[0] === b.order[0]
  )
}

export function useOutputLayout() {
  const [layout, setLayout] = useState<OutputLayout>(readLayout)
  // 拖拽回调不在 React 事件里，读最新值走 ref
  const layoutRef = useRef(layout)
  useEffect(() => {
    layoutRef.current = layout
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
    } catch {
      // 记不住就记不住
    }
  }, [layout])

  const setMode = useCallback((mode: OutputMode, direction?: SplitDirection) => {
    setLayout((prev) => ({ ...prev, mode, direction: direction ?? prev.direction }))
  }, [])
  const swap = useCallback(() => {
    setLayout((prev) => ({ ...prev, order: [prev.order[1], prev.order[0]] }))
  }, [])
  const setRatio = useCallback((ratio: number) => {
    setLayout((prev) => ({ ...prev, ratio: clampRatio(ratio) }))
  }, [])
  const drop = useCallback((view: OutputView, zone: DropZone, rtl: boolean) => {
    setLayout((prev) => placeView(prev, view, zone, rtl) ?? prev)
  }, [])

  return { layout, layoutRef, setMode, swap, setRatio, drop }
}
