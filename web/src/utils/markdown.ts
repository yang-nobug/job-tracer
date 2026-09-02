import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: true
})

const defaultLinkOpen = markdown.renderer.rules.link_open

markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noopener noreferrer')
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, index, options, env, self)
    : self.renderToken(tokens, index, options)
}

export function renderMarkdown(content: string | null | undefined): string {
  return markdown.render(formatLongPlainText(content?.trim() ?? ''))
}

function formatLongPlainText(source: string): string {
  if (source.length < 240 || source.includes('\n\n')) return source
  if (/(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|~~~|\|.+\|)/m.test(source)) return source
  if (/^[\[{]/.test(source) || /(?:=>|function\s+|const\s+|class\s+)\S*/.test(source)) return source

  const sentences = source.match(/[^。！？；!?;\n]+[。！？；!?;]?/g)?.map(item => item.trim()).filter(Boolean) ?? []
  if (sentences.length < 3) return source

  const paragraphs: string[] = []
  let current = ''
  let count = 0
  for (const sentence of sentences) {
    if (current && (current.length + sentence.length > 220 || count >= 3)) {
      paragraphs.push(current)
      current = ''
      count = 0
    }
    current += sentence
    count++
  }
  if (current) paragraphs.push(current)
  return paragraphs.length > 1 ? paragraphs.join('\n\n') : source
}
