/** 是否 macOS：决定快捷键的写法（⌘ 还是 Ctrl）和「回车改名」这类平台习惯。只在模块加载时判断一次。 */
export const isMac =
  typeof navigator !== 'undefined' &&
  /mac/i.test(
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
      navigator.platform ||
      navigator.userAgent
  )

/** 给按钮 title 用的快捷键写法 */
export const shortcut = {
  run: isMac ? '⌘↩' : 'Ctrl+Enter',
  stop: 'Shift+F5',
  save: isMac ? '⌘S' : 'Ctrl+S',
  // VS Code 桌面版是 ⌘W / Ctrl+W，但浏览器把它保留给「关闭浏览器标签页」，网页拦不住
  // （vscode.dev 也是同样的处境），所以用 Alt+W；Mac 上 Option+W 在编辑器里本身没有用途
  closeTab: isMac ? '⌥W' : 'Alt+W',
  // ⌘N / Ctrl+N 同样归浏览器（新窗口），和关闭一样落到 Alt 上
  newFile: isMac ? '⌥N' : 'Alt+N',
}

/** 当前文档是否从右往左（阿拉伯语）。分栏、标签栏、滚动条的左右方向都要跟着翻。 */
export const isRtl = () => document.documentElement.dir === 'rtl'
