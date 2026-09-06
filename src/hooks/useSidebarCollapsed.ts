import { useEffect, useState } from 'react'
import { useMediaQuery } from './useMediaQuery'

const COLLAPSED_KEY = 'scrawl:sidebarCollapsed'

/**
 * 侧栏收起 / 展开。状态放在 App 里而不是 Sidebar 里：开关按钮在顶栏上，
 * 收起后侧栏整个不渲染，得有个地方把它再叫回来。
 *
 * 默认值：手机竖屏上侧栏会占掉大半个屏幕，没存过就收起。
 * 中途变窄（旋转平板、缩小窗口）也收起；变宽不自动展开，由用户决定。
 * 窄屏期间的收起状态不落盘，回到桌面尺寸时仍是用户原来的选择。
 */
export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const saved = localStorage.getItem(COLLAPSED_KEY)
      if (saved !== null) return saved === '1'
    } catch {
      /* 读不到就按默认来 */
    }
    return typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 767px)').matches
  })
  const narrow = useMediaQuery('(max-width: 767px)')
  useEffect(() => {
    if (narrow) setCollapsed(true)
  }, [narrow])
  useEffect(() => {
    if (narrow) return
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      // 记不住就记不住
    }
  }, [collapsed, narrow])
  return [collapsed, setCollapsed] as const
}
