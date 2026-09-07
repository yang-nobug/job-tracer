import assert from 'node:assert/strict'
import test from 'node:test'
import { applicationShareText, feishuApplicationMessage } from './feishu-share.js'

test('飞书岗位纯文本只发送允许分享的招聘字段', () => {
  const app = {
    id: 1,
    company: '示例公司',
    position: 'AI 应用工程师',
    location: '北京市',
    channel: '官网',
    status: '未投递',
    jd_link: 'https://example.com/jobs/1',
    jd_text: '负责 RAG 与 Agent 应用开发。'
  }
  const text = applicationShareText(app)
  assert.match(text, /公司：示例公司/)
  assert.match(text, /岗位 JD 链接：https:\/\/example\.com\/jobs\/1/)
  assert.match(text, /JD 正文：/)

  const payload = JSON.stringify(feishuApplicationMessage(app))
  assert.match(payload, /"msg_type":"text"/)
  assert.match(payload, /【招聘信息】/)
  assert.doesNotMatch(payload, /application_link|投递进度链接|contact_info|联系方式/)
})
