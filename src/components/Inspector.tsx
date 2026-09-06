import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { measure } from '@/lib/text-width'

// runner.worker.ts 序列化后值的类型。普通 JSON 值（string/number/boolean/array/plain object）
// 直接透传；特殊值用 { __type: '...' } 标记，这里负责把它们渲染成对应的 JS 类型外观。
type Marked =
  | { __type: 'null' }
  | { __type: 'undefined' }
  | { __type: 'NaN' }
  | { __type: 'Infinity' }
  | { __type: '-Infinity' }
  | { __type: 'depth' }
  | { __type: 'circular' }
  | { __type: 'function'; name: string }
  | { __type: 'symbol'; desc: string }
  | { __type: 'bigint'; value: string }
  | { __type: 'date'; value: string }
  | { __type: 'regexp'; value: string }
  | { __type: 'error'; value: string; stack?: string[] }
  | { __type: 'stack'; frames: string[] }
  | { __type: 'instance'; class: string; props: Record<string, unknown> }
  | { __type: 'Map'; entries: [unknown, unknown][] }
  | { __type: 'Set'; items: unknown[] }

// 不用 lodash 的 isPlainObject：它的返回类型是 boolean 而不是类型谓词，
// 换过去下面每一处 value.__type 的收窄都得改成断言
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isMarked(v: unknown): v is Marked {
  return isPlainObject(v) && '__type' in v
}

/*
  排版参照 Chrome DevTools 的对象树：
  - 每行开头固定留一格「折叠槽」（GUTTER），可展开的行放三角，叶子行留空，
    这样同一层的 key 无论有没有三角都在同一列；
  - 子层整体缩进一格槽宽，缩进引导线画在上一级三角的正中，一眼能看出归属；
  - 折叠时的预览带上值（`{a: 1, b: "x", c: {…}}`），不用展开也能看到大概。
*/
// 槽宽 16px：三角图标 12px 居中，两侧各留 2px，加上图标自身的留白，与右侧文字之间
// 约 6px 空隙，和 DevTools 的三角-文字间距接近；再窄就会挤着 key
const GUTTER = 'w-4'
const INDENT = 'ps-4'
const GUIDE = 'start-[7px]'
// 槽宽的像素值。预览按可用宽度裁剪时要用它做减法，而 Tailwind 类读不出数值，改槽宽时同步
const GUTTER_PX = 16

// 值类型配色：见 index.css 的 --val-* 令牌。这组颜色不跟界面主色（data-accent）联动，
// 否则把主题切成粉色后数字也跟着变粉，读输出时会很别扭
const C = {
  key: 'text-[var(--val-key)]',
  string: 'text-[var(--val-string)]',
  number: 'text-[var(--val-number)]',
  bool: 'text-[var(--val-bool)]',
  nil: 'text-[var(--val-nil)]',
  fn: 'text-[var(--val-fn)] italic',
  regexp: 'text-[var(--val-regexp)]',
  symbol: 'text-[var(--val-symbol)]',
  error: 'text-[var(--accent-error)]',
  // 类名 / Array(n) / Map(n) 这类「容器名」：中性正文色，靠位置而不是颜色区分
  ctor: 'text-[var(--text-body)]',
  // 预览里的 {…} / [Circular] / 括号逗号 等次要内容
  dim: 'text-[var(--text-faint)]',
} as const

const STRING_PREVIEW_MAX = 40

function quote(s: string, max = Infinity) {
  const body = s.length > max ? s.slice(0, max) + '…' : s
  return `"${body}"`
}

/*
  单值的展示文本与配色。文本单独抽成一份：预览按宽度裁剪时量的是纯文本，
  必须和 JSX 渲染出来的字符完全一致（引号、{…}、ƒ、=> 等），两处共用这里就不会漂移。
*/
function valueStyle(value: unknown, inPreview: boolean): { text: string; cls: string } {
  if (value === null) return { text: 'null', cls: C.nil }
  if (isMarked(value)) {
    switch (value.__type) {
      case 'undefined':
        return { text: 'undefined', cls: C.nil }
      case 'null':
        return { text: 'null', cls: C.nil }
      case 'NaN':
        return { text: 'NaN', cls: C.number }
      case 'Infinity':
        return { text: 'Infinity', cls: C.number }
      case '-Infinity':
        return { text: '-Infinity', cls: C.number }
      case 'circular':
        return { text: '[Circular]', cls: C.dim }
      case 'depth':
        return { text: '[Depth Limit]', cls: C.dim }
      case 'function':
        return { text: inPreview ? 'ƒ' : `ƒ ${value.name}()`, cls: C.fn }
      case 'symbol':
        return { text: value.desc, cls: C.symbol }
      case 'bigint':
        return { text: `${value.value}n`, cls: C.number }
      case 'date':
        return { text: value.value, cls: C.ctor }
      case 'regexp':
        return { text: value.value, cls: C.regexp }
      case 'error':
        return { text: value.value, cls: C.error }
      default:
        break
    }
  }
  switch (typeof value) {
    case 'string':
      return { text: inPreview ? quote(value, STRING_PREVIEW_MAX) : quote(value), cls: C.string }
    case 'number':
      return { text: String(value), cls: C.number }
    case 'boolean':
      return { text: String(value), cls: C.bool }
    default:
      return { text: String(value), cls: C.ctor }
  }
}

