/*
  File System Access API 的封装层：特性检测、授权、目录列举、读写。

  硬约束（会直接影响上层 UI 的形状，不是实现细节）：
  - 只有 Chromium 系实现了 showDirectoryPicker，Firefox 与 Safari 都没有
    （它们只做了 OPFS 那一半）。所以入口必须做特性检测，不支持时整块功能隐藏。
  - 必须是安全上下文（https 或 localhost）。
  - 从 IndexedDB 取回 handle 之后权限不会自动续上：requestPermission 必须发生在
    用户手势里。所以「下次打开还是上次的目录」做不到静默恢复，只能是用户点一下
    「恢复」按钮 —— 上层的空状态就是围绕这一点设计的。
*/

import { compact, partition, range } from 'lodash-es'

import { AppError, type Problem } from './app-error'
// 文件类型判断搬到了 file-types.ts；这里保留再导出，调用方不用改 import
export { isRunnable, extOf, languageOf } from './file-types'


/** 目录列举的两道闸：一是不进这些目录，二是单目录条目上限。 */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'coverage',
  '.idea',
  '.DS_Store',
  '__pycache__',
  'venv',
  '.venv',
  'target',
  'vendor',
])

/**
 * 单个目录最多列多少条。dist 里几千个文件足以把树撑爆，
 * 而超过这个数的目录本来也不是人肉浏览的对象。
 */
export const MAX_ENTRIES_PER_DIR = 500

/** 打开文件的体积上限：Monaco 在几 MB 的单文件上会明显卡顿。 */
export const MAX_FILE_SIZE = 2 * 1024 * 1024

/**
 * Windows 的保留设备名。以这些名字（不论后缀）建文件会直接失败，
 * 而报错信息是底层的一句 NotAllowedError，说不清到底哪里不对。
 */
const RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...range(1, 10).map((n) => `COM${n}`),
  ...range(1, 10).map((n) => `LPT${n}`),
])

export function isSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

/** 弹出目录选择器。用户取消时返回 null（浏览器抛的是 AbortError，不是错误状态）。 */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!window.showDirectoryPicker) throw new AppError('err.fs.noPicker')
  try {
    // mode: 'readwrite' —— 一次就把读写都要到手。分两次申请会弹两次授权，
    // 体验更差；有了写权限 Ctrl+S 才能直接落盘。
    return await window.showDirectoryPicker({ id: 'scrawl-workspace', mode: 'readwrite' })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null
    throw err
  }
}

export type PermissionOutcome = 'granted' | 'denied' | 'unavailable'

/** 查询当前权限状态，不弹窗。 */
export async function queryPermission(
  handle: FileSystemHandle,
  mode: FileSystemPermissionMode = 'readwrite'
): Promise<PermissionState | 'unavailable'> {
  if (!handle.queryPermission) return 'unavailable'
  try {
    return await handle.queryPermission({ mode })
  } catch {
    return 'unavailable'
  }
}

/**
 * 确保拿到权限，必要时弹窗。
 * 调用点必须在用户手势里（点击 / 按键），否则浏览器会直接拒绝而不弹窗。
 */
export async function ensurePermission(
  handle: FileSystemHandle,
  mode: FileSystemPermissionMode = 'readwrite'
): Promise<PermissionOutcome> {
  const current = await queryPermission(handle, mode)
  if (current === 'granted') return 'granted'
  if (!handle.requestPermission) return 'unavailable'
  try {
    return (await handle.requestPermission({ mode })) === 'granted' ? 'granted' : 'denied'
  } catch {
    return 'denied'
  }
}

/** handle 指向的东西已经不在了（目录被改名、移动、删除，或所在磁盘不在了）。 */
export function isStaleHandleError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'NotFoundError'
}

/**
 * 没有权限：授权被撤销、文件只读、或被别的程序锁住（Windows）。
 * 以前和「不存在」混在一起，只读文件也会被当成「已不在磁盘上」，
 * 启动时更会把根目录从列表里永久删掉。
 */
export function isPermissionError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'NotAllowedError'
}

export interface FileEntry {
  kind: 'file'
  name: string
  /** 相对根目录的路径，同时用作树节点与编辑器 model 的 key */
  path: string
  handle: FileSystemFileHandle
}

export interface DirEntry {
  kind: 'directory'
  name: string
  path: string
  handle: FileSystemDirectoryHandle
  /** 命中 IGNORED_DIRS：排在后面、显示为淡色，但用户点了照样展开 */
  ignored: boolean
}

