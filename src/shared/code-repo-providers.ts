/** 市面主流代码仓库平台（设置 → 代码仓库；服务端目录失败时本地兜底） */

export type CodeRepoProviderId = string

export interface CodeRepoProviderDef {
  /** 业务键，与服务端 catalog.key、本地 providers 配置一致 */
  id: CodeRepoProviderId
  name: string
  description: string
  /** 创建 Token 的文档/控制台地址 */
  tokenUrl?: string
  /** Logo 图片 URL（服务端下发；空则用本地内置图标） */
  logoUrl?: string
  /** 是否需要填写实例地址（自建 GitLab / Gitea / 其他） */
  needsBaseUrl?: boolean
  baseUrlPlaceholder?: string
  sortOrder?: number
}

/** 本地兜底列表（与 seed 初始数据对齐；仅服务端不可用时使用） */
export const CODE_REPO_PROVIDERS_FALLBACK: CodeRepoProviderDef[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: '连接 GitHub，访问公开/私有仓库，支持读取代码与 PR。',
    tokenUrl:
      'https://github.com/settings/tokens/new?scopes=repo&description=Code%20Reviewer',
    sortOrder: 10
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    description: '连接 GitLab.com 或自建 GitLab，访问项目与合并请求。',
    tokenUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
    needsBaseUrl: true,
    baseUrlPlaceholder: 'https://gitlab.com',
    sortOrder: 20
  },
  {
    id: 'gitee',
    name: 'Gitee',
    description: '连接码云 Gitee，访问企业/个人仓库。',
    tokenUrl: 'https://gitee.com/profile/personal_access_tokens',
    sortOrder: 30
  },
  {
    id: 'bitbucket',
    name: 'Bitbucket',
    description: '连接 Atlassian Bitbucket Cloud，访问仓库与 Pull Request。',
    tokenUrl: 'https://bitbucket.org/account/settings/app-passwords/',
    sortOrder: 40
  },
  {
    id: 'coding',
    name: 'CODING',
    description: '连接腾讯云 CODING DevOps，访问团队代码仓库。',
    tokenUrl: 'https://coding.net/user/account/setting/tokens',
    sortOrder: 50
  },
  {
    id: 'gitcode',
    name: 'GitCode',
    description: '连接华为云 GitCode / 开源社区仓库。',
    tokenUrl: 'https://gitcode.com/setting/token-classic',
    sortOrder: 60
  },
  {
    id: 'azure',
    name: 'Azure DevOps',
    description: '连接 Azure Repos，访问 Azure DevOps 中的 Git 仓库。',
    tokenUrl: 'https://dev.azure.com/',
    needsBaseUrl: true,
    baseUrlPlaceholder: 'https://dev.azure.com/org',
    sortOrder: 70
  },
  {
    id: 'gitea',
    name: 'Gitea',
    description: '连接自建或托管的 Gitea 实例。',
    needsBaseUrl: true,
    baseUrlPlaceholder: 'https://gitea.example.com',
    sortOrder: 80
  },
  {
    id: 'other',
    name: '其他 Git 仓库',
    description: '任意支持 HTTPS + Personal Access Token 的 Git 托管平台。',
    needsBaseUrl: true,
    baseUrlPlaceholder: 'https://git.example.com',
    sortOrder: 90
  }
]

/** @deprecated 请用 CODE_REPO_PROVIDERS_FALLBACK；保留别名避免旧引用炸掉 */
export const CODE_REPO_PROVIDERS = CODE_REPO_PROVIDERS_FALLBACK

export const mapCatalogToProviderDef = (item: {
  key: string
  name: string
  description?: string
  tokenUrl?: string
  logoUrl?: string
  needsBaseUrl?: boolean
  baseUrlPlaceholder?: string
  sortOrder?: number
}): CodeRepoProviderDef => ({
  id: item.key,
  name: item.name,
  description: item.description || '',
  tokenUrl: item.tokenUrl,
  logoUrl: item.logoUrl,
  needsBaseUrl: item.needsBaseUrl,
  baseUrlPlaceholder: item.baseUrlPlaceholder,
  sortOrder: item.sortOrder
})
