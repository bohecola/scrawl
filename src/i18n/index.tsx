/*
  语言的 Provider。这个文件里只有组件 —— 类型、hook、工具函数都在 context.ts，
  原因见 context.ts 顶部的注释。

  形状与 src/theme/index.tsx 完全同构（三态、写 localStorage、首帧由 index.html 兜住），
  只有一处刻意的偏离，见下面 sysLang。
*/
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { Direction } from 'radix-ui'
import { useTranslation } from 'react-i18next'

import { LANG_TAGS } from './langs'
import { i18n, loadLang } from './setup'
import { I18nContext, STORAGE_KEY, dirOf, readLangMode, systemLang, type LangMode } from './context'

export function I18nProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<LangMode>(readLangMode)

  /*
    与主题的唯一区别：系统语言进 state。

    主题那边 effective 是 render 期直接算的派生值，系统配色变化时只改了 <html data-theme>、
    Context 里的值并不更新（theme/index.tsx:49-57，所以 Monaco 主题不会实时跟随）。
    对配色来说这只是个小瑕疵，对文案不行 —— 语言变了必须重渲染，否则整屏文字停在旧语言。
    所以订阅 languagechange 把它放进 state。
  */
  const [sysLang, setSysLang] = useState(systemLang)

  useEffect(() => {
    const onChange = () => setSysLang(systemLang())
    window.addEventListener('languagechange', onChange)
    return () => window.removeEventListener('languagechange', onChange)
  }, [])

  const lang = mode === 'system' ? sysLang : mode

  /*
    t 来自 useTranslation()：语言切换后 react-i18next 会给它一个新引用，
    下游 hook 把它放进 useCallback / useEffect 依赖里的老机制照旧生效。
  */
  const { t } = useTranslation()

  // 持久化用户选择
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      /* ignore */
    }
  }, [mode])

  // 语言的 JSON 资源是懒加载的：切换时先补齐资源包，再让 i18next 换语言
  useEffect(() => {
    let cancelled = false
    loadLang(lang)
      .then(() => {
        if (!cancelled) i18n.changeLanguage(LANG_TAGS[lang])
      })
      .catch((err: unknown) => {
        // 语言 chunk 加载失败：界面停在上一种语言，至少留个痕迹
        console.error('[i18n] failed to load language', LANG_TAGS[lang], err)
      })
    return () => {
      cancelled = true
    }
  }, [lang])

  /*
    <html lang> 与排版方向。排版方向（阿拉伯语 rtl）也要写回 <html dir>，CSS 没有跟着语言走的内置规则。
    首帧那一下由 index.html 的内联脚本负责。标题不在这里：它就是产品名，写死在 <title> 里。
  */
  useEffect(() => {
    document.documentElement.lang = LANG_TAGS[lang]
    document.documentElement.dir = dirOf(lang)
  }, [lang])

  const value = useMemo(() => ({ mode, setMode, lang, t }), [mode, lang, t])

  /*
    Radix 的弹层（Select / DropdownMenu / ContextMenu / Tooltip…）不读 <html dir>，
    方向由各自的 DirectionProvider 决定，默认 LTR。在这里包一层，让所有弹层
    跟着界面方向走：阿拉伯语下选项右对齐、勾在行首、子菜单往左弹、方向键正确。
  */
  return (
    <I18nContext.Provider value={value}>
      <Direction.Provider dir={dirOf(lang)}>{children}</Direction.Provider>
    </I18nContext.Provider>
  )
}
