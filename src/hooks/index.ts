// 加载内置 Demo 源码。
//
// 刻意不在这里做任何转换（早先版本会先 stripExports 再返回）：
// 编辑器现在也用来打开用户本地磁盘上的文件，而「加载时改内容」在那条路上是灾难 ——
// Ctrl+S 会把被改过的内容原样写回磁盘。运行前的 export 剥离已经由 compileToJs 承担，
// 对内置 Demo 和本地文件一视同仁，这里只负责把原文交出去。
const modules = import.meta.glob('../resources/**/*.{js,html,css,md}', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>

/** glob 的 key 带着这个前缀（`../resources/demos/overrides/call.js`）。 */
const PREFIX = '../resources/'

export async function loadTemplate(path: string): Promise<string> {
  const loader = modules[path]
  if (!loader) throw new Error(`Template not found: ${path}`)
  return await loader()
}

// 所有 Demo 的路径（用于侧边栏「Demo 片段」分组）。
// 模块级算一次：App 每次渲染都调它，返回新数组会让依赖它的 effect / useMemo 全部抖动
const TEMPLATE_PATHS: readonly string[] = Object.keys(modules)
export function listTemplates(): readonly string[] {
  return TEMPLATE_PATHS
}

export interface TemplateFile {
  /** 相对总目录的路径，如 `overrides/call.js` */
  path: string
  content: string
}

/**
 * 一次取回全部 Demo 源码，给「存到本地文件夹」用。
 *
 * 路径去掉 glob 前缀，落到磁盘上就是同一套目录结构，和侧边栏里列出来的严格一致。
 *
 * 一共 9 个文件、几十 KB，全量并发取，不必分批。
 */
export async function loadAllTemplates(): Promise<TemplateFile[]> {
  return await Promise.all(
    Object.entries(modules).map(async ([path, load]) => ({
      path: path.slice(PREFIX.length),
      content: await load(),
    }))
  )
}
