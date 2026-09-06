/*
  编辑器主题表。设置面板的「编辑器主题」下拉从这里取；'auto' 表示跟随界面明暗
  （深色 → vs-dark，浅色 → playground-light，见 setup.ts）。

  自定义主题只写 JS / TS 常见的那几类 token，其余继承 base；名字用主题本名，不翻译。
*/
import { monaco } from './setup'

export type EditorThemeKind = 'dark' | 'light'

export interface EditorThemeMeta {
  id: string
  label: string
  kind: EditorThemeKind
}

export const AUTO_THEME = 'auto'

type Palette = {
  base: 'vs' | 'vs-dark'
  bg: string
  fg: string
  line: string
  cursor: string
  selection: string
  lineNo: string
  comment: string
  keyword: string
  string: string
  number: string
  type: string
  fn: string
  regexp: string
}

function define(id: string, p: Palette) {
  monaco.editor.defineTheme(id, {
    base: p.base,
    inherit: true,
    rules: [
      { token: 'comment', foreground: p.comment, fontStyle: 'italic' },
      { token: 'keyword', foreground: p.keyword },
      { token: 'string', foreground: p.string },
      { token: 'number', foreground: p.number },
      { token: 'regexp', foreground: p.regexp },
      { token: 'type', foreground: p.type },
      { token: 'type.identifier', foreground: p.type },
      { token: 'function', foreground: p.fn },
      { token: 'identifier', foreground: p.fg },
      { token: 'delimiter', foreground: p.fg },
      { token: 'operator', foreground: p.fg },
      { token: 'tag', foreground: p.keyword },
      { token: 'attribute.name', foreground: p.type },
      { token: 'attribute.value', foreground: p.string },
      { token: 'annotation', foreground: p.fn },
    ],
    colors: {
      'editor.background': p.bg,
      'editor.foreground': p.fg,
      'editor.lineHighlightBackground': p.line,
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': p.cursor,
      'editor.selectionBackground': p.selection,
      'editorLineNumber.foreground': p.lineNo,
      'editorLineNumber.activeForeground': p.fg,
    },
  })
}

define('github-dark', {
  base: 'vs-dark', bg: '#0d1117', fg: '#c9d1d9', line: '#161b22', cursor: '#58a6ff',
  selection: '#264f78', lineNo: '#6e7681', comment: '8b949e', keyword: 'ff7b72',
  string: 'a5d6ff', number: '79c0ff', type: 'ffa657', fn: 'd2a8ff', regexp: 'a5d6ff',
})
define('one-dark', {
  base: 'vs-dark', bg: '#282c34', fg: '#abb2bf', line: '#2c313c', cursor: '#528bff',
  selection: '#3e4451', lineNo: '#4b5263', comment: '5c6370', keyword: 'c678dd',
  string: '98c379', number: 'd19a66', type: 'e5c07b', fn: '61afef', regexp: '56b6c2',
})
define('dracula', {
  base: 'vs-dark', bg: '#282a36', fg: '#f8f8f2', line: '#44475a', cursor: '#f8f8f2',
  selection: '#44475a', lineNo: '#6272a4', comment: '6272a4', keyword: 'ff79c6',
  string: 'f1fa8c', number: 'bd93f9', type: '8be9fd', fn: '50fa7b', regexp: 'f1fa8c',
})
define('monokai', {
  base: 'vs-dark', bg: '#272822', fg: '#f8f8f2', line: '#3e3d32', cursor: '#f8f8f0',
  selection: '#49483e', lineNo: '#90908a', comment: '75715e', keyword: 'f92672',
  string: 'e6db74', number: 'ae81ff', type: '66d9ef', fn: 'a6e22e', regexp: 'e6db74',
})
define('github-light', {
  base: 'vs', bg: '#ffffff', fg: '#24292f', line: '#f6f8fa', cursor: '#0969da',
  selection: '#b6d7ff', lineNo: '#8c959f', comment: '6e7781', keyword: 'cf222e',
  string: '0a3069', number: '0550ae', type: '953800', fn: '8250df', regexp: '0a3069',
})
define('solarized-light', {
  base: 'vs', bg: '#fdf6e3', fg: '#657b83', line: '#eee8d5', cursor: '#657b83',
  selection: '#e0dbc7', lineNo: '#93a1a1', comment: '93a1a1', keyword: '859900',
  string: '2aa198', number: 'd33682', type: 'b58900', fn: '268bd2', regexp: 'dc322f',
})

/** 下拉里可选的主题。内置的 vs-dark / playground-light 也列上，名字按大家熟悉的叫法。 */
export const EDITOR_THEMES: readonly EditorThemeMeta[] = [
  { id: 'vs-dark', label: 'Dark (VS Code)', kind: 'dark' },
  { id: 'github-dark', label: 'GitHub Dark', kind: 'dark' },
  { id: 'one-dark', label: 'One Dark', kind: 'dark' },
  { id: 'dracula', label: 'Dracula', kind: 'dark' },
  { id: 'monokai', label: 'Monokai', kind: 'dark' },
  { id: 'hc-black', label: 'High Contrast Dark', kind: 'dark' },
  { id: 'playground-light', label: 'Light (Scrawl)', kind: 'light' },
  { id: 'github-light', label: 'GitHub Light', kind: 'light' },
  { id: 'solarized-light', label: 'Solarized Light', kind: 'light' },
  { id: 'hc-light', label: 'High Contrast Light', kind: 'light' },
]

export function isEditorTheme(id: unknown): id is string {
  return id === AUTO_THEME || EDITOR_THEMES.some((t) => t.id === id)
}

/** 把设置值解析成真正要交给 Monaco 的主题 id */
export function resolveEditorTheme(setting: string, effective: 'dark' | 'light'): string {
  if (setting !== AUTO_THEME && isEditorTheme(setting)) return setting
  return effective === 'dark' ? 'vs-dark' : 'playground-light'
}
