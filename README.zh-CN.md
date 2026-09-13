# Scrawl

> [English](./README.md) | 中文

**Scrawl** 是一张写给网页代码的在线草稿纸。写一段 JavaScript 或 TypeScript，点一下运行，立刻在右侧 Console 看到输出；打开 HTML 文件，页面就在 Console 旁边渲染出来。

## 特性

| 特性 | 说明 |
| --- | --- |
| 即时运行 | 代码跑在独立 Web Worker 里，不卡界面；支持顶层 `await`，`while (true)` 也能一键终止。 |
| HTML 预览 | HTML 文件在沙箱 iframe 里渲染，页面里的 `console` 输出、警告和错误会收进同一个 Console。 |
| Markdown 预览 | `.md` 文件在编辑器旁边渲染成排版好的文档，外观跟随应用主题；编辑停手即自动刷新。 |
| Monaco 编辑器 | VS Code 同款编辑器，带语法高亮、自动补全和 TypeScript 类型检查；多标签页，字号、编辑器主题、文件图标都可在设置里调。 |
| 未命名文件 | 不打开任何文件夹也能直接写：未命名文件存在浏览器本地，刷新不丢；开着文件夹时按 Ctrl+S 起个名字就存进去。 |
| 本地文件系统 | 通过浏览器文件系统 API 打开本地文件夹（可同时打开多个），在侧边栏里浏览目录树，编辑、保存、重命名、删除文件，本地文件之间支持相对路径 `import`。 |
| 内置 Demo | 自带一组可直接运行的示例片段，可一键存到本地再改。 |
| 多语言 | 界面提供 12 种语言（含阿拉伯语的从右到左布局），默认跟随系统，在设置里切换。 |
| 主题 | 深色 / 浅色跟随系统或手动指定，另有 7 种配色可选。 |

> 说明：预览是在沙箱 iframe 里渲染你打开的那个 HTML 文件——它不是开发服务器：引用其它文件的相对路径资源（样式表、脚本、图片）目前还不会解析。

## 技术栈

React · TypeScript · Web Worker · Vite · Monaco Editor · shadcn/ui（Radix + Tailwind）

## 环境要求

- [Node.js](https://nodejs.org/)（推荐使用较新的 LTS 版本）
- [pnpm](https://pnpm.io/)（本仓库通过 `packageManager` 固定为 `pnpm@10.20.0`）

## 安装依赖

```sh
pnpm install
```

## 本地运行

```sh
pnpm dev
```

然后在浏览器中打开终端输出的地址（默认 <http://localhost:5173/>）。

## 构建与检查

```sh
pnpm build   # 类型检查 + 生产构建（产物在 dist/）
pnpm lint    # 代码检查（--max-warnings 0，任何告警都会失败）
```

## 在线体验

在线地址：[playground.deore.me](https://playground.deore.me/)

![Scrawl 界面预览](/src/assets/imgs/preview.png?v=6)
