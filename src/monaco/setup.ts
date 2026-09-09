import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

// 只有 JS / TS 是常用路径，它们的 worker 直接打进主包；
// json / css / html 只在用户从本地目录打开这类文件时才用得到（合计 2MB 多），按需再下。
// getWorker 允许返回 Promise<Worker>。
self.MonacoEnvironment = {
  getWorker(_, label) {
    switch (label) {
      case 'json':
        return import('monaco-editor/esm/vs/language/json/json.worker?worker').then((m) => new m.default())
      case 'css':
      case 'scss':
      case 'less':
        return import('monaco-editor/esm/vs/language/css/css.worker?worker').then((m) => new m.default())
      case 'html':
      case 'handlebars':
      case 'razor':
        return import('monaco-editor/esm/vs/language/html/html.worker?worker').then((m) => new m.default())
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      default:
        return new editorWorker()
    }
  },
}

/** 编辑器里每个文件（key）对应的 model URI。Editor 建 model、compile 找 model 都用它 */
export const modelUri = (key: string) => monaco.Uri.parse(`inmemory://scrawl/${encodeURIComponent(key)}`)

/**
 * modelUri 的反向：从 URI 拿回 key。不是本应用建的 model（比如 Monaco 内部的）返回 null。
 * Uri.parse 已经把 encodeURIComponent 过的 key 还原成 path（带一个开头的斜杠），
 * 所以 `local:r1/src/a.ts` 这种带斜杠的 key 在 path 里也是原样的。
 */
export const keyOfUri = (uri: monaco.Uri): string | null =>
  uri.scheme === 'inmemory' && uri.authority === 'scrawl' ? uri.path.slice(1) : null

/*
  编辑器现在同时打开多个文件（每个文件一个 model），这会踩到 TS 语言服务的一个默认行为：
  没有顶层 import/export 的文件被当成「全局脚本」，所有这类文件共享同一个作用域。
  于是同时打开两个各自写着 `const fn = ...` 的 TS 文件时，两边会互相报
  「Cannot redeclare block-scoped variable」——代码没问题，报错纯属误伤。
  （.js model 暂时看不到这个误报：monaco 的 javascriptDefaults 默认关掉了语义诊断。
  但语言服务两边共用一套文件表，选项还是一起设，省得哪天打开 checkJs 又冒出来。）

  moduleDetection: Force 让每个文件都被视作模块，各自独立作用域，误报消失。
  用 merge 而不是整体替换：语言服务的默认值里还有一堆 lib / 诊断相关配置，
  替换掉会连带丢掉那些。
*/
const SHARED_COMPILER_OPTIONS: monaco.typescript.CompilerOptions = {
  // 3 = ModuleDetectionKind.Force。monaco 的类型定义里没有这个枚举（它比 TS 里
  // 加入 moduleDetection 的时间早），但选项本身会原样传给 ts.worker，写数字即可。
  moduleDetection: 3,
  module: monaco.typescript.ModuleKind.ESNext,
  // 用 ESNext 而不是 ES2022：monaco 的 ScriptTarget 枚举停在 ES2020，
  // 这里既影响补全和诊断，也决定运行前 emit 出来的 JS 形态（顶层 await、class 字段等原样保留）。
  target: monaco.typescript.ScriptTarget.ESNext,
  // model 的 URI 是 inmemory://…，没有 .ts/.js 后缀也要能被语言服务接受
  allowNonTsExtensions: true,
  // 100 = ModuleResolutionKind.Bundler（monaco 的枚举只到 NodeJs，数字原样传给 ts.worker）。
  // module: ESNext 下 TS 默认用 Classic 解析，它不认目录 index、也不会把 `./a.js` 对到 a.ts；
  // Bundler 这三种都认，和运行时 module-graph 里 candidates() 的探测规则一致。
  // 跨文件的内容由 lib/project-index.ts 喂进来，没有它这里解析出来的也只是「找不到」。
  moduleResolution: 100 as monaco.typescript.ModuleResolutionKind,
  // 允许 `import './a.ts'` / `'./a.mts'` 这种带 TS 后缀的写法（否则 TS 报 5097），
  // emit 时会把后缀改写成 .js / .mjs，运行时 candidates() 再把它们对回 .ts / .mts。
  rewriteRelativeImportExtensions: true,
}

for (const defaults of [monaco.typescript.javascriptDefaults, monaco.typescript.typescriptDefaults]) {
  defaults.setCompilerOptions({ ...defaults.getCompilerOptions(), ...SHARED_COMPILER_OPTIONS })
}

// 自定义「高对比浅色」主题：默认 vs 浅色主题对部分人偏淡，
// 这里加深深色文字、注释、token 色彩并明确光标，提升可读性。
monaco.editor.defineTheme('playground-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '1a7f37', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'b31d28' },
    { token: 'string', foreground: 'a01d1d' },
    { token: 'number', foreground: '0550ae' },
    { token: 'regexp', foreground: '0a7d7d' },
    { token: 'type', foreground: '215f8e' },
    { token: 'type.identifier', foreground: '215f8e' },
    { token: 'function', foreground: '8250df' },
    { token: 'identifier', foreground: '24292f' },
    { token: 'delimiter', foreground: '24292f' },
    { token: 'tag', foreground: '116329' },
    { token: 'attribute.name', foreground: 'a03b0b' },
    { token: 'attribute.value', foreground: '1a7f37' },
    { token: 'variable', foreground: '24292f' },
    { token: 'operator', foreground: '0550ae' },
    { token: 'annotation', foreground: '6639ba' },
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#24292f',
    'editorCursor.foreground': '#0969da',
    'editor.selectionBackground': '#b6d7ff',
    'editor.lineHighlightBackground': '#f6f8fa',
    'editor.lineHighlightBorder': '#00000000',
    'editorIndentGuide.background1': '#d0d7de',
    'editorIndentGuide.activeBackground1': '#0969da',
    'editorWhitespace.foreground': '#d0d7de',
  },
})

export { monaco }
