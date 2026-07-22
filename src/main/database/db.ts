import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import type {
  AppConfig,
  ChatMessage,
  ChatSession,
  LlmMemory,
  MemoryKind,
  MemoryListQuery,
  MemoryScope,
  MemorySource,
  MemoryStats,
  ReviewReport,
  UpsertMemoryInput
} from '../../shared/types'

let db: Database.Database | null = null

const getDataDir = (): string => {
  const dir = join(app.getPath('userData'), 'data')
  mkdirSync(dir, { recursive: true })
  return dir
}

const getDbPath = (): string => join(getDataDir(), 'review-history.db')

const getLegacyJsonPath = (): string => join(getDataDir(), 'review-history.json')

const rowToReport = (row: { payload: string }): ReviewReport => {
  return JSON.parse(row.payload) as ReviewReport
}

const ensureSchema = (database: Database.Database): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS review_reports (
      id TEXT PRIMARY KEY,
      repo_url TEXT NOT NULL,
      pr_number TEXT,
      commit_sha TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      total_duration_ms INTEGER,
      issue_count INTEGER NOT NULL DEFAULT 0,
      from_cache INTEGER NOT NULL DEFAULT 0,
      pull_source TEXT,
      payload TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_reports_created
      ON review_reports(created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_reports_commit
      ON review_reports(commit_sha);

    CREATE INDEX IF NOT EXISTS idx_reports_status_commit
      ON review_reports(status, commit_sha);

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      report_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated
      ON chat_sessions(updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_chat_messages_session
      ON chat_messages(session_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS app_config (
      id TEXT PRIMARY KEY CHECK (id = 'default'),
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ext_app_repo_cache (
      id TEXT PRIMARY KEY CHECK (id = 'default'),
      fingerprint TEXT NOT NULL,
      repos_json TEXT NOT NULL,
      errors_json TEXT NOT NULL DEFAULT '[]',
      fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_memories (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      repo_url TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_llm_memories_updated
      ON llm_memories(updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_llm_memories_scope_repo
      ON llm_memories(scope, repo_url);
  `)

  const chatCols = database
    .prepare(`PRAGMA table_info(chat_messages)`)
    .all() as Array<{ name: string }>
  if (!chatCols.some((c) => c.name === 'thinking')) {
    database.exec(`ALTER TABLE chat_messages ADD COLUMN thinking TEXT`)
  }
}

/** 将旧版 JSON 历史一次性迁移进 SQLite */
const migrateFromJsonIfNeeded = (database: Database.Database): void => {
  const jsonPath = getLegacyJsonPath()
  if (!existsSync(jsonPath)) return

  const count = database.prepare('SELECT COUNT(*) AS c FROM review_reports').get() as {
    c: number
  }
  if (count.c > 0) {
    // 已有 SQLite 数据，备份 JSON 后结束
    try {
      renameSync(jsonPath, `${jsonPath}.migrated.bak`)
    } catch {
      // ignore
    }
    return
  }

  try {
    const raw = JSON.parse(readFileSync(jsonPath, 'utf-8')) as {
      reports?: ReviewReport[]
    }
    const reports = raw.reports ?? []
    const insert = database.prepare(`
      INSERT OR REPLACE INTO review_reports (
        id, repo_url, pr_number, commit_sha, status, created_at, finished_at,
        total_duration_ms, issue_count, from_cache, pull_source, payload
      ) VALUES (
        @id, @repo_url, @pr_number, @commit_sha, @status, @created_at, @finished_at,
        @total_duration_ms, @issue_count, @from_cache, @pull_source, @payload
      )
    `)

    const tx = database.transaction((items: ReviewReport[]) => {
      for (const report of items) {
        insert.run({
          id: report.id,
          repo_url: report.repoUrl,
          pr_number: report.prNumber ?? null,
          commit_sha: report.commitSha ?? null,
          status: report.status,
          created_at: report.createdAt,
          finished_at: report.finishedAt ?? null,
          total_duration_ms: report.totalDurationMs ?? null,
          issue_count: report.issues?.length ?? 0,
          from_cache: report.fromCache ? 1 : 0,
          pull_source: report.pullSource ?? null,
          payload: JSON.stringify(report)
        })
      }
    })
    tx(reports)

    renameSync(jsonPath, `${jsonPath}.migrated.bak`)
    console.info(`[db] 已从 JSON 迁移 ${reports.length} 条审查记录到 SQLite`)
  } catch (error) {
    console.warn('[db] JSON 迁移失败，保留原文件:', error)
  }
}

const getDb = (): Database.Database => {
  if (db) return db
  db = new Database(getDbPath())
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  ensureSchema(db)
  migrateFromJsonIfNeeded(db)
  return db
}

const trimOldReports = (database: Database.Database, keep = 100): void => {
  database
    .prepare(
      `
      DELETE FROM review_reports
      WHERE id NOT IN (
        SELECT id FROM review_reports
        ORDER BY created_at DESC
        LIMIT ?
      )
    `
    )
    .run(keep)
}

export const initDatabase = (): void => {
  getDb()
}

export const saveReviewReport = (report: ReviewReport): void => {
  const database = getDb()
  database
    .prepare(
      `
      INSERT OR REPLACE INTO review_reports (
        id, repo_url, pr_number, commit_sha, status, created_at, finished_at,
        total_duration_ms, issue_count, from_cache, pull_source, payload
      ) VALUES (
        @id, @repo_url, @pr_number, @commit_sha, @status, @created_at, @finished_at,
        @total_duration_ms, @issue_count, @from_cache, @pull_source, @payload
      )
    `
    )
    .run({
      id: report.id,
      repo_url: report.repoUrl,
      pr_number: report.prNumber ?? null,
      commit_sha: report.commitSha ?? null,
      status: report.status,
      created_at: report.createdAt,
      finished_at: report.finishedAt ?? null,
      total_duration_ms: report.totalDurationMs ?? null,
      issue_count: report.issues?.length ?? 0,
      from_cache: report.fromCache ? 1 : 0,
      pull_source: report.pullSource ?? null,
      payload: JSON.stringify(report)
    })
  trimOldReports(database, 100)
}

export const getLatestReviewReport = (): ReviewReport | null => {
  const row = getDb()
    .prepare(
      `
      SELECT payload FROM review_reports
      ORDER BY created_at DESC
      LIMIT 1
    `
    )
    .get() as { payload: string } | undefined
  return row ? rowToReport(row) : null
}

export const listReviewReports = (limit = 50): ReviewReport[] => {
  const rows = getDb()
    .prepare(
      `
      SELECT payload FROM review_reports
      ORDER BY created_at DESC
      LIMIT ?
    `
    )
    .all(limit) as Array<{ payload: string }>
  return rows.map(rowToReport)
}

export const getReviewReportById = (reportId: string): ReviewReport | null => {
  const row = getDb()
    .prepare(`SELECT payload FROM review_reports WHERE id = ?`)
    .get(reportId) as { payload: string } | undefined
  return row ? rowToReport(row) : null
}

export const deleteReviewReport = (reportId: string): boolean => {
  const result = getDb()
    .prepare(`DELETE FROM review_reports WHERE id = ?`)
    .run(reportId)
  return result.changes > 0
}

export const findCachedReportByCommitSha = (commitSha: string): ReviewReport | null => {
  if (!commitSha) return null
  const row = getDb()
    .prepare(
      `
      SELECT payload FROM review_reports
      WHERE commit_sha = ? AND status = 'completed'
      ORDER BY created_at DESC
      LIMIT 1
    `
    )
    .get(commitSha) as { payload: string } | undefined
  return row ? rowToReport(row) : null
}

export const buildContentFingerprint = (
  repoUrl: string,
  prNumber: string | undefined,
  files: Array<{ filePath: string; content: string }>
): string => {
  const hash = createHash('sha256')
  hash.update(repoUrl)
  hash.update('|')
  hash.update(prNumber ?? '')
  hash.update('|')
  for (const file of files) {
    hash.update(file.filePath)
    hash.update('\n')
    hash.update(file.content)
    hash.update('\n---\n')
  }
  return hash.digest('hex')
}

/** 关闭数据库（测试/退出时可选调用） */
export const closeDatabase = (): void => {
  if (db) {
    db.close()
    db = null
  }
}

const rowToSession = (row: {
  id: string
  title: string
  report_id: string | null
  created_at: string
  updated_at: string
}): ChatSession => ({
  id: row.id,
  title: row.title,
  reportId: row.report_id ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  messages: []
})

export const listChatSessions = (limit = 50): ChatSession[] => {
  const rows = getDb()
    .prepare(
      `
      SELECT id, title, report_id, created_at, updated_at
      FROM chat_sessions
      ORDER BY updated_at DESC
      LIMIT ?
    `
    )
    .all(limit) as Array<{
    id: string
    title: string
    report_id: string | null
    created_at: string
    updated_at: string
  }>
  return rows.map(rowToSession)
}

export const getChatSessionById = (sessionId: string): ChatSession | null => {
  const row = getDb()
    .prepare(
      `
      SELECT id, title, report_id, created_at, updated_at
      FROM chat_sessions WHERE id = ?
    `
    )
    .get(sessionId) as
    | {
        id: string
        title: string
        report_id: string | null
        created_at: string
        updated_at: string
      }
    | undefined
  if (!row) return null

  const messages = getDb()
    .prepare(
      `
      SELECT id, session_id, role, content, thinking, created_at
      FROM chat_messages
      WHERE session_id = ?
      ORDER BY created_at ASC
    `
    )
    .all(sessionId) as Array<{
    id: string
    session_id: string
    role: string
    content: string
    thinking: string | null
    created_at: string
  }>

  return {
    ...rowToSession(row),
    messages: messages.map((m) => ({
      id: m.id,
      sessionId: m.session_id,
      role: m.role as ChatMessage['role'],
      content: m.content,
      thinking: m.thinking?.trim() || undefined,
      createdAt: m.created_at
    }))
  }
}

export const createChatSession = (input: {
  id: string
  title: string
  reportId?: string
}): ChatSession => {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `
      INSERT INTO chat_sessions (id, title, report_id, created_at, updated_at)
      VALUES (@id, @title, @report_id, @created_at, @updated_at)
    `
    )
    .run({
      id: input.id,
      title: input.title,
      report_id: input.reportId ?? null,
      created_at: now,
      updated_at: now
    })
  return {
    id: input.id,
    title: input.title,
    reportId: input.reportId,
    createdAt: now,
    updatedAt: now,
    messages: []
  }
}

export const updateChatSessionMeta = (
  sessionId: string,
  patch: { title?: string; reportId?: string | null }
): void => {
  const session = getChatSessionById(sessionId)
  if (!session) return
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `
      UPDATE chat_sessions
      SET title = @title, report_id = @report_id, updated_at = @updated_at
      WHERE id = @id
    `
    )
    .run({
      id: sessionId,
      title: patch.title ?? session.title,
      report_id:
        patch.reportId === undefined ? (session.reportId ?? null) : patch.reportId,
      updated_at: now
    })
}

export const appendChatMessage = (message: ChatMessage): void => {
  const database = getDb()
  database
    .prepare(
      `
      INSERT INTO chat_messages (id, session_id, role, content, thinking, created_at)
      VALUES (@id, @session_id, @role, @content, @thinking, @created_at)
    `
    )
    .run({
      id: message.id,
      session_id: message.sessionId,
      role: message.role,
      content: message.content,
      thinking: message.thinking?.trim() || null,
      created_at: message.createdAt
    })
  database
    .prepare(`UPDATE chat_sessions SET updated_at = ? WHERE id = ?`)
    .run(message.createdAt, message.sessionId)
}

/** 删除会话末尾连续的 assistant 消息（供重新生成） */
export const deleteTrailingAssistantMessages = (sessionId: string): number => {
  const session = getChatSessionById(sessionId)
  if (!session?.messages.length) return 0
  const ids: string[] = []
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i]
    if (msg.role !== 'assistant') break
    ids.push(msg.id)
  }
  if (!ids.length) return 0
  const database = getDb()
  const del = database.prepare(`DELETE FROM chat_messages WHERE id = ?`)
  const tx = database.transaction((list: string[]) => {
    for (const id of list) del.run(id)
    database
      .prepare(`UPDATE chat_sessions SET updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), sessionId)
  })
  tx(ids)
  return ids.length
}

export const deleteChatSession = (sessionId: string): void => {
  const database = getDb()
  const tx = database.transaction((id: string) => {
    database.prepare(`DELETE FROM chat_messages WHERE session_id = ?`).run(id)
    database.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(id)
  })
  tx(sessionId)
}

export const getAppConfigPayload = (): AppConfig | null => {
  const row = getDb()
    .prepare(`SELECT payload FROM app_config WHERE id = 'default'`)
    .get() as { payload: string } | undefined
  if (!row?.payload) return null
  try {
    return JSON.parse(row.payload) as AppConfig
  } catch {
    return null
  }
}

export const saveAppConfigPayload = (config: AppConfig): void => {
  getDb()
    .prepare(
      `
      INSERT INTO app_config (id, payload, updated_at)
      VALUES ('default', @payload, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `
    )
    .run({
      payload: JSON.stringify(config),
      updated_at: new Date().toISOString()
    })
}

export type ExtAppRepoCacheRow = {
  fingerprint: string
  repos: unknown[]
  errors: string[]
  fetchedAt: number
}

export const getExtAppRepoCache = (): ExtAppRepoCacheRow | null => {
  const row = getDb()
    .prepare(
      `SELECT fingerprint, repos_json, errors_json, fetched_at
       FROM ext_app_repo_cache WHERE id = 'default'`
    )
    .get() as
    | {
        fingerprint: string
        repos_json: string
        errors_json: string
        fetched_at: number
      }
    | undefined
  if (!row) return null
  try {
    const repos = JSON.parse(row.repos_json) as unknown[]
    const errors = JSON.parse(row.errors_json || '[]') as string[]
    if (!Array.isArray(repos)) return null
    return {
      fingerprint: row.fingerprint,
      repos,
      errors: Array.isArray(errors) ? errors : [],
      fetchedAt: Number(row.fetched_at) || 0
    }
  } catch {
    return null
  }
}

export const setExtAppRepoCache = (input: {
  fingerprint: string
  repos: unknown[]
  errors: string[]
}): void => {
  getDb()
    .prepare(
      `
      INSERT INTO ext_app_repo_cache (id, fingerprint, repos_json, errors_json, fetched_at)
      VALUES ('default', @fingerprint, @repos_json, @errors_json, @fetched_at)
      ON CONFLICT(id) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        repos_json = excluded.repos_json,
        errors_json = excluded.errors_json,
        fetched_at = excluded.fetched_at
    `
    )
    .run({
      fingerprint: input.fingerprint,
      repos_json: JSON.stringify(input.repos),
      errors_json: JSON.stringify(input.errors),
      fetched_at: Date.now()
    })
}

export const clearExtAppRepoCache = (): void => {
  getDb().prepare(`DELETE FROM ext_app_repo_cache`).run()
}

const parseTags = (raw: string | null | undefined): string[] => {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      : []
  } catch {
    return []
  }
}

const rowToMemory = (row: {
  id: string
  title: string
  content: string
  kind: string
  scope: string
  repo_url: string | null
  tags_json: string
  enabled: number
  source: string
  created_at: string
  updated_at: string
}): LlmMemory => ({
  id: row.id,
  title: row.title,
  content: row.content,
  kind: row.kind as MemoryKind,
  scope: row.scope as MemoryScope,
  repoUrl: row.repo_url || undefined,
  tags: parseTags(row.tags_json),
  enabled: Boolean(row.enabled),
  source: (['manual', 'remember', 'chat', 'review'].includes(row.source)
    ? row.source
    : 'manual') as MemorySource,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

export const normalizeMemoryRepoUrl = (repoUrl?: string | null): string => {
  const raw = (repoUrl || '').trim()
  if (!raw) return ''
  return raw
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

export const listLlmMemories = (query: MemoryListQuery = {}): LlmMemory[] => {
  const rows = getDb()
    .prepare(
      `
      SELECT *
      FROM llm_memories
      ORDER BY updated_at DESC
      LIMIT 500
    `
    )
    .all() as Array<Parameters<typeof rowToMemory>[0]>

  const q = (query.q || '').trim().toLowerCase()
  const repo = normalizeMemoryRepoUrl(query.repoUrl)
  const scope = query.scope || 'all'
  const kind = query.kind || 'all'

  return rows
    .map(rowToMemory)
    .filter((m) => {
      if (query.enabledOnly && !m.enabled) return false
      if (kind !== 'all' && m.kind !== kind) return false
      if (scope === 'global' && m.scope !== 'global') return false
      if (scope === 'repo') {
        if (m.scope !== 'repo') return false
        if (repo && normalizeMemoryRepoUrl(m.repoUrl) !== repo) return false
      }
      if (!q) return true
      const hay = `${m.title}\n${m.content}\n${m.tags.join(' ')}`.toLowerCase()
      return hay.includes(q)
    })
}

export const getLlmMemoryById = (id: string): LlmMemory | null => {
  const row = getDb()
    .prepare(`SELECT * FROM llm_memories WHERE id = ?`)
    .get(id) as Parameters<typeof rowToMemory>[0] | undefined
  return row ? rowToMemory(row) : null
}

export const upsertLlmMemory = (input: UpsertMemoryInput): LlmMemory => {
  const now = new Date().toISOString()
  const id = input.id?.trim() || randomUUID()
  const existing = input.id ? getLlmMemoryById(id) : null
  const scope: MemoryScope = input.scope || existing?.scope || 'global'
  const repoUrl =
    scope === 'repo'
      ? normalizeMemoryRepoUrl(input.repoUrl ?? existing?.repoUrl) || undefined
      : undefined
  const title = (input.title || existing?.title || '').trim() || '未命名记忆'
  const content = (input.content || existing?.content || '').trim()
  if (!content) throw new Error('记忆内容不能为空')

  const kind: MemoryKind = input.kind || existing?.kind || 'note'
  const tags = input.tags ?? existing?.tags ?? []
  const enabled = input.enabled ?? existing?.enabled ?? true
  const source = input.source || existing?.source || 'manual'
  const createdAt = existing?.createdAt || now

  getDb()
    .prepare(
      `
      INSERT INTO llm_memories (
        id, title, content, kind, scope, repo_url, tags_json, enabled, source, created_at, updated_at
      ) VALUES (
        @id, @title, @content, @kind, @scope, @repo_url, @tags_json, @enabled, @source, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        kind = excluded.kind,
        scope = excluded.scope,
        repo_url = excluded.repo_url,
        tags_json = excluded.tags_json,
        enabled = excluded.enabled,
        source = excluded.source,
        updated_at = excluded.updated_at
    `
    )
    .run({
      id,
      title,
      content,
      kind,
      scope,
      repo_url: repoUrl || null,
      tags_json: JSON.stringify(tags),
      enabled: enabled ? 1 : 0,
      source,
      created_at: createdAt,
      updated_at: now
    })

  return getLlmMemoryById(id)!
}

export const deleteLlmMemory = (id: string): void => {
  getDb().prepare(`DELETE FROM llm_memories WHERE id = ?`).run(id)
}

export const setLlmMemoryEnabled = (
  id: string,
  enabled: boolean
): LlmMemory | null => {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `UPDATE llm_memories SET enabled = ?, updated_at = ? WHERE id = ?`
    )
    .run(enabled ? 1 : 0, now, id)
  return getLlmMemoryById(id)
}

export const countLlmMemories = (): number => {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM llm_memories`)
    .get() as { c: number }
  return Number(row?.c || 0)
}

export const getLlmMemoryStats = (maxCount: number): MemoryStats => {
  const total = countLlmMemories()
  const enabledRow = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM llm_memories WHERE enabled = 1`)
    .get() as { c: number }
  return {
    total,
    enabled: Number(enabledRow?.c || 0),
    maxCount
  }
}

/** 删除最旧的 n 条（按 updated_at ASC） */
export const deleteOldestLlmMemories = (n: number): number => {
  if (n <= 0) return 0
  const rows = getDb()
    .prepare(
      `SELECT id FROM llm_memories ORDER BY updated_at ASC LIMIT ?`
    )
    .all(n) as Array<{ id: string }>
  const del = getDb().prepare(`DELETE FROM llm_memories WHERE id = ?`)
  const tx = getDb().transaction((ids: string[]) => {
    for (const id of ids) del.run(id)
  })
  tx(rows.map((r) => r.id))
  return rows.length
}

/** 超出上限时清理，返回删除条数 */
export const enforceLlmMemoryCapacity = (maxCount: number): number => {
  const limit = Math.max(20, Math.min(1000, maxCount || 200))
  const total = countLlmMemories()
  if (total <= limit) return 0
  return deleteOldestLlmMemories(total - limit)
}

