import { Notification, app } from 'electron'
import type { ReviewReport } from '../../shared/types'

export const notifyReviewFinished = (report: ReviewReport): void => {
  if (!Notification.isSupported()) return

  const title =
    report.status === 'completed'
      ? '审查完成'
      : report.status === 'cancelled'
        ? '审查已取消'
        : '审查失败'

  const body =
    report.status === 'completed'
      ? `${report.repoUrl} · ${report.issues.length} 个问题${report.fromCache ? '（缓存）' : ''}`
      : report.error || report.progressLabel

  const notification = new Notification({
    title: `${app.getName()}: ${title}`,
    body,
    silent: false
  })
  notification.show()
}
