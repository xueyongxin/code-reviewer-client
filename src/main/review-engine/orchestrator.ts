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
import { clampBatchReviewConcurrency } from '../../shared/batch-concurrency'
import { resolveStaticRuleIds, reviewMethodById } from '../../shared/review-methods'
import {
  resolveAnalysisReportDir,
  resolvePipelineProjectRoot
} from '../../shared/repo-path'
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
    if (!payloads.length) return []
    const concurrency = clampBatchReviewConcurrency(
      getAppConfig().batchReviewConcurrency
    )
    // 单条失败不拖垮整批：start 内部多数错误已落 failed 报告；此处再兜底
    return runPool(payloads, concurrency, async (payload) => {
      try {
        return await this.start(payload, onProgress, getWindow)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const failed: ReviewReport = {
          id: randomUUID(),
          repoUrl: payload.repoUrl || '',
          prNumber: payload.prNumber,
          commitSha: payload.commitSha,
          createdAt: new Date().toISOString(),
          status: 'failed',
          progress: 0,
          progressLabel: '审查失败',
          error: message,
          flowTimeline: [],
          files: [],
          issues: [],
          summaryMarkdown: '',
          finishedAt: new Date().toISOString()
        }
        saveReviewReport(failed)
        onProgress(failed)
        getWindow()?.webContents.send(IPC_CHANNELS.REVIEW_PROGRESS, failed)
        return failed
      }
    })
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
          : ['md', 'html']

    const focusMethods = methodIds
      .map((id) => reviewMethodById(id))
      .filter((m): m is NonNullable<typeof m> => Boolean(m))
      .map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description
      }))
    const focusHints = focusMethods.map((m) => `${m.name}：${m.description}`)

    const config = {
      ...baseConfig,
      enabledRuleIds: effectiveRuleIds,
      activeLlmProviderId: llmProviderId || baseConfig.activeLlmProviderId
    }

    const effectiveBranch =
      payload.branch?.trim() || pipeline?.branch?.trim() || undefined
    const runNote = payload.runNote?.trim() || undefined

    const flow = new FlowTracker()
    const report: ReviewReport = {
      id: randomUUID(),
      repoUrl: payload.repoUrl || pipeline?.repoUrl || '',
      prNumber: payload.prNumber || pipeline?.prNumber,
      commitSha: payload.commitSha || pipeline?.commitSha,
      pipelineId: payload.pipelineId || pipeline?.id,
      branch: effectiveBranch,
      runNote,
      methodIds: methodIds.length ? [...methodIds] : undefined,
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
    // 尽早落库，便于启动后立刻打开报告页
    saveReviewReport(report)

    const emit = (patch: Partial<ReviewReport>): void => {
      Object.assign(report, patch)
      this.latest = { ...report, flowTimeline: [...(report.flowTimeline || [])] }
      onProgress(this.latest)
      getWindow()?.webContents.send(IPC_CHANNELS.REVIEW_PROGRESS, this.latest)
    }

    // 立刻推一帧，让 IPC 可以提前返回并跳转报告页
    emit({
      progress: 5,
      progressLabel: '初始化审查任务…'
    })

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
    let ephemeralWorkDir = false

    /** 优先写入流水线工作区下的「分析报告」 */
    const resolveReportOutDir = (): string | undefined => {
      const projectRoot =
        (workDir && !ephemeralWorkDir ? workDir : '') ||
        resolvePipelineProjectRoot(pipeline?.workDir, report.repoUrl)
      if (projectRoot) return resolveAnalysisReportDir(projectRoot)
      const fallback = config.reportOutputDir?.trim()
      return fallback || undefined
    }

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
        enableGitClone: config.enableGitClone,
        branch: effectiveBranch,
        workDir: pipeline?.workDir
      })
      workDir = fetched.workDir
      // 仅显式 ephemeral 才视为临时目录；未返回时按持久工作区处理
      ephemeralWorkDir = fetched.ephemeral === true
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
            ['llm', '⑤ 大模型重点审查'],
            ...focusMethods.map(
              (m) => [`check:${m.id}`, `⑤ · ${m.name}`] as [string, string]
            ),
            ['merge', '⑥ 合并去重']
          ]
          let timeline = flow.snapshot()
          for (const [id, name] of skipRest) {
            timeline = flow.skip(id, name, '因缓存命中跳过')
          }

          // 先合并缓存内容，再写「分析报告」（缓存命中也要落盘到工作区）
          const cachedIssues = (cached.issues ?? []).filter(
            (issue) => issue.severity === 'error'
          )
          const cachedFiles = (cached.files ?? []).map((file) => ({
            ...file,
            issues: (file.issues ?? []).filter((issue) => issue.severity === 'error')
          }))
          Object.assign(report, {
            ...cached,
            id: report.id,
            createdAt: report.createdAt,
            pipelineId: report.pipelineId,
            branch: report.branch,
            runNote: report.runNote,
            methodIds: report.methodIds,
            fromCache: true,
            pullSource: 'cache' as const,
            issues: cachedIssues,
            files: cachedFiles
          })
          timeline = flow.begin('report', '⑦ 生成报告')
          report.summaryMarkdown = buildMarkdownSummary(report)
          const writtenDir = persistReportFiles(
            report,
            resolveReportOutDir(),
            reportFormats
          )
          timeline = flow.end(
            'report',
            'success',
            `已写入 ${writtenDir}（${reportFormats.join('/')}）`
          )

          timeline = flow.begin('done', '⑧ 完成')
          timeline = flow.end('done', 'success', '缓存复用完成')

          const reused: ReviewReport = {
            ...report,
            progress: 100,
            progressLabel: '⑧ 命中缓存，跳过扫描 / LLM',
            status: 'completed',
            ...finishMeta(flow, timeline)
          }
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
        // 报告/UI 只展示 error；warning/info 不进入中间态
        file.issues = issues.filter((issue) => issue.severity === 'error')
        return issues
      })
      const staticErrors = staticIssues.filter((issue) => issue.severity === 'error')
      emitFlow(
        flow.end(
          'static',
          'success',
          `命中 ${staticIssues.length} 条（错误 ${staticErrors.length}）· ${Date.now() - staticStarted}ms`
        ),
        {
          progress: 55,
          progressLabel: `④ 静态扫描完成 · 错误 ${staticErrors.length} 条`,
          issues: staticErrors,
          files: [...files]
        }
      )
      assertNotCancelled()

      // ⑤ 大模型重点审查（按流水线勾选的审查方式拆分子节点）
      const activeProvider = resolveActiveProvider(config)
      const canLlm =
        config.enableLlm &&
        (!!activeProvider?.apiKey?.trim() || activeProvider?.protocol === 'ollama')

      const matchMethodCount = (
        issues: typeof staticIssues,
        methodId: string
      ): number =>
        issues.filter((issue) => {
          const rid = (issue.ruleId || '').toLowerCase()
          const mid = methodId.toLowerCase()
          return rid === mid || rid.includes(mid) || rid.startsWith(`${mid}`)
        }).length

      let llmIssues: typeof staticIssues = []
      if (canLlm) {
        const focusLabel = focusMethods.length
          ? `重点 ${focusMethods.length} 项：${focusMethods.map((m) => m.name).join('、')}`
          : `${activeProvider?.name} · ${activeProvider?.model}`
        emitFlow(
          flow.begin(
            'llm',
            '⑤ 大模型重点审查',
            `${activeProvider?.name} · ${activeProvider?.model}${
              focusMethods.length ? ` · ${focusMethods.length} 项检查` : ''
            }`
          ),
          {
            progress: 60,
            progressLabel: `⑤ 大模型审查中 · ${focusLabel}`
          }
        )
        for (const method of focusMethods) {
          emitFlow(
            flow.begin(
              `check:${method.id}`,
              `⑤ · ${method.name}`,
              method.description
            ),
            {
              progressLabel: `⑤ 检查「${method.name}」…`
            }
          )
        }
        try {
          llmIssues = await runLlmReview(files, config, abort.signal, {
            focusHints,
            focusMethods,
            providerId: llmProviderId
          })
          for (const method of focusMethods) {
            const hit = matchMethodCount(llmIssues, method.id)
            emitFlow(
              flow.end(
                `check:${method.id}`,
                'success',
                hit > 0 ? `命中 ${hit} 条` : '未发现问题'
              )
            )
          }
          emitFlow(
            flow.end(
              'llm',
              'success',
              focusMethods.length
                ? `完成 ${focusMethods.length} 项重点检查 · 共 ${llmIssues.length} 条`
                : `返回 ${llmIssues.length} 条语义问题`
            ),
            {
              progress: 82,
              progressLabel: `⑤ 大模型完成 · ${llmIssues.length} 条`
            }
          )
        } catch (error) {
          if (abort.signal.aborted) throw new Error('审查已取消')
          const message = error instanceof Error ? error.message : String(error)
          for (const method of focusMethods) {
            emitFlow(
              flow.end(`check:${method.id}`, 'failed', message.slice(0, 120))
            )
          }
          emitFlow(flow.end('llm', 'failed', message.slice(0, 240)), {
            progress: 82,
            progressLabel: `⑤ 大模型失败，继续生成报告`
          })
        }
      } else {
        emitFlow(
          flow.skip(
            'llm',
            '⑤ 大模型重点审查',
            '未启用或未配置 API Key'
          ),
          { progress: 70, progressLabel: '⑤ 跳过大模型审查' }
        )
        for (const method of focusMethods) {
          emitFlow(
            flow.skip(
              `check:${method.id}`,
              `⑤ · ${method.name}`,
              '大模型未启用，跳过该项'
            )
          )
        }
      }
      assertNotCancelled()

      // ⑥ 合并（报告只保留 error，丢弃 warning / info）
      emitFlow(flow.begin('merge', '⑥ 合并去重'), {
        progress: 88,
        progressLabel: '⑥ 合并问题列表…'
      })
      const merged = dedupeIssues([...staticIssues, ...llmIssues])
      const allIssues = merged.filter((issue) => issue.severity === 'error')
      for (const file of files) {
        file.issues = allIssues.filter((issue) => issue.filePath === file.filePath)
      }
      emitFlow(
        flow.end(
          'merge',
          'success',
          `静态 ${staticIssues.length} + LLM ${llmIssues.length} → 去重后 ${merged.length} · 错误 ${allIssues.length}`
        ),
        {
          progress: 90,
          progressLabel: `⑥ 去重完成 · 错误 ${allIssues.length} 条`,
          issues: allIssues,
          files: [...files]
        }
      )

      // ⑦ 生成报告摘要（落盘放到完成后只写一次，避免重复文件）
      emitFlow(flow.begin('report', '⑦ 生成报告'), {
        progress: 92,
        progressLabel: '⑦ 生成报告…'
      })
      report.summaryMarkdown = buildMarkdownSummary(report)
      emitFlow(flow.end('report', 'success', '摘要已生成'), {
        progress: 96,
        progressLabel: '⑦ 报告摘要已生成',
        summaryMarkdown: report.summaryMarkdown
      })

      // ⑧ 完成并落盘（每种格式各一份）
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
      // 落盘前再次写回，避免中间 patch/缓存复用丢掉备注
      if (runNote) report.runNote = runNote
      if (effectiveBranch) report.branch = effectiveBranch
      report.summaryMarkdown = buildMarkdownSummary(report)
      const outputDir = persistReportFiles(
        report,
        resolveReportOutDir(),
        reportFormats
      )

      emit({
        ...finished,
        summaryMarkdown: report.summaryMarkdown,
        runNote: report.runNote,
        branch: report.branch,
        progressLabel: `⑧ 审查完成 · 已写入 ${outputDir}`
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

      if (runNote) report.runNote = runNote
      if (effectiveBranch) report.branch = effectiveBranch

      emit({
        status,
        progress: report.progress,
        progressLabel: status === 'cancelled' ? '已取消' : '审查失败',
        error: message,
        runNote: report.runNote,
        branch: report.branch,
        ...finishMeta(flow, timeline)
      })
      saveReviewReport(report)
      if (config.notifyOnComplete) notifyReviewFinished(report)
      return { ...report }
    } finally {
      // 用户配置的工作目录保留本地代码，仅清理临时目录
      if (ephemeralWorkDir) cleanupGitWorkDir(workDir)
      cancelledIds.delete(report.id)
      abortControllers.delete(report.id)
    }
  }
}

export const reviewOrchestrator = new ReviewOrchestrator()
