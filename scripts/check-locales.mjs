/*
  校验 src/locales/*.json（docs/i18n-migration-plan.md §7）。纯 Node，无依赖。

  对每个语言文件检查（任何一项失败以非零码退出）：
  1. 多余键：不在 en.json 里的键（复数 / 上下文后缀去掉后比较）
  2. 缺失键：只打印数量汇总，不算错误（缺的键运行时回退英文）；
     zh-CN.json 例外 —— 它和英文一样要求完整
  3. 插值变量一致：每条文案 {{name}} / {{name, fmt}} 的变量集合必须和
     en.json 同一键（或同一基键）相同
  4. 复数类别齐全：en.json 里有 _other 后缀的基键，该语言必须提供
     Intl.PluralRules(tag) 的每一个类别
  5. 上下文键：en.json 里带 _file / _directory 后缀的基键，该语言若翻了基键，
     也必须翻齐全部后缀键
  6. 空字符串
  7. JSON 合法且顶层是扁平对象（值全是字符串）
  8. 键顺序和 en.json 不一致 → 警告（不退出非零）

  最后再扫一遍 src/ 下的调用点（第 9 项）：
  9. t('键', { ... }) 传的参数要和 en.json 里那条文案的 {{占位符}} 对得上

  第 9 项补的是前 8 项和类型系统都够不着的那个洞（见 i18n/i18next.d.ts 的注释）：
  键名写错有 CustomTypeOptions 兜着，各语言之间不一致有第 3 项兜着，
  但「键还在、11 种语言也都一致，只是调用方传的参数换了一个名字」谁都看不见。
  真出过一次：file.untitled 从 Untitled.{{ext}} 被改成标签用的 Untitled-{{n}}，
  useFileDraft 那个调用点没跟着改，界面上就原样显示出了「未命名-{{n}}」。
*/
import { readFileSync, readdirSync } from 'node:fs'
import { join, basename, extname } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const LOCALES = join(ROOT, 'src', 'locales')

// 所有 CLDR 复数类别 + 本项目用到的上下文后缀（fs-access.ts 里 kind 的取值）
const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other']
const CONTEXT_SUFFIXES = ['file', 'directory']
const STRIPPABLE = [...PLURAL_CATEGORIES, ...CONTEXT_SUFFIXES]

const stripSuffix = (key) => {
  for (const suffix of STRIPPABLE) {
    if (key.endsWith(`_${suffix}`)) return key.slice(0, -(suffix.length + 1))
  }
  return key
}

