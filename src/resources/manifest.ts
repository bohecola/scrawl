import { listTemplates } from '@/hooks'
import type { ParseKeys } from 'i18next'

/*
  资源面板的统一清单：内容增长只改这里 ——
  每类内容一个 src/resources/<分类>/ 目录 + 下面一段声明，弹窗自动长出新分类。

  「资源」是个容器词，示例、地图、Web3D 以后都往里放；具体性由下一层承担：
  分类名和每条一句话说明是界面文字，必须翻译（check-locales 会盯着）。
  条目名（title）和分组名（子目录名）是代码名，刻意不走 i18n —— promise-order 翻译了反而怪。
*/

export interface ResourceItem {
  /** 打开用的路径（= loadTemplate 的 glob key，如 `../resources/demos/overrides/call.js`） */
  id: string
  /** 展示名 */
  title: string
  /** 一句话说明的 i18n key，可选；缺失就不渲染 */
  descKey?: ParseKeys
}

export interface ResourceCategory {
  id: string
  /** 分类名的 i18n key */
  labelKey: ParseKeys
  items: ResourceItem[]
}

const DEMO_PREFIX = '../resources/demos/'

// 每个 demo 的一句话说明。键是分类目录下的相对路径；新加文件没写说明也能列出来，只是少一行
const DEMO_DESC: Record<string, ParseKeys> = {
  'other/bst.js': 'resources.demos.bst',
  'overrides/apply.js': 'resources.demos.apply',
  'overrides/bind.js': 'resources.demos.bind',
  'overrides/call.js': 'resources.demos.call',
  'overrides/promise-order.js': 'resources.demos.promiseOrder',
  'overrides/setInterval.js': 'resources.demos.setInterval',
  'utils/index.js': 'resources.demos.index',
  'utils/perf.js': 'resources.demos.perf',
  'utils/sort.js': 'resources.demos.sort',
}

// Demo 条目从 glob 派生：文件名（含后缀）当标题 —— 后缀也是信息，
// promise-order.js 和 .ts 是两个东西。以后加「地图」「Web3D」等分类时
// 各自建 src/resources/<分类>/ 目录、再声明一段即可
const demoItems: ResourceItem[] = listTemplates()
  .filter((path) => path.startsWith(DEMO_PREFIX))
  .map((path) => ({
    id: path,
    title: path.split('/').pop()!,
    descKey: DEMO_DESC[path.slice(DEMO_PREFIX.length)],
  }))

export const RESOURCE_CATEGORIES: readonly ResourceCategory[] = [
  {
    id: 'demos',
    labelKey: 'resources.cat.demos',
    items: demoItems,
  },
]
