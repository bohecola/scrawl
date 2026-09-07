/*
  从 iconify 的图标包里抽出各文件图标主题用到的图标，生成 src/icon-themes/sets/<id>.json。

  整包（material 约 900 KB、vscode-icons 约 3.7 MB）不能直接打进产物，所以按主题规则表
  只取用到的几十个，运行时按主题懒加载。规则表就是 src/icon-themes/<id>.ts 里的 rules，
  这里 import 它（Node ≥ 22.6 带 --experimental-strip-types 可直接跑 .ts）。
  规则里写错的图标名在这里报错，而不是等到界面上出现空白。

  用法：pnpm icons:build。改了规则表要重新跑，生成的 JSON 进仓库。
*/
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { getIconData, iconToSVG } from '@iconify/utils'

const require = createRequire(import.meta.url)
const OUT = new URL('../src/icon-themes/sets/', import.meta.url)

/*
  Material 的「默认目录」那两张图不在 @iconify-json/material-icon-theme 里。

  上游 icons/folder.svg 是要按 material-icon-theme.folders.color 重新上色的那一张，
  iconify 的导入没把这类图收进来（folder-root 同理，但它形状完全不同，补不出来）。
  好在它和包里有的 folder-base 是同一条路径，差别只有两点：去掉那块浅色 motive、
  底色换成那个设置项的默认值。这里就照这层关系推出来 —— 形状始终跟着包走，
  不在仓库里另存一份迟早会过期的 SVG。取值都对着上游 5.38.1 核过。
*/
const MATERIAL_FOLDER = {
  /** material-icon-theme.folders.color 的默认值（blue grey 300），就是 VS Code 里那个灰 */
  color: '#90a4ae',
  /** folder-base 的底色 */
  base: '#8d6e63',
  /** folder-base 上那块浅色装饰，默认目录没有 */
  motive: '#d7ccc8',
}

/** folder-base → 默认目录。形状不对（不是「一条底色路径 + 一条 motive」）就返回 null，让生成失败 */
function plainFolder(icon) {
  const paths = icon.body.match(/<path[^>]*\/>/g) ?? []
  const solid = paths.filter((path) => path.includes(MATERIAL_FOLDER.base))
  const motive = paths.filter((path) => path.includes(MATERIAL_FOLDER.motive))
  if (paths.length !== 2 || solid.length !== 1 || motive.length !== 1) return null
  return { body: solid[0].replace(MATERIAL_FOLDER.base, MATERIAL_FOLDER.color), viewBox: icon.viewBox }
}

const THEMES = [
  {
    id: 'material',
    pkg: '@iconify-json/material-icon-theme',
    mod: '../src/icon-themes/material.ts',
    name: 'material',
    /** 包里没有、要从别的图标推出来的：图标名 → [来源图标, 变换] */
    derive: { folder: ['folder-base', plainFolder], 'folder-open': ['folder-base-open', plainFolder] },
  },
  { id: 'vscode-icons', pkg: '@iconify-json/vscode-icons', mod: '../src/icon-themes/vscode-icons.ts', name: 'vscodeIcons' },
]

function iconNames(rules) {
  const names = new Set()
  const add = (v) => v && names.add(v)
  add(rules.file); add(rules.folder); add(rules.folderExpanded); add(rules.rootFolder); add(rules.rootFolderExpanded)
  for (const map of [rules.fileNames, rules.fileExtensions, rules.languageIds, rules.folderNames, rules.folderNamesExpanded]) {
    for (const v of Object.values(map ?? {})) add(v)
  }
  return [...names].sort()
}

mkdirSync(OUT, { recursive: true })
let failed = false
for (const theme of THEMES) {
  const { [theme.name]: meta } = await import(theme.mod)
  const set = require(`${theme.pkg}/icons.json`)
  const out = {}
  const missing = []
  const fromPkg = (name) => {
    const data = getIconData(set, name)
    if (!data) return null
    // iconToSVG 会把 left/top/width/height 和 rotate/flip 都折算进 viewBox / body
    // （Material 里有些图标是 Material Symbols 的 0 -960 960 960 坐标系，光有 width/height 画不出来）
    const svg = iconToSVG(data)
    return { body: svg.body, viewBox: svg.attributes.viewBox }
  }
  for (const name of iconNames(meta.rules)) {
    // 推出来的那几个下面单独处理，别在包里白找一遍
    if (theme.derive?.[name]) continue
    const icon = fromPkg(name)
    if (!icon) { missing.push(name); continue }
    out[name] = icon
  }
  for (const [name, [from, transform]] of Object.entries(theme.derive ?? {})) {
    const src = fromPkg(from)
    const icon = src && transform(src)
    // 源图标没了、或者形状变得对不上，都要停在这里：静悄悄少一个图标，
    // 界面上就是一格空白，比生成失败难查得多
    if (!icon) { missing.push(`${name} (由 ${from} 推出)`); continue }
    out[name] = icon
  }
  if (missing.length) {
    failed = true
    console.error(`${theme.id}: ${missing.length} icon(s) not in ${theme.pkg}:\n  ${missing.join('\n  ')}`)
    continue
  }
  const json = JSON.stringify(out, null, 2) + '\n'
  writeFileSync(new URL(`${theme.id}.json`, OUT), json)
  console.log(`${theme.id}: ${Object.keys(out).length} icons, ${(json.length / 1024).toFixed(1)} KB (${set.info?.license?.title ?? 'license?'})`)
}
if (failed) process.exit(1)