export type Entry = FileEntry | DirEntry

export interface Listing {
  entries: Entry[]
  /** 条目数触顶被截断，UI 需要显示一行「还有更多」 */
  truncated: boolean
}

/**
 * 列一层目录的内容 —— 只列一层，绝不递归。
 *
 * 递归是这个功能唯一真正的性能陷阱：用户随手选个前端项目根目录，
 * 里面的 node_modules 有十万级条目，一次走完足以让页面假死。
 * 所以树是懒展开的，每次只读用户点开的那一层。
 */
export async function listDirectory(
  dir: FileSystemDirectoryHandle,
  basePath = ''
): Promise<Listing> {
  const dirs: DirEntry[] = []
  const files: FileEntry[] = []
  let truncated = false
  let count = 0

  for await (const [name, handle] of dir.entries()) {
    if (++count > MAX_ENTRIES_PER_DIR) {
      truncated = true
      break
    }
    const path = basePath ? `${basePath}/${name}` : name
    if (handle.kind === 'directory') {
      dirs.push({ kind: 'directory', name, path, handle, ignored: IGNORED_DIRS.has(name) })
    } else {
      files.push({ kind: 'file', name, path, handle })
    }
  }

  // 排序键是「名字」，比较规则得带上 numeric + 忽略大小写，lodash 的 sortBy 表达不了，
  // 所以比较器留着手写；只有「忽略名单沉底」这一层拿 partition 分开
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })

  // 目录在前、文件在后；被忽略的目录再压到目录组的末尾
  const [plain, ignored] = partition(dirs, (dir) => !dir.ignored)
  files.sort(byName)

  return { entries: [...plain.sort(byName), ...ignored.sort(byName), ...files], truncated }
}

export interface LoadedFile {
  text: string
  /** 用于「外部改动检测」的基线：没有文件监听 API，只能靠比对 mtime */
  lastModified: number
  /**
   * 推断出的文件编码，只在底部状态栏展示用（VS Code 式）。
   * 注意：Scrawl 解码/写回固定走 UTF-8，这里只是「这个文件本来是什么编码」的标签，
   * 并不改变读写行为 —— 有 BOM 的 UTF-16 文件读进来仍是按 UTF-8 解、会乱码，
   * 只是状态栏能如实告诉你它的真实编码。
   */
  encoding: FileEncoding
}

/** 展示用的编码标签。名字本身是通用 ASCII 标识，不随界面语言翻译。 */
export type FileEncoding = 'UTF-8' | 'UTF-8 with BOM' | 'UTF-16 LE' | 'UTF-16 BE'

/**
 * 只看文件头几个字节判断有没有 BOM，据此给出编码标签。
 * 没 BOM 时无从区分 —— 按当前读盘行为一律当成 UTF-8 报。
 * 传进来的是原始字节（不能拿按 UTF-8 解出来的字符串判断，UTF-16 解完就乱码了）。
 */
export function detectFileEncoding(lead: Uint8Array): FileEncoding {
  const [b0, b1, b2, b3] = lead
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) return 'UTF-8 with BOM'
  if (b0 === 0xff && b1 === 0xfe && !(b2 === 0x00 && b3 === 0x00)) return 'UTF-16 LE'
  if (b0 === 0xfe && b1 === 0xff) return 'UTF-16 BE'
  return 'UTF-8'
}

