import { useState, useMemo, useEffect, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  dialogCloseButtonClass,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { isMac } from '@/lib/platform'
import { useI18n, LANGS, systemLang, translatedLangNames, type LangMode } from '@/i18n/context'
import type { ParseKeys } from 'i18next'
import { useTheme, type Accent, type ThemeMode, ACCENTS } from '@/theme/index'
import {
  useSettings,
  FONT_PRESETS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  DEFAULT_SETTINGS,
  type EditorSettings,
} from '@/settings/context'
import { FileIcon } from '@/components/FileIcon'
import { ICON_THEMES, getIconSet, type IconThemeId } from '@/icon-themes'
import { AUTO_THEME, EDITOR_THEMES } from '@/monaco/themes'

/*
  右上角唯一的「设置」入口：齿轮按钮 → 一个对话框，左侧页签「外观 / 编辑器 / 快捷键」，
  右侧是当前页的内容。所有改动即时生效、自动保存，没有「确定」按钮 —— 和 VS Code 的
  设置页、Discord / Linear 这类应用的设置对话框一致。明暗 / 配色 / 语言的状态仍在各自
  的 Provider 里，这里只是入口。
*/

type Tab = 'appearance' | 'editor' | 'shortcuts'

const TABS: { id: Tab; icon: string; labelKey: ParseKeys }[] = [
  { id: 'appearance', icon: 'icon-[lucide--palette]', labelKey: 'settings.appearance' },
  { id: 'editor', icon: 'icon-[lucide--code]', labelKey: 'settings.editor' },
  { id: 'shortcuts', icon: 'icon-[lucide--keyboard]', labelKey: 'settings.shortcuts' },
]

const ACCENT_COLOR: Record<Accent, string> = {
  blue: '#0ea5e9',
  pink: '#ec4899',
  orange: '#f97316',
  green: '#22c55e',
  violet: '#8b5cf6',
  teal: '#14b8a6',
  graphite: '#71717a',
}

const ACCENT_LABEL = {
  blue: 'header.accent.blue',
  pink: 'header.accent.pink',
  orange: 'header.accent.orange',
  green: 'header.accent.green',
  violet: 'header.accent.violet',
  teal: 'header.accent.teal',
  graphite: 'header.accent.graphite',
} as const

/**
 * 配色选择器：平涂的圆角方块色板，像设计工具里的颜色选择器。
 * 选中的用自己的颜色描一圈、中间留一道背景色的缝，而不是统一的灰圈，石墨那块才不会和「选中」混。
 * 名字不常驻显示，悬停 / 聚焦时用面板里同款的 Tooltip 弹出（同「?」说明气泡）。
 */
function AccentPicker({
  accent,
  onChange,
  t,
}: {
  accent: Accent
  onChange: (a: Accent) => void
  t: (key: (typeof ACCENT_LABEL)[Accent]) => string
}) {
  return (
    <div role="radiogroup" className="flex items-center gap-2">
      {ACCENTS.map((a) => {
        const on = a === accent
        const color = ACCENT_COLOR[a]
        return (
          <Tooltip key={a}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={t(ACCENT_LABEL[a])}
                onClick={() => onChange(a)}
                className={cn(
                  'flex size-[22px] items-center justify-center rounded-md outline-none transition-[box-shadow,opacity] duration-150',
                  on ? 'opacity-100' : 'opacity-80 hover:opacity-100 focus-visible:opacity-100'
                )}
                style={{
                  backgroundColor: color,
                  boxShadow: on ? `0 0 0 2px var(--background), 0 0 0 4px ${color}` : undefined,
                }}
              >
                {on && <Icon className="icon-[lucide--check] size-3.5 text-white" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{t(ACCENT_LABEL[a])}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

// ---- 快捷键表 ----
// 每个组合是一串按键；同一功能有多个组合时并列。Mac 用符号，其余平台用英文名。
// 回车用 ↵（U+21B5）而不是 ↩（U+21A9）：后者在 Chrome 里会落到彩色 emoji 字体上
const K = isMac
  ? { mod: '⌘', alt: '⌥', shift: '⇧', enter: '↵', up: '↑', down: '↓' }
  : { mod: 'Ctrl', alt: 'Alt', shift: 'Shift', enter: 'Enter', up: '↑', down: '↓' }

interface ShortcutRow {
  labelKey: ParseKeys
  combos: string[][]
}

const APP_SHORTCUTS: ShortcutRow[] = [
  { labelKey: 'editor.run', combos: [[K.mod, K.enter]] },
  { labelKey: 'editor.stop', combos: [[K.shift, 'F5']] },
  { labelKey: 'editor.save', combos: [[K.mod, 'S']] },
  // ⌘W / Ctrl+W 归浏览器，见 lib/platform.ts 的 shortcut.closeTab
  { labelKey: 'tab.close', combos: [[K.alt, 'W']] },
  { labelKey: 'tab.new', combos: [[K.alt, 'N']] },
  { labelKey: 'settings.shortcuts.rename', combos: isMac ? [[K.enter], ['F2']] : [['F2']] },
]

// Monaco 自带的默认键位，列出最常用的几条
const EDITOR_SHORTCUTS: ShortcutRow[] = [
  { labelKey: 'settings.shortcuts.palette', combos: [['F1']] },
  { labelKey: 'settings.shortcuts.find', combos: [[K.mod, 'F']] },
  {
    labelKey: 'settings.shortcuts.replace',
    combos: isMac ? [[K.alt, K.mod, 'F']] : [[K.mod, 'H']],
  },
  { labelKey: 'settings.shortcuts.format', combos: [[K.shift, K.alt, 'F']] },
  { labelKey: 'settings.shortcuts.comment', combos: [[K.mod, '/']] },
  {
    labelKey: 'settings.shortcuts.moveLine',
    combos: [
      [K.alt, K.up],
      [K.alt, K.down],
    ],
  },
  { labelKey: 'settings.shortcuts.copyLine', combos: [[K.shift, K.alt, K.down]] },
  { labelKey: 'settings.shortcuts.multiCursor', combos: [[K.mod, 'D']] },
]

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--panel-bg)] px-1.5 font-sans text-[11px] font-medium text-[var(--text-body)] shadow-[0_1px_0_var(--border-strong)]">
      {children}
    </kbd>
  )
}

function Combo({ keys }: { keys: string[] }) {
  return (
    // 快捷键组合是按键序列，顺序有含义（⌘ 在前）：RTL 下 flex 主轴反向会把它显示反，
    // 钉回 LTR —— macOS 阿拉伯语系统设置里的快捷键也保持原顺序
    <span dir="ltr" className="inline-flex items-center gap-1">
      {keys.map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </span>
  )
}

/** 一行设置：左标签（可带一个带说明气泡的 ? 图标 info）、右控件 */
function Row({ label, info, children }: { label: string; info?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 py-1">
      <div className="flex min-w-0 items-center gap-1 text-[13px] text-[var(--text-body)]">
        {label}
        {info && (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* 用 button 而不是裸图标：键盘 Tab 到它也能弹出说明 */}
              <button
                type="button"
                aria-label={info}
                className="flex size-4 items-center justify-center rounded-full text-[var(--text-faint)] outline-none hover:text-[var(--text-body)] focus-visible:text-[var(--text-body)]"
              >
                <Icon className="icon-[lucide--circle-help] size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" align="start">
              {info}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  )
}

/** 页内的小节：标题 + 下面一组行。行与行之间不画分隔线，靠行距分开（同 VS Code / Linear 的设置页） */
function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      {title && (
        <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-[var(--text-faint)] uppercase">
          {title}
        </h3>
      )}
      <div className="flex flex-col gap-1">{children}</div>
    </section>
  )
}

/** 分段选择（明暗三态） */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; icon: string; label: string }[]
}) {
  return (
    <div role="radiogroup" className="flex rounded-md bg-[var(--panel-hover)] p-0.5">
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.label}
            aria-label={o.label}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[12px] transition-colors',
              on
                ? 'bg-[var(--panel-bg)] text-[var(--text-primary)] shadow-sm'
                : 'text-[var(--text-muted)] hover:text-[var(--text-body)]'
            )}
          >
            <Icon className={cn('size-3.5', o.icon)} />
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** 数字步进（字号） */
function Stepper({
  value,
  min,
  max,
  onChange,
  label,
}: {
  value: number
  min: number
  max: number
  onChange: (v: number) => void
  label: string
}) {
  return (
    <div className="flex items-center rounded-md border border-[var(--border-strong)]">
      <button
        type="button"
        aria-label={`${label} −`}
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
        className="flex size-7 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-40"
      >
        <Icon className="icon-[lucide--minus] size-3.5" />
      </button>
      <span className="w-7 text-center font-mono text-[12px] tabular-nums">{value}</span>
      <button
        type="button"
        aria-label={`${label} +`}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
        className="flex size-7 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-40"
      >
        <Icon className="icon-[lucide--plus] size-3.5" />
      </button>
    </div>
  )
}

