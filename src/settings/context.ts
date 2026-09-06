/*
  编辑器设置：字号、字体、编辑器主题、换行 / 缩略图 / 行号 / 连字，以及文件图标主题。
  类型、常量、hook 都在这里；Provider 在 index.tsx（和 i18n 一样拆开，满足 react-refresh 的
  「组件文件只导出组件」）。明暗 / 配色 / 语言仍各自归 ThemeProvider / I18nProvider 管，
  设置面板只是把它们的入口收到一处。
*/
import { createContext, useContext } from 'react'
import { AUTO_THEME, isEditorTheme } from '@/monaco/themes'
import { DEFAULT_ICON_THEME, isIconTheme, type IconThemeId } from '@/icon-themes'

/** 字体预设。id 存进 localStorage；family 是交给 Monaco 的 font-family 串，带兜底。 */
export const FONT_PRESETS = [
  { id: 'system', family: "Menlo, Monaco, Consolas, 'Courier New', monospace" },
  { id: 'jetbrains', label: 'JetBrains Mono', family: "'JetBrains Mono', Menlo, Consolas, monospace" },
  { id: 'fira', label: 'Fira Code', family: "'Fira Code', Menlo, Consolas, monospace" },
  { id: 'cascadia', label: 'Cascadia Code', family: "'Cascadia Code', 'Cascadia Mono', Consolas, Menlo, monospace" },
  { id: 'source', label: 'Source Code Pro', family: "'Source Code Pro', Menlo, Consolas, monospace" },
  { id: 'sfmono', label: 'SF Mono', family: "'SF Mono', Menlo, Monaco, monospace" },
  { id: 'consolas', label: 'Consolas', family: "Consolas, 'Courier New', monospace" },
] as const

export type FontPresetId = (typeof FONT_PRESETS)[number]['id']

export interface EditorSettings {
  fontSize: number
  fontFamily: FontPresetId
  fontLigatures: boolean
  wordWrap: boolean
  minimap: boolean
  lineNumbers: boolean
  /** 'auto' 跟随界面明暗；否则是 monaco/themes.ts 里的主题 id */
  editorTheme: string
  /** 目录树 / 标签栏的文件图标主题，见 icon-themes/ */
  iconTheme: IconThemeId
  /** 标签栏里也显示文件图标 */
  tabIcons: boolean
}

export const FONT_SIZE_MIN = 10
export const FONT_SIZE_MAX = 24

export const DEFAULT_SETTINGS: EditorSettings = {
  fontSize: 14,
  fontFamily: 'system',
  fontLigatures: false,
  wordWrap: false,
  minimap: false,
  lineNumbers: true,
  editorTheme: AUTO_THEME,
  iconTheme: DEFAULT_ICON_THEME,
  tabIcons: true,
}

export const STORAGE_KEY = 'scrawl:editor'

function isFontPreset(v: unknown): v is FontPresetId {
  return FONT_PRESETS.some((p) => p.id === v)
}

export function fontFamilyOf(id: FontPresetId): string {
  return FONT_PRESETS.find((p) => p.id === id)?.family ?? FONT_PRESETS[0].family
}

// 逐字段校验：存的 JSON 可能来自旧版本或被手改过，认不出的字段一律回默认值
export function readSettings(): EditorSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const v = JSON.parse(raw) as Partial<Record<keyof EditorSettings, unknown>>
    const bool = (x: unknown, d: boolean) => (typeof x === 'boolean' ? x : d)
    return {
      fontSize:
        typeof v.fontSize === 'number' && v.fontSize >= FONT_SIZE_MIN && v.fontSize <= FONT_SIZE_MAX
          ? Math.round(v.fontSize)
          : DEFAULT_SETTINGS.fontSize,
      fontFamily: isFontPreset(v.fontFamily) ? v.fontFamily : DEFAULT_SETTINGS.fontFamily,
      fontLigatures: bool(v.fontLigatures, DEFAULT_SETTINGS.fontLigatures),
      wordWrap: bool(v.wordWrap, DEFAULT_SETTINGS.wordWrap),
      minimap: bool(v.minimap, DEFAULT_SETTINGS.minimap),
      lineNumbers: bool(v.lineNumbers, DEFAULT_SETTINGS.lineNumbers),
      editorTheme: isEditorTheme(v.editorTheme) ? v.editorTheme : DEFAULT_SETTINGS.editorTheme,
      iconTheme: isIconTheme(v.iconTheme) ? v.iconTheme : DEFAULT_SETTINGS.iconTheme,
      tabIcons: bool(v.tabIcons, DEFAULT_SETTINGS.tabIcons),
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

interface SettingsContextValue {
  settings: EditorSettings
  update: <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) => void
  reset: () => void
}

export const SettingsContext = createContext<SettingsContextValue | null>(null)

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider')
  return ctx
}
