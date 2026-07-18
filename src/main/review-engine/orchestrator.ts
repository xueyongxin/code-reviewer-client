import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import type {
  ReviewFlowNode,
  ReviewReport,
  StartReviewPayload
} from '../../shared/types'
import { IPC_CHANNELS } from '../../shared/ipc'
import { getAppConfig } from '../config/store'
import {
  buildContentFingerprint,
  findCachedReportByCommitSha,
  saveReviewReport
} from '../database/db'
import { runStaticScan } from './static-rules'
import { toStaticRules } from './custom-rules'
import { dedupeIssues, resolveActiveProvider, runLlmReview } from './llm-reviewer'
import { buildMarkdownSummary, persistReportFiles } from './report-writer'
import { notifyReviewFinished } from './notify'
import { fetchReviewFiles, languageFromPath } from './code-fetcher'
import { cleanupGitWorkDir } from './git-fetcher'
import { FlowTracker } from './flow-tracker'
import { resolveStaticRuleIds, reviewMethodById } from '../../shared/review-methods'
import type { ReportOutputFormat } from '../../shared/types'

type ProgressCallback = (report: ReviewReport) => void

const cancelledIds = new Set<string>()
const abortControllers = new Map<string, AbortController>()

const runPool = async <T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(items.length)
  let cursor = 0

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index])
    }
  })

  await Promise.all(runners)
  return results
}

const finishMeta = (
  flow: FlowTracker,
  timeline: ReviewFlowNode[]
): Pick<ReviewReport, 'finishedAt' | 'totalDurationMs' | 'flowTimeline'> => ({
  finishedAt: new Date().toISOString(),
  totalDurationMs: flow.totalMs(),
  flowTimeline: timeline
})

export class ReviewOrchestrator {
  private latest: ReviewReport | null = null

  getLatest(): ReviewReport | null {
    return this.latest
  }

  getReportById(reportId: string): ReviewReport | null {
    if (this.latest?.id === reportId) return this.latest
    return null
  }

  cancel(reportId: string): void {
    cancelledIds.add(reportId)
    abortControllers.get(reportId)?.abort()
  }

  cancelAll(): void {
    for (const id of Array.from(abortControllers.keys())) {
      this.cancel(id)
    }
  }

  async startBatch(
    payloads: StartReviewPayload[],
    onProgress: ProgressCallback,
    getWindow: () => BrowserWindow | null
  ): Promise<ReviewReport[]> {
    return runPool(payloads, 2, (payload) => this.start(payload, onProgress, getWindow))
  }