/** 语言项后面的次要文字。Radix 会把选中项的内容整个复制进触发器，触发器窄，那里只留主名字 */
function LangHint({ children }: { children: ReactNode }) {
  return (
    <span className="text-[var(--text-muted)] [[data-slot=select-trigger]_&]:hidden">{children}</span>
  )
}

export function SettingsDialog() {
  const { t, lang, mode: langMode, setMode: setLangMode } = useI18n()
  // 语言下拉各项后面的括注（当前界面语言写的语言名）；「跟随系统」后面注明系统语言解析成了哪一种
  const langNames = useMemo(() => translatedLangNames(lang), [lang])
  const sysLang = systemLang()
  const sysLangName = langNames[sysLang] ?? LANGS.find((l) => l.value === sysLang)?.label
  const { mode, setMode, accent, setAccent } = useTheme()
  const { settings, update, reset } = useSettings()
  const [tab, setTab] = useState<Tab>('appearance')
  // 「文件图标」下拉里每项都有预览，提前把各主题的图标集拉下来，打开下拉时不会先闪一下占位图标
  useEffect(() => {
    for (const th of ICON_THEMES) getIconSet(th.id)
  }, [])

  const toggle = (
    key: keyof Pick<EditorSettings, 'wordWrap' | 'minimap' | 'lineNumbers' | 'fontLigatures' | 'tabIcons'>
  ) => (
    <Switch
      checked={settings[key]}
      onCheckedChange={(v) => update(key, v)}
      aria-label={t(`settings.${key}`)}
    />
  )

  const fontLabel = (id: EditorSettings['fontFamily']) => {
    const p = FONT_PRESETS.find((x) => x.id === id)
    return p && 'label' in p ? p.label : t('settings.fontFamily.system')
  }

  const dirty =
    settings !== DEFAULT_SETTINGS && JSON.stringify(settings) !== JSON.stringify(DEFAULT_SETTINGS)

  const shortcutTable = (rows: ShortcutRow[]) =>
    rows.map((r) => (
      <div key={r.labelKey} className="flex min-h-9 items-center justify-between gap-4 py-0.5">
        <span className="text-[13px] text-[var(--text-body)]">{t(r.labelKey)}</span>
        <span className="flex shrink-0 items-center gap-2">
          {r.combos.map((c, i) => (
            <span key={i} className="inline-flex items-center gap-2">
              {i > 0 && <span className="text-[11px] text-[var(--text-faint)]">/</span>}
              <Combo keys={c} />
            </span>
          ))}
        </span>
      </div>
    ))

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('settings.title')}
          aria-label={t('settings.title')}
          className="text-[var(--text-muted)] data-[state=open]:bg-[var(--panel-hover)] data-[state=open]:text-[var(--text-primary)]"
        >
          <Icon className="icon-[lucide--settings]" />
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="h-[min(560px,calc(100vh-4rem))] sm:max-w-2xl sm:flex-row"
      >
        {/* 左栏：标题 + 页签。窄屏时变成顶部的一排 */}
        <nav className="flex shrink-0 flex-col gap-3 border-b border-[var(--border)] bg-[var(--panel-bg)] p-3 sm:w-44 sm:border-e sm:border-b-0 sm:p-4">
          <DialogTitle className="px-2 text-sm">{t('settings.title')}</DialogTitle>
          <div role="tablist" aria-orientation="vertical" className="flex gap-1 sm:flex-col">
            {TABS.map((item) => {
              const on = item.id === tab
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  id={`settings-tab-${item.id}`}
                  aria-selected={on}
                  aria-controls={`settings-panel-${item.id}`}
                  onClick={() => setTab(item.id)}
                  className={cn(
                    'flex h-8 items-center gap-2 rounded-md px-2 text-[13px] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    on
                      ? 'bg-[var(--list-active)] text-[var(--text-primary)]'
                      : 'text-[var(--text-muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--text-body)]'
                  )}
                >
                  <Icon className={cn('size-4', item.icon)} />
                  {t(item.labelKey)}
                </button>
              )
            })}
          </div>
        </nav>

        {/* 右栏：固定的标题栏（页名 + ×）+ 下面可滚动的内容。× 不浮在内容上，
            否则快捷键这种长列表滚起来会从它旁边穿过去 */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] ps-6 pe-3">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              {t(TABS.find((x) => x.id === tab)!.labelKey)}
            </h2>
            <DialogClose
              aria-label={t('settings.close')}
              title={t('settings.close')}
              className={dialogCloseButtonClass}
            >
              <Icon className="icon-[lucide--x] size-4" />
            </DialogClose>
          </div>
          <div
            role="tabpanel"
            id={`settings-panel-${tab}`}
            aria-labelledby={`settings-tab-${tab}`}
            className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-5"
          >
            <TooltipProvider>
              {tab === 'appearance' && (
                <>
                  <Group>
                    <Row label={t('settings.mode')}>
                      <Segmented<ThemeMode>
                        value={mode}
                        onChange={setMode}
                        options={[
                          {
                            value: 'dark',
                            icon: 'icon-[lucide--moon]',
                            label: t('header.theme.dark'),
                          },
                          {
                            value: 'light',
                            icon: 'icon-[lucide--sun]',
                            label: t('header.theme.light'),
                          },
                          {
                            value: 'system',
                            icon: 'icon-[lucide--monitor]',
                            label: t('header.theme.system'),
                          },
                        ]}
                      />
                    </Row>
                    <Row label={t('settings.accent')}>
                      <AccentPicker accent={accent} onChange={setAccent} t={t} />
                    </Row>
                    <Row label={t('settings.language')}>
                      {/* 各语言项刻意用各自母语写：看不懂当前界面语言的人，正需要用目标语言认出自己那一项 */}
                      <Select value={langMode} onValueChange={(v) => setLangMode(v as LangMode)}>
                        <SelectTrigger
                          size="sm"
                          className="w-44"
                          aria-label={t('settings.language')}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper" className="max-h-72">
                          <SelectItem value="system">
                            <Icon className="icon-[lucide--monitor]" />
                            {t('header.lang.system')}
                            {sysLangName && <LangHint>{sysLangName}</LangHint>}
                          </SelectItem>
                          <SelectSeparator />
                          {LANGS.map(({ value, label }) => (
                            <SelectItem key={value} value={value}>
                              {label}
                              {langNames[value] && <LangHint>{langNames[value]}</LangHint>}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Row>
                    <Row label={t('settings.iconTheme')}>
                      <Select
                        value={settings.iconTheme}
                        onValueChange={(v) => update('iconTheme', v as IconThemeId)}
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-44"
                          aria-label={t('settings.iconTheme')}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper">
                          {ICON_THEMES.map((th) => (
                            <SelectItem key={th.id} value={th.id}>
                              {/* 每项前面画几个代表性的图标当预览：目录、ts、js、package.json */}
                              <span className="flex items-center gap-0.5 [&_[data-slot=icon]]:size-4">
                                <FileIcon theme={th.id} kind="directory" name="src" />
                                <FileIcon theme={th.id} kind="file" name="index.ts" />
                                <FileIcon theme={th.id} kind="file" name="app.js" />
                                <FileIcon theme={th.id} kind="file" name="package.json" />
                              </span>
                              {th.id === 'minimal' ? t('settings.iconTheme.minimal') : th.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Row>
                    <Row label={t('settings.tabIcons')}>{toggle('tabIcons')}</Row>
                  </Group>
                </>
              )}

              {tab === 'editor' && (
                <>
                  <Group>
                    <Row label={t('settings.fontSize')}>
                      <Stepper
                        value={settings.fontSize}
                        min={FONT_SIZE_MIN}
                        max={FONT_SIZE_MAX}
                        onChange={(v) => update('fontSize', v)}
                        label={t('settings.fontSize')}
                      />
                    </Row>
                    <Row label={t('settings.fontFamily')} info={t('settings.fontFamily.hint')}>
                      <Select
                        value={settings.fontFamily}
                        onValueChange={(v) =>
                          update('fontFamily', v as EditorSettings['fontFamily'])
                        }
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-44"
                          aria-label={t('settings.fontFamily')}
                        >
                          {/* 触发器里用界面字体显示名字：下拉项里那种「用字体本身写名字」的预览
                            在窄触发器里会被截断（等宽字体比界面字体宽得多） */}
                          <SelectValue>{fontLabel(settings.fontFamily)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent position="popper">
                          {FONT_PRESETS.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              <span style={{ fontFamily: p.family }}>{fontLabel(p.id)}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Row>
                    <Row label={t('settings.editorTheme')}>
                      <Select
                        value={settings.editorTheme}
                        onValueChange={(v) => update('editorTheme', v)}
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-44"
                          aria-label={t('settings.editorTheme')}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper">
                          <SelectItem value={AUTO_THEME}>
                            {t('settings.editorTheme.auto')}
                          </SelectItem>
                          {(['dark', 'light'] as const).map((kind) => (
                            <SelectGroup key={kind}>
                              <SelectLabel>
                                {t(
                                  kind === 'dark'
                                    ? 'settings.editorTheme.dark'
                                    : 'settings.editorTheme.light'
                                )}
                              </SelectLabel>
                              {EDITOR_THEMES.filter((th) => th.kind === kind).map((th) => (
                                <SelectItem key={th.id} value={th.id}>
                                  {th.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          ))}
                        </SelectContent>
                      </Select>
                    </Row>
                    <Row label={t('settings.wordWrap')}>{toggle('wordWrap')}</Row>
                    <Row label={t('settings.minimap')}>{toggle('minimap')}</Row>
                    <Row label={t('settings.lineNumbers')}>{toggle('lineNumbers')}</Row>
                    <Row
                      label={t('settings.fontLigatures')}
                      info={t('settings.fontLigatures.hint')}
                    >
                      {toggle('fontLigatures')}
                    </Row>
                  </Group>
                  {/* 低强调的文字按钮，靠右和上面的控件列对齐；有改动时才可点 */}
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!dirty}
                      onClick={reset}
                      className="text-[var(--text-muted)] hover:text-[var(--text-body)]"
                    >
                      <Icon className="icon-[lucide--undo-2]" />
                      {t('settings.reset')}
                    </Button>
                  </div>
                </>
              )}

              {tab === 'shortcuts' && (
                <>
                  <Group title={t('settings.shortcuts.app')}>{shortcutTable(APP_SHORTCUTS)}</Group>
                  <Group title={t('settings.shortcuts.editorBuiltin')}>
                    {shortcutTable(EDITOR_SHORTCUTS)}
                  </Group>
                </>
              )}
            </TooltipProvider>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
