import { useCallback, useEffect, useMemo, useState } from 'react'
import { debounce } from 'lodash-es'
import { idbGet, idbSet } from '@/lib/idb'

/*
  未命名文件（VS Code 的 Untitled-N）的编号与持久化。

  编号：取当前没被占用的最小正整数，关掉「未命名-2」再新建还是「未命名-2」。
  分配是同步的、只看内存里这份表，所以连按新建不会撞号。

  持久化：整张表存成 IndexedDB 里的一条（key `untitled`），内容变了就防抖重写。
  刷新后全部恢复成标签，playground 里随手写的东西不该因为一次刷新就没了。
  转正成本地文件或关掉标签时从表里删掉。
*/

export interface UntitledRecord {
  n: number
  language: string
  content: string
}

const IDB_KEY = 'untitled'
const WRITE_DELAY_MS = 300

export const untitledKey = (n: number) => `untitled:${n}`
export const isUntitledKey = (key: string) => key.startsWith('untitled:')

export function useUntitled() {
  // 用 state 的惰性初始值而不是 ref：这张表只在回调里读写，从不驱动渲染，但它得是个稳定对象
  const [map] = useState(() => new Map<number, UntitledRecord>())
  /** 启动时那次读盘结束了没有；App 等它和 workspace.ready 一起决定首屏开什么 */
  const [ready, setReady] = useState(false)

  const write = useMemo(
    () =>
      debounce(() => {
        const rows = [...map.values()].sort((a, b) => a.n - b.n)
        // 存不进去就算了：只是少了「刷新不丢」，编辑本身不受影响
        void idbSet(IDB_KEY, rows).catch(() => {})
      }, WRITE_DELAY_MS),
    [map]
  )

  useEffect(() => {
    let cancelled = false
    idbGet<UntitledRecord[]>(IDB_KEY)
      .then((rows) => {
        if (cancelled) return
        for (const row of rows ?? []) {
          // 读盘期间用户可能已经按 Alt+N 建了一份同号的空文件；存过内容的那份优先
          const live = map.get(row.n)
          if (!live || live.content === '') map.set(row.n, row)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [map])

  // 离开页面前把防抖里攒着的那次写掉。IndexedDB 在 pagehide 里不保证能提交，
  // 但内容很小，实际基本都来得及；这已经是不阻塞卸载的前提下能做的全部
  useEffect(() => {
    const flush = () => write.flush()
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [write])

  const create = useCallback(
    (language = 'javascript'): UntitledRecord => {
      let n = 1
      while (map.has(n)) n++
      const row = { n, language, content: '' }
      map.set(n, row)
      write()
      return row
    },
    [map, write]
  )

  const update = useCallback(
    (key: string, content: string) => {
      const row = map.get(Number(key.slice('untitled:'.length)))
      if (!row || row.content === content) return
      row.content = content
      write()
    },
    [map, write]
  )

  const remove = useCallback(
    (key: string) => {
      if (map.delete(Number(key.slice('untitled:'.length)))) write()
    },
    [map, write]
  )

  /** 启动时恢复用：按编号排好的全部记录 */
  const all = useCallback(() => [...map.values()].sort((a, b) => a.n - b.n), [map])

  return { ready, create, update, remove, all }
}