  async start(
    payload: StartReviewPayload,
    onProgress: ProgressCallback,
    getWindow: () => BrowserWindow | null
  ): Promise<ReviewReport> {
    const baseConfig = getAppConfig()
    const pipeline = payload.pipelineId
      ? baseConfig.reviewPipelines?.find((p) => p.id === payload.pipelineId)
      : undefined

    const methodIds =
      payload.methodIds?.length
        ? payload.methodIds
        : pipeline?.methodIds?.length
          ? pipeline.methodIds
          : []
    const methodRuleIds = resolveStaticRuleIds(methodIds)
    const effectiveRuleIds =
      methodIds.length === 0
        ? baseConfig.enabledRuleIds
        : methodRuleIds.length
          ? methodRuleIds
          : baseConfig.enabledRuleIds

    const llmProviderId =
      payload.llmProviderId || pipeline?.llmProviderId || baseConfig.activeLlmProviderId
    const reportFormats: ReportOutputFormat[] =
      payload.reportFormats?.length
        ? payload.reportFormats
        : pipeline?.reportFormats?.length
          ? pipeline.reportFormats
          : ['md', 'json']

    const focusHints = methodIds
      .map((id) => reviewMethodById(id))
      .filter(Boolean)
      .map((m) => `${m!.name}：${m!.description}`)

    const config = {
      ...baseConfig,
      enabledRuleIds: effectiveRuleIds,
      activeLlmProviderId: llmProviderId || baseConfig.activeLlmProviderId
    }

    const flow = new FlowTracker()
    const report: ReviewReport = {
      id: randomUUID(),
      repoUrl: payload.repoUrl || pipeline?.repoUrl || '',
      prNumber: payload.prNumber || pipeline?.prNumber,
      commitSha: payload.commitSha || pipeline?.commitSha,
      createdAt: new Date().toISOString(),
      status: 'running',
      progress: 5,
      progressLabel: '初始化审查任务',
      flowTimeline: [],
      files: [],
      issues: [],
      summaryMarkdown: ''
    }

    if (!report.repoUrl.trim()) {
      throw new Error('请先在流水线中配置代码源仓库')
    }

    const abort = new AbortController()
    abortControllers.set(report.id, abort)
    this.latest = report

    const emit = (patch: Partial<ReviewReport>): void => {
      Object.assign(report, patch)
      this.latest = { ...report, flowTimeline: [...(report.flowTimeline || [])] }
      onProgress(this.latest)
      getWindow()?.webContents.send(IPC_CHANNELS.REVIEW_PROGRESS, this.latest)
    }

    const emitFlow = (
      timeline: ReviewFlowNode[],
      patch: Partial<ReviewReport> = {}
    ): void => {
      emit({
        ...patch,
        flowTimeline: timeline,
        totalDurationMs: flow.totalMs()
      })
    }

    const assertNotCancelled = (): void => {
      if (cancelledIds.has(report.id) || abort.signal.aborted) {
        throw new Error('审查已取消')
      }
    }

    let workDir: string | undefined

    try {
      // ① 初始化
      emitFlow(flow.begin('init', '① 初始化任务', '创建审查上下文'), {
        progress: 8,
        progressLabel: '① 初始化任务'
      })
      emitFlow(flow.end('init', 'success', '任务已创建'), {
        progress: 10,
        progressLabel: '① 初始化完成'
      })
      assertNotCancelled()

      // ② 拉取代码
      emitFlow(
        flow.begin('fetch', '② 拉取代码', '尝试 MCP → Git 克隆 → 演示回退'),
        { progress: 12, progressLabel: '② 拉取代码中…' }
      )
      assertNotCancelled()

      const enabledServer =
        (pipeline?.mcpServerId
          ? config.mcpServers.find((s) => s.id === pipeline.mcpServerId)
          : null) || config.mcpServers.find((s) => s.enabled)
      const fetched = await fetchReviewFiles({
        repoUrl: report.repoUrl,
        prNumber: report.prNumber,
        serverId: enabledServer?.id ?? null,
        enableGitClone: config.enableGitClone
      })
      workDir = fetched.workDir
      const files = fetched.files
      for (const file of files) {
        file.language = file.language || languageFromPath(file.filePath)
      }

      const pullSource = fetched.source ?? (fetched.usedDemo ? 'demo' : 'mcp')
      emitFlow(
        flow.end(
          'fetch',
          'success',
          fetched.reason ||
            `来源 ${pullSource} · ${files.length} 个文件` +
              (fetched.commitSha ? ` · ${fetched.commitSha.slice(0, 8)}` : '')
        ),
        {
          progress: 28,
          progressLabel: `② 拉取完成 · ${pullSource} · ${files.length} 文件`,
          files,
          pullSource
        }
      )
      assertNotCancelled()

      // ③ 缓存检查
      const fingerprint =
        payload.commitSha?.trim() ||
        fetched.commitSha ||
        buildContentFingerprint(payload.repoUrl, payload.prNumber, files)
      report.commitSha = fingerprint

      emitFlow(flow.begin('cache', '③ 缓存检查', fingerprint.slice(0, 12)), {
        progress: 32,
        progressLabel: '③ 检查缓存…'
      })

      if (!payload.forceRefresh) {
        const cached = findCachedReportByCommitSha(fingerprint)
        if (cached) {
          emitFlow(flow.end('cache', 'success', '命中缓存，复用历史结果'))
          const skipRest: Array<[string, string]> = [
            ['static', '④ 静态规则扫描'],
            ['llm', '⑤ LLM 语义审查'],
            ['merge', '⑥ 合并去重'],
            ['report', '⑦ 生成报告']
          ]
          let timeline = flow.snapshot()
          for (const [id, name] of skipRest) {
            timeline = flow.skip(id, name, '因缓存命中跳过')
          }
          timeline = flow.begin('done', '⑧ 完成')
          timeline = flow.end('done', 'success', '缓存复用完成')

          const reused: ReviewReport = {
            ...cached,
            id: report.id,
            createdAt: report.createdAt,
            fromCache: true,
            pullSource: 'cache',
            progress: 100,
            progressLabel: '⑧ 命中缓存，跳过扫描 / LLM',
            status: 'completed',
            ...finishMeta(flow, timeline)
          }
          // 若缓存无时间线，补上本次扭转记录
          if (!reused.flowTimeline?.length) reused.flowTimeline = timeline
          Object.assign(report, reused)
          emit({ ...reused })
          saveReviewReport(report)
          if (config.notifyOnComplete) notifyReviewFinished(report)
          void import('../cloud/client').then(({ maybeAutoUploadReport }) =>
            maybeAutoUploadReport(report)
          )
          return { ...report }
        }
      }

      emitFlow(
        flow.end(
          'cache',
          'success',
          payload.forceRefresh ? '强制刷新，忽略缓存' : '未命中缓存，继续全量审查'
        ),
        { progress: 35, progressLabel: '③ 缓存未命中，继续' }
      )
      assertNotCancelled()

      // ④ 静态扫描
      emitFlow(flow.begin('static', '④ 静态规则扫描'), {
        progress: 45,
        progressLabel: '④ 静态规则扫描中…'
      })
      const extraRules = toStaticRules(config.customRules ?? [])
      const staticStarted = Date.now()
      const staticIssues = files.flatMap((file) => {
        const issues = runStaticScan(
          file.filePath,
          file.content,
          config.enabledRuleIds,
          extraRules
        )
        file.issues = issues
        return issues
      })
      emitFlow(
        flow.end(
          'static',
          'success',
          `命中 ${staticIssues.length} 条 · ${Date.now() - staticStarted}ms 内完成`
        ),
        {
          progress: 55,
          progressLabel: `④ 静态扫描完成 · ${staticIssues.length} 条`,
          issues: staticIssues,
          files: [...files]
        }
      )
      assertNotCancelled()

      // ⑤ LLM
      const activeProvider = resolveActiveProvider(config)
      const canLlm =
        config.enableLlm &&
        (!!activeProvider?.apiKey?.trim() || activeProvider?.protocol === 'ollama')

      let llmIssues: typeof staticIssues = []
      if (canLlm) {
        emitFlow(
          flow.begin(
            'llm',
            '⑤ LLM 语义审查',
            `${activeProvider?.name} · ${activeProvider?.model}`
          ),
          {
            progress: 60,
            progressLabel: `⑤ LLM 审查中 · ${activeProvider?.name ?? 'LLM'}…`
          }
        )
        try {
          llmIssues = await runLlmReview(files, config, abort.signal, {
            focusHints,
            providerId: llmProviderId
          })
          emitFlow(
            flow.end('llm', 'success', `返回 ${llmIssues.length} 条语义问题`),
            {
              progress: 82,
              progressLabel: `⑤ LLM 完成 · ${llmIssues.length} 条`
            }
          )
        } catch (error) {
          if (abort.signal.aborted) throw new Error('审查已取消')
          const message = error instanceof Error ? error.message : String(error)
          emitFlow(flow.end('llm', 'failed', message.slice(0, 240)), {
            progress: 82,
            progressLabel: `⑤ LLM 失败，继续生成报告`
          })
        }
      } else {
        emitFlow(
          flow.skip('llm', '⑤ LLM 语义审查', '未启用或未配置 API Key'),
          { progress: 70, progressLabel: '⑤ 跳过 LLM' }
        )
      }
      assertNotCancelled()

      // ⑥ 合并
      emitFlow(flow.begin('merge', '⑥ 合并去重'), {
        progress: 88,
        progressLabel: '⑥ 合并问题列表…'
      })
      const allIssues = dedupeIssues([...staticIssues, ...llmIssues])
      for (const file of files) {
        file.issues = allIssues.filter((issue) => issue.filePath === file.filePath)
      }
      emitFlow(
        flow.end(
          'merge',
          'success',
          `静态 ${staticIssues.length} + LLM ${llmIssues.length} → 去重后 ${allIssues.length}`
        ),
        {
          progress: 90,
          progressLabel: `⑥ 去重完成 · ${allIssues.length} 条`,
          issues: allIssues,
          files: [...files]
        }
      )

      // ⑦ 写报告
      emitFlow(flow.begin('report', '⑦ 生成报告'), {
        progress: 92,
        progressLabel: '⑦ 生成报告…'
      })
      report.summaryMarkdown = buildMarkdownSummary(report)
      const outputDir = persistReportFiles(report, config.reportOutputDir, reportFormats)
      emitFlow(flow.end('report', 'success', `已写入 ${outputDir}（${reportFormats.join('/')}）`), {
        progress: 96,
        progressLabel: '⑦ 报告已落盘',
        summaryMarkdown: report.summaryMarkdown
      })

      // ⑧ 完成
      emitFlow(flow.begin('done', '⑧ 完成'))
      const timeline = flow.end(
        'done',
        'success',
        `全流程 ${flow.totalMs()}ms · 问题 ${allIssues.length} 条`
      )

      const finished = {
        status: 'completed' as const,
        progress: 100,
        progressLabel: `⑧ 审查完成 · 总耗时 ${flow.totalMs()}ms`,
        fromCache: false,
        ...finishMeta(flow, timeline)
      }
      Object.assign(report, finished)
      report.summaryMarkdown = buildMarkdownSummary(report)
      persistReportFiles(report, config.reportOutputDir, reportFormats)

      emit({
        ...finished,
        summaryMarkdown: report.summaryMarkdown
      })

      saveReviewReport(report)
      if (config.notifyOnComplete) notifyReviewFinished(report)
      void import('../cloud/client').then(({ maybeAutoUploadReport }) =>
        maybeAutoUploadReport(report)
      )
      return { ...report }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = message.includes('取消') ? 'cancelled' : 'failed'
      const running = report.flowTimeline?.find((n) => n.status === 'running')
      let timeline = flow.snapshot()
      if (running) {
        timeline = flow.end(running.id, 'failed', message.slice(0, 240))
      }
      timeline = flow.begin('done', status === 'cancelled' ? '⑧ 已取消' : '⑧ 失败')
      timeline = flow.end('done', 'failed', message.slice(0, 240))

      emit({
        status,
        progress: report.progress,
        progressLabel: status === 'cancelled' ? '已取消' : '审查失败',
        error: message,
        ...finishMeta(flow, timeline)
      })
      saveReviewReport(report)
      if (config.notifyOnComplete) notifyReviewFinished(report)
      return { ...report }
    } finally {
      cleanupGitWorkDir(workDir)
      cancelledIds.delete(report.id)
      abortControllers.delete(report.id)
    }
  }
}

export const reviewOrchestrator = new ReviewOrchestrator()