// 单值渲染（非可展开对象）。inPreview 时字符串截短，函数只显示 ƒ
function ValueText({ value, inPreview = false }: { value: unknown; inPreview?: boolean }) {
  const s = valueStyle(value, inPreview)
  return <span className={s.cls}>{s.text}</span>
}

/** 预览里的一个值：能展开的容器缩成一个名字（`{…}` / `Array(3)` / `Node` / `Map(2)`），其余按单值印 */
function previewStyle(value: unknown): { text: string; cls: string } {
  if (Array.isArray(value)) return { text: `Array(${value.length})`, cls: C.dim }
  if (isPlainObject(value) && !isMarked(value)) return { text: '{…}', cls: C.dim }
  if (isMarked(value)) {
    switch (value.__type) {
      case 'instance':
        return { text: value.class, cls: C.ctor }
      case 'Map':
        return { text: `Map(${value.entries.length})`, cls: C.ctor }
      case 'Set':
        return { text: `Set(${value.items.length})`, cls: C.ctor }
      case 'stack':
        return { text: 'stack', cls: C.dim }
      default:
        break
    }
  }
  return valueStyle(value, true)
}

// 预览里最多列几项：对象 5 个 key（同 DevTools），数组多给一些，短数组能一眼看全
const PREVIEW_MAX = 5
const ARRAY_PREVIEW_MAX = 10

/*
  折叠预览的统一描述：head + open + 逗号拼接的 items + close。
  有了每项的纯文本形式（text 与 node 渲染的字符一致），就能用 measure 按可用宽度
  贪心裁剪，省略号之后把右括号补回去 —— 纯 CSS text-overflow 做不到这一点。
*/
interface PreviewSpec {
  // 'Node ' / 'Map(2) ' / '(16) '，含尾随空格；数组计数与容器名配色不同，带上各自的类
  head?: { text: string; cls: string }
  open: '{' | '['
  items: { node: ReactNode; text: string }[] // 已按 PREVIEW_MAX / ARRAY_PREVIEW_MAX 截过数量
  close: '}' | ']'
  moreByCount: boolean // 数量上就没列全（要显示 ", …" 的情况）
}

function previewItem(value: unknown): { node: ReactNode; text: string } {
  const s = previewStyle(value)
  return { node: <span className={s.cls}>{s.text}</span>, text: s.text }
}

// 对象条目：`key: value`。key 原样印（同 DevTools，只有值才加引号）
function entryItem(key: string, value: unknown): { node: ReactNode; text: string } {
  const s = previewStyle(value)
  return {
    node: (
      <>
        <span className={C.key}>{key}</span>: <span className={s.cls}>{s.text}</span>
      </>
    ),
    text: `${key}: ${s.text}`,
  }
}

// Map 条目：`key => value`
function mapEntryItem(key: unknown, value: unknown): { node: ReactNode; text: string } {
  const k = previewStyle(key)
  const v = previewStyle(value)
  return {
    node: (
      <>
        <span className={k.cls}>{k.text}</span> {'=>'} <span className={v.cls}>{v.text}</span>
      </>
    ),
    text: `${k.text} => ${v.text}`,
  }
}

function braceSpec(head: PreviewSpec['head'], entries: [string, unknown][], max: number): PreviewSpec {
  return {
    head,
    open: '{',
    close: '}',
    items: entries.slice(0, max).map(([k, v]) => entryItem(k, v)),
    moreByCount: entries.length > max,
  }
}

