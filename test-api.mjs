// 后端 API 冒烟测试：node test-api.mjs
const BASE = 'http://localhost:3210/api'

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${json.message || JSON.stringify(json)}`)
  return json
}

const assert = (cond, msg) => {
  if (!cond) throw new Error('断言失败: ' + msg)
  console.log('✓', msg)
}

// 1. 创建（未投递）
const a1 = await req('POST', '/applications', { company: '字节跳动', position: '后端开发工程师', channel: 'BOSS', location: '北京市海淀区' })
assert(a1.status === 'unsent' && !a1.applied_at, '创建默认未投递、无投递日期')

// 2. 更新到已投递（自动填当天）
const a2 = await req('PUT', `/applications/${a1.id}`, { ...a1, status: 'applied' })
assert(a2.status === 'applied' && a2.applied_at, '标记已投递自动填日期')

// 3. 必填校验
try {
  await req('POST', '/applications', { company: '' })
  throw new Error('should fail')
} catch (e) {
  assert(e.message.includes('公司'), '空公司返回 422')
}

// 4. 状态变更自动写事件
const d1 = await req('GET', `/applications/${a1.id}`)
assert(d1.events.some((e) => e.type === 'status'), '状态变更自动记录时间线')

// 5. 动态事件
await req('POST', `/applications/${a1.id}/events`, { content: 'HR 加了微信，约下周一面' })

// 6. 面试 + 自动生成复盘
const iv = await req('POST', `/applications/${a1.id}/interviews`, { round: '一面', scheduled_at: '2026-08-20 14:00', location: '腾讯会议 123-456' })
assert(iv.review_file && iv.review_file.startsWith('reviews/'), '创建面试自动生成复盘 md: ' + iv.review_file)

// 7. 清单
const c1 = await req('POST', `/interviews/${iv.id}/checklist`, { content: '复习 MySQL 索引' })
await req('POST', `/interviews/${iv.id}/checklist`, { content: '过一遍项目架构图' })
await req('PATCH', `/checklist/${c1.id}`, { done: true })

// 8. 复盘读写
const r1 = await req('GET', `/interviews/${iv.id}/review`)
assert(r1.content.includes('被问的问题'), '复盘模板含问题区块')
await req('PUT', `/interviews/${iv.id}/review`, { content: '# 复盘\n- 问题1：讲讲项目' })
const r2 = await req('GET', `/interviews/${iv.id}/review`)
assert(r2.content.includes('问题1'), '复盘保存后可读回')

// 9. 挂掉与撤销
const a3 = await req('PATCH', `/applications/${a1.id}/reject`, { reject_type: 'company' })
assert(a3.rejected_at && a3.reject_type === 'company', '标记被拒')
const a4 = await req('PATCH', `/applications/${a1.id}/reject`, {})
assert(!a4.rejected_at, '撤销挂掉')

// 10. meta / upcoming / reviews / stats
const meta = await req('GET', '/meta')
assert(meta.companies.length === 1, '公司自动补全列表')
const up = await req('GET', '/upcoming')
assert(up.length === 1 && up[0].company === '字节跳动', '倒计时数据源')
const reviews = await req('GET', '/reviews')
assert(reviews.length === 1 && reviews[0].round === '一面', '复盘汇总')
const stats = await req('GET', '/stats')
assert(stats.cards.total === 1 && stats.funnel[0].value === 1, '统计数字')

// 11. JD 解析
const jd = await req('POST', '/jd-parse', { text: '字节跳动招聘 后端开发工程师\n工作地点：北京市海淀区\n岗位职责：负责推荐系统开发' })
console.log('JD 解析结果:', JSON.stringify(jd))
assert(jd.position && jd.location, 'JD 解析出职位和地点')

// 12. 删除级联
const a5 = await req('POST', '/applications', { company: '临时公司', position: '测试' })
await req('POST', `/applications/${a5.id}/events`, { content: 'x' })
await req('DELETE', `/applications/${a5.id}`)
try {
  await req('GET', `/applications/${a5.id}`)
  throw new Error('should 404')
} catch (e) {
  assert(e.message.includes('404'), '删除后 404')
}

console.log('\n全部通过 ✅')
