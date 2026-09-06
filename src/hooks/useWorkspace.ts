import { useCallback, useEffect, useRef, useState } from 'react'
import { max, sortBy } from 'lodash-es'
import { AppError } from '@/lib/app-error'
import { messageOf, useI18n } from '@/i18n/context'
import { idbDel, idbGet, idbSet, requestPersistentStorage } from '@/lib/idb'
import {
  createDirectory,
  createDirectoryUnique,
  createFile,
  ensurePermission,
  isIgnoredDir,
  isPermissionError,
  isStaleHandleError,
  isSupported,
  listDirectory,
  measureTree,
  pickDirectory,
  queryPermission,
  removeEntry,
  renameDirectory,
  renameFile,
  resolveDirectory,
  resolveFile,
  writeFilesInto,
  type BundleFile,
  type DirEntry,
  type Entry,
  type Listing,
  type TreeSize,
  type WriteProgress,
} from '@/lib/fs-access'

/*
  本地目录工作区的状态机。可以同时打开多个目录，每个目录是一棵独立的树。

  路径怎么编：`<根 id>/<相对路径>`，根目录自己的路径就是它的 id。
  为什么要有 id 而不是直接用目录名 —— 名字会撞（同时打开两个项目里的 src），
  而路径同时是 childrenByPath 的 key、编辑器 model 的 key（local:<path>）、
  还有「上次展开了哪些层」的持久化内容，撞了就会互相盖掉。
  id 跟 handle 一起存进 IndexedDB，所以重开页面后这些 key 还对得上。

  每个根有三种状态，UI 完全不同：
  - status === 'ready'    →  可用，展开就是目录树
  - status === 'locked'   →  上次打开过，这次还没拿到权限，行上标「需要授权」
  - status === 'missing'  →  句柄指向的目录找不到了（改名、移动、删除、外置盘没插），行上标「找不到目录」

  为什么会有 locked：从 IndexedDB 取回 handle 之后权限不会自动续上，
  requestPermission 必须发生在用户手势里。所以「静默恢复」只在浏览器已经
  记住了这个站点的持久授权时才成立（Chrome 的「每次访问时允许」），
  否则只能等用户点一下那一行。

  为什么 missing 不直接删：一次 NotFoundError 不足以证明目录真的没了 —— 外置盘、
  网络盘、临时改名、甚至一次失败的授权尝试都可能撞上它。用户开过的目录是用户的
  配置，程序不该替用户删（VS Code 对丢失的工作区目录也是标出来、留着）。
  留在列表里，移回来后点一下就恢复；确实不要了由用户右键关闭。

  目录树是懒展开的：childrenByPath 里只有用户真的展开过的那几层。
  用一张 path → Listing 的平表而不是嵌套树结构，是因为「刷新某一层」「展开某一层」
  都只需要动一个 key，不用为了改一个叶子重建整条路径上的对象 —— 多根之后这一点更划算，
  一张表就装下了所有树。
*/

const IDB_KEY = 'workspace-roots'
/** 单目录时代的存法：值就是一个裸 handle。只在迁移的时候读一次。 */
const LEGACY_IDB_KEY = 'workspace-root'
const EXPANDED_KEY = 'jotter:expanded'

/**
 * 目录改名的体量闸门。浏览器没有目录改名 API，那件事实际是「整棵复制 + 删原目录」，
 * 所以必须有个上限：够装一个普通项目的 src，又不至于让页面卡上几十秒。
 */
const MAX_RENAME_FILES = 500
const MAX_RENAME_BYTES = 50 * 1024 * 1024

export interface WorkspaceRoot {
  /** 路径前缀，同时是持久化身份。不用名字当 id：名字会重复 */
  id: string
  name: string
  handle: FileSystemDirectoryHandle
  /** ready 可用；locked 还没拿到权限，等用户点一下那一行；missing 目录找不到了，见文件头注释 */
  status: RootStatus
}

export type RootStatus = 'ready' | 'locked' | 'missing'

/** 存进 IndexedDB 的那部分。status 是运行时状态，不存。 */
type StoredRoot = Pick<WorkspaceRoot, 'id' | 'name' | 'handle'>

/** 路径的第一段就是它所属根目录的 id。 */
export const rootIdOf = (path: string) => path.split('/', 1)[0]

/** 去掉根 id 之后的相对路径。根目录本身得到空串 —— 正好是 resolveDirectory 的「就是它」。 */
const relativeOf = (path: string) => path.slice(rootIdOf(path).length + 1)

/** 把根目录当成树里的一个目录条目，这样展开/选中能和普通目录走同一套代码。 */
export function rootAsEntry(root: WorkspaceRoot): DirEntry {
  return { kind: 'directory', name: root.name, path: root.id, handle: root.handle, ignored: false }
}

