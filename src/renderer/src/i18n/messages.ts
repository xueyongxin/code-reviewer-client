import type { AppLocale } from '../prefs/appearance'

const zh = {
  'nav.newReview': '新建审查',
  'nav.records': '审查记录',
  'nav.chat': '对话',
  'nav.taskList': '任务列表',
  'nav.noTasks': '暂无任务',
  'nav.guest': '未登录',
  'nav.clickLogin': '点击登录',
  'nav.openingLogin': '正在打开…',
  'nav.expandSider': '展开侧栏',
  'nav.collapseSider': '折叠侧栏',

  'menu.language': '语言',
  'menu.theme': '主题',
  'menu.settings': '设置',
  'menu.upgrade': '升级权益',
  'menu.manageAccount': '管理账号',
  'menu.messages': '消息',
  'menu.reportIssue': '报告问题',
  'menu.logout': '退出登录',
  'menu.free': '免费',
  'menu.loggedIn': '已登录',

  'settings.account': '账号',
  'settings.general': '通用',
  'settings.mcp': 'MCP',
  'settings.models': '模型',
  'settings.rules': '规则',
  'settings.loading': '正在加载配置…',

  'general.title': '通用',
  'general.basic': '基础设置',
  'general.theme': '主题',
  'general.themeDesc': '选择主题',
  'general.themeLight': '亮色',
  'general.themeDark': '暗色',
  'general.themeSystem': '跟随系统',
  'general.language': '语言',
  'general.languageDesc': '此设置将影响按钮标签和应用文本',
  'general.langZh': '简体中文',
  'general.langEn': 'English',
  'general.prefs': '偏好设置',
  'general.notify': '审查完成系统通知',
  'general.notifyDesc': '开启后，审查任务完成时通过系统通知提醒',
  'general.gitClone': '允许 Git 直连克隆',
  'general.gitCloneDesc': '在未配置 MCP 时，允许通过 Git 直接拉取代码进行审查',

  'account.title': '账号',
  'account.info': '账户信息',
  'account.manage': '管理账号',
  'account.upgrade': '升级权益',
  'account.upgradeDesc': '升级可获得更多审查额度与高级能力',
  'account.usage': '审查用量',
  'account.usageAvailable': '可用',
  'account.usageTimes': '次',
  'account.autoUpload': '自动上传报告',
  'account.autoUploadDesc':
    '开启后，本地审查完成时将自动把报告同步到云端，便于多端查看与团队协作。关闭则仅保存在本机。',
  'account.logout': '退出登录',
  'account.notLoggedIn': '未登录',
  'account.guestHint':
    '请点击左下角「点击登录」，将打开浏览器完成手机号验证码授权；地址由服务后台动态下发，无需在客户端配置。',
  'account.noPhone': '未绑定手机',
  'account.org': '组织',
  'account.more': '更多',
  'account.superAdmin': '超管',
  'account.clickToLogin': '点击账号完成登录'
} as const

export type MessageKey = keyof typeof zh
type Dict = Record<MessageKey, string>

const en: Dict = {
  'nav.newReview': 'New Review',
  'nav.records': 'Records',
  'nav.chat': 'Chat',
  'nav.taskList': 'Tasks',
  'nav.noTasks': 'No tasks',
  'nav.guest': 'Not signed in',
  'nav.clickLogin': 'Sign in',
  'nav.openingLogin': 'Opening…',
  'nav.expandSider': 'Expand sidebar',
  'nav.collapseSider': 'Collapse sidebar',

  'menu.language': 'Language',
  'menu.theme': 'Theme',
  'menu.settings': 'Settings',
  'menu.upgrade': 'Upgrade',
  'menu.manageAccount': 'Manage account',
  'menu.messages': 'Messages',
  'menu.reportIssue': 'Report issue',
  'menu.logout': 'Log out',
  'menu.free': 'Free',
  'menu.loggedIn': 'Signed in',

  'settings.account': 'Account',
  'settings.general': 'General',
  'settings.mcp': 'MCP',
  'settings.models': 'Models',
  'settings.rules': 'Rules',
  'settings.loading': 'Loading settings…',

  'general.title': 'General',
  'general.basic': 'Basics',
  'general.theme': 'Theme',
  'general.themeDesc': 'Choose a theme',
  'general.themeLight': 'Light',
  'general.themeDark': 'Dark',
  'general.themeSystem': 'System',
  'general.language': 'Language',
  'general.languageDesc': 'Affects button labels and app text',
  'general.langZh': '简体中文',
  'general.langEn': 'English',
  'general.prefs': 'Preferences',
  'general.notify': 'Notify when review finishes',
  'general.notifyDesc': 'Show a system notification when a review completes',
  'general.gitClone': 'Allow direct Git clone',
  'general.gitCloneDesc':
    'When MCP is not configured, allow cloning code via Git for review',

  'account.title': 'Account',
  'account.info': 'Account info',
  'account.manage': 'Manage account',
  'account.upgrade': 'Upgrade',
  'account.upgradeDesc': 'Upgrade for more review quota and advanced features',
  'account.usage': 'Review usage',
  'account.usageAvailable': 'Available',
  'account.usageTimes': '',
  'account.autoUpload': 'Auto-upload reports',
  'account.autoUploadDesc':
    'When enabled, completed reviews are synced to the cloud for multi-device access. When off, reports stay local only.',
  'account.logout': 'Log out',
  'account.notLoggedIn': 'Not signed in',
  'account.guestHint':
    'Click “Sign in” at the bottom left to open the browser and finish SMS verification. The URL is provided by the server.',
  'account.noPhone': 'No phone linked',
  'account.org': 'Org',
  'account.more': 'More',
  'account.superAdmin': 'Admin',
  'account.clickToLogin': 'Sign in to continue'
}

const catalogs: Record<AppLocale, Dict> = {
  'zh-CN': zh,
  'en-US': en
}

export const translate = (locale: AppLocale, key: MessageKey): string =>
  catalogs[locale][key] ?? catalogs['zh-CN'][key] ?? key
