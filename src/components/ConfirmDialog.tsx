import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/context'
import type { Confirm } from '@/hooks/useConfirm'

/*
  useConfirm 的渲染端。自己不持有任何状态，内容全部来自 confirm.request。

  用 AlertDialog 而不是 Dialog：它默认把焦点放在「取消」上、Esc 能退、点遮罩不关，
  正好是「不可逆操作」该有的行为 —— 一回车就把文件删了不行。
*/
const DANGER = 'bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive/70'
const OUTLINE = buttonVariants({ variant: 'outline' })
const DANGER_OUTLINE = 'text-destructive hover:bg-destructive/10 hover:text-destructive'

export default function ConfirmDialog({ confirm }: { confirm: Confirm }) {
  const { t } = useI18n()
  const request = confirm.request
  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) confirm.settle('cancel')
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{request?.title}</AlertDialogTitle>
          {/* asChild + div：正文是多行，<p> 里套 <p> 是非法嵌套，浏览器会把它拆开 */}
          <AlertDialogDescription asChild>
            <div className="space-y-1.5 leading-relaxed">
              {request?.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => confirm.settle('cancel')}>
            {t('confirm.cancel')}
          </AlertDialogCancel>
          {/* 第三个按钮（「不保存」）：描边红字、靠最左，和右边的「取消 / 保存」拉开
              （同 macOS 保存弹窗的排法）。一个弹窗只留一个实心主按钮，两个实心并排会互相抢；
              危险动作单独放一边，也顺手防了误点 */}
          {request?.alt && (
            <AlertDialogAction
              className={cn(OUTLINE, 'sm:order-first sm:me-auto', request.alt.tone === 'danger' && DANGER_OUTLINE)}
              onClick={() => confirm.settle('alt')}
            >
              {request.alt.text}
            </AlertDialogAction>
          )}
          <AlertDialogAction
            className={cn(request?.tone === 'danger' && DANGER)}
            onClick={() => confirm.settle('confirm')}
          >
            {request?.confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
