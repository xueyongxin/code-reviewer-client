import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import type { AppConfig, ChatMessage, ChatSession, ReviewReport } from '../../shared/types'

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
  `)
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
      SELECT id, session_id, role, content, created_at
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
    created_at: string
  }>

  return {
    ...rowToSession(row),
    messages: messages.map((m) => ({
      id: m.id,
      sessionId: m.session_id,
      role: m.role as ChatMessage['role'],
      content: m.content,
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
      INSERT INTO chat_messages (id, session_id, role, content, created_at)
      VALUES (@id, @session_id, @role, @content, @created_at)
    `
    )
    .run({
      id: message.id,
      session_id: message.sessionId,
      role: message.role,
      content: message.content,
      created_at: message.createdAt
    })
  database
    .prepare(`UPDATE chat_sessions SET updated_at = ? WHERE id = ?`)
    .run(message.createdAt, message.sessionId)
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


