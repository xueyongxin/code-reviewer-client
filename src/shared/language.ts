/** 根据路径识别 Monaco 语言 id */

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sass: 'scss',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  vue: 'html',
  svelte: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  java: 'java',
  go: 'go',
  rs: 'rust',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  sql: 'sql',
  mysql: 'mysql',
  pgsql: 'pgsql',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  env: 'ini',
  properties: 'ini',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  php: 'php',
  rb: 'ruby',
  r: 'r',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  scala: 'scala',
  groovy: 'java',
  gradle: 'java',
  dart: 'dart',
  proto: 'protobuf',
  graphql: 'graphql',
  gql: 'graphql',
  tf: 'hcl',
  hcl: 'hcl',
  dockerfile: 'dockerfile',
  bat: 'bat',
  cmd: 'bat',
  ps1: 'powershell',
  psm1: 'powershell',
  coffee: 'coffee',
  clojure: 'clojure',
  clj: 'clojure',
  cljs: 'clojure',
  fs: 'fsharp',
  fsx: 'fsharp',
  vb: 'vb',
  rkt: 'scheme',
  scm: 'scheme',
  lisp: 'scheme',
  jl: 'julia',
  ex: 'elixir',
  exs: 'elixir',
  sol: 'solidity',
  zig: 'plaintext',
  nim: 'plaintext',
  vuex: 'javascript',
  wasm: 'plaintext',
  txt: 'plaintext',
  log: 'plaintext',
  csv: 'plaintext',
  tsv: 'plaintext'
}

const BASENAME_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'plaintext',
  gnumakefile: 'plaintext',
    'cmakelists.txt': 'plaintext',
    'go.mod': 'go',
    'go.sum': 'go',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  brewfile: 'ruby',
  '.gitignore': 'ini',
  '.gitattributes': 'ini',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.env': 'ini',
  '.env.local': 'ini',
  '.env.development': 'ini',
  '.env.production': 'ini',
  '.babelrc': 'json',
  '.eslintrc': 'json',
  '.prettierrc': 'json',
  'tsconfig.json': 'json',
  'package.json': 'json',
  'composer.json': 'json',
  'cargo.toml': 'ini',
  'pyproject.toml': 'ini',
  'readme.md': 'markdown',
  'readme': 'markdown'
}

export const languageFromPath = (filePath?: string | null): string => {
  if (!filePath?.trim()) return 'plaintext'
  const normalized = filePath.replace(/\\/g, '/').trim()
  const base = normalized.split('/').pop() || normalized
  const baseLower = base.toLowerCase()

  if (BASENAME_LANG[baseLower]) return BASENAME_LANG[baseLower]

  // Dockerfile.* / Makefile.*
  if (/^dockerfile(\.|$)/i.test(base)) return 'dockerfile'
  if (/^makefile(\.|$)/i.test(base)) return 'plaintext'

  const dot = baseLower.lastIndexOf('.')
  if (dot <= 0) return 'plaintext'
  const ext = baseLower.slice(dot + 1)
  return EXT_LANG[ext] || 'plaintext'
}

/** 合并路径推断与显式 language；plaintext 不覆盖有扩展名的路径推断 */
export const resolveEditorLanguage = (
  filePath?: string | null,
  language?: string | null
): string => {
  const fromPath = languageFromPath(filePath)
  const explicit = (language || '').trim().toLowerCase()
  if (!explicit || explicit === 'plaintext' || explicit === 'text' || explicit === 'plain') {
    return fromPath
  }
  return explicit
}

/** 状态栏展示用短名 */
export const languageDisplayName = (lang: string): string => {
  const map: Record<string, string> = {
    typescript: 'TypeScript',
    javascript: 'JavaScript',
    json: 'JSON',
    markdown: 'Markdown',
    css: 'CSS',
    scss: 'SCSS',
    less: 'Less',
    html: 'HTML',
    yaml: 'YAML',
    xml: 'XML',
    python: 'Python',
    java: 'Java',
    go: 'Go',
    rust: 'Rust',
    shell: 'Shell',
    sql: 'SQL',
    mysql: 'MySQL',
    pgsql: 'PostgreSQL',
    ini: 'INI',
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
    kotlin: 'Kotlin',
    swift: 'Swift',
    php: 'PHP',
    ruby: 'Ruby',
    r: 'R',
    lua: 'Lua',
    perl: 'Perl',
    scala: 'Scala',
    groovy: 'Groovy',
    dart: 'Dart',
    dockerfile: 'Dockerfile',
    powershell: 'PowerShell',
    bat: 'Batch',
    plaintext: 'Plain Text'
  }
  return map[lang] || lang
}
