import { useCallback, useEffect, useRef, useState } from 'react'
import { loadAllTemplates } from './index'
import {
  DEMO_SAVE_KEY,
  DEMO_SAVING_KEY,
  type InterruptedSave,
  type ResidualDemo,
  type Workspace,
  type WorkspaceRoot,
} from './useWorkspace'
import type { Confirm } from './useConfirm'
import { pickDirectory, queryPermission, removeEntry } from '@/lib/fs-access'
import { idbDel, idbGet } from '@/lib/idb'
import { messageOf, type T } from '@/i18n/context'
import type { Notice } from '@/types'

/** 「把全部 Demo 存到本地」时建的总目录名。纯 ASCII，跨系统都安全 */
const DEMOS_DIR = 'scrawl-demos'

interface UseDemoSaverOptions {
  workspace: Workspace
  confirm: Confirm
  t: T
  setNotice: (notice: Notice) => void
}

/*
  「把全部 Demo 存到本地文件夹」这条产品功能的全部状态：
  写入进度、取消、以及启动时对「上次没存完」残留的检测与清理引导。
  写盘本身在 workspace.saveBundle 里；这里管的是围绕它的交互与善后。
*/
export function useDemoSaver({ workspace, confirm, t, setNotice }: UseDemoSaverOptions) {
  /** 把 Demo 存到本地时的写入进度（null 表示当前没有正在进行的保存） */
  const [saveProgress, setSaveProgress] = useState<{
    file: string
    doneFiles: number
    totalFiles: number
    writtenBytes: number
    totalBytes: number
  } | null>(null)
  /** 写入 demo 时置 true，writeFilesInto 每写一个文件前检查它；取消后立即复位 */
  const cancelSaveRef = useRef(false)
  /** 是否正在执行取消（点了确认、在清理残留）。用于把取消按钮置灰防重复 */
  const [cancelling, setCancelling] = useState(false)

  // 检测到「上次没存完」的 demo 残留时，引导清理。清理直接用左侧已打开根目录的
  // handle 删，不需要重新选文件夹（父目录已在侧边栏且已授权）。
  const handleDetectedResiduals = useCallback(
    async (residuals: { root: WorkspaceRoot; demo: ResidualDemo }[]) => {
      const ok = await confirm.ask({
        title: t('confirm.cleanupInterrupted.title'),
        lines: [
          t('confirm.cleanupInterrupted.bodyMultiple', {
            labels: residuals.map((r) => r.demo.label).join('、'),
          }),
        ],
        confirmText: t('confirm.cleanupInterrupted.ok'),
        tone: 'danger',
      })
      if (!ok) return
      let cleaned = 0
      for (const { root, demo } of residuals) {
        try {
          await removeEntry(root.handle, demo.dirName, 'directory')
          cleaned += 1
        } catch {
          // 单个失败不影响其他；失败的那个可能是权限问题，留给用户自行处理
        }
      }
      await idbDel(DEMO_SAVE_KEY).catch(() => {})
      try {
        sessionStorage.removeItem(DEMO_SAVING_KEY)
      } catch {
        /* ignore */
      }
      if (cleaned > 0) {
        setNotice({ tone: 'info', text: t('notice.demoSaveCleaned', { count: cleaned }) })
      }
    },
    [setNotice, confirm, t]
  )

  // 主判据：IndexedDB 里那条「进行中」记录。优先用左侧已打开、可写的根目录 handle 来删
  // （记录里存的 parent handle 刷新后可能陈旧、removeEntry 会拒绝），找不到才让用户重选。
  const handleInterruptedRecord = useCallback(
    async (record: InterruptedSave) => {
      const ok = await confirm.ask({
        title: t('confirm.cleanupInterrupted.title'),
        lines: [t('confirm.cleanupInterrupted.bodyRecord', { label: record.label })],
        confirmText: t('confirm.cleanupInterrupted.ok'),
        tone: 'danger',
      })
      if (!ok) return
      // 清理记录/标记：删成功、或残留目录已不存在（NotFound）都算完事
      const clearSave = () => {
        void idbDel(DEMO_SAVE_KEY).catch(() => {})
        try {
          sessionStorage.removeItem(DEMO_SAVING_KEY)
        } catch {
          /* ignore */
        }
      }
      // 尝试删；目录已不存在时返回 'gone'，删成功返回 'ok'，其它错误抛出
      const tryRemove = async (dir: FileSystemDirectoryHandle): Promise<'ok' | 'gone'> => {
        try {
          await removeEntry(dir, record.dirName, 'directory')
          return 'ok'
        } catch (err) {
          if (err instanceof DOMException && err.name === 'NotFoundError') return 'gone'
          throw err
        }
      }
      // 优先用左侧已打开、且名字对得上的根目录 handle —— 它是最活跃、肯定可写的那个
      const openRoot = workspace.roots.find(
        (r) => r.status === 'ready' && r.handle.name === record.parent.name
      )
      const target = openRoot?.handle ?? record.parent
      const perm = await queryPermission(target, 'readwrite').catch(() => 'unavailable')
      if (perm === 'granted') {
        try {
          const outcome = await tryRemove(target)
          clearSave()
          setNotice({
            tone: 'info',
            text: outcome === 'gone' ? t('notice.demoSaveGone') : t('notice.demoSaveCleaned', { count: 1 }),
          })
        } catch (err) {
          setNotice({ tone: 'error', text: messageOf(err, t) })
        }
        return
      }
      // 权限不足或句柄陈旧：重新选一次父文件夹来重新授权，再删
      const parent = await pickDirectory().catch(() => null)
      if (!parent) return // 用户取消，记录留着下次再说
      try {
        const outcome = await tryRemove(parent)
        clearSave()
        setNotice({
          tone: 'info',
          text: outcome === 'gone' ? t('notice.demoSaveGone') : t('notice.demoSaveCleaned', { count: 1 }),
        })
      } catch (err) {
        setNotice({ tone: 'error', text: messageOf(err, t) })
      }
    },
    [setNotice, confirm, t, workspace.roots]
  )

  // 打开页面后，等目录恢复完，先看同步「正在保存」标记和 IndexedDB 记录，都没有再扫磁盘兜底。
  const cleanupPromptedRef = useRef(false)
  useEffect(() => {
    if (cleanupPromptedRef.current || !workspace.ready) return
    cleanupPromptedRef.current = true
    let cancelled = false
    void (async () => {
      // 1) 同步「正在保存」标记：同标签页刷新后第一次加载就能读到，不受 IndexedDB 事务时序影响
      let savingMark = false
      try {
        savingMark = sessionStorage.getItem(DEMO_SAVING_KEY) === '1'
      } catch {
        /* ignore */
      }
      // 2) 主判据：进行中记录。写入中途刷新/失败会留下它，全部写完才删。
      //    注意这里不读 cancelled：StrictMode 下 effect 会被双调用、cleanup 会把上一次
      //    的 cancelled 置 true，若主判据也受它影响，记录明明在却会被跳过、不弹窗。
      const record = await idbGet<InterruptedSave>(DEMO_SAVE_KEY).catch(() => null)
      if (record) {
        void handleInterruptedRecord(record)
        return
      }
      // 3) 标记在但记录丢了（极端情况），扫磁盘兜底
      if (savingMark) {
        const found: { root: WorkspaceRoot; demo: ResidualDemo }[] = []
        for (const root of workspace.roots) {
          if (root.status !== 'ready') continue
          const demos = await workspace.detectResidualDemos(root)
          for (const demo of demos) found.push({ root, demo })
        }
        if (found.length > 0) void handleDetectedResiduals(found)
        return
      }
      // 4) 纯磁盘扫描兜底：记录丢了也没标记（比如旧版本），主动扫已授权 root
      const found: { root: WorkspaceRoot; demo: ResidualDemo }[] = []
      for (const root of workspace.roots) {
        if (root.status !== 'ready') continue
        const demos = await workspace.detectResidualDemos(root)
        for (const demo of demos) found.push({ root, demo })
      }
      if (!cancelled && found.length > 0) void handleDetectedResiduals(found)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.ready, handleInterruptedRecord, handleDetectedResiduals])


  /**
   * 把全部 Demo 存进用户选的文件夹。
   *
   * 这是「真的想拿它们练手」的入口：builtin: 那条路能改但存不回去（源码是打包进来的
   * 字符串），落到磁盘上之后它们就是普通的本地文件，Ctrl+S 直接写回。
   */
  async function saveDemos() {
    let files
    try {
      files = await loadAllTemplates()
    } catch (err) {
      setNotice({ tone: 'error', text: t('notice.demoReadFailed', { message: messageOf(err, t) }) })
      return
    }
    // 写磁盘前先确认一次：会建目录、落文件，误点会把一堆文件写进用户文件夹
    const proceed = await confirm.ask({
      title: t('confirm.saveDemos.title'),
      lines: [t('confirm.saveDemos.body', { count: files.length })],
      confirmText: t('confirm.saveDemos.ok'),
    })
    if (!proceed) return
    // 这里不提前 setSaveProgress：saveBundle 第一步是弹文件夹选择框，用户还没选、
    // 还没开始写入，这时候显示「正在写入」是错的。进度面板交给 writeFilesInto 在
    // 真正开始落盘时再亮起（见下方 onProgress 的首次回调）。
    cancelSaveRef.current = false
    try {
      const saved = await workspace.saveBundle(DEMOS_DIR, files, {
        onProgress: (p) => setSaveProgress(p),
        shouldCancel: () => cancelSaveRef.current,
        onOpen: async ({ label, count }) => {
          // 落盘之后问一句：把选中的文件夹接管成左侧根目录是会改变界面布局的动作，
          // 应该由用户明确同意才做，而不是默认静默执行。
          return await confirm.ask({
            title: t('confirm.openDemos.title'),
            lines: [t('confirm.openDemos.body', { count, label })],
            confirmText: t('confirm.openDemos.ok'),
          })
        },
      })
      // null 有两种：用户在选择器里取消（不该有任何动静），或者出错
      // （原因已经在侧边栏那条 workspace.error 提示条上了）
      if (!saved) return
      setNotice({
        tone: 'info',
        text: saved.opened
          ? t('notice.demosSaved', { count: saved.count, label: saved.label })
          : t('notice.demosSavedClosed', { count: saved.count, label: saved.label }),
      })
    } finally {
      setSaveProgress(null)
      setCancelling(false)
    }
  }


  // 写入 demo 时用户点了「取消」：先二次确认（会删掉已写文件），确认后才置标志。
  // writeFilesInto 会在下一个文件前停下，saveBundle 的 catch 里删掉残留目录并返回 null。
  async function cancelSave() {
    if (cancelling) return
    const ok = await confirm.ask({
      title: t('confirm.cancelSave.title'),
      lines: [t('confirm.cancelSave.body')],
      confirmText: t('confirm.cancelSave.ok'),
      tone: 'danger',
    })
    if (!ok) return
    setCancelling(true)
    cancelSaveRef.current = true
  }


  return { saveProgress, cancelling, saveDemos, cancelSave }
}