const readJson = (file) => {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`JSON 无效：${err.message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('顶层必须是对象')
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') throw new Error(`键 ${k} 的值不是字符串（必须保持扁平）`)
  }
  return parsed
}

// {{name}} / {{name, fmt}} → 变量名集合
const interpVars = (text) => {
  const vars = new Set()
  for (const m of text.matchAll(/\{\{([^}]+)\}\}/g)) {
    vars.add(m[1].split(',')[0].trim())
  }
  return vars
}

const en = readJson(join(LOCALES, 'en.json'))
const enKeys = Object.keys(en)
const enBases = new Set(enKeys.map(stripSuffix))
// 每个基键在 en.json 里的变量并集（语言缺某个具体后缀键时按基键比对）
const enVarsByBase = new Map()
for (const [key, text] of Object.entries(en)) {
  const base = stripSuffix(key)
  for (const v of interpVars(text)) {
    if (!enVarsByBase.has(base)) enVarsByBase.set(base, new Set())
    enVarsByBase.get(base).add(v)
  }
}
// en.json 里的复数基键与上下文基键
const enPluralBases = new Set(enKeys.filter((k) => PLURAL_CATEGORIES.some((c) => k.endsWith(`_${c}`))).map(stripSuffix))
const enContextBases = new Map() // base -> [suffix...]
for (const key of enKeys) {
  for (const suffix of CONTEXT_SUFFIXES) {
    if (key.endsWith(`_${suffix}`)) {
      const base = stripSuffix(key)
      if (!enContextBases.has(base)) enContextBases.set(base, [])
      enContextBases.get(base).push(suffix)
    }
  }
}

// en 的键序（去重后的基键序列），供第 8 项比对
const dedup = (arr) => [...new Set(arr)]
const enOrder = dedup(enKeys.map(stripSuffix))

let failed = false
const fail = (file, msg) => {
  failed = true
  console.error(`  ✗ ${msg}`)
}

for (const file of readdirSync(LOCALES)) {
  if (!file.endsWith('.json')) continue
  const tag = basename(file, '.json')
  if (tag === 'en') continue // en.json 是基准，不查它自己

  console.log(`src/locales/${file}`)
  let dict
  try {
    dict = readJson(join(LOCALES, file))
  } catch (err) {
    fail(file, err.message)
    continue
  }
  const keys = Object.keys(dict)

  // 1. 多余键
  for (const key of keys) {
    if (key in en) continue
    if (enBases.has(stripSuffix(key))) continue
    fail(file, `多余键：${key}`)
  }

  // 2. 缺失键
  const bases = new Set(keys.map(stripSuffix))
  const missing = [...enBases].filter((base) => !bases.has(base))
  if (missing.length > 0) {
    if (tag === 'zh-CN') fail(file, `缺失键（zh-CN 要求完整）：${missing.join(', ')}`)
    else console.log(`  · 缺 ${missing.length} 条（回退英文）：${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' …' : ''}`)
  }

  // 3. 插值变量一致
  for (const [key, text] of Object.entries(dict)) {
    const vars = interpVars(text)
    const expected = key in en ? interpVars(en[key]) : enVarsByBase.get(stripSuffix(key))
    if (!expected) continue // 多余键已在第 1 项报过
    const missingVar = [...expected].filter((v) => !vars.has(v))
    const extraVar = [...vars].filter((v) => !expected.has(v))
    if (missingVar.length > 0 || extraVar.length > 0) {
      fail(file, `插值变量不一致：${key}（缺 ${missingVar.join(', ') || '—'}，多 ${extraVar.join(', ') || '—'}）`)
    }
  }

  // 4. 复数类别齐全
  const categories = new Intl.PluralRules(tag).resolvedOptions().pluralCategories
  for (const base of enPluralBases) {
    for (const category of categories) {
      if (!(`${base}_${category}` in dict)) {
        fail(file, `复数类别缺失：${base}_${category}（${tag} 需要 ${categories.join(' / ')}）`)
      }
    }
  }

  // 5. 上下文键
  for (const [base, suffixes] of enContextBases) {
    if (base in dict) {
      for (const suffix of suffixes) {
        if (!(`${base}_${suffix}` in dict)) fail(file, `上下文键缺失：${base}_${suffix}（基键已翻译）`)
      }
    }
  }

  // 6. 空字符串
  for (const [key, text] of Object.entries(dict)) {
    if (text.trim() === '') fail(file, `空字符串：${key}`)
  }

  // 8. 键顺序（警告）
  if (dedup(keys.map(stripSuffix)).join('\n') !== enOrder.join('\n')) {
    console.log(`  ⚠ 键顺序与 en.json 不一致（建议修正，方便 diff）`)
  }
}

// ---- 9. 调用点参数 ----

/* i18next 自己认的参数名，任何键都可以传，不算「多余」 */
const RESERVED = new Set([
  'count', 'context', 'lng', 'lngs', 'ns', 'defaultValue', 'replace',
  'returnObjects', 'interpolation', 'formatParams', 'ordinal',
])

/*
  从 `{ a, b: expr, 'c': x }` 里取出顶层属性名。
  只认字面量对象：带 ... 展开、或者压根不是 `{` 开头（参数是个变量）的调用一律跳过 ——
  这个检查宁可漏报也不能误报，误报会让 pnpm lint 变成需要绕开的东西。
  返回 null 表示「这处看不懂，跳过」。
*/
function objectKeys(src) {
  const keys = []
  let depth = 0
  let start = 1 // 跳过开头的 {
  let quote = null
  const segments = []
  for (let i = 1; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{' || c === '[' || c === '(') { depth++; continue }
    if (c === '}' && depth === 0) { segments.push(src.slice(start, i)); break }
    if (c === '}' || c === ']' || c === ')') { depth--; continue }
    if (c === ',' && depth === 0) { segments.push(src.slice(start, i)); start = i + 1 }
  }
  for (const seg of segments) {
    const text = seg.trim()
    if (text === '') continue
    if (text.startsWith('...')) return null // 展开进来的参数，看不出有哪些
    // `名字:`、`'名字':` 或者简写 `名字`
    const m = /^(?:'([^']+)'|"([^"]+)"|\[[^\]]+\]|([A-Za-z_$][\w$]*))\s*(:|$)/.exec(text)
    if (!m) return null
    if (m[3] === undefined && m[1] === undefined && m[2] === undefined) return null // 计算属性名
    keys.push(m[1] ?? m[2] ?? m[3])
  }
  return keys
}

/** 从 `t('键'` 那个位置起，把紧跟其后的字面量对象整段切出来；没有第二个参数返回 undefined */
function secondArg(src, from) {
  let i = from
  while (i < src.length && /\s/.test(src[i])) i++
  if (src[i] !== ',') return undefined // 只有键，没参数
  i++
  while (i < src.length && /\s/.test(src[i])) i++
  if (src[i] !== '{') return null // 参数不是字面量对象（变量 / 展开），跳过
  let depth = 0
  let quote = null
  for (let j = i; j < src.length; j++) {
    const c = src[j]
    if (quote) {
      if (c === '\\') j++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return src.slice(i, j + 1)
  }
  return null // 括号没配平，交给 tsc 去骂
}

const sources = []
;(function walk(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name)
    if (name.isDirectory()) walk(full)
    else if (['.ts', '.tsx'].includes(extname(name.name))) sources.push(full)
  }
})(join(ROOT, 'src'))

console.log('\n调用点参数（src/**/*.ts(x)）')
let checked = 0
let skipped = 0
for (const file of sources) {
  const src = readFileSync(file, 'utf8')
  const rel = file.slice(ROOT.length)
  // \bt( 同时覆盖 t('…') 和 i18n.t('…')；translate( / at( 这类不会命中（t 后面不是括号）
  for (const m of src.matchAll(/\bt\(\s*'([^']*)'/g)) {
    const key = m[1]
    const expected = key in en ? interpVars(en[key]) : enVarsByBase.get(stripSuffix(key))
    if (!expected) {
      // 键名本身错了。tsc 一般先一步报出来，但动态拼出来的键它管不着
      fail(rel, `${rel}: t('${key}') 的键不在 en.json 里`)
      continue
    }
    const arg = secondArg(src, m.index + m[0].length)
    const passed = arg === undefined ? [] : arg === null ? null : objectKeys(arg)
    if (passed === null) { skipped++; continue }
    checked++
    const missingVar = [...expected].filter((v) => !passed.includes(v))
    const extraVar = passed.filter((v) => !expected.has(v) && !RESERVED.has(v))
    if (missingVar.length > 0 || extraVar.length > 0) {
      fail(rel, `${rel}: t('${key}') 参数对不上文案 ${JSON.stringify(en[key] ?? '(按基键比对)')}` +
        `（缺 ${missingVar.join(', ') || '—'}，多 ${extraVar.join(', ') || '—'}）`)
    }
  }
}
console.log(`  · 查了 ${checked} 处，跳过 ${skipped} 处（参数不是字面量对象）`)

if (failed) {
  console.error('\ni18n:check 未通过')
  process.exit(1)
}
console.log('\nlocales 校验通过')
