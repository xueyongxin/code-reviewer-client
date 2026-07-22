import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AppConfig,
  ElectronAPI,
  MemoryListQuery,
  PostPrCommentsPayload,
  ReviewReport,
  SendChatPayload,
  StartReviewPayload,
  UpsertMemoryInput
} from '../shared/types'
import { IPC_CHANNELS } from '../shared/ipc'

const api: ElectronAPI = {
  getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.GET_CONFIG),
  saveConfig: (config: AppConfig) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_CONFIG, config),
  verifyExternalApp: (payload) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXTERNAL_APP_VERIFY, payload),
  getExternalAppSecret: (providerId) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXTERNAL_APP_GET_SECRET, providerId),
  listExternalAppRepos: (payload) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXTERNAL_APP_LIST_REPOS, payload),
  listExternalAppBranches: (payload) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXTERNAL_APP_LIST_BRANCHES, payload),
  listMcpStatus: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_LIST_STATUS),
  connectMcp: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_CONNECT, serverId),
  disconnectMcp: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_DISCONNECT, serverId),
  listMcpRepos: (payload?: string | { serverId?: string; forceRefresh?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_LIST_REPOS, payload),
  listMcpBranches: (payload) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_LIST_BRANCHES, payload),
  listRepoFiles: (payload) => ipcRenderer.invoke(IPC_CHANNELS.REPO_LIST_FILES, payload),
  readRepoFile: (payload) => ipcRenderer.invoke(IPC_CHANNELS.REPO_READ_FILE, payload),
  writeRepoFile: (payload) => ipcRenderer.invoke(IPC_CHANNELS.REPO_WRITE_FILE, payload),
  openLocalFolder: () => ipcRenderer.invoke(IPC_CHANNELS.LOCAL_OPEN_FOLDER),
  pickLocalDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.LOCAL_PICK_DIRECTORY),
  listLocalFolder: (rootPath) =>
    ipcRenderer.invoke(IPC_CHANNELS.LOCAL_LIST_FOLDER, rootPath),
  readLocalFile: (payload) => ipcRenderer.invoke(IPC_CHANNELS.LOCAL_READ_FILE, payload),
  writeLocalFile: (payload) => ipcRenderer.invoke(IPC_CHANNELS.LOCAL_WRITE_FILE, payload),
  saveLocalFileDialog: (payload) =>
    ipcRenderer.invoke(IPC_CHANNELS.LOCAL_SAVE_DIALOG, payload),
  createLocalDir: (payload) => ipcRenderer.invoke(IPC_CHANNELS.LOCAL_CREATE_DIR, payload),
  deleteLocalEntry: (payload) => ipcRenderer.invoke(IPC_CHANNELS.LOCAL_DELETE, payload),
  renameLocalEntry: (payload) => ipcRenderer.invoke(IPC_CHANNELS.LOCAL_RENAME, payload),
  createRepoDir: (payload) => ipcRenderer.invoke(IPC_CHANNELS.REPO_CREATE_DIR, payload),
  revealInFolder: (targetPath) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_REVEAL_IN_FOLDER, targetPath),
  openInTerminal: (targetPath) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_IN_TERMINAL, targetPath),
  startReview: (payload: StartReviewPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.REVIEW_START, payload),
  startBatchReview: (payloads: StartReviewPayload[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.REVIEW_BATCH, payloads),
  cancelReview: (reportId: string) => ipcRenderer.invoke(IPC_CHANNELS.REVIEW_CANCEL, reportId),
  getLatestReport: () => ipcRenderer.invoke(IPC_CHANNELS.REVIEW_LATEST),
  getReportHistory: () => ipcRenderer.invoke(IPC_CHANNELS.REVIEW_HISTORY),
  getReportById: (reportId: string) => ipcRenderer.invoke(IPC_CHANNELS.REVIEW_GET, reportId),
  deleteReport: (reportId: string) => ipcRenderer.invoke(IPC_CHANNELS.REVIEW_DELETE, reportId),
  postPrComments: (payload: PostPrCommentsPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.REVIEW_POST_COMMENTS, payload),
  importCustomRules: () => ipcRenderer.invoke(IPC_CHANNELS.RULES_IMPORT),
  checkForUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK),
  runDocDemoReviews: () => ipcRenderer.invoke(IPC_CHANNELS.REVIEW_RUN_DOC_DEMO),
  listChatSessions: () => ipcRenderer.invoke(IPC_CHANNELS.CHAT_LIST),
  getChatSession: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET, sessionId),
  createChatSession: (reportId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_CREATE, reportId),
  deleteChatSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_DELETE, sessionId),
  sendChatMessage: (payload: SendChatPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, payload),
  cancelChatGeneration: () => ipcRenderer.invoke(IPC_CHANNELS.CHAT_CANCEL),
  listMemories: (query?: MemoryListQuery) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_LIST, query),
  getMemory: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET, id),
  upsertMemory: (input: UpsertMemoryInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_UPSERT, input),
  deleteMemory: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DELETE, id),
  setMemoryEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SET_ENABLED, id, enabled),
  getMemoryStats: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_STATS),
  distillChatMemories: (payload) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DISTILL_CHAT, payload),
  clearOldestMemories: (count?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_CLEAR_OLDEST, count),
  exportMemories: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_EXPORT),
  importMemories: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_IMPORT),
  importMemoriesFromMcp: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_IMPORT_MCP),
  cloudLogin: (payload) => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_LOGIN, payload),
  cloudLoginPhone: (payload) => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_LOGIN_PHONE, payload),
  cloudLoginSms: (payload) => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_LOGIN_SMS, payload),
  cloudSendSms: (payload) => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_SEND_SMS, payload),
  cloudRegister: (payload) => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_REGISTER, payload),
  cloudRegisterPhone: (payload) =>
    ipcRenderer.invoke(IPC_CHANNELS.CLOUD_REGISTER_PHONE, payload),
  cloudStartBrowserLogin: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CLOUD_START_BROWSER_LOGIN),
  cloudOpenAccountManage: (nextPath?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CLOUD_OPEN_ACCOUNT_MANAGE, nextPath),
  onCloudAuthComplete: (callback) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { ok: boolean; config?: AppConfig; error?: string }
    ): void => {
      callback(payload)
    }
    ipcRenderer.on(IPC_CHANNELS.CLOUD_AUTH_COMPLETE, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CLOUD_AUTH_COMPLETE, listener)
    }
  },
  cloudRefreshProfile: () => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_REFRESH_PROFILE),
  cloudSyncEndpoints: () => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_SYNC_ENDPOINTS),
  cloudLogout: () => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_LOGOUT),
  cloudListOrgs: () => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_LIST_ORGS),
  cloudSetOrg: (payload) => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_SET_ORG, payload),
  cloudPullConfig: () => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_PULL_CONFIG),
  cloudUploadReport: () => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_UPLOAD_REPORT),
  cloudMcpCatalog: (q?: string) => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_MCP_CATALOG, q),
  cloudAddMcp: (itemKey: string) => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_ADD_MCP, itemKey),
  cloudReviewMethods: (q?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CLOUD_REVIEW_METHODS, q),
  cloudLlmCatalog: (q?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CLOUD_LLM_CATALOG, q),
  cloudCodeRepoCatalog: (q?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CLOUD_CODE_REPO_CATALOG, q),
  cloudChatCommands: (q?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CLOUD_CHAT_COMMANDS, q),
  onReviewProgress: (callback) => {
    const listener = (_event: IpcRendererEvent, report: ReviewReport): void => {
      callback(report)
    }
    ipcRenderer.on(IPC_CHANNELS.REVIEW_PROGRESS, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.REVIEW_PROGRESS, listener)
    }
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
