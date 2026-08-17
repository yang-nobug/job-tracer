const BASE = 'http://localhost:3210/api'

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

// 未配置 config.json 时应返回友好错误（502 + 提示），而不是崩溃
const r1 = await req('POST', '/ai/jd-parse', { text: '字节跳动 后端开发工程师' })
console.log('AI jd-parse（未配置）:', r1.status, r1.json.message)

const r2 = await req('POST', '/ai/review-advice', { interviewId: 1 })
console.log('AI review-advice（面试不存在）:', r2.status, r2.json.message)

const r3 = await req('POST', '/ai/review-advice', {})
console.log('AI review-advice（缺参）:', r3.status, r3.json.message)

// 原有正则解析不受影响
const r4 = await req('POST', '/jd-parse', { text: 'XX科技有限公司 招聘 后端开发工程师 工作地点：上海市浦东新区' })
console.log('本地正则解析:', JSON.stringify(r4.json))
