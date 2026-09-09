/*
  项目索引：把本地目录里的 JS / TS 源码整体喂给 Monaco 的 TS 语言服务，
  跨文件 import 才有成员补全、类型信息，以及正确的「找不到模块」判断。

  为什么需要它 —— Monaco 的 TS worker 把「当前有 model 的文件」当成整个项目
  （tsWorker 的 getScriptFileNames / fileExists 只查 model 和 extraLibs）。
  编辑器里每个打开的文件才有一个 model，而且 Editor 还会按 LRU 淘汰，
  所以 `import { x } from './utils'` 时，只要 utils.ts 没打开，语言服务就当它不存在。

  做法：扫一遍根目录，把可运行的源码文件（后缀见 INDEXED_EXT）用 addExtraLib 登记进
  语言服务，文件名用和编辑器 model 一模一样的 URI（modelUri）。tsWorker 取内容时 model 优先、
  extraLib 兜底，于是「打开着的文件以缓冲区为准、没打开的用磁盘内容」自然成立。

  JS 和 TS 是两个独立的 worker（workerManager 只把同语言的 model 同步给各自的 worker）：
  - javascript 那个 worker 默认开了 allowJs，.ts / .js 两种都能按真实文件名登记；
  - typescript 那个没开 allowJs，而且不能开：monaco 的 getScriptKind 对 .mts 这类后缀按
    「allowJs ? JS : TS」判定，一开 .mts 文件就会被当 JS 解析、类型标注全成语法错误，
    compile.ts 里按语法诊断拦运行也会跟着误伤。所以 .js 文件在 TS worker 里改用
    「.js → .ts」的别名登记（moduleResolution: Bundler 下 `./a.js` / `./a` 都会先找 a.ts）。
    JS 代码按 TS 解析，除了 JSDoc 类型不生效外，推断出来的签名是一样的。
    同名的 a.ts 真实存在时别名让位，和运行时 candidates() 的探测顺序（.js 优先）略有出入，
    这种同名并存的情况本身就该避免。

  编辑器里的改动通过 setContent 推进来（App 在 Editor 的 onChange 里调）：同语言 worker
  用不上（model 优先），但另一个语言的 worker 只能靠它看到未保存的内容。

  不碰 React、不碰 workspace 状态；根目录的 handle 由 useProjectIndex 在根就绪时交进来。
*/

import { debounce } from 'lodash-es'

import { monaco, modelUri } from '@/monaco/setup'
import { extOf } from './file-types'
import { listDirectory, resolveDirectory, resolveFile, type Listing } from './fs-access'

/** 进索引的后缀：和 module-graph 里 RUNNABLE_EXT 一致，运行时能 import 的才有必要让语言服务认识 */
export const INDEXED_EXT = new Set(['ts', 'mts', 'js', 'mjs'])

/** 单个根最多索引多少文件。到顶就停：超过这个数的目录不是 playground 的用法 */
export const MAX_INDEX_FILES = 500

/** 单文件上限。源码远小于此；超过的多半是打包产物，喂给语言服务只会拖慢它 */
const MAX_INDEX_FILE_SIZE = 512 * 1024

/** 编辑器改动推给 worker 的节流间隔：每次推送都是整份 extraLibs 表，不能按键盘节奏发 */
const PUSH_DELAY = 400

interface IndexedFile {
  content: string
  /** 磁盘上的 mtime；重扫时和它比，没变的不重读 */
  lastModified: number
}

