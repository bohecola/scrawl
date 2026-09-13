import { cn } from '@/lib/utils'
import { Icon } from '@/components/ui/icon'

/*
  分段选择器：一组互斥的选项挤在一个浅色 pill 里，选中项是浮起的亮块。
  从设置面板（明暗三态那个）抽出来共享：右栏的 Console / 预览切换也要同款观感，
  两处各写一份迟早漂移。icon 可选——设置里带图标，面板切换纯文字。
*/
export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; icon?: string; label: string }[]
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
            {o.icon && <Icon className={cn('size-3.5', o.icon)} />}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
