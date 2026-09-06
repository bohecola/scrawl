import {
  createContext,
  forwardRef,
  memo,
  useCallback,
  useDeferredValue,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { useI18n } from '@/i18n/context'
import { LANG_TAGS } from '@/i18n/langs'
import { codeRunner, type RawConsoleMessage } from '@/lib/runner'
import { measure, setMeasureFont } from '@/lib/text-width'
import type { ConsoleMessage, LogLevel } from '../types'
import Inspector from './Inspector'

export interface ConsoleHandle {
  clear: () => void
}

/**
 * 面板最多保留的行数。超出后丢最旧的，顶部提示省略了多少条。
 * 两万行 Inspector 一起挂在 DOM 上会让每次滚动都掉帧，五千是「还能顺畅滚动」的上限。
 */
const MAX_LINES = 5000

// 各日志级别的配色与图标
const LEVEL_META: Record<LogLevel, { color: string; badge: string }> = {
  log: { color: 'text-[var(--text-body)]', badge: '' },
  info: { color: 'text-[var(--accent-number)]', badge: 'i' },
  debug: { color: 'text-[var(--text-faint)]', badge: 'dbg' },
  warn: { color: 'text-[var(--accent-symbol)]', badge: 'warn' },
  error: { color: 'text-[var(--accent-error)]', badge: 'err' },
  table: { color: 'text-[var(--accent-string)]', badge: 'table' },
  time: { color: 'text-[var(--accent-number)]', badge: '⏱' },
  trace: { color: 'text-[var(--text-body)]', badge: 'trace' },
  group: { color: 'text-[var(--text-primary)] font-semibold', badge: '' },
}

function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && v in LEVEL_META
}

// 与 Tailwind 类对应的像素常量：可用宽度是拿 measure 量的，类名读不出数值，改类时同步。
// px-2（容器左右内边距合计）、gap-2（行内各列之间）、px-1（徽标两侧合计）、mr-1（group ▾ 右边距）
const PAD_X = 16
const ROW_GAP = 8
const BADGE_PAD = 8
const ARROW_GAP = 4
// group 缩进每层的 paddingInlineStart，与 Inspector 的折叠槽（GUTTER w-4）同套排版
const INDENT_PX = 12

// 日志正文列的可用宽度（px）。Infinity = 还没量出来，预览先靠 CSS truncate 兜底。
// LogRow 是 memo 的，靠 context 感知宽度：宽度没变不重渲染，拖动分栏时才整列重算
const ConsoleWidthContext = createContext<number>(Infinity)

// 顶层的字符串参数按原文输出（和 DevTools 一致：console.log('hi') 不带引号），
// 嵌在对象 / 数组里的字符串才由 Inspector 加引号。其余值都交给 Inspector 识别标记并渲染。
// 多参数时每个参数各拿整行宽度：放不下会折到下一行，在自己那段里裁，不必精确分摊
function renderArg(arg: unknown, key: string | number, width: number) {
  if (typeof arg === 'string') {
    return (
      <span key={key} className="whitespace-pre-wrap">
        {arg}
      </span>
    )
  }
  return <Inspector key={key} value={arg} width={width} />
}

function renderArgs(args: unknown[], key: string, width: number) {
  if (args.length === 1) return renderArg(args[0], key, width)
  return (
    <span key={key} className="flex flex-wrap items-baseline gap-x-2">
      {args.map((a, i) => renderArg(a, i, width))}
    </span>
  )
}

interface LogState {
  logs: ConsoleMessage[]
  /** 因超出 MAX_LINES 被丢掉的最早的行数 */
  omitted: number
}

const EMPTY: LogState = { logs: [], omitted: 0 }

// 时间戳的格式跟着界面语言走（中文 24 小时制、英文也用 24 小时制，
// 差别在分隔符与前导零，交给 Intl 按 locale 决定）。
// 缓存 formatter：toLocaleTimeString 每次都新建一个，五千行一起渲染时光这一项就要几百毫秒。
const timeFormatters = new Map<string, Intl.DateTimeFormat>()
function formatTime(timestamp: number, locale: string): string {
  let f = timeFormatters.get(locale)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    timeFormatters.set(locale, f)
  }
  return f.format(timestamp)
}

// content-visibility: auto 让浏览器只布局视口附近的行；contain-intrinsic-size 给离屏行一个估计高度，
// 滚动条长度才不会随滚动跳变（一行单值 24px 左右，展开的对象树会更高，但估计值只影响滚动条）
const ROW_STYLE: CSSProperties = { contentVisibility: 'auto', containIntrinsicSize: 'auto 24px' }

// 单行 memo：一批新日志进来只渲染新增的那几百行，已有的几千行原样复用
const LogRow = memo(function LogRow({ log, locale }: { log: ConsoleMessage; locale: string }) {
  const meta = LEVEL_META[log.type]
  const contentWidth = useContext(ConsoleWidthContext)
  // 本行预览的可用宽度：正文列宽减去徽标（按 10px 字号量宽，加两侧 px-1 与前面的 gap）、
  // group 缩进与 ▾。字符串参数不裁剪（照原文折行），对象预览按这个宽裁
  const rowWidth =
    contentWidth -
    (meta.badge ? measure(meta.badge.toUpperCase(), 10) + BADGE_PAD + ROW_GAP : 0) -
    log.indent * INDENT_PX -
    (log.type === 'group' ? measure('▾') + ARROW_GAP : 0)
  return (
    <div
      className={`flex gap-2 py-0.5 ${meta.color} border-b border-[var(--border)]/60 last:border-0`}
      // 离屏的行跳过布局与绘制：几千行一起挂着时，每来一批新日志就重排全部行太贵
      style={ROW_STYLE}
    >
      <span className="shrink-0 text-[var(--text-faint)]">{formatTime(log.timestamp, locale)}</span>
      {meta.badge && (
        <span className="shrink-0 rounded bg-[var(--badge-bg)] px-1 text-[10px] uppercase">{meta.badge}</span>
      )}
      <div
        className="min-w-0 flex-1 break-words"
        style={log.indent > 0 ? { paddingInlineStart: `${log.indent * INDENT_PX}px` } : undefined}
      >
        {log.type === 'group' && <span className="mr-1 text-[var(--text-faint)]">▾</span>}
        {renderArgs(log.args, String(log.id), rowWidth)}
      </div>
    </div>
  )
})

