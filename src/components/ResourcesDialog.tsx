import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
  dialogCloseButtonClass,
} from '@/components/ui/dialog'
import { RESOURCE_CATEGORIES } from '@/resources/manifest'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n/context'
import { cn } from '@/lib/utils'

/*
  资源面板：内置内容（现在是 Demo 片段，以后还有地图 / Web3D / 面试题…）的统一入口。
  双栏布局照 SettingsDialog：左栏分类导航、右栏内容。现在只有一个分类，左栏照样渲染 ——
  它交代的是「这里以后不止一类」，也是新分类出现时的既定位置。

  内容清单在 src/resources/manifest.ts：加一类新内容 = 建目录 + 清单加一段，
  这里不用动。「资源」是个泛词，具体性由分类名和每条一句话说明承担；
  分组沿用子目录名（代码名，不翻译），条目是文件名 + 一句话说明。

  展开方式与 VS Code 的 emmet 建议一致：点条目 = DialogClose 包住的按钮，
  先关弹窗再打开文件，避免弹窗动画和标签切换抢焦点。

  open 状态由 App 持有：顶栏按钮之外，欢迎页也有一个「浏览资源」入口。
*/

export interface ResourcesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenTemplate: (path: string) => void
  /** 「把全部 Demo 存到本地文件夹」。选文件夹、落盘、接管成根都在 App 那边 */
  onSaveDemos: () => void
  /** 写入进行中时点「取消」：停止写入并清理已写残留 */
  onCancelSave: () => void
  /** 是否正在执行取消（点了确认、在清理残留），用于把取消按钮置灰防重复 */
  cancelling: boolean
  /** 正在把 Demo 存到本地的写入进度（文件级 + 字节级）；null 表示当前没有正在进行的保存 */
  saveProgress: {
    file: string
    doneFiles: number
    totalFiles: number
    writtenBytes: number
    totalBytes: number
  } | null
}

