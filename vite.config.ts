import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LANG_TAGS, ALL_LANGS } from './src/i18n/langs.ts'

const here = import.meta.dirname
const monacoVs = resolve(here, 'node_modules/monaco-editor/esm/vs')

/*
  把语言表注进 index.html 的首帧脚本。
  那段脚本在 React 挂载前决定 <html lang> / dir / 标题，拿不到模块，
  以前是手抄一份语言列表和两种语言的标题；现在从 src/i18n 里那一张表生成，
  加语言只改 langs.ts 和 locales 下的 JSON。
*/
function injectLangTable(): Plugin {
  // locales/ 里 html.title 没有插值，读文件比把它打进构建图更省事（构建图归 setup.ts 管）
  const titles = Object.fromEntries(
    ALL_LANGS.map((lang) => {
      const tag = LANG_TAGS[lang]
      const json = JSON.parse(readFileSync(resolve(here, `src/locales/${tag}.json`), 'utf8'))
      return [tag, json['html.title']]
    }),
  )
  return {
    name: 'scrawl:inject-lang-table',
    transformIndexHtml(html) {
      return html
        .replace('__SCRAWL_LANG_TAGS__', JSON.stringify(LANG_TAGS))
        .replace('__SCRAWL_TITLES__', JSON.stringify(titles))
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), injectLangTable()],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // 排除 monaco-editor 的预打包：dev 下预打包会丢失 ?worker 的 default 导出
    // （worker 模块被优化成普通模块，没有 default）。改成按需直接以 ESM 提供。
    exclude: ['monaco-editor'],
  },
  resolve: {
    alias: {
      "@": resolve(here, "./src"),
      "monaco-editor/esm/vs": monacoVs
    }
  }
})
