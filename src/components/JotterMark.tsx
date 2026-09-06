/*
  Jotter 自己的标记：一笔随手划出来的涂鸦。

  之前是一页折角的草稿纸加两行字和一根光标，三个元素在 16px 下糊成一团色块，
  折角页本身又是「文档」类图标的通用形状。现在只留一笔：像蜡笔在纸上划的一道波浪，
  说的是「随手记」，不端着，也不需要底板。

  三个细节：
  - 只有描边没有填充，线是渐变色，透出来的都是背后那层的颜色，深浅两套主题一份图形。
  - 渐变两端跟随配色（data-accent），见 index.css 的 --logo-hi / --logo-lo。
  - 几何数据与 public/favicon.svg 相同，favicon 的线加粗一档（16px 下才立得住），
    改一处要改两处 —— favicon 必须是静态文件，没法与这里共用同一份源码。

  与 GithubMark 一样是真 svg（不是图标插件那种 mask <span>），所以 shadcn 组件里的
  [&_svg] 规则对它有效。
*/
export function JotterMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={className}>
      <linearGradient id="jotter-mark" x1="7" y1="4" x2="25" y2="28" gradientUnits="userSpaceOnUse">
        <stop stopColor="var(--logo-hi)" />
        <stop offset="1" stopColor="var(--logo-lo)" />
      </linearGradient>
      <path
        fill="none"
        stroke="url(#jotter-mark)"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5.5 20c1.6-6.4 4.6-8 6.4-4 1.2 2.6-.8 6.6 1 4.4 2.4-3 4.6-6.6 6.8-3.4 1.4 2.2-.8 6.4 1.2 4.4 2-2 3.6-4.6 5.6-3.4"
      />
    </svg>
  )
}
