# Scrawl

> English | [中文](./README.zh-CN.md)

**Scrawl** is an online scratchpad for web code. Write a snippet of JavaScript or TypeScript, hit run, and see the console output immediately — or open an HTML file and watch the page render right beside the console.

## Features

| Feature | Description |
| --- | --- |
| Instant execution | Code runs in a dedicated Web Worker, so the UI stays responsive; top-level `await` works and `while (true)` loops can be stopped with one click. |
| HTML preview | HTML files render in a sandboxed iframe beside the console; the page's `console` output, warnings, and errors are captured into the same console. |
| Markdown preview | `.md` files render as styled documents next to the editor, following the app theme; edits refresh the preview automatically. |
| Monaco editor | The same editor that powers VS Code, with syntax highlighting, autocompletion, cross-file import suggestions, TypeScript type checking, and Emmet abbreviation expansion (`!`, `div.card>li*5`, `m10`…); multiple tabs, with font size, editor theme, and file icons adjustable in settings. |
| Untitled files | Start writing without opening any folder: untitled files are kept in the browser and survive reloads; with a folder open, Ctrl+S names the file and saves it there. |
| Local file system | Open local folders (several at once) via the browser's File System Access API, browse the directory tree in the sidebar, edit/save/rename/delete files, and use relative `import`s between local files. |
| Built-in demos | Ready-to-run examples live in the resources panel (top right); save them all to a local folder with one click to modify. |
| Multilingual UI | 12 interface languages (including right-to-left layout for Arabic), following the system language by default and switchable in settings. |
| Themes | Dark / light following the system or set by hand, plus 7 accent colors. |

> Note: The preview renders the opened HTML file in a sandboxed iframe — it is not a dev server: relative resources (linked stylesheets, scripts, images from other files) are not resolved yet.

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

![Scrawl UI preview](/src/assets/imgs/preview.png?v=6)