export interface ProjectIndex {
  /** 扫（或重扫）一个根目录。重扫按 mtime 增量读，可以随便调 */
  scanRoot(id: string, handle: FileSystemDirectoryHandle): Promise<void>
  /** 用之前交进来的 handle 重扫。根不在索引里就什么都不做 */
  rescan(id: string): Promise<void>
  /** 根被移除 / 失去授权：它下面的文件整体撤出语言服务 */
  dropRoot(id: string): void
  /** 编辑器里的内容变了（未保存也算）。path 是 workspace 路径（`<根 id>/<相对路径>`） */
  setContent(path: string, content: string): void
  /** 文件或整个目录被删了 */
  remove(path: string): void
  /** 文件或整个目录改了名：内容不变，key 换前缀 */
  rename(from: string, to: string): void
  /** 丢掉编辑器里的版本，改回磁盘内容（关掉未保存的标签之后）。文件不在了就撤出索引 */
  reload(path: string): Promise<void>
  /** 列一层目录，给路径补全用。根不可用或目录不存在返回 null */
  listDir(path: string): Promise<Listing | null>
  dispose(): void
}

const rootIdOf = (path: string) => path.split('/', 1)[0]
const relativeOf = (path: string) => path.slice(rootIdOf(path).length + 1)
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const libNameOf = (path: string) => modelUri(`local:${path}`).toString()

/** 一个 worker（defaults）里已登记的 extraLib：内容用来判断要不要重发，disposable 用来撤 */
interface Registered {
  content: string
  disposable: monaco.IDisposable
}