// 把可展开值翻译成 PreviewSpec；null 表示不是括号容器（error / stack 有各自的纯文本预览）
function previewSpec(value: unknown): PreviewSpec | null {
  if (Array.isArray(value)) {
    return {
      head: { text: `(${value.length}) `, cls: C.dim },
      open: '[',
      close: ']',
      items: value.slice(0, ARRAY_PREVIEW_MAX).map((v) => previewItem(v)),
      moreByCount: value.length > ARRAY_PREVIEW_MAX,
    }
  }
  if (!isPlainObject(value)) return null
  if (!isMarked(value)) return braceSpec(undefined, Object.entries(value), PREVIEW_MAX)
  switch (value.__type) {
    case 'instance':
      return braceSpec({ text: `${value.class} `, cls: C.ctor }, Object.entries(value.props), PREVIEW_MAX)
    case 'Map':
      return {
        head: { text: `Map(${value.entries.length}) `, cls: C.ctor },
        open: '{',
        close: '}',
        items: value.entries.slice(0, PREVIEW_MAX).map(([k, v]) => mapEntryItem(k, v)),
        moreByCount: value.entries.length > PREVIEW_MAX,
      }
    case 'Set':
      return {
        head: { text: `Set(${value.items.length}) `, cls: C.ctor },
        open: '{',
        close: '}',
        items: value.items.slice(0, PREVIEW_MAX).map((v) => previewItem(v)),
        moreByCount: value.items.length > PREVIEW_MAX,
      }
    default:
      return null
  }
}

/** 按可用宽度贪心挑能放下的项，返回要渲染的项与是否被裁 */
function fitPreview(spec: PreviewSpec, availPx: number): { items: ReactNode[]; truncated: boolean } {
  const tailFull = measure(spec.close)
  // 裁剪时结尾还挂着 ", …"，要先给它留位
  const tailCut = measure(`, …${spec.close}`)
  let used = measure(spec.head?.text ?? '') + measure(spec.open)
  let n = 0
  for (let i = 0; i < spec.items.length; i++) {
    const w = measure(i > 0 ? `, ${spec.items[i].text}` : spec.items[i].text)
    const tail = i === spec.items.length - 1 && !spec.moreByCount ? tailFull : tailCut
    if (used + w + tail > availPx) break
    used += w
    n++
  }
  return {
    items: spec.items.slice(0, n).map((item) => item.node),
    truncated: n < spec.items.length || spec.moreByCount,
  }
}

// Map 的 key 在展开行里的写法：基本类型直接印出来，对象类 key 用序号占位
function mapKeyLabel(key: unknown, index: number): string {
  if (typeof key === 'string') return quote(key)
  if (typeof key === 'number' || typeof key === 'boolean') return String(key)
  if (isMarked(key)) {
    if (key.__type === 'symbol') return key.desc
    if (key.__type === 'bigint') return `${key.value}n`
    if (key.__type === 'null' || key.__type === 'undefined' || key.__type === 'NaN') return key.__type
  }
  return `[key ${index}]`
}

/**
 * 一个可展开节点：spec 非空时折叠行渲染按宽度拟合的预览，否则用纯文本 preview
 * （error / stack）；children 拿当前可用宽度逐行渲染子层
 */
interface Node {
  spec: PreviewSpec | null
  preview?: ReactNode
  children: (width: number) => ReactNode
}

// 子层的可用宽度：每层缩进一格槽宽（INDENT 的 ps-4）
function childWidth(width: number): number {
  return width === Infinity ? Infinity : width - GUTTER_PX
}

// 展开后的子行：数组 / Map / Set 按序号命名，对象 / 实例按 key，Map 的对象类 key 用占位符
function childRows(value: unknown, depth: number, width: number): ReactNode {
  if (Array.isArray(value)) {
    return value.map((v, i) => (
      <Inspector key={i} value={v} name={String(i)} depth={depth + 1} width={width} />
    ))
  }
  if (!isPlainObject(value)) return null
  if (!isMarked(value)) {
    return Object.entries(value).map(([k, v]) => (
      <Inspector key={k} value={v} name={k} depth={depth + 1} width={width} />
    ))
  }
  switch (value.__type) {
    case 'instance':
      return Object.entries(value.props).map(([k, v]) => (
        <Inspector key={k} value={v} name={k} depth={depth + 1} width={width} />
      ))
    case 'Map':
      return value.entries.map(([k, v], i) => (
        <Inspector key={i} value={v} name={mapKeyLabel(k, i)} depth={depth + 1} width={width} />
      ))
    case 'Set':
      return value.items.map((v, i) => (
        <Inspector key={i} value={v} name={String(i)} depth={depth + 1} width={width} />
      ))
    default:
      return null
  }
}

function describe(value: unknown, depth: number): Node | null {
  const spec = previewSpec(value)
  if (spec) {
    return { spec, children: (width) => childRows(value, depth, childWidth(width)) }
  }
  if (isMarked(value)) {
    if (value.__type === 'error') {
      if (!value.stack || value.stack.length === 0) return null
      const frames = value.stack
      return {
        spec: null,
        preview: <span className={C.error}>{value.value}</span>,
        children: () => <StackFrames frames={frames} />,
      }
    }
    if (value.__type === 'stack') {
      return {
        spec: null,
        preview: <span className={C.dim}>stack</span>,
        children: () => <StackFrames frames={value.frames} />,
      }
    }
  }
  return null
}

