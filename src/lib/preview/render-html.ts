/*
  HTML 预览的生产者：把用户文档变成 iframe 的 srcDoc。
  唯一要做的事是在 <head> 顶部注入 console 桥——页面里的 console.log / 报错
  postMessage 回父窗口，父窗口再塞进 Console，写 HTML+JS 时两边都看得到。
  后续 markdown 预览会加 render-markdown.ts，与此文件并列，共用「producer」这个位置。
*/

// 桥接脚本。写成字符串而不是函数序列化：内容固定，直观可读，也不怕构建期改写。
// 参数序列化只做 JSON 能吃下的浅拷贝，失败就 String() 兜底 —— Console 的 Inspector
// 本来就按「普通 JSON 值直接透传」设计，够用。
const BRIDGE = `<script>
(function () {
  var safe = function (v) {
    if (v === null) return v
    var t = typeof v
    if (t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined') return v
    try { return JSON.parse(JSON.stringify(v)) } catch (e) { return String(v) }
  }
  var send = function (level, args) {
    try {
      parent.postMessage({ __scrawlPreview: 1, level: level, args: args.map(safe) }, '*')
    } catch (e) { /* postMessage 不该炸掉页面自己的逻辑 */ }
  }
  ;['log', 'info', 'warn', 'error', 'debug'].forEach(function (m) {
    var orig = console[m]
    console[m] = function () {
      send(m, Array.prototype.slice.call(arguments))
      if (orig) orig.apply(console, arguments)
    }
  })
  window.addEventListener('error', function (e) {
    send('error', [(e.message || 'Error') + ' (' + (e.filename || '').split('/').pop() + ':' + e.lineno + ')'])
  })
  window.addEventListener('unhandledrejection', function (e) {
    send('error', ['Unhandled rejection: ' + ((e.reason && e.reason.message) || e.reason)])
  })
})()
</script>`

/** 注入桥接脚本，返回可作 srcDoc 的完整文档。无 <head> 的片段也能用（整体前置）。 */
export function renderPagePreview(html: string): string {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + BRIDGE)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + BRIDGE)
  return BRIDGE + html
}
