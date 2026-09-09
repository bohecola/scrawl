/*
  import 路径补全：光标在 `import … from './|'`、`import './|'`、`import('./|')` 的引号里时，
  按当前文件所在目录列出子目录和可运行的源码文件。

  为什么不用 TS 自带的路径补全：它靠语言服务宿主的 readDirectory / getDirectories，
  monaco 的 tsWorker 一个都没实现，引号里永远是空的。目录内容在主线程手上（File System
  Access 的 handle），在这里列一层反而最直接。

  只补相对路径：运行时（module-graph）只认 `./` `../` 开头的 specifier，裸模块名提示了也跑不了。
  列出来的文件也只有 INDEXED_EXT 那几种，其余类型 import 进来运行时会报「不支持的类型」。
*/

import { monaco, keyOfUri } from './setup'
import { INDEXED_EXT } from '@/lib/project-index'
import { extOf } from '@/lib/file-types'
import type { Listing } from '@/lib/fs-access'

export interface PathCompletionHost {
  listDir(path: string): Promise<Listing | null>
}

/** 光标前的那截文本是不是 import 说明符字符串的开头部分。捕获：引号、已经敲进去的路径 */
const IN_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"]*)$/

/** 以 fromPath 所在目录为基准解析一段目录路径；越出根目录返回 null。根目录本身是合法结果 */
function joinDir(fromPath: string, spec: string): string | null {
  const out = fromPath.split('/').slice(0, -1)
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      out.pop()
      if (out.length === 0) return null
      continue
    }
    out.push(seg)
  }
  return out.join('/')
}

/**
 * 写进代码里的形态：.ts / .js 去掉后缀（TS 的 Bundler 解析和运行时的 candidates() 都认），
 * .mts / .mjs 保留 —— 无后缀时 TS 不会去试这两种。
 */
function specifierNameOf(name: string): string {
  const ext = extOf(name)
  return ext === 'ts' || ext === 'js' ? name.slice(0, -(ext.length + 1)) : name
}

export function registerPathCompletion(host: PathCompletionHost): monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider(['javascript', 'typescript'], {
    triggerCharacters: ['/', '"', "'"],
    async provideCompletionItems(model, position) {
      const key = keyOfUri(model.uri)
      if (!key?.startsWith('local:')) return null
      const fromPath = key.slice('local:'.length)

      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1)
      const m = IN_SPECIFIER.exec(before)
      if (!m) return null
      const typed = m[2]
      // 正在敲的这一段（最后一个斜杠之后）是要被替换的范围，前面的目录部分留着
      const slash = typed.lastIndexOf('/')
      const segment = typed.slice(slash + 1)
      const range = new monaco.Range(
        position.lineNumber,
        position.column - segment.length,
        position.lineNumber,
        position.column
      )
      const triggerSuggest = { id: 'editor.action.triggerSuggest', title: '' }

      if (slash === -1) {
        // 还没写到 `./` 或 `../`：只提示这两个开头。裸模块名不补 —— 运行时不支持
        if (segment !== '' && !/^\.{1,2}$/.test(segment)) return null
        return {
          suggestions: ['./', '../'].map((p, i) => ({
            label: p,
            kind: monaco.languages.CompletionItemKind.Folder,
            insertText: p,
            range,
            sortText: String(i),
            command: triggerSuggest,
          })),
        }
      }

      const dirPath = joinDir(fromPath, typed.slice(0, slash))
      if (dirPath === null) return null
      const listing = await host.listDir(dirPath)
      if (!listing) return null

      const suggestions: monaco.languages.CompletionItem[] = []
      for (const entry of listing.entries) {
        if (entry.path === fromPath) continue
        if (entry.kind === 'directory') {
          if (entry.ignored) continue
          suggestions.push({
            label: entry.name,
            kind: monaco.languages.CompletionItemKind.Folder,
            insertText: entry.name,
            range,
            sortText: `0${entry.name}`,
          })
        } else if (INDEXED_EXT.has(extOf(entry.name))) {
          suggestions.push({
            label: entry.name,
            kind: monaco.languages.CompletionItemKind.File,
            insertText: specifierNameOf(entry.name),
            range,
            sortText: `1${entry.name}`,
          })
        }
      }
      return { suggestions }
    },
  })
}
