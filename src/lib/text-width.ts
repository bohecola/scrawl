/*
  用 canvas 的 measureText 量文本像素宽度。
  控制台是等宽字体，折叠预览能放下几项可以直接按宽度算出来，不必每行读 DOM ——
  读离屏行的 offsetWidth 会强制它们排版，抵消 content-visibility: auto 的收益。
*/

let ctx: CanvasRenderingContext2D | null = null
// 量宽用的字体串（CSS font 简写），Console 在挂载 / fonts.ready / resize 时从容器同步过来
let font = ''
// ctx 当前生效的字体，避免每次 measure 都重新赋值
let applied = ''
const cache = new Map<string, number>()

/** 设置量宽字体（取自控制台容器的 computed style）。字体变了必须清缓存。 */
export function setMeasureFont(f: string) {
  if (f === font) return
  font = f
  cache.clear()
}

/**
 * 量一段文本的像素宽。sizePx 用于量非基准字号的文本（比如控制台徽标的 10px）：
 * 实现上把字体简写里的字号 token（第一个「Npx」，可带「/行高」）替换掉。
 */
export function measure(text: string, sizePx?: number): number {
  if (!text) return 0
  const key = sizePx ? `\u0000${sizePx}\u0000${text}` : text
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  if (!ctx) ctx = document.createElement('canvas').getContext('2d')!
  const f = sizePx ? font.replace(/(\d+(?:\.\d+)?)px(\/\s*\d+(?:\.\d+)?)?/, `${sizePx}px`) : font
  if (f !== applied) {
    ctx.font = f
    applied = f
  }
  const w = ctx.measureText(text).width
  // 日志里会出现海量不同的 key / 字符串，缓存超限直接清空，避免无限膨胀
  if (cache.size > 2000) cache.clear()
  cache.set(key, w)
  return w
}
