/*
  语言的运行时：类型、Context、hook、探测与持久化。

  为什么不和 <I18nProvider> 放在一个文件里：eslint 的
  react-refresh/only-export-components 不允许「组件 + 非组件」同文件导出，
  eslint.config.js 已经为 src/theme/index.tsx 破过一次例（注释里写明是历史遗留），
  新代码不该再加一条。所以 .tsx 里只留组件，工具函数都在这个 .ts 里，
  规则本来就不管它。组件里写 `import { useI18n } from '@/i18n/context'`。

  文案本体在 src/locales/*.json（i18next JSON v4），由 setup.ts 驱动；
  这里只保留对外 API（useI18n / messageOf / translate / LANGS / T）。
*/
import { createContext, useContext } from 'react'

import type { TFunction } from 'i18next'

import { AppError, type Problem } from '@/lib/app-error'
import { langFromTag, LANG_TAGS, type Lang } from './langs'

/**
 * 真正生效的语言（不含 system）：
 *   zh      简体中文   en   English        fr  Français
 *   de      Deutsch     it   Italiano      ko   한국어
 *   ja      日本語      vi   Tiếng Việt    pt   Português
 *   ar      العربية     th   ภาษาไทย       zhHant  繁體中文
 * 键名即 localStorage 里存的取值（zh 沿用历史键值，老用户的偏好不用迁移）。
 */
export type { Lang }
/** 用户的选择：明确指定，或跟随系统 —— 与 ThemeMode 同构 */
export type LangMode = Lang | 'system'

/*
  与 index.html 首帧脚本里的键名一致，改这里要一起改那边。
  主题那支键还是历史遗留的 'playground-theme'，新键跟 scrawl:* 一族对齐。
*/
export const STORAGE_KEY = 'scrawl:lang'

/** react-i18next 给的 t，键名受 i18next.d.ts 的 CustomTypeOptions 约束。 */
export type T = TFunction<'translation'>

/** 浏览器语言：按 navigator.language 就近归到我们支持的语言，认不出回英文。 */
export function systemLang(): Lang {
  const raw = typeof navigator === 'undefined' ? '' : navigator.language
  return langFromTag(raw)
}

/** 读用户存过的选择。存的不是受支持字面量之一（或读不出来）就回落到「跟随系统」。 */
export function readLangMode(): LangMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    // hasOwn 而不是 in：localStorage 里若被写成 'toString' 这种原型链上的名字，in 会放行
    if (saved !== null && (saved === 'system' || Object.hasOwn(LANG_TAGS, saved)))
      return saved as LangMode
  } catch {
    // 隐私模式下 localStorage 直接抛，按默认走
  }
  return 'system'
}

interface I18nContextValue {
  mode: LangMode
  setMode: (mode: LangMode) => void
  lang: Lang
  t: T
}

/**
 * 语言下拉里每项后面的括注：用当前界面语言写的该语言名（中文界面下 Deutsch 后面跟「德语」）。
 * 交给浏览器的 Intl.DisplayNames，不用自己维护 11×11 张互译表。
 * 与母语名相同的（英文界面下的 English）不返回，界面上不重复显示。
 * 简中按 zh-Hans 查而不是 zh-CN：后者得到的是「中文（中国）」。
 */
export function translatedLangNames(ui: Lang): Partial<Record<Lang, string>> {
  const names: Partial<Record<Lang, string>> = {}
  if (typeof Intl.DisplayNames !== 'function') return names
  let dn: Intl.DisplayNames
  try {
    dn = new Intl.DisplayNames([LANG_TAGS[ui]], { type: 'language' })
  } catch {
    return names
  }
  for (const { value, label } of LANGS) {
    const name = dn.of(value === 'zh' ? 'zh-Hans' : LANG_TAGS[value])
    if (name && name.localeCompare(label, undefined, { sensitivity: 'base' }) !== 0) names[value] = name
  }
  return names
}

/** 阿拉伯语从右往左，其余从左往右。 */
export function dirOf(lang: Lang): 'rtl' | 'ltr' {
  return lang === 'ar' ? 'rtl' : 'ltr'
}

/** 语言下拉的固定选项：名字用各自母语写，不翻译（看不懂当前界面语言的人，
    正需要用目标语言认出自己那一项），与主题/配色的设计一致。顺序即菜单顺序 ——
    按母语名排：拉丁字母书写的名字在前（按字母序），其余按码位紧随其后。
    结果就是常见的「拉丁语系靠前、中文/日/韩/阿拉伯靠后」观感。 */
export const LANGS: { value: Lang; label: string }[] = [
  { value: 'de', label: 'Deutsch' }, // German
  { value: 'en', label: 'English' }, // English
  { value: 'fr', label: 'Français' }, // French
  { value: 'it', label: 'Italiano' }, // Italian
  { value: 'pt', label: 'Português' }, // Portuguese
  { value: 'vi', label: 'Tiếng Việt' }, // Vietnamese
  { value: 'ar', label: 'العربية' }, // Arabic
  { value: 'th', label: 'ภาษาไทย' }, // Thai
  { value: 'ja', label: '日本語' }, // Japanese
  { value: 'zh', label: '简体中文' }, // Chinese (Simplified)
  { value: 'zhHant', label: '繁體中文' }, // Chinese (Traditional)
  { value: 'ko', label: '한국어' }, // Korean
]

export const I18nContext = createContext<I18nContextValue | null>(null)

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}

/*
  把任意异常变成一句能给人看的话。

  原先 App / useWorkspace / useFileDraft 各有一份一模一样的实现（都是
  `err instanceof Error ? err.message : String(err)`），这里合成一处，顺带接上翻译：
  lib/ 抛出来的 AppError 只带键和参数，翻译在这一刻才发生。

  这个断言是整套 i18n 里唯一的类型缺口：AppError 存不住「每条键各自的参数类型」
  （那需要泛型 AppError，抛出侧就得写 new AppError<'err.fs.tooLarge'>(...)，太吵）。
  代价被关在这一个函数里 —— 抛出侧仍然是普通的字符串键，写错键名照样报错。
*/
export function messageOf(err: unknown, t: T): string {
  if (err instanceof AppError) return translate(err, t)
  // 文件系统 API 的权限错误：浏览器给的英文原句又长又含糊，换成一句说得清的
  if (err instanceof DOMException && err.name === 'NotAllowedError') return t('err.fs.notAllowed')
  return err instanceof Error ? err.message : String(err)
}

/**
 * 翻译一条描述符（AppError 也是一条描述符）。
 *
 * 上面那处类型缺口的唯一落点就在这里：`Problem` 只存得下「键 + 一坨参数」，
 * 存不住「这个键要的正是这种参数」。抛出 / 返回描述符的那一侧仍然是普通字符串键，
 * 键名写错照样编译不过；对不上的只有参数，而参数是紧跟着键写在同一行的。
 */
export function translate(problem: Problem, t: T): string {
  const raw = t as unknown as (key: string, params?: unknown) => string
  const params = problem.params
  // err.fs.nameTaken 的 kind 参数兼任 i18next 的 context（选 _file / _directory 变体）
  if (params && typeof params === 'object' && 'kind' in params) {
    return raw(problem.key, { ...params, context: params.kind })
  }
  return raw(problem.key, params)
}
