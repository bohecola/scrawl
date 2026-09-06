import { useCallback, useMemo, useRef, useState } from 'react'

/*
  一个 Promise 式的确认框。

  为什么不是 onConfirm / onCancel 两个回调：需要确认的动作（删除、目录改名）本身
  是一串 await —— 量体积、落盘、迁移编辑器状态。拆成回调就得把后半截逻辑搬到另一个
  函数里去，读的人要在两处之间跳。`if (!(await confirm.ask(...))) return` 一行读完。

  文案在调用点拼好传进来：只有那里知道删的是哪个路径、目录里有多少东西。
  弹窗组件（ConfirmDialog）只管渲染，不认识文件系统。
*/

export interface ConfirmRequest {
  title: string
  /** 正文，一行一段 */
  lines: string[]
  /** 确认按钮上的字。写成动词（「删除」而不是「确定」），让人在按下之前知道会发生什么 */
  confirmText: string
  /** danger：确认按钮用红色。留给不可逆的操作 */
  tone?: 'default' | 'danger'
  /**
   * 可选的第三个按钮，排在取消和确认之间。给「保存 / 不保存 / 取消」这种三选一用：
   * 确认是「保存」，alt 是红色的「不保存」。
   */
  alt?: { text: string; tone?: 'default' | 'danger' }
}

/** 弹窗的结果：confirm = 主按钮，alt = 第三个按钮，cancel = 取消 / Esc / 点外面 */
export type ConfirmChoice = 'confirm' | 'alt' | 'cancel'

export interface Confirm {
  /** 当前要问的事，null 表示弹窗关着 */
  request: ConfirmRequest | null
  /** 两个按钮的问法：true = 点了确认 */
  ask: (request: ConfirmRequest) => Promise<boolean>
  /** 三个按钮的问法，拿到具体点了哪个 */
  choose: (request: ConfirmRequest) => Promise<ConfirmChoice>
  /** 由弹窗调用 */
  settle: (choice: ConfirmChoice) => void
}

export function useConfirm(): Confirm {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const resolveRef = useRef<((choice: ConfirmChoice) => void) | null>(null)

  const choose = useCallback((next: ConfirmRequest) => {
    // 上一个还没结（正常流程走不到，弹窗是模态的）：当成取消结掉，
    // 否则那个 await 会永远悬着，调用方的 busy 状态也就永远下不来
    resolveRef.current?.('cancel')
    setRequest(next)
    return new Promise<ConfirmChoice>((resolve) => {
      resolveRef.current = resolve
    })
  }, [])

  const ask = useCallback(
    (next: ConfirmRequest) => choose(next).then((choice) => choice === 'confirm'),
    [choose]
  )

  // 按钮的 onClick 和 onOpenChange(false) 会一前一后都进来，第二次是空转
  const settle = useCallback((choice: ConfirmChoice) => {
    setRequest(null)
    resolveRef.current?.(choice)
    resolveRef.current = null
  }, [])

  // 返回稳定对象：调用方把 confirm 整个放进 useCallback / useEffect 的依赖里，
  // 每次渲染换一个新对象会让那些缓存全部失效，效果比不写 useCallback 还糟
  return useMemo(() => ({ request, ask, choose, settle }), [request, ask, choose, settle])
}
