/** 审查方式目录（对齐《代码审查.md》强制流程，可勾选进流水线） */
export interface ReviewMethodDef {
  id: string
  name: string
  /** 所属大类，用于展示分组 */
  group: string
  description: string
  /** 映射到静态规则 id（可选） */
  staticRuleIds?: string[]
}

/** 内置兜底（离线或服务端不可用时使用） */
export const FALLBACK_REVIEW_METHOD_CATALOG: ReviewMethodDef[] = [
  {
    id: 'null-check',
    name: '空指针 / 判空检测',
    group: '功能逻辑',
    description: '入参判空：空串、null、空数组、0、负数、超长参数',
    staticRuleIds: []
  },
  {
    id: 'exception-handling',
    name: '异常处理',
    group: '功能逻辑',
    description: '外部调用（DB/接口/缓存/文件）异常捕获、超时重试熔断',
    staticRuleIds: []
  },
  {
    id: 'business-logic',
    name: '业务逻辑正确性',
    group: '功能逻辑',
    description: '分支完整、计算精度、状态流转闭环',
    staticRuleIds: []
  },
  {
    id: 'concurrency',
    name: '并发安全',
    group: '功能逻辑',
    description: '锁与原子操作，防超卖、重复创建、重复扣款',
    staticRuleIds: []
  },
  {
    id: 'auth-check',
    name: '权限控制',
    group: '功能逻辑',
    description: '登录态、角色、数据权限，后端二次校验防越权',
    staticRuleIds: []
  },
  {
    id: 'sql-injection',
    name: 'SQL 注入',
    group: '安全漏洞',
    description: '禁止拼接 SQL，使用预编译参数化查询',
    staticRuleIds: []
  },
  {
    id: 'xss-csrf',
    name: 'XSS / CSRF',
    group: '安全漏洞',
    description: '输入过滤转义、接口 token 校验',
    staticRuleIds: []
  },
  {
    id: 'hardcoded-secret',
    name: '硬编码密钥',
    group: '安全漏洞',
    description: '密钥、token、连接串禁止硬编码',
    staticRuleIds: ['no-hardcoded-secret']
  },
  {
    id: 'sensitive-data',
    name: '敏感信息处理',
    group: '安全漏洞',
    description: '密码证件不明文、不落日志、不回传前端',
    staticRuleIds: ['no-hardcoded-secret']
  },
  {
    id: 'memory-leak',
    name: '内存泄漏',
    group: '性能资源',
    description: '连接关闭、无全局大集合膨胀、流式/分页处理',
    staticRuleIds: []
  },
  {
    id: 'db-performance',
    name: '数据库性能',
    group: '性能资源',
    description: '索引、禁循环查库、分页与事务范围',
    staticRuleIds: []
  },
  {
    id: 'code-style',
    name: '代码规范可读性',
    group: '规范可读',
    description: '命名、函数行数、注释、魔法数字、格式化',
    staticRuleIds: ['no-console-log', 'no-debugger', 'no-todo-fix', 'no-any-type']
  },
  {
    id: 'maintainability',
    name: '复用与可维护性',
    group: '可维护性',
    description: '去重、去硬编码、分层与解耦',
    staticRuleIds: []
  },
  {
    id: 'api-test',
    name: '接口测试覆盖',
    group: '测试覆盖',
    description: '新增/修改接口补充自动化用例，禁跳过关键测试',
    staticRuleIds: []
  },
  {
    id: 'unit-test',
    name: '单元测试覆盖',
    group: '测试覆盖',
    description: '核心业务/工具函数覆盖正常、异常、边界',
    staticRuleIds: []
  },
  {
    id: 'compat-ops',
    name: '兼容与运维',
    group: '兼容运维',
    description: '版本兼容、日志规范、告警埋点、回滚友好',
    staticRuleIds: []
  }
]

/** @deprecated 请使用 getReviewMethodCatalog()；保留导出名以兼容旧引用 */
export const REVIEW_METHOD_CATALOG = FALLBACK_REVIEW_METHOD_CATALOG

let cachedCatalog: ReviewMethodDef[] = [...FALLBACK_REVIEW_METHOD_CATALOG]

export const getReviewMethodCatalog = (): ReviewMethodDef[] => cachedCatalog

export const setReviewMethodCatalog = (items: ReviewMethodDef[]): void => {
  if (!items?.length) return
  cachedCatalog = items.map((m) => ({
    id: m.id,
    name: m.name,
    group: m.group,
    description: m.description || '',
    staticRuleIds: m.staticRuleIds ?? []
  }))
}

export const reviewMethodById = (id: string): ReviewMethodDef | undefined =>
  cachedCatalog.find((m) => m.id === id) ||
  FALLBACK_REVIEW_METHOD_CATALOG.find((m) => m.id === id)

export const resolveStaticRuleIds = (methodIds: string[]): string[] => {
  const ids = new Set<string>()
  for (const mid of methodIds) {
    const method = reviewMethodById(mid)
    for (const rid of method?.staticRuleIds ?? []) ids.add(rid)
  }
  return Array.from(ids)
}
