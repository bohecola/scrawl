// 主题状态：明暗（亮 / 暗 / 跟随系统）+ 配色（蓝 / 粉 / 橙 / 绿 / 紫 / 青 / 石墨，作用于界面高亮主色）。
// 通过 Context 提供，供 App 的界面共同消费。
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'
export type EffectiveTheme = 'light' | 'dark'
/** 界面高亮主色。蓝是历史默认值；粉 / 橙 / 绿按「粉白粉黑…」的需求补进来；
    紫 / 青填色相环的空，石墨给不想要彩色的人（对照 macOS 的强调色集合）。 */
export type Accent = 'blue' | 'pink' | 'orange' | 'green' | 'violet' | 'teal' | 'graphite'

interface ThemeContextValue {
  mode: ThemeMode
  effective: EffectiveTheme
  setMode: (m: ThemeMode) => void
  accent: Accent
  setAccent: (a: Accent) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

// 注意：index.html 里有一段首帧前的内联脚本读同一个键、用同一个默认值（dark / blue）
// 提前写好 <html data-theme> / data-accent，避免主题闪变。改这里时记得同步那段脚本。
// 键名刻意与产品名解耦：以后再改名不会又把访客存的主题偏好清空一次。
const STORAGE_KEY = 'playground-theme'
const ACCENT_KEY = 'playground-accent'

function getInitialMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  } catch {
    /* ignore */
  }
  return 'dark' // 默认延续暗色
}

const ACCENTS: readonly Accent[] = ['blue', 'pink', 'orange', 'green', 'violet', 'teal', 'graphite']

function getInitialAccent(): Accent {
  try {
    const saved = localStorage.getItem(ACCENT_KEY)
    if (typeof saved === 'string' && (ACCENTS as readonly string[]).includes(saved)) {
      return saved as Accent
    }
  } catch {
    /* ignore */
  }
  return 'blue' // 默认延续蓝色
}

const LIGHT_QUERY = '(prefers-color-scheme: light)'

function systemPref(): EffectiveTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark'
}

/*
  切主题的那一瞬间把页面上所有过渡关掉。

  很多控件（shadcn 的按钮 transition-all、页签 / 开关的 transition-colors）会把颜色变化
  渐变 150ms，而没写过渡的背景是瞬间变的，切换明暗时就会一块快一块慢。主流要么全部
  瞬时（VS Code、GitHub），要么全部统一渐变；这里选瞬时，做法同 next-themes 的
  disableTransitionOnChange：临时塞一条 `* { transition: none !important }`，属性改完、
  样式算完再摘掉。
*/
function withoutTransitions(apply: () => void) {
  const style = document.createElement('style')
  style.textContent = '*,*::before,*::after{transition:none!important;animation-duration:0s!important}'
  document.head.appendChild(style)
  apply()
  // 强制一次样式计算，让新值在「无过渡」状态下落地；下一帧再把规则拿掉
  void window.getComputedStyle(document.body).opacity
  requestAnimationFrame(() => style.remove())
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(getInitialMode)
  const [accent, setAccent] = useState<Accent>(getInitialAccent)
  // 系统配色放进 state：之前是 render 里直接读 matchMedia，系统切换时只改了 DOM 属性，
  // effective 不更新，Monaco（靠 effective 决定主题）就停在旧主题上。
  const [system, setSystem] = useState<EffectiveTheme>(systemPref)

  const effective: EffectiveTheme = mode === 'system' ? system : mode

  // 跟随系统：监听 prefers-color-scheme 变化。挂上就读一次当前值，
  // 免得从 light/dark 切回 system 的那一刻用的是过期的值。
  useEffect(() => {
    if (mode !== 'system' || !window.matchMedia) return
    const mql = window.matchMedia(LIGHT_QUERY)
    const sync = () => setSystem(mql.matches ? 'light' : 'dark')
    sync()
    mql.addEventListener('change', sync)
    return () => mql.removeEventListener('change', sync)
  }, [mode])

  // 应用到 <html> 的 data-theme 属性，驱动 CSS 变量、color-scheme 与 Monaco 主题。
  // color-scheme 交给 index.css 里的 [data-theme] 规则，不在这里写内联样式，
  // 避免同一属性存在两处来源。
  useEffect(() => {
    withoutTransitions(() => document.documentElement.setAttribute('data-theme', effective))
  }, [effective])

  // 配色通过 data-accent 驱动 index.css 里那组高亮主色变量（蓝 / 粉 / 橙 / 绿）。
  useEffect(() => {
    withoutTransitions(() => document.documentElement.setAttribute('data-accent', accent))
  }, [accent])

  // 持久化用户选择
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      /* ignore */
    }
  }, [mode])

  useEffect(() => {
    try {
      localStorage.setItem(ACCENT_KEY, accent)
    } catch {
      /* ignore */
    }
  }, [accent])

  const value = useMemo(
    () => ({ mode, effective, setMode, accent, setAccent }),
    [mode, effective, accent]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}

export { ACCENTS }
