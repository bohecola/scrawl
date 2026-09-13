// 文件类型：后缀 → 语言、能不能在 runner 里跑。纯函数，不碰文件系统 API。

/** 后缀 → Monaco 语言 id。不在表里的按「非文本」处理，点击时给提示而不是硬塞进编辑器。 */
const LANGUAGE_BY_EXT: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  sh: 'shell',
  bash: 'shell',
  sql: 'sql',
  txt: 'plaintext',
  log: 'plaintext',
  env: 'plaintext',
  gitignore: 'plaintext',
  editorconfig: 'plaintext',
  npmrc: 'plaintext',
}

/** 能交给 runner 执行的语言（runner 是没有 DOM 的 Web Worker，只跑 JS/TS）。 */
export function isRunnable(language: string): boolean {
  return language === 'javascript' || language === 'typescript'
}

/** 一种语言的预览规格。mode 区分沙箱策略与刷新模型（详见 PreviewPanel）；auto = 防抖自动刷新。 */
export interface PreviewSpec {
  mode: 'page' | 'document'
  auto: boolean
}

/**
 * 该语言能不能预览、按什么模式预览。
 * html 走 page 模式：iframe 里跑真正的页面，刷新跟「运行」模型（手动触发）；
 * markdown 走 document 模式：排版外壳是我们的、跟着应用主题走，编辑即防抖刷新（文档不是程序）。
 */
export function previewOf(language: string): PreviewSpec | null {
  if (language === 'html') return { mode: 'page', auto: false }
  if (language === 'markdown') return { mode: 'document', auto: true }
  return null
}

/** 运行按钮对哪些语言可用：JS/TS 进 worker，HTML 进预览（runCode 按语言分流）。
 *  document 模式不算——它是自动刷新的文档，没有「运行」语义，按钮不该亮。 */
export function isExecutable(language: string): boolean {
  return isRunnable(language) || previewOf(language)?.mode === 'page'
}

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  // 「.gitignore」这类以点开头、没有真正后缀的文件，整个名字当后缀看
  if (dot <= 0) return name.replace(/^\./, '').toLowerCase()
  return name.slice(dot + 1).toLowerCase()
}

/** 推断 Monaco 语言 id；无法识别时返回 null（视为非文本文件）。 */
export function languageOf(name: string): string | null {
  return LANGUAGE_BY_EXT[extOf(name)] ?? null
}