function readExpanded(): string[] {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

function writeExpanded(paths: string[]): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(paths))
  } catch {
    // 隐私模式下 localStorage 可能直接抛，展开状态记不住无所谓
  }
}

/** 路径的父目录；顶层（没有斜杠）返回空串 */
export const parentOf = (path: string) => {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/**
 * 「属于这棵子树吗」的判据：自己 + 自己下面的所有层。
 * 关掉目录、删除、目录改名都要按它清 childrenByPath / expanded。
 * 放在模块级而不是组件里：组件里的函数每次渲染都是新的，会把 useCallback 的依赖搅乱。
 */
const subtreeOf = (path: string) => (p: string) => p === path || p.startsWith(`${path}/`)

/** r1、r2…… 当前最大值 +1。够短，在 devtools 里一眼能和目录对上。 */
function nextRootId(roots: StoredRoot[]): string {
  // max 对空数组返回 undefined，第一个目录就落到 r1
  const used = max(roots.map((root) => Number(root.id.slice(1)) || 0)) ?? 0
  return `r${used + 1}`
}

/** 取回上次打开的目录列表，顺手把单目录时代存的那一条搬过来。 */
async function readStoredRoots(): Promise<StoredRoot[]> {
  const rows = await idbGet<StoredRoot[]>(IDB_KEY).catch(() => undefined)
  if (Array.isArray(rows)) return rows.filter((row) => row?.handle?.kind === 'directory')

  const legacy = await idbGet<FileSystemDirectoryHandle>(LEGACY_IDB_KEY).catch(() => undefined)
  if (legacy?.kind !== 'directory') return []
  // 搬过来而不是丢掉：丢了用户就得重新走一遍授权
  const migrated: StoredRoot[] = [{ id: 'r1', name: legacy.name, handle: legacy }]
  await idbSet(IDB_KEY, migrated).catch(() => {})
  await idbDel(LEGACY_IDB_KEY).catch(() => {})
  return migrated
}

/** 「把一整套文件导出到本地」的结果，用来拼提示文案。 */
/** 「把全部 Demo 存到本地」写进 IndexedDB 的进行中记录。刷新后据此提示上次没存完。 */
export interface InterruptedSave {
  /** 父目录 handle。清理时用它删残留目录；权限不够时需要用户重新授权 */
  parent: FileSystemDirectoryHandle
  /** 实际创建出来的目录名（可能带了 -2 之类编号） */
  dirName: string
  /** 可读路径（`文件夹名/总目录名`） */
  label: string
  doneFiles: number
  totalFiles: number
}
/** 进行中记录的键。保存完成会删掉，中途刷新/失败会留下，下次打开能发现。 */
export const DEMO_SAVE_KEY = 'jotter:interruptedDemoSave'
/**
 * sessionStorage 里的「正在保存」标记。IndexedDB 记录虽然可靠，但写入事务提交和
 * 刷新之间仍存在极小竞态窗口；这个同步标记能保证同标签页刷新后第一次加载就读到。
 */
export const DEMO_SAVING_KEY = 'jotter:saving'

export interface BundleResult {
  /** 总目录的路径（`<根 id>/<目录名>`）。它已经被展开并设为新建目标了 */
  path: string
  /** 提示文案里用的可读路径（`文件夹名/总目录名`） */
  label: string
  count: number
  /** 是否把选中的文件夹接管成了左侧的根目录。false 表示用户拒绝在左侧打开 */
  opened: boolean
}

/** 主动在已打开的目录里检测到的「上次没存完」残留。 */
export interface ResidualDemo {
  /** 可读路径（`父文件夹/jotter-demos`） */
  label: string
  /** 残留目录名（如 `jotter-demos`），用于删除 */
  dirName: string
}

export interface Workspace {
  /** 浏览器是否支持 File System Access（Firefox / Safari 为 false，整块 UI 要隐藏） */
  supported: boolean
  /** 「上次打开的目录」这件事已经问完了。App 要等它才知道该不该恢复上次打开的文件。 */
  ready: boolean
  /** 打开的所有根目录，按打开顺序排；包含还没授权的那些 */
  roots: WorkspaceRoot[]
  /** 至少有一个已授权的目录 —— 「新建」「保存进目录」这些路要靠它 */
  hasRoot: boolean
  childrenByPath: Map<string, Listing>
  expanded: Set<string>
  /**
   * 「新建」落到哪个目录：完整路径（第一段是根 id），没有可用目录时是空串。
   * 和 expanded 分开存 —— 展开是「我想看看里面」，选中是「东西建到这儿」，
   * 用户会同时展开好几个目录，但目标永远只有一个。
   */
  target: string
  busy: boolean
  error: string | null
  clearError: () => void
  /** 路径属于哪个根。返回 null 说明那个根被关掉了，挂在它上面的 UI 该自己收摊 */
  rootOf: (path: string) => WorkspaceRoot | null
  /** 把路径里的根 id 换成目录名，用于提示文案和 title */
  displayPath: (path: string) => string
  /** 再打开一个目录（不是替换）。选到已经打开过的那个时不会重复加一份 */
  pick: () => Promise<void>
  /**
   * 让用户挑一个文件夹，把 files 整套写进它下面的一个新建子目录 dirName（撞名自动编号），
   * 然后把那个文件夹接管成根。取消和失败都返回 null（失败原因已写进 error）。
   */
  saveBundle: (
    dirName: string,
    files: BundleFile[],
    opts?: {
      /** 落盘后是否把选中的文件夹接管成左侧根目录（用户确认才做） */
      onOpen?: (info: { label: string; count: number }) => Promise<boolean>
      /** 写入进度（字节级 + 文件级） */
      onProgress?: (p: WriteProgress) => void
      /** 每个文件写前检查一次，返回 true 即取消本次写入并清理已写残留 */
      shouldCancel?: () => boolean
    }
  ) => Promise<BundleResult | null>
  restore: (id: string) => Promise<void>
  forget: (id: string) => void
  toggle: (dir: DirEntry) => Promise<void>
  refresh: (path: string) => Promise<void>
  select: (path: string) => void
  /** 幂等地展开某一层（缺列表就读一层）。新建之前要用它把目标目录打开。 */
  expandDir: (path: string) => Promise<void>
  /** 在 parentPath 下新建。成功返回新条目，失败返回 null（原因已写进 error）。 */
  createEntry: (parentPath: string, name: string, kind: Entry['kind']) => Promise<Entry | null>
  /**
   * 量一下目录里有多少东西，给「目录改名」的确认弹窗用；同时它就是那道体量闸门 ——
   * 太大、或者树里有 node_modules 这类目录时返回 null（原因已写进 error）。
   */
  measureDirectory: (entry: DirEntry) => Promise<TreeSize | null>
  /**
   * 删掉一个条目，目录连里面的内容一起删。成功返回 true。
   * 这里不问用户 —— 二次确认是调用方的事，走到这一步就是真的删。
   */
  deleteEntry: (entry: Entry) => Promise<boolean>
  /** 改名。成功返回改名后的条目，失败返回 null（原因已写进 error）。 */
  renameEntry: (entry: Entry, name: string) => Promise<Entry | null>
  /**
   * 在一个已授权的根目录里，主动找「上次没存完」的 demo 残留（含 .crswap 交换文件的
   * jotter-demos* 目录）。不依赖 IndexedDB 记录，直接看磁盘。
   */
  detectResidualDemos: (root: WorkspaceRoot) => Promise<ResidualDemo[]>
  /** 按路径找回文件 handle：重开页面恢复上次打开的文件时，手里只有一个字符串 */
  resolveFilePath: (path: string) => Promise<FileSystemFileHandle | null>
}

export function useWorkspace(): Workspace {
  const [supported] = useState(isSupported)
  // 不支持的浏览器没什么要问的，一开始就算问完了
  const [ready, setReady] = useState(!supported)
  const [roots, setRoots] = useState<WorkspaceRoot[]>([])
  const [childrenByPath, setChildrenByPath] = useState<Map<string, Listing>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /*
    t 走 ref，不进依赖数组。

    这里的回调几乎都是 useCallback([])，而 activate 又被「进页面把上次的目录挨个问一遍」
    那个 effect 依赖着 —— 把 t 写进依赖，切一次语言就会重跑那一整轮：所有根目录重新
    列举、重新问一遍权限。文案是出错那一刻才用得上的，现取即可。

    代价是提示条上已经显示出来的那一句不跟着换语言。这里可以接受：它是一次性的提示，
    下一个动作就会把它清掉。真正会长时间挂在界面上的那条（新建/改名输入框下面的
    行内校验）走的是另一条路 —— useFileDraft 里存的是描述符，渲染时才翻译。
  */
  const { t } = useI18n()
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  })

  const rootOf = useCallback(
    (path: string) => roots.find((root) => root.id === rootIdOf(path)) ?? null,
    [roots]
  )

  /** 只有已授权的根谈得上读写。没授权的一律当不存在处理，等用户点那一行去恢复。 */
  const liveRootOf = useCallback(
    (path: string) => {
      const root = rootOf(path)
      return root && root.status === 'ready' ? root : null
    },
    [rootOf]
  )

  /** 已在列表里就就地改状态（位置不动），不在就追加 */
  const setRootStatus = useCallback((root: StoredRoot, status: RootStatus) => {
    setRoots((prev) =>
      prev.some((r) => r.id === root.id)
        ? prev.map((r) => (r.id === root.id ? { ...r, status } : r))
        : [...prev, { ...root, status }]
    )
  }, [])

  /**
   * 打开一个已经拿到权限的目录：列它自己这一层，再把上次展开过的子层尽量恢复回来。
   * 结果是合并进现有的表，不是整体替换 —— 别的根还开着。
   */
  const activate = useCallback(async (root: StoredRoot, expandRoot: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const map = new Map<string, Listing>([[root.id, await listDirectory(root.handle, root.id)]])
      const opened = new Set<string>(expandRoot ? [root.id] : [])

      // 按层级深度排序：轮到某个子目录时，它父目录的列表一定已经在 map 里了
      const wanted = sortBy(
        readExpanded().filter((path) => path.startsWith(`${root.id}/`)),
        (path) => path.split('/').length
      )
      for (const path of wanted) {
        const entry = map.get(parentOf(path))?.entries.find((e) => e.path === path)
        if (entry?.kind !== 'directory') continue
        try {
          map.set(path, await listDirectory(entry.handle, path))
          opened.add(path)
        } catch {
          // 这一层读不到就跳过，不影响其他层
        }
      }

      setChildrenByPath((prev) => new Map([...prev, ...map]))
      setExpanded((prev) => new Set([...prev, ...opened]))
      // 重新授权走的也是这里，那时它已经在列表里了，就地更新，位置不动
      setRootStatus(root, 'ready')
      // 第一个可用目录顺手成为新建目标，省掉用户一次点击
      setTarget((prev) => prev || root.id)
    } catch (err) {
      if (isStaleHandleError(err)) {
        // 目录找不到了：标出来、留在列表里（见文件头），不替用户删
        setRootStatus(root, 'missing')
        setError(tRef.current('err.ws.rootMoved', { name: root.name }))
      } else if (isPermissionError(err)) {
        // 权限被撤销：目录还在，留在列表里等用户再点一次授权，别当成「已移动」
        setRootStatus(root, 'locked')
        setError(tRef.current('err.ws.permissionDenied', { name: root.name }))
      } else {
        setError(messageOf(err, tRef.current))
      }
    } finally {
      setBusy(false)
    }
  }, [setRootStatus])

  // 进页面时把上次的目录挨个问一遍：浏览器已经记住授权（「每次访问时允许」）就直接恢复，
  // 否则只在列表里占一行，等用户点一下 —— 重新授权必须发生在用户手势里。
  useEffect(() => {
    if (!supported) return
    let cancelled = false
    void readStoredRoots()
      .then(async (stored) => {
        const wanted = readExpanded()
        for (const row of stored) {
          if (cancelled) return
          if ((await queryPermission(row.handle, 'readwrite')) === 'granted') {
            // 只有上次是展开着的才展开：多根之后收起来的那些应该保持收起
            await activate(row, wanted.includes(row.id))
          } else {
            setRoots((prev) =>
              prev.some((r) => r.id === row.id) ? prev : [...prev, { ...row, status: 'locked' }]
            )
          }
        }
      })
      .catch(() => {})
      // ready 在这一轮全部就位之后才翻，App 那边不用处理中间态
      .finally(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [supported, activate])

  // 目录列表落盘。等 ready 之后才写：开头那一轮读还没回来时 roots 是空的，
  // 这时候写下去等于把上次的目录全擦掉。不支持的浏览器同理（它压根没读过）。
  useEffect(() => {
    if (!ready || !supported) return
    const rows: StoredRoot[] = roots.map(({ id, name, handle }) => ({ id, name, handle }))
    void idbSet(IDB_KEY, rows).catch(() => {})
  }, [roots, ready, supported])

  // 展开状态跟着变化落盘。没授权 / 找不到的根读不出树，它那部分展开状态还留在存储里，
  // 这里要原样带过去，别顺手擦掉。
  useEffect(() => {
    if (!ready || !supported) return
    const asleep = new Set(roots.filter((r) => r.status !== 'ready').map((r) => r.id))
    const kept = asleep.size ? readExpanded().filter((path) => asleep.has(rootIdOf(path))) : []
    writeExpanded([...new Set([...expanded, ...kept])])
  }, [expanded, roots, ready, supported])

  /** 重新读某一层。没有文件监听 API，目录内容变了只能靠用户点刷新。 */
  const refresh = useCallback(
    async (path: string) => {
      const root = liveRootOf(path)
      if (!root) return
      const handle =
        path === root.id ? root.handle : await resolveDirectory(root.handle, relativeOf(path))
      if (!handle) return
      try {
        const listing = await listDirectory(handle, path)
        setChildrenByPath((prev) => new Map(prev).set(path, listing))
      } catch (err) {
        setError(messageOf(err, tRef.current))
      }
    },
    [liveRootOf]
  )

  /**
   * 接管一个刚从选择器拿到的目录，返回它的根 id。
   *
   * 已经在列表里了就地重读、不再加一份 —— 至少让用户看见它已经开着；顺带也就救活了
   * 「需要授权」的那一行：手里这个 handle 是刚从选择器出来的，带着权限。
   */
  const addRoot = useCallback(
    async (handle: FileSystemDirectoryHandle): Promise<string> => {
      for (const root of roots) {
        if (await root.handle.isSameEntry(handle)) {
          setTarget(root.id)
          await activate({ id: root.id, name: root.name, handle }, true)
          return root.id
        }
      }
      // 存 handle 失败（隐私模式等）不该挡住这次使用，只是下次没法恢复
      requestPersistentStorage()
      const id = nextRootId(roots)
      // 刚挑的这个目录就是新建目标：用户的注意力正在它身上，
      // 让「新建」还落在之前那个根上会很意外（activate 里的 `prev || id` 只兜底首次）
      setTarget(id)
      await activate({ id, name: handle.name, handle }, true)
      return id
    },
    [roots, activate]
  )

  const pick = useCallback(async () => {
    setError(null)
    try {
      const handle = await pickDirectory()
      if (!handle) return // 用户取消，不是错误
      await addRoot(handle)
    } catch (err) {
      setError(messageOf(err, tRef.current))
    }
  }, [addRoot])

  const restore = useCallback(
    async (id: string) => {
      const root = roots.find((r) => r.id === id)
      if (!root) return
      setError(null)
      const outcome = await ensurePermission(root.handle, 'readwrite')
      if (outcome === 'granted') {
        await activate(root, true)
        return
      }
      setError(
        outcome === 'denied'
          ? tRef.current('err.ws.permissionDenied', { name: root.name })
          : tRef.current('err.ws.permissionUnavailable')
      )
    },
    [roots, activate]
  )

  /** 关掉一个目录。只影响它自己那棵树，别的根不动。 */
  const forget = useCallback(
    (id: string) => {
      const mine = subtreeOf(id)
      const left = roots.filter((r) => r.id !== id)
      setRoots(left)
      setChildrenByPath((prev) => new Map([...prev].filter(([path]) => !mine(path))))
      setExpanded((prev) => new Set([...prev].filter((path) => !mine(path))))
      // 目标在这棵树里的话，挪到还留着的第一个可用目录上
      setTarget((prev) => (mine(prev) ? (left.find((r) => r.status === 'ready')?.id ?? '') : prev))
      setError(null)
    },
    [roots]
  )

  const toggle = useCallback(
    async (dir: DirEntry) => {
      if (expanded.has(dir.path)) {
        setExpanded((prev) => {
          const next = new Set(prev)
          next.delete(dir.path)
          return next
        })
        return
      }
      // 先展开再读盘：目录内容已经缓存时不闪，没缓存时也能立刻看到箭头翻转
      setExpanded((prev) => new Set(prev).add(dir.path))
      if (childrenByPath.has(dir.path)) return
      try {
        const listing = await listDirectory(dir.handle, dir.path)
        setChildrenByPath((prev) => new Map(prev).set(dir.path, listing))
      } catch (err) {
        setExpanded((prev) => {
          const next = new Set(prev)
          next.delete(dir.path)
          return next
        })
        setError(
          isStaleHandleError(err)
            ? tRef.current('err.ws.dirStale', { name: dir.name })
            : messageOf(err, tRef.current)
        )
      }
    },
    [expanded, childrenByPath]
  )

  const select = useCallback((path: string) => setTarget(path), [])

  /**
   * 把某一层变成「已展开且已读入」，重复调用无副作用。
   * 新建之前必须先过这一步：输入框是插在目标目录的子列表里的，
   * 那一层没展开（或者从没读过）就没有地方放它。
   */
  const expandDir = useCallback(
    async (path: string) => {
      const root = liveRootOf(path)
      if (!root) return
      setExpanded((prev) => (prev.has(path) ? prev : new Set(prev).add(path)))
      if (childrenByPath.has(path)) return
      const handle = await resolveDirectory(root.handle, relativeOf(path))
      if (!handle) return
      try {
        const listing = await listDirectory(handle, path)
        setChildrenByPath((prev) => new Map(prev).set(path, listing))
      } catch (err) {
        setError(messageOf(err, tRef.current))
      }
    },
    [liveRootOf, childrenByPath]
  )

  /*
    新建文件 / 目录。父目录的 handle 用 resolveDirectory 从根走一遍，而不是去
    childrenByPath 里翻：那张表里的 handle 可能是上次列举时拿的，目录被外部程序
    删掉重建后它就指向一个不存在的东西了。

    返回的 Entry 用刚拿到的 handle 现拼，不去刷新后的列表里找 —— 万一父目录条目
    触顶截断（MAX_ENTRIES_PER_DIR），新建的这个可能根本不在列表里，那时候找不到
    并不代表没建成功。
  */
  const createEntry = useCallback(
    async (parentPath: string, name: string, kind: Entry['kind']): Promise<Entry | null> => {
      const root = liveRootOf(parentPath)
      if (!root) return null
      setError(null)
      try {
        const parent = await resolveDirectory(root.handle, relativeOf(parentPath))
        if (!parent) throw new AppError('err.ws.parentGone')
        const path = `${parentPath}/${name}`
        const entry: Entry =
          kind === 'file'
            ? { kind: 'file', name, path, handle: await createFile(parent, name) }
            : {
                kind: 'directory',
                name,
                path,
                handle: await createDirectory(parent, name),
                ignored: isIgnoredDir(name),
              }
        await refresh(parentPath)
        return entry
      } catch (err) {
        setError(
          isStaleHandleError(err)
            ? tRef.current('err.ws.parentStale')
            : messageOf(err, tRef.current)
        )
        return null
      }
    },
    [liveRootOf, refresh]
  )

  /*
    把一组文件整套写进用户选的文件夹里（「把 Demo 存到本地」用的就是它）。

    每次都弹选择器，即使已经开着目录：这是个一次写好几个文件的动作，落点必须是用户
    当场指的。而且只往那个文件夹下的一个**新建**子目录里写（名字被占就自动编号），
    绝不把文件直接铺进用户已有的目录 —— 那样很容易和他自己的东西混在一起。

    写完顺手把选中的文件夹接管成根、展开并选中新目录：否则用户点完只看到一句提示，
    还得自己再「打开文件夹」把刚写出来的东西找回来。
  */
  const saveBundle = useCallback(
    async (
      dirName: string,
      files: BundleFile[],
      opts?: {
        onOpen?: (info: { label: string; count: number }) => Promise<boolean>
        onProgress?: (p: WriteProgress) => void
        /** 每个文件写前检查一次，返回 true 即取消本次写入并清理已写残留 */
        shouldCancel?: () => boolean
      }
    ): Promise<BundleResult | null> => {
      const { onOpen, onProgress, shouldCancel } = opts ?? {}
      setError(null)
      const parent = await pickDirectory().catch((err) => {
        setError(messageOf(err, tRef.current))
        return null
      })
      if (!parent) return null // 用户取消（或者选择器自己出错，已经写进 error 了）
      setBusy(true)
      // dir 声明在 try 外面：取消/出错时要靠它删掉已写的残留目录
      let dir: FileSystemDirectoryHandle | null = null
      let label = ''
      try {
        const d = await createDirectoryUnique(parent, dirName)
        dir = d
        label = `${parent.name}/${d.name}`
        // 从这一刻起，磁盘上已经开始出现不完整的 demo 了。写一条「进行中」记录，
        // 刷新/失败后下次打开能据此提示「上次没存完」；全部写完再删掉。
        await idbSet(DEMO_SAVE_KEY, {
          parent,
          dirName: d.name,
          label,
          doneFiles: 0,
          totalFiles: files.length,
        }).catch(() => {})
        // 同步的「正在保存」标记：比 IndexedDB 事务更早一步能读到的可靠信号
        try {
          sessionStorage.setItem(DEMO_SAVING_KEY, '1')
        } catch {
          /* sessionStorage 不可用时忽略，IndexedDB 记录仍会兜底 */
        }
        const trackProgress = (p: WriteProgress) => {
          onProgress?.(p)
          // 记录「进行中」的写入进度。注意：不到 writeFilesInto 全部完成绝不在这一层删记录，
          // 否则 fire-and-forget 的删除会在「最后一个文件写完」的瞬间抢先把记录清掉，
          // 恰好又赶在刷新前，刷新后就再也读不到残留记录了。
          void idbSet(DEMO_SAVE_KEY, {
            parent,
            dirName: d.name,
            label,
            doneFiles: p.doneFiles,
            totalFiles: p.totalFiles,
          }).catch(() => {})
        }
        await writeFilesInto(d, files, { onProgress: trackProgress, shouldCancel })
        // 到这里所有文件都已完整落盘，保存才算真正结束，这时才删掉记录
        await idbDel(DEMO_SAVE_KEY).catch(() => {})
        try {
          sessionStorage.removeItem(DEMO_SAVING_KEY)
        } catch {
          /* ignore */
        }
        const count = files.length
        // 落盘是「真的想用它们」的第一步，而把选中的文件夹接管成左侧根目录是会改变
        // 界面布局的动作，不是用户显式要求就默认别做 —— 先问一句。
        if (onOpen && !(await onOpen({ label, count }))) {
          return { path: '', label, count, opened: false }
        }
        const rootId = await addRoot(parent)
        const path = `${rootId}/${d.name}`
        /*
          这里不能用 expandDir：addRoot 里的 setRoots 还没提交，它读到的 roots 里
          没有这个根，会当成「不可用」直接返回。反正 d 的 handle 就在手上，
          自己列一层最省事，连 resolveDirectory 都不用走。
        */
        const listing = await listDirectory(d, path)
        setChildrenByPath((prev) => new Map(prev).set(path, listing))
        setExpanded((prev) => new Set(prev).add(path))
        setTarget(path)
        return { path, label, count, opened: true }
      } catch (err) {
        // 用户取消：把已经写进去的那套不完整文件整个删掉，恢复到保存前的状态
        if (err instanceof AppError && err.key === 'err.save.cancelled') {
          await idbDel(DEMO_SAVE_KEY).catch(() => {})
          try {
            sessionStorage.removeItem(DEMO_SAVING_KEY)
          } catch {
            /* ignore */
          }
          if (dir) await removeEntry(parent, dir.name, 'directory').catch(() => {})
          setError(null)
          return null
        }
        // 其他错误：先试着把半成品目录删掉；删掉了就连「进行中」记录一起清，
        // 否则下次启动会弹一个「清理残留」的确认框，用户点了之后却发现目录早就不在了。
        // 删不掉（比如权限中途被撤）才留着记录，下次启动据此提示清理。
        try {
          sessionStorage.removeItem(DEMO_SAVING_KEY)
        } catch {
          /* ignore */
        }
        if (dir) {
          const removed = await removeEntry(parent, dir.name, 'directory').then(
            () => true,
            () => false
          )
          if (removed) await idbDel(DEMO_SAVE_KEY).catch(() => {})
        }
        setError(messageOf(err, tRef.current))
        return null
      } finally {
        setBusy(false)
      }
    },
    [addRoot]
  )

  const measureDirectory = useCallback(
    async (entry: DirEntry): Promise<TreeSize | null> => {
      const root = liveRootOf(entry.path)
      if (!root) return null
      setError(null)
      setBusy(true)
      try {
        const dir = await resolveDirectory(root.handle, relativeOf(entry.path))
        if (!dir) throw new AppError('err.ws.dirGone')
        return await measureTree(dir, { maxFiles: MAX_RENAME_FILES, maxBytes: MAX_RENAME_BYTES })
      } catch (err) {
        // 两条分支各是一句完整的话。原来是 `条目 ${name}` 后面直接接上另一句的碎片，
        // 中间没有分隔符，渲染出来是「条目 foo目录内包含 node_modules，…」
        setError(
          isStaleHandleError(err)
            ? tRef.current('err.ws.entryStale', { name: entry.name })
            : tRef.current('err.ws.entryFailed', {
                name: entry.name,
                message: messageOf(err, tRef.current),
              })
        )
        return null
      } finally {
        setBusy(false)
      }
    },
    [liveRootOf]
  )

  const deleteEntry = useCallback(
    async (entry: Entry): Promise<boolean> => {
      const root = liveRootOf(entry.path)
      if (!root) return false
      const parentPath = parentOf(entry.path)
      setError(null)
      setBusy(true)
      try {
        const parent = await resolveDirectory(root.handle, relativeOf(parentPath))
        if (!parent) throw new AppError('err.ws.holderGone')
        await removeEntry(parent, entry.name, entry.kind)
        await refresh(parentPath)
        // 这棵子树整个从缓存里去掉：里面的 handle 全都指向已经不存在的东西了
        const mine = subtreeOf(entry.path)
        setChildrenByPath((prev) => new Map([...prev].filter(([path]) => !mine(path))))
        setExpanded((prev) => new Set([...prev].filter((path) => !mine(path))))
        // 新建目标落在被删掉的这棵树里时，退到它的父目录 —— 那个一定还在、一定可用
        setTarget((prev) => (mine(prev) ? parentPath : prev))
        return true
      } catch (err) {
        setError(
          isStaleHandleError(err)
            ? tRef.current('err.ws.entryMissing', { name: entry.name })
            : messageOf(err, tRef.current)
        )
        return false
      } finally {
        setBusy(false)
      }
    },
    [liveRootOf, refresh]
  )

  /*
    改名。文件走 move()（不行就复制+删除），目录只能整棵复制再删原目录 ——
    两条路都在 fs-access 里，这里只管状态迁移。

    目录改名之后子树里缓存的 handle 全部作废（它们指向已经被删掉的那个原目录），
    一个都不能留：childrenByPath 里那棵树整个丢掉，expanded 里那些路径也一并去掉，
    所以改完名它是收起来的 —— 点一下就重新读。留着「标记为展开但渲染不出内容」更糟。
  */
  const renameEntry = useCallback(
    async (entry: Entry, name: string): Promise<Entry | null> => {
      const root = liveRootOf(entry.path)
      if (!root) return null
      const parentPath = parentOf(entry.path)
      const nextPath = `${parentPath}/${name}`
      setError(null)
      setBusy(true)
      try {
        const parent = await resolveDirectory(root.handle, relativeOf(parentPath))
        if (!parent) throw new AppError('err.ws.holderGone')
        // handle 从根现走一遍拿，不用 childrenByPath 里那个：那是上次列举时的，可能已经失效
        let next: Entry
        if (entry.kind === 'file') {
          const handle = await parent.getFileHandle(entry.name)
          next = {
            kind: 'file',
            name,
            path: nextPath,
            handle: await renameFile(parent, handle, name),
          }
        } else {
          const handle = await parent.getDirectoryHandle(entry.name)
          next = {
            kind: 'directory',
            name,
            path: nextPath,
            handle: await renameDirectory(parent, handle, name),
            ignored: isIgnoredDir(name),
          }
        }
        await refresh(parentPath)
        if (entry.kind === 'directory') {
          const mine = subtreeOf(entry.path)
          setChildrenByPath((prev) => new Map([...prev].filter(([path]) => !mine(path))))
          setExpanded((prev) => new Set([...prev].filter((path) => !mine(path))))
          // 目标在这棵树里就换前缀：复制过去之后那些路径在新名字下都还在
          setTarget((prev) => (mine(prev) ? nextPath + prev.slice(entry.path.length) : prev))
        }
        return next
      } catch (err) {
        setError(
          isStaleHandleError(err)
            ? tRef.current('err.ws.entryMissing', { name: entry.name })
            : messageOf(err, tRef.current)
        )
        return null
      } finally {
        setBusy(false)
      }
    },
    [liveRootOf, refresh]
  )

  /** 提示文案和 title 里不能出现 r1 这种内部 id，换成用户看得懂的目录名。 */
  const displayPath = useCallback(
    (path: string) => {
      const root = rootOf(path)
      if (!root) return path
      const rest = relativeOf(path)
      return rest ? `${root.name}/${rest}` : root.name
    },
    [rootOf]
  )

  const resolveFilePath = useCallback(
    async (path: string) => {
      const root = liveRootOf(path)
      return root ? resolveFile(root.handle, relativeOf(path)) : null
    },
    [liveRootOf]
  )

  // 在一个已授权的根目录里找 demo 残留：列根目录顶层，挑出 jotter-demos* 目录，
  // 再看里面有没有 .crswap（createWritable 写入中断留下的交换文件，完整保存不会有）。
  const detectResidualDemos = useCallback(
    async (root: WorkspaceRoot): Promise<ResidualDemo[]> => {
      if (root.status !== 'ready') return []
      try {
        const top = await listDirectory(root.handle, root.id)
        const demoDirs = top.entries.filter(
          (e): e is DirEntry =>
            e.kind === 'directory' && /^jotter-demos(-[0-9]+)?$/.test(e.name)
        )
        const found: ResidualDemo[] = []
        for (const dir of demoDirs) {
          const listing = await listDirectory(dir.handle, dir.path)
          if (listing.entries.some((e) => e.kind === 'file' && e.name.endsWith('.crswap'))) {
            found.push({ label: `${root.name}/${dir.name}`, dirName: dir.name })
          }
        }
        return found
      } catch {
        return []
      }
    },
    []
  )

  return {
    supported,
    ready,
    roots,
    hasRoot: roots.some((root) => root.status === 'ready'),
    childrenByPath,
    expanded,
    target,
    busy,
    error,
    clearError: () => setError(null),
    rootOf,
    displayPath,
    pick,
    saveBundle,
    restore,
    forget,
    toggle,
    refresh,
    select,
    expandDir,
    createEntry,
    measureDirectory,
    deleteEntry,
    renameEntry,
    detectResidualDemos,
    resolveFilePath,
  }
}
