/*
  Markdown 预览的生产者：把 md 变成 iframe 的 srcDoc。
  与 render-html 同居「producer」这个位置，但文档外壳恰恰相反——page 模式必须
  原样呈现用户的页面，而 document 模式的排版是我们的：GitHub 风格 + 跟着应用主题走。

  安全：document 模式的 iframe 是 sandbox=""（脚本全禁），md 里内嵌的 <script>、
  onerror 之类一概不执行，所以解析结果不需要再过 sanitizer。
  代码块暂不做语法高亮：highlight.js 的体积对这个功能来说不成比例，等真有需要再加。
*/

import { marked } from 'marked'

// 两套调色板都取自应用的语义令牌（见 assets/style/index.css 的 data-theme 块），
// 让预览和面板底色、边框融为一体，而不是一张突兀的白纸
const PALETTES: Record<'light' | 'dark', Record<string, string>> = {
  light: {
    bg: '#ffffff',
    text: '#1e293b',
    heading: '#0f172a',
    link: '#0284c7',
    border: '#e2e8f0',
    codeBg: '#f1f5f9',
    quote: '#64748b',
  },
  dark: {
    bg: '#1e1e1e',
    text: '#d4d4d4',
    heading: '#e5e5e5',
    link: '#4cc2ff',
    border: '#3c3c3c',
    codeBg: '#2a2d2e',
    quote: '#9d9d9d',
  },
}

function docStyle(p: Record<string, string>): string {
  return `
    body {
      margin: 0; padding: 16px 20px 32px;
      background: ${p.bg}; color: ${p.text};
      font: 15px/1.65 -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
      word-wrap: break-word;
    }
    h1, h2, h3, h4, h5, h6 { color: ${p.heading}; line-height: 1.3; margin: 1.4em 0 0.6em; }
    h1 { font-size: 1.7em; }
    h1, h2 { border-bottom: 1px solid ${p.border}; padding-bottom: 0.3em; }
    h3 { font-size: 1.3em; }
    p { margin: 0.7em 0; }
    a { color: ${p.link}; }
    code {
      font-family: Consolas, 'Courier New', monospace; font-size: 0.88em;
      background: ${p.codeBg}; border-radius: 4px; padding: 0.15em 0.4em;
    }
    pre {
      background: ${p.codeBg}; border: 1px solid ${p.border}; border-radius: 6px;
      padding: 12px 14px; overflow: auto;
    }
    pre code { background: none; padding: 0; font-size: 13px; }
    blockquote {
      margin: 0.7em 0; padding: 0.1em 1em; color: ${p.quote};
      border-inline-start: 3px solid ${p.border};
    }
    table { border-collapse: collapse; margin: 0.8em 0; }
    th, td { border: 1px solid ${p.border}; padding: 5px 12px; }
    th { background: ${p.codeBg}; }
    hr { border: none; border-top: 1px solid ${p.border}; margin: 1.5em 0; }
    img { max-width: 100%; }
  `
}

/**
 * 把 md 渲染成完整文档。theme 跟着应用的 data-theme 走（渲染时读，主题切换时上层会重渲染）。
 */
export function renderMarkdownPreview(markdown: string, theme: 'light' | 'dark'): string {
  const body = marked.parse(markdown, { async: false })
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${docStyle(PALETTES[theme])}</style></head><body>${body}</body></html>`
}
