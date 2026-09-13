import { useEffect, useLayoutEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { codeRunner, type RawConsoleMessage } from '@/lib/runner'
import { isLogLevel } from '@/types'
import { useI18n } from '@/i18n/context'

export interface PreviewPanelProps {
  /** 上次「运行」时 producer 产出的完整文档；null = 还没运行过（空态，只有 page 模式会这样） */
  srcDoc: string | null
  /** page = 用户的页面（跑脚本、手动刷新）；document = 我们的文档（禁脚本、自动刷新，如 markdown） */
  mode: 'page' | 'document'
}

/*
  预览外壳，语言无关：沙箱 iframe + 消息桥 + 滚动保持。
  「塞什么文档进去」由各语言的生产者负责（lib/preview/render-*.ts），
  这里只管安全地装着它、把页面日志送回 Console。

  沙箱两种模式都不给 allow-same-origin（预览永远摸不到应用的 localStorage /
  IndexedDB / 目录句柄）：page 模式开 allow-scripts 让页面代码能跑；
  document 模式连脚本都禁——markdown 里内嵌的 <script> 不该执行。
*/
export default function PreviewPanel({ srcDoc, mode }: PreviewPanelProps) {
  const { t } = useI18n()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // 刷新前后的滚动位置：长页面重跑时视口别弹回顶部。读不到就算了，best-effort
  const scrollTopRef = useRef(0)

  // 页面日志 → Console。沙箱 iframe 的 origin 是 "null"，没法按 origin 校验，
  // 靠 source 指针必须等于本 iframe 才认，别的窗口冒充不进来。
  // rAF 合批：页面一口气 log 几十条时一帧只进一次分发管线
  useEffect(() => {
    const queue: RawConsoleMessage[] = []
    let frame: number | null = null
    const flush = () => {
      frame = null
      if (queue.length > 0) codeRunner.emitPage(queue.splice(0))
    }
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { __scrawlPreview?: number; level?: string; args?: unknown[] } | null
      if (!data || data.__scrawlPreview !== 1 || !Array.isArray(data.args)) return
      if (e.source !== iframeRef.current?.contentWindow) return
      queue.push({
        type: isLogLevel(data.level) ? data.level : 'log',
        args: data.args,
        indent: 0,
        timestamp: Date.now(),
      })
      if (frame === null) frame = requestAnimationFrame(flush)
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [])

  // srcDoc 每次变化都是整篇文档重载，先存一下旧页面的滚动位置，onLoad 时写回。
  // 沙箱 iframe 是不透明源，读 scrollY 本身就抛 SecurityError —— 包住当没有，
  // 这个机制只对将来不带 allow-scripts 的同源预览（如 markdown 文档）真正生效
  useLayoutEffect(() => {
    try {
      scrollTopRef.current = iframeRef.current?.contentWindow?.scrollY ?? 0
    } catch {
      scrollTopRef.current = 0
    }
  }, [srcDoc])

  const restoreScroll = () => {
    try {
      iframeRef.current?.contentWindow?.scrollTo(0, scrollTopRef.current)
    } catch {
      // 同上，跨域读不到就算了
    }
  }

  if (srcDoc === null) {
    return <div className="p-3 text-[var(--text-faint)]">{t('preview.empty')}</div>
  }

  return (
    <div className="relative h-full">
      <iframe
        ref={iframeRef}
        title="preview"
        sandbox={mode === 'page' ? 'allow-scripts' : ''}
        srcDoc={srcDoc}
        onLoad={restoreScroll}
        // page 模式垫白底（页面默认就是白的）；document 模式的底色由文档自己画，跟主题走
        className={mode === 'page' ? 'size-full border-0 bg-white' : 'size-full border-0'}
      />
    </div>
  )
}

// 预览视图的头部动作：刷新 + 「已改未重跑」脏点。放这里而不是 App：
// 头部 JSX 与面板的关联最紧，App 那边只管数据
export function PreviewActions({ dirty, onRefresh }: { dirty: boolean; onRefresh: () => void }) {
  const { t } = useI18n()
  return (
    <div className="flex items-center gap-1">
      {dirty && (
        <span
          title={t('preview.dirty')}
          aria-label={t('preview.dirty')}
          className="size-2 shrink-0 rounded-full bg-[var(--accent-symbol)]"
        />
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onRefresh}
        title={t('preview.refresh')}
        aria-label={t('preview.refresh')}
      >
        <Icon className="icon-[lucide--refresh-cw]" />
      </Button>
    </div>
  )
}
