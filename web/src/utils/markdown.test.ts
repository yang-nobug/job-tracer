import assert from 'node:assert/strict'
import test from 'node:test'
import { renderMarkdown } from './markdown.js'

test('renders Markdown structure and ordinary line breaks', () => {
  const html = renderMarkdown('## 标题\n\n- 要点一\n- 要点二\n\n第一行\n第二行')
  assert.match(html, /<h2>标题<\/h2>/)
  assert.match(html, /<ul>/)
  assert.match(html, /第一行<br>\n第二行/)
})

test('escapes raw HTML and rejects unsafe link protocols', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1))')
  assert.doesNotMatch(html, /<script>/)
  assert.doesNotMatch(html, /href="javascript:/)
})

test('opens valid links without exposing the opener', () => {
  const html = renderMarkdown('[资料](https://example.com)')
  assert.match(html, /target="_blank"/)
  assert.match(html, /rel="noopener noreferrer"/)
})

test('splits legacy unformatted long prose into readable paragraphs', () => {
  const sentence = '这是一句用于验证旧内容展示兼容性的完整说明。'
  const html = renderMarkdown(sentence.repeat(24))
  assert.ok((html.match(/<p>/g) ?? []).length > 1)
})
