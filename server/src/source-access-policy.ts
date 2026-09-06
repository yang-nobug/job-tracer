/**
 * Shared read-only source access policy.
 *
 * Project archives stay on the local machine, but code-reading results are sent
 * to the configured model. Keep this policy conservative so the two paths do
 * not accidentally have different privacy boundaries.
 */
export const IGNORED_SOURCE_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt', '.cache',
  'vendor', 'target', '__pycache__', '.venv', 'venv', '.aws', '.ssh', '.gnupg', '.idea', 'backups',
  'data', 'secrets'
])

const SENSITIVE_FILENAME = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.pgpass|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|keystore|jks|tfvars|tfstate)|(?:credentials?|secrets?|auth(?:entication)?|tokens?|passwords?)(?:\..*)?|(?:config|settings)(?:\..*)?\.(?:json|ya?ml|toml|ini|properties)|(?:service-account|kubeconfig)(?:\..*)?)$/i
const PRIVATE_KEY = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/
const WELL_KNOWN_TOKEN = /(?:AKIA[0-9A-Z]{16}|(?:ghp|github_pat)_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{16,})/
const AUTHORIZATION_VALUE = /(?:authorization|x-api-key)\s*[:=]\s*(?:bearer\s+)?["'`]?([^\s,"'`}{]{8,})/i
const SECRET_ASSIGNMENT = /(?:api[_-]?key|api[_-]?secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential)\s*[:=]\s*["'`]?([^\s,"'`}{]{8,})/i
const CONNECTION_WITH_PASSWORD = /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s/:]+:[^\s@/]+@/i

export function isProtectedSourceName(name: string): boolean {
  return SENSITIVE_FILENAME.test(name)
}

export function isIgnoredSourceSegment(name: string): boolean {
  return IGNORED_SOURCE_DIRS.has(name)
}

function looksLikeReference(value: string): boolean {
  return /^(?:process\.env(?:\.|\[)|import\.meta\.env(?:\.|\[)|os\.environ(?:\[|\.)|(?:getenv|env)\(|\$\{|\{\{|<|\[|YOUR_|REPLACE_|CHANGE_ME|EXAMPLE|undefined|null|true|false)/i.test(value)
}

/**
 * A content guard for secrets hidden in otherwise innocuous source files.
 * It intentionally ignores environment-variable references and placeholders;
 * those describe configuration without exposing a credential value.
 */
export function hasLikelySecretContent(value: Buffer | string): boolean {
  const text = (Buffer.isBuffer(value) ? value.toString('utf8') : value).slice(0, 1_000_000)
  if (PRIVATE_KEY.test(text) || WELL_KNOWN_TOKEN.test(text) || CONNECTION_WITH_PASSWORD.test(text)) return true
  for (const pattern of [AUTHORIZATION_VALUE, SECRET_ASSIGNMENT]) {
    const matches = text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))
    for (const match of matches) if (match[1] && !looksLikeReference(match[1])) return true
  }
  return false
}

export function pathIsWithinScopes(relativePath: string, scopes: string[]): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '') || '.'
  return scopes.some(scope => {
    const permitted = scope.replace(/\\/g, '/').replace(/^\.\//, '') || '.'
    return permitted === '.' || normalized === permitted || normalized.startsWith(`${permitted}/`)
  })
}