export function ResourcesDialog({
  open,
  onOpenChange,
  onOpenTemplate,
  onSaveDemos,
  onCancelSave,
  cancelling,
  saveProgress,
}: ResourcesDialogProps) {
  const { t } = useI18n()
  const [catId, setCatId] = useState(() => RESOURCE_CATEGORIES[0]!.id)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  // 折叠的分组（key = 分类/分组名）。默认全展开：现在的量级一屏能看全，
  // 折叠是为将来的大分类预备的导航手段
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const searching = query.trim() !== ''

  const cat = RESOURCE_CATEGORIES.find((c) => c.id === catId) ?? RESOURCE_CATEGORIES[0]!
  // 大小写不敏感地过滤标题和说明：条目名是代码名（promise-order），
  // 用户更可能搜的是说明里的词（「防抖」「排序」）
  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return cat.items
    return cat.items.filter(
      (x) => x.title.toLowerCase().includes(q) || (x.descKey && t(x.descKey).toLowerCase().includes(q))
    )
  }, [cat, query, t])

  // 条目按子目录分组：路径 ../resources/<分类>/<子目录…>/<文件名> 中间的子目录段就是分组，
  // 直接放在分类根下的条目归到无标题组。按首次出现的顺序收集，搜索过滤后空组自然消失
  const groups = useMemo(() => {
    const byGroup = new Map<string | null, typeof cat.items>()
    for (const item of items) {
      const rest = item.id.replace(`../resources/${cat.id}/`, '')
      const parts = rest.split('/')
      const g = parts.length > 1 ? parts.slice(0, -1).join('/') : null
      if (!byGroup.has(g)) byGroup.set(g, [])
      byGroup.get(g)!.push(item)
    }
    // 无标题组排最前，免得夹在两组中间显得错位
    return [...byGroup.entries()].sort(([a], [b]) => {
      if (a === b) return 0
      if (a === null) return -1
      if (b === null) return 1
      return 0
    })
  }, [cat, items])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('resources.title')}
          aria-label={t('resources.title')}
          className="text-[var(--text-muted)] data-[state=open]:bg-[var(--panel-hover)] data-[state=open]:text-[var(--text-primary)]"
        >
          <Icon className="icon-[lucide--shapes]" />
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        // 打开就能直接打字搜：默认焦点会落在标题栏的 ×，改成落到搜索框
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          searchRef.current?.focus()
        }}
        className="h-[min(560px,calc(100vh-4rem))] sm:max-w-3xl sm:flex-row"
      >
        {/* 左栏：标题 + 分类导航。现在只有一个分类，结构按多分类写 —— 这是本面板存在的意义 */}
        <nav className="flex shrink-0 flex-col gap-3 border-b border-[var(--border)] bg-[var(--panel-bg)] p-3 sm:w-44 sm:border-e sm:border-b-0 sm:p-4">
          {/* 「内置资源只读」的说明收进标题旁的 tip 图标：每个条目旁都印一遍太吵，
              藏在Tooltip 里又没人发现，标题旁是最顺理成章的位置 */}
          <h2 className="flex items-center gap-1 px-2 text-sm font-semibold text-[var(--text-primary)]">
            {t('resources.title')}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('resources.builtinHint')}
                    className="flex size-4 shrink-0 items-center justify-center text-[var(--text-faint)] transition-colors hover:text-[var(--text-body)]"
                  >
                    <Icon className="icon-[lucide--circle-help] size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-56" side="right">
                  {t('resources.builtinHint')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </h2>
          {RESOURCE_CATEGORIES.map((c) => {
            const on = c.id === catId
            return (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => {
                  setCatId(c.id)
                  setQuery('')
                }}
                className={cn(
                  'flex h-8 items-center rounded-md px-2 text-[13px] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  on
                    ? 'bg-[var(--list-active)] text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--text-body)]'
                )}
              >
                {t(c.labelKey)}
              </button>
            )
          })}
        </nav>

        {/* 右栏：固定的标题栏（分类名 + ×）+ 搜索 + 条目列表 + 底栏（存到本地） */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] ps-6 pe-3">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t(cat.labelKey)}</h2>
            <DialogClose
              aria-label={t('settings.close')}
              title={t('settings.close')}
              className={dialogCloseButtonClass}
            >
              <Icon className="icon-[lucide--x] size-4" />
            </DialogClose>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-6 py-2.5">
              <div className="relative min-w-0 flex-1">
                <Icon className="icon-[lucide--search] pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--text-faint)]" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('resources.search')}
                  aria-label={t('resources.search')}
                  className="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--panel-bg)] ps-8 pe-2.5 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--primary)]/60"
                />
              </div>
              {/* 「存到本地文件夹」是要落盘写文件的重操作：图标 + tooltip 而不是文字大按钮。
                  这些 Demo 打开后改得动，但存不回去（它们是打包进来的字符串，不是磁盘上的文件）；
                  存到本地文件夹之后就是普通的本地文件了，改完 Ctrl+S 直接写回。
                  只在 demos 分类显示：别的分类（未来的地图 / Web3D）未必有「存走一份」的语义 */}
              {cat.id === 'demos' && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0 text-[var(--text-muted)]"
                        onClick={onSaveDemos}
                        // 正在写入时禁用：重复触发会并发写、弹多个确认框、生成重复目录
                        disabled={saveProgress !== null}
                        aria-label={t('sidebar.saveDemos')}
                      >
                        <Icon className="icon-[codicon--desktop-download]" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {t('sidebar.saveDemos')}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>

            {/* 刻意没有 pt-：组标题 sticky top-0 吸在滚动容器顶端，顶部留了 padding 的话，
                滚出去的条目会从标题上方的缝隙里露出来（试过就这样坏的） */}
            <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
              {items.length === 0 ? (
                <p className="px-3 py-6 text-center text-[13px] text-[var(--text-faint)]">
                  {t('resources.noMatch')}
                </p>
              ) : (
                // 分组渲染：组标题可折叠、吸顶（滚动时贴在面板顶部），沿用目录树的 twistie 交互。
                // 无标题组（直接放在分类根下的文件）没有可折叠的标题，永远展开
                groups.map(([group, groupItems]) => {
                  const folded = !searching && group !== null && collapsed.has(`${cat.id}/${group}`)
                  return (
                    <div key={group ?? '_root'} className="mb-1.5">
                      {group !== null && (
                        <button
                          type="button"
                          aria-expanded={!folded}
                          onClick={() =>
                            setCollapsed((prev) => {
                              const key = `${cat.id}/${group}`
                              const next = new Set(prev)
                              if (next.has(key)) next.delete(key)
                              else next.add(key)
                              return next
                            })
                          }
                          className="sticky top-0 z-10 flex w-full cursor-pointer items-center gap-1 bg-[var(--panel-bg)] px-2 pb-1 pt-2 font-mono text-[12px] text-[var(--text-muted)] hover:text-[var(--text-body)]"
                        >
                          <span className="flex shrink-0 items-center [&>[data-slot=icon]]:size-3">
                            <Icon
                              className={cn(
                                'icon-[lucide--chevron-right] transition-transform duration-100',
                                folded ? '[&:dir(rtl)]:rotate-180' : 'rotate-90'
                              )}
                            />
                          </span>
                          {group}
                        </button>
                      )}
                      {!folded && (
                        // 有分组标题的条目缩进一级（对齐到标题文字，越过 twistie 那一列），
                        // 无标题组的条目顶格 —— 没有可对齐的父级
                        <ul className={cn('flex flex-col gap-0.5', group !== null && 'ps-3')}>
                          {groupItems.map((item) => (
                            <li key={item.id}>
                              <DialogClose asChild>
                                <button
                                  type="button"
                                  onClick={() => onOpenTemplate(item.id)}
                                  className="flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-start transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 hover:bg-[var(--panel-hover)]"
                                >
                                  <span className="font-mono text-[13px] text-[var(--text-body)]">{item.title}</span>
                                  {item.descKey && (
                                    <span className="text-[12px] leading-snug text-[var(--text-faint)]">
                                      {t(item.descKey)}
                                    </span>
                                  )}
                                </button>
                              </DialogClose>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )
                })
              )}
            </div>

            {/* 底栏只在写入进行中出现：进度条 + 取消，固定在这里不随列表滚走。
                入口按钮在搜索栏旁（见上），不写进度时这一栏整个不占高度 */}
            {cat.id === 'demos' && saveProgress && (
              <div className="flex shrink-0 items-center gap-3 border-t border-[var(--border)] bg-[var(--panel-bg)] px-6 py-2.5">
                <SmoothProgressBar
                  value={
                    saveProgress.totalBytes > 0
                      ? (saveProgress.writtenBytes / saveProgress.totalBytes) * 100
                      : 0
                  }
                />
                <span className="shrink-0 text-[12px] leading-snug text-[var(--text-faint)]">
                  {saveProgress.file
                    ? t('sidebar.savingDemosFile', {
                        name: saveProgress.file.slice(saveProgress.file.lastIndexOf('/') + 1),
                        done: saveProgress.doneFiles,
                        total: saveProgress.totalFiles,
                      })
                    : t('sidebar.savingDemos', {
                        done: saveProgress.doneFiles,
                        total: saveProgress.totalFiles,
                      })}
                </span>
                <button
                  type="button"
                  onClick={onCancelSave}
                  disabled={cancelling}
                  title={cancelling ? t('sidebar.cancellingSave') : t('sidebar.cancelSave')}
                  aria-label={cancelling ? t('sidebar.cancellingSave') : t('sidebar.cancelSave')}
                  className="flex shrink-0 items-center gap-0.5 text-[var(--text-muted)] hover:text-[var(--text-body)] disabled:pointer-events-none disabled:opacity-60"
                >
                  <Icon
                    className={`size-3.5 ${cancelling ? 'icon-[lucide--loader-circle] animate-spin' : 'icon-[lucide--x]'}`}
                  />
                  {cancelling && (
                    <span className="text-[11px] text-[var(--text-faint)]">{t('sidebar.cancellingSave')}</span>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/*
  平滑进度条：rAF 每帧最多推进 SPEED 个百分点，太快不「平滑」，太慢显得拖。
*/
function SmoothProgressBar({ value }: { value: number }) {
  const [shown, setShown] = useState(0)
  const shownRef = useRef(0)
  const SPEED = 1.2

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const cur = shownRef.current
      if (Math.abs(value - cur) < 0.01) {
        shownRef.current = value
        setShown(value)
        return
      }
      const next = cur < value ? Math.min(cur + SPEED, value) : Math.max(cur - SPEED, value)
      shownRef.current = next
      setShown(next)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])

  return (
    <>
      <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--panel-hover)]">
        <div className="h-full bg-[var(--primary)]/70" style={{ width: `${shown}%` }} />
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-faint)]">
        {Math.round(shown)}%
      </span>
    </>
  )
}
