import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { GithubMark } from './GithubMark'
import { ScrawlMark } from './ScrawlMark'
import { SettingsDialog } from './SettingsDialog'
import { useI18n } from '@/i18n/context'
import { cn } from '@/lib/utils'

interface HeaderBarProps {
  /** 侧栏收起 / 展开。开关放顶栏最左、正压在侧栏上方：它管的是整个窗口的分栏，不是侧栏里的内容 */
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  /** 不支持目录 API 的浏览器上才显示「导入」按钮 */
  showImport: boolean
  onImport: () => void
}

/** 顶栏：侧栏开关、品牌、（可选的）导入、设置面板、GitHub 链接。 */
export function HeaderBar({ sidebarCollapsed, onToggleSidebar, showImport, onImport }: HeaderBarProps) {
  const { t } = useI18n()
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border)] bg-[var(--panel-bg)] px-3 py-3">
      <Button
        variant="ghost"
        size="icon-sm"
        title={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
        aria-label={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
        aria-expanded={!sidebarCollapsed}
        className="text-[var(--text-muted)]"
        onClick={onToggleSidebar}
      >
        <Icon
          className={cn(
            sidebarCollapsed ? 'icon-[lucide--panel-left-open]' : 'icon-[lucide--panel-left-close]',
            'rtl:-scale-x-100'
          )}
        />
      </Button>
      <div className="flex items-center gap-2 text-base font-semibold">
        <ScrawlMark className="size-5" />
        Scrawl
      </div>

      {/* 「新建」挪到文件栏的标题行上去了：它和那边的「新建文件 / 新建文件夹」是一类事，
          顶栏留给运行相关的东西。
          「导入」只在不支持目录 API 的浏览器上留着 —— 那里没有「打开文件夹」，
          这个隐藏的 <input type=file> 是唯一能读到本地文件的路（侧栏那段提示也指着它）。
          Chromium 上它是纯冗余：导进来的文件存不回原处，只能下载。 */}
      {showImport && (
        <>
          <div aria-hidden className="h-5 w-px shrink-0 bg-[var(--border)]" />
          <Button variant="ghost" size="sm" onClick={onImport}>
            <Icon className="icon-[lucide--upload]" />
            {t('header.import')}
          </Button>
        </>
      )}

      <div className="ms-auto flex items-center gap-2">
        {/* 语言 / 配色 / 明暗 / 编辑器选项全部收进一个「设置」面板，见 SettingsDialog */}
        <SettingsDialog />

        <Button
          asChild
          variant="ghost"
          size="icon-sm"
          className="text-[var(--text-muted)]"
          title={t('header.github')}
        >
          <a
            href="https://github.com/bohecola/scrawl"
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('header.github')}
          >
            <GithubMark className="size-[18px]" />
          </a>
        </Button>
      </div>
    </header>
  )
}
