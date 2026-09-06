# Jotter

> English | [中文](./README.zh-CN.md)

**Jotter** is an online scratchpad for running JavaScript and TypeScript code. Write a snippet, hit run, and see the console output immediately.

## Features

| Feature | Description |
| --- | --- |
| Instant execution | Code runs in a dedicated Web Worker, so the UI stays responsive; top-level `await` works and `while (true)` loops can be stopped with one click. |
| Monaco editor | The same editor that powers VS Code, with syntax highlighting, autocompletion, and TypeScript type checking; multiple tabs, with font size, editor theme, and file icons adjustable in settings. |
| Untitled files | Start writing without opening any folder: untitled files are kept in the browser and survive reloads; with a folder open, Ctrl+S names the file and saves it there. |
| Local file system | Open local folders (several at once) via the browser's File System Access API, browse the directory tree in the sidebar, edit/save/rename/delete files, and use relative `import`s between local files. |
| Built-in demos | A set of ready-to-run examples; save them all to a local folder with one click to modify. |
| Multilingual UI | 11 interface languages (including right-to-left layout for Arabic), following the system language by default and switchable in settings. |
| Themes | Dark / light following the system or set by hand, plus 7 accent colors. |

> Note: Jotter is a code scratchpad — it runs JavaScript / TypeScript and shows console output. It is **not** an HTML / CSS live preview tool.

## Tech Stack

React · TypeScript · Web Worker · Vite · Monaco Editor · shadcn/ui (Radix + Tailwind)

## Prerequisites

- [Node.js](https://nodejs.org/) (a recent LTS version is recommended)
- [pnpm](https://pnpm.io/) (pinned to `pnpm@10.20.0` via the repo's `packageManager` field)

## Install Dependencies

```sh
pnpm install
```

## Run Locally

```sh
pnpm dev
```

Then open the address printed in the terminal (default <http://localhost:5173/>) in your browser.

## Build & Check

```sh
pnpm build   # type-check + production build (output in dist/)
pnpm lint    # code linting (--max-warnings 0; any warning fails)
```

## Try It Online

Online playground: [playground.deore.me](https://playground.deore.me/)

![Jotter UI preview](/src/assets/imgs/preview.png?v=5)
