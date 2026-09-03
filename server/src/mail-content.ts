const MAX_LINKS = 30

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '
  }
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match
    const hex = entity[1]?.toLowerCase() === 'x'
    const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match
    try { return String.fromCodePoint(codePoint) } catch { return match }
  })
}

export function normalizeVisibleText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/[ \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 仅提取可见文字；HTML、CSS 和远程资源从不执行。 */
export function htmlToVisibleText(html: string): string {
  const withoutHiddenBlocks = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|svg|canvas|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|table|section|article|h[1-6])\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
  return normalizeVisibleText(decodeHtmlEntities(withoutHiddenBlocks))
}

function safeHttpUrl(value: string): string | null {
  const decoded = decodeHtmlEntities(value).trim().replace(/[),.;，。；]+$/u, '')
  if (!decoded || decoded.length > 2048) return null
  try {
    const parsed = new URL(decoded)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? decoded : null
  } catch {
    return null
  }
}

/** 只收集正文中原样存在的 http(s) 链接，不访问链接。 */
export function extractBodyUrls(plainText: string, html: string): string[] {
  const values: string[] = []
  const hrefPattern = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi
  for (const match of html.matchAll(hrefPattern)) values.push(match[1] ?? match[2] ?? match[3] ?? '')
  const visible = `${plainText}\n${htmlToVisibleText(html)}`
  for (const match of visible.matchAll(/https?:\/\/[^\s<>"']+/gi)) values.push(match[0])
  const result: string[] = []
  for (const value of values) {
    const safe = safeHttpUrl(value)
    if (safe && !result.includes(safe)) result.push(safe)
    if (result.length >= MAX_LINKS) break
  }
  return result
}