/** 「340 KB」「1.2 MB」这种给人看的体积。导出是因为确认弹窗也要写这个数。 */
export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`
}

/** 读一个文本文件。体积超限或看起来是二进制时抛出可直接展示的错误。 */
export async function readTextFile(handle: FileSystemFileHandle): Promise<LoadedFile> {
  const file = await handle.getFile()
  if (file.size > MAX_FILE_SIZE) {
    throw new AppError('err.fs.tooLarge', {
      name: handle.name,
      size: formatSize(file.size),
      max: formatSize(MAX_FILE_SIZE),
    })
  }
  // 只看头几个字节判断编码；slice 出的是个新 File，读它的 arrayBuffer 只有几字节开销
  const encoding = detectFileEncoding(
    new Uint8Array(await file.slice(0, 4).arrayBuffer())
  )
  const text = await file.text()
  // 二进制兜底：后缀表认不出的文件走不到这里，但 .txt 里塞二进制这种情况仍要拦。
  // NUL 字节在正常文本里不会出现，是最省事也最可靠的判据。
  if (text.includes('\u0000')) {
    throw new AppError('err.fs.binary', { name: handle.name })
  }
  return { text, lastModified: file.lastModified, encoding }
}

/** 写回磁盘，返回新的 mtime（顺带把外部改动检测的基线刷新掉）。 */
export async function writeTextFile(
  handle: FileSystemFileHandle,
  text: string
): Promise<number> {
  // createWritable 默认清空原内容再写，正是「保存」要的语义
  const writable = await handle.createWritable()
  try {
    await writable.write(text)
  } catch (err) {
    // 出错时也要关掉流，否则文件会一直被锁着
    await writable.abort().catch(() => {})
    throw err
  }
  await writable.close()
  return (await handle.getFile()).lastModified
}

/**
 * 每个文件切块写入，并报告字节级进度。返回写进去的字节数。
 *
 * write() 整串一次写入拿不到中间进度；改用 File System Access 的分块写法
 * `{ type: 'write', position, data }`，按固定块大小切片，位置跟着字节偏移走，
 * 每写完一块就把「已经写进去多少字节」报给调用方。切块按字节走，所以得先
 * TextEncoder 成 Uint8Array —— 否则按字符 slice 会和 UTF-8 字节数对不上，
 * 进度条就会算错。只有真正写到磁盘的字节才算数，多字节字符不会被劈成两半。
 */
export async function writeTextFileWithProgress(
  handle: FileSystemFileHandle,
  text: string,
  onBytes?: (writtenBytes: number, totalBytes: number) => void
): Promise<number> {
  const bytes = new TextEncoder().encode(text)
  const CHUNK = 4 * 1024 // 4 KB，demo 这种小文件也能走出好几格进度
  const writable = await handle.createWritable()
  try {
    let written = 0
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      const end = Math.min(offset + CHUNK, bytes.length)
      await writable.write({ type: 'write', position: offset, data: bytes.subarray(offset, end) })
      written = end
      onBytes?.(written, bytes.length)
    }
  } catch (err) {
    // 出错时也要关掉流，否则文件会一直被锁着
    await writable.abort().catch(() => {})
    throw err
  }
  await writable.close()
  return bytes.length
}

/** 取当前 mtime，用来判断磁盘上的文件是否被外部程序改过。 */
export async function getLastModified(handle: FileSystemFileHandle): Promise<number> {
  return (await handle.getFile()).lastModified
}

/**
 * 按相对路径逐段走到某个文件。用于「重开页面后恢复上次打开的文件」——
 * 那时只有一个字符串路径，没有 handle（handle 只有根目录那一个存进了 IndexedDB）。
 * 路径上任何一段不存在就返回 null，交给调用方静默放弃。
 */
export async function resolveFile(
  root: FileSystemDirectoryHandle,
  path: string
): Promise<FileSystemFileHandle | null> {
  const segments = compact(path.split('/'))
  const name = segments.pop()
  if (!name) return null
  try {
    let dir = root
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment)
    }
    return await dir.getFileHandle(name)
  } catch {
    return null
  }
}

/** resolveFile 的目录版。空路径就是根本身。任一段不存在返回 null。 */
export async function resolveDirectory(
  root: FileSystemDirectoryHandle,
  path: string
): Promise<FileSystemDirectoryHandle | null> {
  try {
    let dir = root
    for (const segment of compact(path.split('/'))) {
      dir = await dir.getDirectoryHandle(segment)
    }
    return dir
  } catch {
    return null
  }
}

/** 新建目录时也要按列举时的同一套规则打上 ignored 标记。 */
export function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name)
}

/**
 * 检查新建的名字，有问题返回一条待翻译的描述符，没问题返回 null。
 *
 * 返回描述符而不是现成的句子：这里是纯模块，拿不到 t。翻译发生在
 * Sidebar 渲染那行红字的地方（useFileDraft 只负责透传）。
 *
 * 规则按最严的那个系统（Windows）来，而不是按当前系统：同一个目录可能被同步到
 * 别的机器上，这里放过去只会把问题推到那时候，而那时已经没人知道是谁建的。
 */
export function validateEntryName(name: string): Problem | null {
  if (!name) return { key: 'validate.empty' }
  if (name.length > 255) return { key: 'validate.tooLong' }
  if (name === '.' || name === '..') return { key: 'validate.dots' }
  if (/[/\\]/.test(name)) return { key: 'validate.slash' }
  if (/[<>:"|?*]/.test(name)) return { key: 'validate.illegalChars' }
  // 控制字符用 charCode 判断而不是正则字符类：那样写会踩到 eslint 的 no-control-regex
  if ([...name].some((ch) => ch.charCodeAt(0) < 32)) return { key: 'validate.control' }
  if (/[. ]$/.test(name)) return { key: 'validate.trailing' }
  if (RESERVED_NAMES.has(name.split('.')[0].toUpperCase())) {
    return { key: 'validate.reserved', params: { name } }
  }
  return null
}

/**
 * 建之前先确认没有同名条目。
 * 规范里 create: true 没有「独占」语义 —— 已存在时它会直接把那个 handle 交回来，
 * 于是「新建」会静悄悄变成「打开」，用户以为建了个新文件，实际在改旧的。
 * 文件和目录都要探：同一层里两者不能同名。
 */
async function assertNameAvailable(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  const [asFile, asDir] = await Promise.all([
    dir.getFileHandle(name).then(
      () => true,
      () => false
    ),
    dir.getDirectoryHandle(name).then(
      () => true,
      () => false
    ),
  ])
  if (asFile || asDir) {
    throw new AppError('err.fs.nameTaken', { name, kind: asFile ? 'file' : 'directory' })
  }
}

export async function createFile(
  dir: FileSystemDirectoryHandle,
  name: string
): Promise<FileSystemFileHandle> {
  await assertNameAvailable(dir, name)
  return dir.getFileHandle(name, { create: true })
}

export async function createDirectory(
  dir: FileSystemDirectoryHandle,
  name: string
): Promise<FileSystemDirectoryHandle> {
  await assertNameAvailable(dir, name)
  return dir.getDirectoryHandle(name, { create: true })
}

/**
 * 建一个「保证是新的」目录：`base` 被占了就依次试 `base-2`、`base-3`…
 *
 * 和 createDirectory 的区别就是它不把撞名当错误。用在「把一整套文件导出到本地」上：
 * 第二次导出时上一份通常还在，那时候报错让用户自己想名字毫无意义，而复用旧目录
 * 更糟 —— 会盖掉他在上一份里改过的东西。
 */
export async function createDirectoryUnique(
  parent: FileSystemDirectoryHandle,
  base: string
): Promise<FileSystemDirectoryHandle> {
  for (let i = 1; i <= 99; i++) {
    const name = i === 1 ? base : `${base}-${i}`
    const taken = await assertNameAvailable(parent, name).then(
      () => false,
      () => true
    )
    if (!taken) return parent.getDirectoryHandle(name, { create: true })
  }
  throw new AppError('err.fs.uniqueExhausted', { base })
}

export interface BundleFile {
  /** 相对目标目录的路径，用 `/` 分隔（`overrides/call.js`）。不能以 `/` 开头 */
  path: string
  content: string
}

/**
 * 把一组文件写进 dir，路径里的斜杠按层建目录。
 *
 * 刻意不走 createFile / createDirectory：它们每次都要先探一遍同名条目，而调用方给的
 * dir 是刚建出来的空目录（见 createDirectoryUnique），那道探测纯属白跑 I/O；
 * 子目录更是本来就该「有则复用」—— `overrides/` 下面有五个文件，只该建一次。
 *
 * 串行写而不是 Promise.all：同一个子目录会被多次 getDirectoryHandle(create)，
 * 并发下去等于让浏览器自己去解决同时建同一个目录的竞态，没必要冒这个险。
 */
export interface WriteProgress {
  /** 正在写入的文件相对路径（`overrides/call.js`） */
  file: string
  /** 已经写完的文件数（不含当前这个） */
  doneFiles: number
  totalFiles: number
  /** 已写入磁盘的总字节数（含已完成文件 + 当前文件已写部分） */
  writtenBytes: number
  totalBytes: number
}

/**
 * 把一组文件写进 dir，路径里的斜杠按层建目录。
 *
 * 刻意不走 createFile / createDirectory：它们每次都要先探一遍同名条目，而调用方给的
 * dir 是刚建出来的空目录（见 createDirectoryUnique），那道探测纯属白跑 I/O；
 * 子目录更是本来就该「有则复用」—— `overrides/` 下面有五个文件，只该建一次。
 *
 * 串行写而不是 Promise.all：同一个子目录会被多次 getDirectoryHandle(create)，
 * 并发下去等于让浏览器自己去解决同时建同一个目录的竞态，没必要冒这个险。
 *
 * onProgress 在每次写完一个块 / 一个文件时回调一次，携带文件级与字节级的双重进度。
 * shouldCancel 在写每个文件前检查一次，返回 true 就抛一个「已取消」错误，中断写入。
 */
export interface WriteFilesOptions {
  onProgress?: (p: WriteProgress) => void
  /** 每个文件开写前检查一次；返回 true 即取消本次写入 */
  shouldCancel?: () => boolean
}

export async function writeFilesInto(
  dir: FileSystemDirectoryHandle,
  files: BundleFile[],
  opts?: WriteFilesOptions
): Promise<void> {
  const { onProgress, shouldCancel } = opts ?? {}
  // 一开始就把总字节数算好：进度条分母需要它，而且各文件字节数在写的过程中不变
  const totalBytes = files.reduce((sum, file) => sum + new Blob([file.content]).size, 0)
  let writtenBytes = 0
  // 进入写入阶段立刻报一次 0%：让进度面板在「选完文件夹、真正开始落盘」这一刻才亮起，
  // 而不是在弹文件夹选择框的时候就显示。file 用第一个文件的路径占位。
  if (onProgress && files.length > 0) {
    onProgress({
      file: files[0].path,
      doneFiles: 0,
      totalFiles: files.length,
      writtenBytes: 0,
      totalBytes,
    })
  }
  for (let i = 0; i < files.length; i++) {
    // 用户取消了就中断，不再写后面的文件。当前这一块可能已经写完，交给调用方清理残留
    if (shouldCancel?.()) throw new AppError('err.save.cancelled')
    const file = files[i]
    const segments = file.path.split('/')
    const name = segments.pop()
    if (!name) throw new AppError('err.fs.badBundlePath', { path: file.path })
    let current = dir
    for (const segment of segments) {
      current = await current.getDirectoryHandle(segment, { create: true })
    }
    const handle = await current.getFileHandle(name, { create: true })
    const fileBytes = await writeTextFileWithProgress(handle, file.content, (written) =>
      // 当前文件写了几字节 + 之前已写完文件的总字节，就是全局累计写入量
      onProgress?.({
        file: file.path,
        doneFiles: i,
        totalFiles: files.length,
        writtenBytes: writtenBytes + written,
        totalBytes,
      })
    )
    writtenBytes += fileBytes
    onProgress?.({
      file: file.path,
      doneFiles: i + 1,
      totalFiles: files.length,
      writtenBytes,
      totalBytes,
    })
  }
}

/**
 * 删掉一个条目。目录必须显式 recursive，否则非空目录会抛 InvalidModificationError。
 *
 * 没有回收站语义 —— removeEntry 就是真的删掉，调用方负责在删之前问用户。
 */
export async function removeEntry(
  dir: FileSystemDirectoryHandle,
  name: string,
  kind: Entry['kind']
): Promise<void> {
  await dir.removeEntry(name, { recursive: kind === 'directory' })
}

/** 把一个文件的内容整份写进另一个 handle。走 Blob 而不是文本：二进制文件也不会坏。 */
async function copyFileInto(from: FileSystemFileHandle, to: FileSystemFileHandle): Promise<void> {
  const file = await from.getFile()
  const writable = await to.createWritable()
  try {
    await writable.write(file)
  } catch (err) {
    // 出错时也要关掉流，否则文件会一直被锁着
    await writable.abort().catch(() => {})
    throw err
  }
  await writable.close()
}

/**
 * 文件改名。返回改名后的 handle（可能就是原来那个）。
 *
 * 首选 move()：一步到位，内容和修改时间都不动。它不在 lib.dom 里（声明补在
 * file-system-access.d.ts），而且有的浏览器只在 OPFS 上给，所以必须做特性检测，
 * 并且备一条「复制成新文件 → 删掉旧的」的回退路 —— 回退用 Blob 复制，
 * 二进制安全，也没有 MAX_FILE_SIZE 那道只针对「打开」的限制。
 *
 * 只改大小写（a.js → A.js）单独走一条：Windows / macOS 的文件系统不区分大小写，
 * assertNameAvailable 一定会把它误判成「已存在」，而复制回退会先把同一个文件
 * create 出来（等于打开旧文件）再 removeEntry 掉 —— 那是真的丢数据。
 * 所以这种情况跳过探测、只允许 move()，没有 move() 就明确拒绝。
 */
export async function renameFile(
  dir: FileSystemDirectoryHandle,
  handle: FileSystemFileHandle,
  name: string
): Promise<FileSystemFileHandle> {
  const caseOnly = name !== handle.name && name.toLowerCase() === handle.name.toLowerCase()
  // move() 会静默覆盖同名文件，探这一遍是必须的
  if (!caseOnly) await assertNameAvailable(dir, name)

  if (handle.move) {
    try {
      await handle.move(name)
      return handle
    } catch (err) {
      // 大小写改名没有安全的回退，原样把错误抛出去
      if (caseOnly) throw err
    }
  } else if (caseOnly) {
    throw new AppError('err.fs.caseRenameUnsupported')
  }

  const next = await dir.getFileHandle(name, { create: true })
  try {
    await copyFileInto(handle, next)
  } catch (err) {
    // 半成品不留在磁盘上；旧文件一直没动过，用户什么都没丢
    await dir.removeEntry(name).catch(() => {})
    throw err
  }
  await dir.removeEntry(handle.name)
  return next
}

export interface TreeSize {
  files: number
  bytes: number
}

/**
 * 递归量一棵目录树有多大，同时充当「目录改名」的闸门 —— 那件事是整棵复制，
 * 先得知道这一下有多大。超限、或者树里撞上被忽略的目录时抛出可直接展示的错误：
 * 对着 node_modules 点一下改名会复制上万个文件，不如直接拒绝并告诉用户去系统里改。
 */
export async function measureTree(
  dir: FileSystemDirectoryHandle,
  limits: { maxFiles: number; maxBytes: number }
): Promise<TreeSize> {
  let files = 0
  let bytes = 0

  const walk = async (current: FileSystemDirectoryHandle): Promise<void> => {
    for await (const [name, handle] of current.entries()) {
      if (handle.kind === 'directory') {
        if (isIgnoredDir(name)) {
          throw new AppError('err.fs.ignoredDirInTree', { name })
        }
        await walk(handle)
        continue
      }
      files += 1
      if (files > limits.maxFiles) {
        // 复数键按 count 变形，max 保留给文案本身用
        throw new AppError('err.fs.treeTooManyFiles', { count: limits.maxFiles, max: limits.maxFiles })
      }
      bytes += (await handle.getFile()).size
      if (bytes > limits.maxBytes) {
        throw new AppError('err.fs.treeTooLarge', { max: formatSize(limits.maxBytes) })
      }
    }
  }

  await walk(dir)
  return { files, bytes }
}

/** 把 src 里的东西全部复制进 dst（dst 必须已经存在）。文件写 Blob，子目录递归。 */
async function copyDirInto(
  src: FileSystemDirectoryHandle,
  dst: FileSystemDirectoryHandle
): Promise<void> {
  for await (const [name, handle] of src.entries()) {
    if (handle.kind === 'directory') {
      await copyDirInto(handle, await dst.getDirectoryHandle(name, { create: true }))
      continue
    }
    await copyFileInto(handle, await dst.getFileHandle(name, { create: true }))
  }
}

/**
 * 目录改名 = 整棵复制到新名字 + 删掉原目录。
 *
 * FileSystemDirectoryHandle 没有 move()（Chrome 152 实测：sub.move is not a function），
 * 这是目前唯一的做法。哪天 Chromium 给目录也实现了 move()，这一整段可以换成一行。
 *
 * 顺序是「先复制完，再删原目录」：中途失败时原目录一动没动，磁盘上留下的是那个
 * 半成品新目录（提示里要写清楚）。反过来先删就是真的没了。
 *
 * assertNameAvailable 这一步不只是防覆盖，还挡住了「只改大小写」：在不区分大小写的
 * 文件系统上 getDirectoryHandle('SRC', { create: true }) 会把 src 自己交回来，
 * 那就变成往自己里面复制自己，然后把自己删掉。所以这里必须先探、必须先抛。
 *
 * 副作用：复制出来的文件修改时间是「现在」，原来的 mtime 保不住。
 */
export async function renameDirectory(
  parent: FileSystemDirectoryHandle,
  dir: FileSystemDirectoryHandle,
  name: string
): Promise<FileSystemDirectoryHandle> {
  await assertNameAvailable(parent, name)
  const next = await parent.getDirectoryHandle(name, { create: true })
  await copyDirInto(dir, next)
  await parent.removeEntry(dir.name, { recursive: true })
  return next
}



