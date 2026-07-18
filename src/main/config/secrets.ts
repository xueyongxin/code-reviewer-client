import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app, safeStorage } from 'electron'

/** 磁盘密文前缀：safeStorage / AES 兜底 */
export const ENC_SS_PREFIX = 'enc::'
export const ENC_AES_PREFIX = 'enc:aes:'
/** 下发给渲染进程时的占位（非空，便于判断「已登录」） */
export const SECRET_MASK = '••••••••'

const isEncrypted = (value: string): boolean =>
  value.startsWith(ENC_SS_PREFIX) || value.startsWith(ENC_AES_PREFIX)

export const isSecretMasked = (value?: string | null): boolean => {
  if (!value) return false
  if (value === SECRET_MASK) return true
  return /^[•*]{4,}$/.test(value)
}

const keyFilePath = (): string => {
  const dir = join(app.getPath('userData'), 'security')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'local.key')
}

/** AES-256 本地密钥（safeStorage 不可用时） */
const getAesKey = (): Buffer => {
  const path = keyFilePath()
  if (existsSync(path)) {
    const raw = readFileSync(path)
    if (raw.length >= 32) return raw.subarray(0, 32)
  }
  const key = randomBytes(32)
  writeFileSync(path, key, { mode: 0o600 })
  return key
}

const encryptAes = (plain: string): string => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getAesKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENC_AES_PREFIX}${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`
}

const decryptAes = (value: string): string => {
  const body = value.slice(ENC_AES_PREFIX.length)
  const [ivB64, tagB64, dataB64] = body.split('.')
  if (!ivB64 || !tagB64 || !dataB64) return ''
  const decipher = createDecipheriv(
    'aes-256-gcm',
    getAesKey(),
    Buffer.from(ivB64, 'base64')
  )
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final()
  ]).toString('utf8')
}

/** 落盘加密：优先 OS safeStorage，否则 AES 本地密钥（不再明文落盘） */
export const encryptSecret = (value?: string): string => {
  if (!value) return ''
  if (isEncrypted(value)) return value
  if (isSecretMasked(value)) return value
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(value)
      return `${ENC_SS_PREFIX}${encrypted.toString('base64')}`
    }
  } catch {
    // fall through
  }
  return encryptAes(value)
}

export const decryptSecret = (value?: string): string => {
  if (!value) return ''
  if (isSecretMasked(value)) return ''
  if (value.startsWith(ENC_AES_PREFIX)) {
    try {
      return decryptAes(value)
    } catch {
      return ''
    }
  }
  if (value.startsWith(ENC_SS_PREFIX)) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const buf = Buffer.from(value.slice(ENC_SS_PREFIX.length), 'base64')
        return safeStorage.decryptString(buf)
      }
      // OS 加密不可用时无法解密历史 safeStorage 密文
      return ''
    } catch {
      return ''
    }
  }
  // 历史明文：读出后由下次 save 加密
  return value
}

export const maskSecret = (value?: string | null): string => {
  if (!value || isSecretMasked(value)) return value ? SECRET_MASK : ''
  // 已加密串不应下发
  if (isEncrypted(value)) return SECRET_MASK
  return SECRET_MASK
}

/** 是否像密钥类环境变量名 */
export const looksLikeSecretEnvKey = (key: string): boolean => {
  const k = key.toUpperCase()
  return /TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|AUTH|CREDENTIAL|PRIVATE/.test(
    k
  )
}

export const encryptEnvMap = (
  env?: Record<string, string>
): Record<string, string> | undefined => {
  if (!env) return env
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (!v) {
      next[k] = ''
      continue
    }
    // 非密钥类（如 API Base URL）可保持明文，便于排查
    next[k] = looksLikeSecretEnvKey(k) ? encryptSecret(v) : v
  }
  return next
}

export const decryptEnvMap = (
  env?: Record<string, string>
): Record<string, string> | undefined => {
  if (!env) return env
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    next[k] = looksLikeSecretEnvKey(k) ? decryptSecret(v) : v
  }
  return next
}

export const maskEnvMap = (
  env?: Record<string, string>
): Record<string, string> | undefined => {
  if (!env) return env
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    next[k] = looksLikeSecretEnvKey(k) && v ? SECRET_MASK : v
  }
  return next
}

/**
 * 渲染进程回写：掩码或空串视为「未改」，保留原值。
 * 主进程内部请直接写明文/空串，不要走此合并。
 */
export const mergeSecretField = (
  incoming: string | undefined,
  existing: string | undefined
): string => {
  if (incoming == null) return existing || ''
  if (isSecretMasked(incoming)) return existing || ''
  if (incoming === '') return existing || ''
  return incoming
}

export const mergeEnvMaps = (
  incoming?: Record<string, string>,
  existing?: Record<string, string>
): Record<string, string> | undefined => {
  if (!incoming && !existing) return incoming
  const keys = Array.from(
    new Set([...Object.keys(incoming || {}), ...Object.keys(existing || {})])
  )
  const next: Record<string, string> = {}
  for (const k of keys) {
    const inc = incoming?.[k]
    const ex = existing?.[k]
    if (inc === undefined) {
      // 入站未带该键：若仍在 existing 且像密钥则保留（避免整表覆盖丢密钥）
      if (ex !== undefined) next[k] = ex
      continue
    }
    next[k] = looksLikeSecretEnvKey(k) ? mergeSecretField(inc, ex) : inc
  }
  return next
}

/** 指纹：不暴露明文，供调试 */
export const secretFingerprint = (value?: string): string => {
  if (!value) return ''
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}
