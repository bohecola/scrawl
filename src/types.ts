import type { FileEncoding } from './lib/fs-access'

// worker → 父页面的 console 消息类型（序列化逻辑见 src/lib/runner.worker.ts）

/**
 * 消息级别 = 被调用的 console 方法。
 * dir / dirxml / count 在 worker 里已归到 log；assert 归到 error；timeLog / timeEnd 归到 time。
 * group 是分组标题行；其后的消息通过 indent 表示嵌套深度。
 */
export type LogLevel = 'log' | 'info' | 'debug' | 'warn' | 'error' | 'table' | 'time' | 'trace' | 'group'

export interface ConsoleMessage {
  id: number
  type: LogLevel
  // 序列化后的参数（runner.worker.ts 里 safeSerialize 的产物，特殊值带 __type 标记）
  args: unknown[]
  // console.group 嵌套深度，0 = 顶层
  indent: number
  timestamp: number
}

// ---- 编辑器里打开的文件 ----

export type Language = 'javascript' | 'typescript'

/*
  打开的文件用一个 key 唯一标识，它同时是 Monaco model 的 key 和侧边栏的选中态：
    builtin:../template/overrides/call.js   内置 Demo（源码打包进来的，可改但存不回去）
    local:src/lib/foo.ts                    用户本地目录里的文件，有 handle，能写回磁盘
    untitled:1                              未命名文件（VS Code 的 Untitled-1）：不落在任何目录里，
                                            可以开多份，内容存在 IndexedDB 里刷新不丢；首屏默认就是一份
    imported:foo.js                         通过 <input type=file> 导入的单个文件
                                            （只有不支持目录 API 的浏览器上还有这个入口）
  只有 local 这一种有 handle —— Ctrl+S 能真正落盘的也只有它，其余退回下载。
*/
export interface ActiveFile {
  key: string
  kind: 'builtin' | 'local' | 'untitled' | 'imported'
  /** 标题栏上显示的名字 */
  name: string
  language: string
  /** 底部状态栏展示的编码。local 来自读盘时对 BOM 的推断；其余在浏览器里生成的
      文件（内置示例 / 未命名 / 导入）按 UTF-8 报。 */
  encoding: FileEncoding
  handle?: FileSystemFileHandle
}

// ---- 顶部提示条 ----

export type NoticeTone = 'info' | 'warn' | 'error'
export interface Notice {
  tone: NoticeTone
  text: string
}

// ---- 本地文件的读盘元数据 ----

/** 读盘时记下的 mtime，用来判断磁盘上的文件是否被外部程序改过。 */
export interface LocalMeta {
  handle: FileSystemFileHandle
  lastModified: number
  /** 该文件的编码推断结果，随 key 一起存，重开 / 改名后仍能对上。
      undefined 表示没走读盘推断（浏览器里新生成的），按 UTF-8 报即可。 */
  encoding?: FileEncoding
}

