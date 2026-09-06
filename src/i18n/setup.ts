/*
  i18next 的初始化与格式器。

  英文静态打包（它是回退语言，必须随时在）；其他语言用 Vite 的 import.meta.glob
  懒加载，addResourceBundle 挂上，一种语言一个 chunk。语言探测与持久化（system 模式、
  scrawl:lang、index.html 首帧脚本）不在这里，见 context.ts 与 main.tsx。
*/
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import type { CompileIssue } from '@/lib/compile'
import en from '@/locales/en.json'
import { LANG_TAGS, type Lang } from './langs'

// en.json 静态打包（下面直接 import），从懒加载清单里排除，避免构建器报 dynamic+static 冲突
const loaders = import.meta.glob<{ default: Record<string, string> }>([
  '../locales/*.json',
  '!../locales/en.json',
])

/** 把一种语言的 JSON 资源挂进 i18next（幂等）。 */
export async function loadLang(lang: Lang) {
  const tag = LANG_TAGS[lang]
  if (i18n.hasResourceBundle(tag, 'translation')) return
  const mod = await loaders[`../locales/${tag}.json`]()
  i18n.addResourceBundle(tag, 'translation', mod.default)
}

export async function initI18n(initial: Lang) {
  await i18n.use(initReactI18next).init({
    lng: LANG_TAGS[initial],
    fallbackLng: 'en',
    // 只查当前标签本身：不要让 zh-Hant 去找 zh、zh-CN 去找 zh（将来若有 zh.json 会被误当回退）
    load: 'currentOnly',
    resources: { en: { translation: en } },
    // 键名里的 . 只是命名习惯，不是层级；键里也没有 :
    keySeparator: false,
    nsSeparator: false,
    // React 自己会转义，i18next 再转一遍 < 这类字符会变成 &lt;
    interpolation: { escapeValue: false },
    returnNull: false,
    // 我们在 render 前自己 await（main.tsx），不用 Suspense
    react: { useSuspense: false },
    // dev 下把漏传参数报成显眼的错误；返回原占位符，界面表现与生产一致（生产不装处理器，
    // i18next 默认原样保留 {{name}}）
    missingInterpolationHandler: import.meta.env.DEV
      ? (text, value: RegExpMatchArray) => {
          console.error('[i18n] missing interpolation in:', text)
          return value[0]
        }
      : undefined,
  })
  registerFormatters()
  await loadLang(initial)
  await i18n.changeLanguage(LANG_TAGS[initial])
}

/*
  字典里做不了的 join 在这里集中处理（原文案搬进 JSON 后唯一的新逻辑）。
  - list：i18next 内置格式器，用 Intl.ListFormat，各语言分隔符自动正确。
  - chain / compileIssues：自定义。
  compileIssues 要翻译子句，拆成 err.compile.issue / issueNoLoc / unknownIssue / issueSep
  四条键（见 locales/*.json）。
*/
function registerFormatters() {
  i18n.services.formatter!.add('chain', (value: string[]) => value.join(' → '))
  i18n.services.formatter!.add('compileIssues', (issues: CompileIssue[], lng) =>
    issues
      .map((i) => {
        const text = i.text || i18n.t('err.compile.unknownIssue', { lng })
        return i.loc
          ? i18n.t('err.compile.issue', { lng, text, line: i.loc.line, column: i.loc.column })
          : i18n.t('err.compile.issueNoLoc', { lng, text })
      })
      .join(i18n.t('err.compile.issueSep', { lng }))
  )
}

export { i18n }
