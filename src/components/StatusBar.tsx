import { Icon } from '@/components/ui/icon'
import { useI18n } from '@/i18n/context'
import type { CursorStatus } from './Editor'
import type { ActiveFile } from '@/types'

interface StatusBarProps {
  active: ActiveFile | null
  cursor: CursorStatus | null
  language: string
  /** 把 local 路径里的根 id 换成目录名（useWorkspace.displayPath） */
  displayPath: (path: string) => string
  /** 一次性反馈（已保存 / 已重命名…），由 useNotice 在两秒多后清掉。放状态栏而不是顶部提示条：不占布局，不会推动编辑器 */
  message?: string | null
}

/**
 * 底部状态栏：左侧「目录 / 文件名」一段横排，目录和文件名同色（faint 淡灰），
 * 只靠顺序与省略号传达层级，不抢注意力；右侧从左到右依次是光标 Ln, Col、缩进
 * （Spaces / Tab Size）、编码（本地文件按 BOM 推断）、换行符（LF / CRLF）和语言
 * （跟随后缀自动判断），同 VS Code 右下角。
 */
export function StatusBar({ active, cursor, language, displayPath, message }: StatusBarProps) {
  const { t } = useI18n()
  // 底部状态栏左侧要展示「目录 + 文件名」，像 VS Code 那样一条横排、目录淡色文件名高亮。
  // 只有 local（key=local:<相对根路径>）与 builtin（name 本身就是它相对 demo 根的子路径，
  // 例如 overrides/promise-order.js）带目录可拆；导入 / 未命名没有目录归属，只显示裸名。
  const footerLoc =
    active == null
      ? null
      : (() => {
          const logical =
            active.kind === 'local'
              ? displayPath(active.key.slice('local:'.length))
              : active.name
          const i = logical.lastIndexOf('/')
          return i === -1
            ? { dir: '', file: logical }
            : { dir: logical.slice(0, i), file: logical.slice(i + 1) }
        })()

  return (
    <footer className="flex h-[26px] shrink-0 items-center gap-3 border-t border-[var(--border)] bg-[var(--panel-bg)] px-4 py-1 text-[11px] text-[var(--text-faint)]">
      <span className="flex min-w-0 flex-1 items-center">
        {footerLoc ? (
          <>
            {footerLoc.dir ? (
              <span
                className="min-w-0 truncate"
                title={`${footerLoc.dir}/${footerLoc.file}`}
              >
                {footerLoc.dir}/
              </span>
            ) : null}
            <span className="shrink-0">{footerLoc.file}</span>
          </>
        ) : (
          <span className="truncate">{t('statusbar.noFile')}</span>
        )}
        {message && (
          <span
            role="status"
            aria-live="polite"
            className="ms-3 flex shrink-0 items-center gap-1 text-[var(--text-muted)]"
          >
            <Icon className="icon-[lucide--check] size-3" />
            {message}
          </span>
        )}
      </span>
      {active && cursor?.position && (
        <span className="shrink-0">
          {t('statusbar.ln', {
            line: cursor.position.line,
            col: cursor.position.column,
          })}
        </span>
      )}
      {active && cursor && (
        <span className="shrink-0">
          {cursor.useTabs
            ? t('statusbar.tabSize', { size: cursor.indentSize })
            : t('statusbar.spaces', { size: cursor.indentSize })}
        </span>
      )}
      {active && (
        <>
          <span className="shrink-0" title={active.encoding}>
            {active.encoding}
          </span>
          <span aria-hidden className="h-2.5 w-px shrink-0 bg-[var(--border)]" />
          <span className="shrink-0">{cursor?.eol ?? 'LF'}</span>
          <span aria-hidden className="h-2.5 w-px shrink-0 bg-[var(--border)]" />
          <span
            className="shrink-0"
            title={
              language === 'typescript' ? t('statusbar.ts') : t('statusbar.js')
            }
          >
            {language === 'typescript' ? 'TypeScript' : 'JavaScript'}
          </span>
        </>
      )}
    </footer>
  )
}
