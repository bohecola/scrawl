// TS → JS 编译：直接用 Monaco 自带的 TypeScript 语言服务（ts.worker）。
//
// 它本来就为了补全 / 诊断常驻着，编辑器里每个文件都是它的一份「脚本」，
// 让它顺手 emit 一份 JS 就够了 —— 不必再拖一个 14MB 的 esbuild.wasm 只为剥类型。
// 代价是编译比 esbuild 慢一点（几十毫秒量级），playground 里感觉不出来。
import { monaco, modelUri } from '@/monaco/setup'
import { AppError } from './app-error'
import { stripExports } from './strip-exports'

/** 一条编译错误。位置的写法（「第 N 行第 M 列」）由译文决定，这里只传数字。 */
export interface CompileIssue {
  text: string
  loc: { line: number; column: number } | null
}

/** 把语法诊断整理成一条待翻译的错误；位置从 0 基偏移换成行列 */
function compileError(model: monaco.editor.ITextModel, diagnostics: monaco.typescript.Diagnostic[]): AppError {
  const issues: CompileIssue[] = diagnostics.map((d) => {
    const pos = typeof d.start === 'number' ? model.getPositionAt(d.start) : null
    return {
      text: flattenMessage(d.messageText),
      loc: pos ? { line: pos.lineNumber, column: pos.column } : null,
    }
  })
  return new AppError('err.compile.failed', { issues })
}

// TS 的 messageText 可能是一条链（DiagnosticMessageChain），取第一层就够看
function flattenMessage(text: monaco.typescript.Diagnostic['messageText']): string {
  return typeof text === 'string' ? text : text.messageText
}

/**
 * TS → JS，只剥类型、不做类型检查（语法错误会拦下）；JS 原样返回。import / export 原样保留。
 *
 * key 是编辑器里 model 的 key（同 EditorHandle 的 key）。TS 路径需要它找到对应 model：
 * 语言服务按 model 工作，而不是按一段字符串。找不到 model（没在编辑器里打开的依赖文件）就临时建一个。
 */
async function emitJs(code: string, language: string, key?: string): Promise<string> {
  if (language !== 'typescript') return code

  const existing = key ? monaco.editor.getModel(modelUri(key)) : null
  const model =
    existing ??
    monaco.editor.createModel(code, 'typescript', modelUri(`__compile__${Date.now()}_${Math.random()}`))
  try {
    // 用户可能刚敲完就按了运行：model 里的内容和传进来的 code 应该一致，以传进来的为准
    if (model.getValue() !== code) model.setValue(code)
    const uri = model.uri.toString()
    const getWorker = await monaco.typescript.getTypeScriptWorker()
    const worker = await getWorker(model.uri)
    const syntax = await worker.getSyntacticDiagnostics(uri)
    if (syntax.length > 0) throw compileError(model, syntax)
    const out = await worker.getEmitOutput(uri)
    // .ts 出 .js，.mts 出 .mjs（.cts 出 .cjs）：只认 .js 会让 .mts 入口报「没有输出」
    const js = out.outputFiles.find((f) => /\.[mc]?js$/.test(f.name))?.text
    if (js === undefined) throw new AppError('err.compile.raw', { message: 'TypeScript emitted no output' })
    return js
  } catch (err) {
    if (err instanceof AppError) throw err
    throw new AppError('err.compile.raw', { message: err instanceof Error ? err.message : String(err) })
  } finally {
    if (!existing) model.dispose()
  }
}

/**
 * 脚本模式：编译成可以直接在 eval（脚本上下文）里执行的 JS，顶层 export 会被剥掉。
 * 入口没有 import 时走这条路（见 docs/module-imports-plan.md 第 3 节）。
 */
export async function compileToJs(code: string, language: string, key?: string): Promise<string> {
  return stripExports(await emitJs(code, language, key))
}

/** 模块模式：保留 import / export，交给 module-graph 改写 specifier 后以 ESM 执行。 */
export async function compileModule(code: string, language: string, key?: string): Promise<string> {
  return emitJs(code, language, key)
}