export default forwardRef<ConsoleHandle>(function Console(_props, ref) {
  const { t, lang } = useI18n()
  const locale = LANG_TAGS[lang]
  const [{ logs, omitted }, setState] = useState<LogState>(EMPTY)
  const idRef = useRef(0)
  const containerRef = useRef<HTMLDivElement>(null)
  // 正文列可用宽度（px），初始 Infinity = 未量过；宽度帧合并用的 rAF 句柄
  const [contentWidth, setContentWidth] = useState<number>(Infinity)
  const widthFrameRef = useRef<number | null>(null)
  // 拖动分栏时宽度每帧都在变，几千行 memo 的 LogRow 会跟着全量重渲染，太重。
  // 传给 context 的宽度降一级优先级：拖动本身的 urgent 渲染先行，行的重算可被输入打断 ——
  // 拖动中预览允许短暂滞后于面板宽度，松手后收敛到最终值，输入不卡
  const fittedWidth = useDeferredValue(contentWidth)
  // worker 来的消息先进队列，一帧只 setState 一次；否则每条消息一次渲染，输出一多主线程就卡死
  const queueRef = useRef<ConsoleMessage[]>([])
  const droppedRef = useRef(0)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    const flush = () => {
      frameRef.current = null
      const incoming = queueRef.current
      const dropped = droppedRef.current
      if (incoming.length === 0 && dropped === 0) return
      queueRef.current = []
      droppedRef.current = 0
      setState((prev) => {
        const merged = prev.logs.length === 0 ? incoming : prev.logs.concat(incoming)
        const overflow = Math.max(0, merged.length - MAX_LINES)
        return {
          logs: overflow > 0 ? merged.slice(overflow) : merged,
          omitted: prev.omitted + dropped + overflow,
        }
      })
    }
    const unsubscribe = codeRunner.subscribe((batch: RawConsoleMessage[], dropped: number) => {
      droppedRef.current += dropped
      for (const m of batch) {
        if (!Array.isArray(m?.args)) continue
        queueRef.current.push({
          id: ++idRef.current,
          type: isLogLevel(m.type) ? m.type : 'log',
          args: m.args,
          indent: typeof m.indent === 'number' ? m.indent : 0,
          timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.now(),
        })
      }
      // 队列本身也截断：一批两万条只留最后 MAX_LINES 条进 state，多余的直接计入省略数
      const excess = queueRef.current.length - MAX_LINES
      if (excess > 0) {
        queueRef.current = queueRef.current.slice(excess)
        droppedRef.current += excess
      }
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(flush)
    })
    return () => {
      unsubscribe()
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      queueRef.current = []
      droppedRef.current = 0
    }
  }, [])

  // 新日志自动滚动到底部
  useEffect(() => {
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  // 量一遍字体与正文列宽度。字体串从容器的 computed style 取（canvas 量宽必须用同一个字体），
  // clientWidth 已含 px-2 的内边距，依次减掉内边距、时间列（随 locale 变）与 gap，
  // 剩下的才是日志正文列。floor 是保守取整，别让预览按四舍五入多占出 1px 触发兜底截断
  const updateWidth = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const cs = getComputedStyle(el)
    setMeasureFont(cs.font || `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`)
    const w = Math.floor(el.clientWidth) - PAD_X - measure(formatTime(Date.now(), locale)) - ROW_GAP
    setContentWidth((prev) => (prev === w ? prev : w))
  }, [locale])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    updateWidth()
    const ro = new ResizeObserver(() => {
      // rAF 合并：拖动分栏时一帧可能触发多次，一帧量一次重渲染一次就够
      if (widthFrameRef.current !== null) return
      widthFrameRef.current = requestAnimationFrame(() => {
        widthFrameRef.current = null
        updateWidth()
      })
    })
    ro.observe(el)
    // webfont 加载完成会改字宽，重新量一次（系统字体栈下这是空操作）
    let cancelled = false
    document.fonts.ready.then(() => {
      if (!cancelled) updateWidth()
    })
    return () => {
      cancelled = true
      ro.disconnect()
      if (widthFrameRef.current !== null) cancelAnimationFrame(widthFrameRef.current)
      widthFrameRef.current = null
    }
  }, [updateWidth])

  useImperativeHandle(ref, () => ({
    clear: () => {
      queueRef.current = []
      droppedRef.current = 0
      setState(EMPTY)
    },
  }))

  return (
    <ConsoleWidthContext.Provider value={fittedWidth}>
      <div
        ref={containerRef}
        className="h-full overflow-auto bg-[var(--panel-bg)] px-2 py-1 font-mono text-[12px] leading-5"
      >
        {logs.length === 0 ? (
          <div className="mt-1 text-[var(--text-faint)]">{t('console.empty')}</div>
        ) : (
          <>
            {omitted > 0 && (
              <div className="border-b border-[var(--border)]/60 py-0.5 text-[var(--text-faint)]">
                … {t('console.omitted', { count: omitted })}
              </div>
            )}
            {logs.map((log) => (
              <LogRow key={log.id} log={log} locale={locale} />
            ))}
          </>
        )}
      </div>
    </ConsoleWidthContext.Provider>
  )
})