export function createProjectIndex(): ProjectIndex {
  const roots = new Map<string, FileSystemDirectoryHandle>()
  const files = new Map<string, IndexedFile>()
  /** 内容来自编辑器缓冲区的路径：重扫时不用磁盘内容盖掉它，reload 才撤销 */
  const buffered = new Set<string>()
  /** 每个根的扫描代数：新一轮扫描或 dropRoot 会让旧一轮的结果作废 */
  const generation = new Map<string, number>()

  const registered = {
    typescript: new Map<string, Registered>(),
    javascript: new Map<string, Registered>(),
  }

  /** 把 files 同步成两份 extraLibs。只发有变化的那些；addExtraLib 对同路径会自己递增版本号 */
  const publish = () => {
    const desired = { typescript: new Map<string, string>(), javascript: new Map<string, string>() }
    for (const [path, file] of files) {
      desired.javascript.set(libNameOf(path), file.content)
      const ext = extOf(nameOf(path))
      if (ext === 'ts' || ext === 'mts') {
        desired.typescript.set(libNameOf(path), file.content)
      } else {
        // .js → .ts、.mjs → .mts 的别名，见文件头。真有同名 .ts 时别名让位
        const alias = `${path.slice(0, -ext.length)}${ext === 'js' ? 'ts' : 'mts'}`
        if (!files.has(alias)) desired.typescript.set(libNameOf(alias), file.content)
      }
    }

    for (const lang of ['typescript', 'javascript'] as const) {
      const defaults = lang === 'typescript' ? monaco.typescript.typescriptDefaults : monaco.typescript.javascriptDefaults
      const current = registered[lang]
      for (const [name, reg] of current) {
        if (desired[lang].has(name)) continue
        reg.disposable.dispose()
        current.delete(name)
      }
      for (const [name, content] of desired[lang]) {
        if (current.get(name)?.content === content) continue
        current.set(name, { content, disposable: defaults.addExtraLib(content, name) })
      }
    }
  }
  const publishSoon = debounce(publish, PUSH_DELAY)

  /** 索引里所有落在 path 这棵子树里的路径（含它自己） */
  const subtree = (path: string) =>
    [...files.keys()].filter((p) => p === path || p.startsWith(`${path}/`))

  /**
   * 递归读一个根。目录列举复用 listDirectory（同一套忽略名单和单目录上限），
   * 文件先看 mtime，和上次一样的不重读。到 MAX_INDEX_FILES 就停下。
   */
  const scanRoot = async (id: string, handle: FileSystemDirectoryHandle) => {
    roots.set(id, handle)
    const gen = (generation.get(id) ?? 0) + 1
    generation.set(id, gen)
    const alive = () => generation.get(id) === gen

    const seen = new Map<string, IndexedFile>()
    const walk = async (dir: FileSystemDirectoryHandle, path: string) => {
      let listing: Listing
      try {
        listing = await listDirectory(dir, path)
      } catch {
        return // 这一层读不到（权限、句柄失效）就跳过，别的层照常
      }
      for (const entry of listing.entries) {
        if (!alive() || seen.size >= MAX_INDEX_FILES) return
        if (entry.kind === 'directory') {
          if (!entry.ignored) await walk(entry.handle, entry.path)
          continue
        }
        if (!INDEXED_EXT.has(extOf(entry.name))) continue
        try {
          const file = await entry.handle.getFile()
          if (file.size > MAX_INDEX_FILE_SIZE) continue
          const prev = files.get(entry.path)
          if (prev && (buffered.has(entry.path) || prev.lastModified === file.lastModified)) {
            seen.set(entry.path, { content: prev.content, lastModified: file.lastModified })
          } else {
            seen.set(entry.path, { content: await file.text(), lastModified: file.lastModified })
          }
        } catch {
          // 单个文件读失败不影响别的
        }
      }
    }
    await walk(handle, id)
    if (!alive()) return

    // 这一轮没看到的就是被删了（或超出上限）；缓冲区里的除外 —— 那是编辑器里还开着的
    for (const path of subtree(id)) {
      if (!seen.has(path) && !buffered.has(path)) files.delete(path)
    }
    for (const [path, file] of seen) files.set(path, file)
    publish()
  }

  const remove = (path: string) => {
    for (const p of subtree(path)) {
      files.delete(p)
      buffered.delete(p)
    }
    publish()
  }

  return {
    scanRoot,

    rescan: async (id) => {
      const handle = roots.get(id)
      if (handle) await scanRoot(id, handle)
    },

    dropRoot: (id) => {
      roots.delete(id)
      generation.set(id, (generation.get(id) ?? 0) + 1)
      remove(id)
    },

    setContent: (path, content) => {
      if (!roots.has(rootIdOf(path)) || !INDEXED_EXT.has(extOf(nameOf(path)))) return
      const prev = files.get(path)
      if (prev?.content === content) return
      files.set(path, { content, lastModified: prev?.lastModified ?? 0 })
      buffered.add(path)
      publishSoon()
    },

    remove,

    rename: (from, to) => {
      for (const p of subtree(from)) {
        const next = to + p.slice(from.length)
        const file = files.get(p)!
        files.delete(p)
        files.set(next, file)
        if (buffered.delete(p)) buffered.add(next)
      }
      publish()
    },

    reload: async (path) => {
      buffered.delete(path)
      const root = roots.get(rootIdOf(path))
      if (!root || !INDEXED_EXT.has(extOf(nameOf(path)))) return
      const handle = await resolveFile(root, relativeOf(path))
      let next: IndexedFile | null = null
      if (handle) {
        try {
          const file = await handle.getFile()
          if (file.size <= MAX_INDEX_FILE_SIZE) next = { content: await file.text(), lastModified: file.lastModified }
        } catch {
          // 读不到就按不存在处理
        }
      }
      // 期间用户可能又把它打开并改了：缓冲区的版本更新，别用磁盘的盖掉
      if (buffered.has(path)) return
      if (next) files.set(path, next)
      else files.delete(path)
      publish()
    },

    listDir: async (path) => {
      const root = roots.get(rootIdOf(path))
      if (!root) return null
      const dir = await resolveDirectory(root, relativeOf(path))
      if (!dir) return null
      try {
        return await listDirectory(dir, path)
      } catch {
        return null
      }
    },

    dispose: () => {
      publishSoon.cancel()
      for (const id of roots.keys()) generation.set(id, (generation.get(id) ?? 0) + 1)
      roots.clear()
      files.clear()
      buffered.clear()
      for (const current of Object.values(registered)) {
        for (const reg of current.values()) reg.disposable.dispose()
        current.clear()
      }
    },
  }
}
