/*
  模块路径解析：把一个「代码里写出来的路径」展开成磁盘上真正可能是哪个文件的候选序列。

  两个调用方共用这一份规则，它俩必须完全一致，否则会出现「跑得起来但跳不过去」这种怪事：
  - 运行时 lib/module-graph.ts：解析 import 的 specifier，决定读哪个文件；
  - 跳定义 components/Editor.tsx：TS 语言服务回给我们的文件名（可能是别名）要对回磁盘上的文件。

  目录那条规则在 monaco/path-completion.ts 里也有一份，但那边只补目录、不涉及候选后缀，
  语义不同，不合并。
*/

import { uniq } from 'lodash-es'

import { extOf } from './file-types'

/** 能在 runner 里执行的源码后缀。其余后缀 import 进来运行时会报「不支持的类型」 */
export const RUNNABLE_EXT = new Set(['js', 'mjs', 'ts', 'mts'])

/**
 * 从 fromPath 所在目录出发拼接 spec，做 `.` / `..` 规范化。
 * 返回 null 表示越出了根目录（把 rootId 那一段都 pop 掉了）。
 */
export function joinPath(fromPath: string, spec: string): string | null {
  const base = fromPath.split('/').slice(0, -1) // 去掉文件名
  const rootId = base[0]
  const out = [...base]
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      out.pop()
      // rootId 是第一段，pop 到它没了就是越界
      if (out.length === 0) return null
      continue
    }
    out.push(seg)
  }
  if (out[0] !== rootId || out.length < 2) return null
  return out.join('/')
}

/**
 * 省略后缀 / 写了 .js 实为 .ts 的候选，按探测顺序。
 *
 * 后两条（js→ts、mjs→mts）对应磁盘上真实的错配：代码里写 `import './a.js'`，
 * 而目录里只有 a.ts —— TS 项目里很常见。运行时要找得到那个文件，
 * 跳定义也要能把语言服务报回的名字对回磁盘。
 */
export function candidates(path: string): string[] {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const ext = extOf(name)
  const list = [path]
  if (!name.includes('.') || !RUNNABLE_EXT.has(ext)) {
    // 没有后缀（或后缀不像可运行文件，比如 ./utils.v2）：补后缀、找目录 index
    list.push(`${path}.ts`, `${path}.js`, `${path}.mts`, `${path}.mjs`, `${path}/index.ts`, `${path}/index.js`)
  }
  if (ext === 'js') list.push(path.slice(0, -3) + '.ts')
  if (ext === 'mjs') list.push(path.slice(0, -4) + '.mts')
  return uniq(list)
}

/**
 * 这个候选路径是不是「运行时可 import 的源码」。
 *
 * candidates() 的第一个元素永远是输入路径本身，所以输入后缀不是 ts/mts/js/mjs 时
 * （比如 `./a.jsx`、`./style.css`），首元素会是非可运行文件。运行时碰到它要报
 * 「不支持的类型」，跳定义碰到它也不该打开 —— 两条路必须用这同一个判据，
 * 否则又会出现「跑不起来却能跳过去」这种反过来的一侧。
 */
export function isRunnablePath(path: string): boolean {
  return RUNNABLE_EXT.has(extOf(path.slice(path.lastIndexOf('/') + 1)))
}
