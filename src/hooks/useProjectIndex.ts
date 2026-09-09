import { useEffect, useRef, useState } from 'react'

import { createProjectIndex, type ProjectIndex } from '@/lib/project-index'
import { registerPathCompletion } from '@/monaco/path-completion'
import type { Workspace } from './useWorkspace'

/** 回到窗口时重扫的最小间隔：来回切窗口不该每次都把目录树走一遍 */
const FOCUS_RESCAN_INTERVAL = 3000

/*
  把 lib/project-index.ts 挂到 workspace 上：
  - 根目录变成可用（新开、重新授权）就扫一遍；被移除或失去授权就整体撤出；
  - 窗口重新获得焦点时按 mtime 重扫一遍 —— 没有文件监听 API，用户在别的编辑器里改了
    依赖文件，只有这个时机能发现（和 useExternalChangeWatcher 对当前文件的做法一样）；
  - 顺手注册 import 路径补全，它要的「列一层目录」就是索引手里的 handle。

  编辑器里的内容变化、删除、改名、关标签这些由 App 直接调索引的方法，这里不管。
*/
export function useProjectIndex(workspace: Workspace): ProjectIndex {
  const [index] = useState(createProjectIndex)
  /** 已经交给索引的根：id → handle。同一个根反复 ready（状态对象被替换）不用重扫 */
  const trackedRef = useRef(new Map<string, FileSystemDirectoryHandle>())
  const lastScanRef = useRef(0)

  useEffect(() => {
    const disposable = registerPathCompletion(index)
    return () => {
      disposable.dispose()
      index.dispose()
    }
  }, [index])

  useEffect(() => {
    const tracked = trackedRef.current
    const ready = new Map(
      workspace.roots.filter((root) => root.status === 'ready').map((root) => [root.id, root.handle] as const)
    )
    for (const id of tracked.keys()) {
      if (!ready.has(id)) {
        tracked.delete(id)
        index.dropRoot(id)
      }
    }
    for (const [id, handle] of ready) {
      if (tracked.get(id) === handle) continue
      tracked.set(id, handle)
      lastScanRef.current = Date.now()
      void index.scanRoot(id, handle)
    }
  }, [index, workspace.roots])

  useEffect(() => {
    const onFocus = () => {
      if (Date.now() - lastScanRef.current < FOCUS_RESCAN_INTERVAL) return
      lastScanRef.current = Date.now()
      for (const id of trackedRef.current.keys()) void index.rescan(id)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [index])

  return index
}