function StackFrames({ frames }: { frames: string[] }) {
  return (
    <>
      {frames.map((f, i) => (
        <div key={i} className={cn('flex leading-5', C.dim)}>
          <span className={cn('shrink-0', GUTTER)} />
          <span className="min-w-0 break-all">{f}</span>
        </div>
      ))}
    </>
  )
}

interface InspectorProps {
  value: unknown
  name?: string
  depth?: number
  /** 本行可用宽度（px）。缺省 Infinity = 不按宽度裁剪，靠外层 truncate 兜底 */
  width?: number
}

function Inspector({ value, name, depth = 0, width = Infinity }: InspectorProps) {
  // describe 对同一个 (value, depth) 结果不变，memo 住它：折叠预览的 spec 保持引用稳定，
  // 下面的 fitPreview 才能真的按 (value, avail) 缓存住，宽度不变的重渲染几乎零成本
  const node = useMemo(() => describe(value, depth), [value, depth])
  // 错误与调用栈默认展开（在 playground 里行号就是最想看的东西）；其余节点和 DevTools 一样
  // 默认折叠，靠预览看大概，需要时再点开
  const [open, setOpen] = useState(
    isMarked(value) && (value.__type === 'error' || value.__type === 'stack')
  )

  const label = name != null && (
    <>
      <span className={C.key}>{name}</span>
      <span className={C.dim}>: </span>
    </>
  )

  // 表头预览的可用宽度：本层宽度减折叠槽，再减「name: 」的宽度
  const availPx = width - GUTTER_PX - (name != null ? measure(`${name}: `) : 0)
  const fit = useMemo(() => (node?.spec ? fitPreview(node.spec, availPx) : null), [node, availPx])

  // 普通单值（非对象/数组，或标记值）：留空折叠槽，让 key 与可展开行对齐
  if (!node) {
    return (
      <div className="flex leading-5">
        <span className={cn('shrink-0', GUTTER)} />
        <span className="min-w-0 break-words whitespace-pre-wrap">
          {label}
          <ValueText value={value} />
        </span>
      </div>
    )
  }

  return (
    // min-w-0 / max-w-full：作为多参数日志（flex-wrap）里的一项时也允许被压窄，预览才截得住
    <div className="min-w-0 max-w-full leading-5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="group/row flex w-full cursor-pointer select-none text-start focus:outline-none"
      >
        <span
          className={cn(
            'flex h-5 shrink-0 items-center justify-center text-[var(--text-faint)] group-hover/row:text-[var(--text-body)]',
            GUTTER
          )}
        >
          <span
            className={cn(
              // 展开后朝下在两种方向下都对；收起时 RTL 界面里应指左（chevron 左右对称，
              // 转 180° 等于镜像）。不用 rtl: 变体：它是 [dir=rtl] * 匹配，会无视中间
              // 日志行的 dir=ltr 把行内的三角也转掉；:dir() 只认最近的 dir 祖先
              'icon-[lucide--chevron-right] size-3 transition-transform duration-100',
              open ? 'rotate-90' : '[&:dir(rtl)]:rotate-180'
            )}
          />
        </span>
        {/* 折叠预览只占一行：宽度不够时先按像素裁剪、把右括号补回去（whitespace-pre 保住逗号后的空格），
            CSS truncate 只作兜底；展开后的叶子值才允许换行 */}
        <span className="min-w-0 truncate">
          {label}
          {node.spec && fit ? (
            <span className={cn(C.dim, 'whitespace-pre')}>
              {node.spec.head && <span className={node.spec.head.cls}>{node.spec.head.text}</span>}
              {node.spec.open}
              {fit.items.map((item, i) => (
                <Fragment key={i}>
                  {i > 0 && ', '}
                  {item}
                </Fragment>
              ))}
              {fit.truncated && (fit.items.length > 0 ? ', …' : '…')}
              {node.spec.close}
            </span>
          ) : (
            node.preview
          )}
        </span>
      </button>
      {open && (
        <div className={cn('relative', INDENT)}>
          {/* 缩进引导线：落在上一级三角的正中 */}
          <span className={cn('absolute inset-y-0 w-px bg-[var(--border-strong)]/60', GUIDE)} />
          {node.children(width)}
        </div>
      )}
    </div>
  )
}

export default Inspector
