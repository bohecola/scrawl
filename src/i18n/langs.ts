/*
  语言表：整个应用里「有哪些语言、各自对应什么 <html lang>」只在这里写一次。

  这个文件刻意不 import React、不 import 字典 —— vite.config.ts 里的插件也要读它，
  把同一张表注进 index.html 的首帧脚本（React 挂载前就要定下 <html lang> / dir / 标题）。
*/

/**
 * 支持的语言。键名即 localStorage 里存的取值（zh 沿用历史键值，老用户的偏好不用迁移）。
 *   zh  简体中文   zhHant 繁體中文   en  English   fr  Français   de  Deutsch   it  Italiano
 *   ko  한국어     ja     日本語     vi  Tiếng Việt  pt  Português  ar  العربية     th  ภาษาไทย
 */
export type Lang = 'zh' | 'zhHant' | 'en' | 'fr' | 'de' | 'it' | 'ko' | 'ja' | 'vi' | 'pt' | 'ar' | 'th'

/** Lang → <html lang> 的 BCP 47 标签（与各字典的 'html.lang' 一致） */
export const LANG_TAGS: Record<Lang, string> = {
  zh: 'zh-CN',
  zhHant: 'zh-Hant',
  en: 'en',
  fr: 'fr',
  de: 'de',
  it: 'it',
  ko: 'ko',
  ja: 'ja',
  vi: 'vi',
  pt: 'pt',
  ar: 'ar',
  th: 'th',
}

export const ALL_LANGS = Object.keys(LANG_TAGS) as Lang[]

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && Object.hasOwn(LANG_TAGS, value)
}

/**
 * 按 BCP 47 标签（navigator.language 之类）把某语言归位到我们的 Lang；认不出就回英文。
 * 中文按地区分简繁：台湾 / 香港 / 澳门按繁中，其余 zh（大陆、新加坡简体区）按简体。
 * index.html 的首帧脚本里有一份同样逻辑的精简版（那里拿不到模块）。
 */
export function langFromTag(tag: string): Lang {
  const [primaryRaw, regionRaw] = tag.split('-')
  const primary = (primaryRaw || '').toLowerCase()
  if (primary === 'zh') {
    const region = (regionRaw || '').toUpperCase()
    return region === 'TW' || region === 'HK' || region === 'MO' ? 'zhHant' : 'zh'
  }
  return ALL_LANGS.find((lang) => LANG_TAGS[lang].split('-')[0] === primary) ?? 'en'
}
