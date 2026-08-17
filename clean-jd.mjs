// 用 AI 清洗已存记录的 jd_text（整页复制的垃圾内容）
const BASE = 'http://localhost:3210/api'

async function main() {
  const apps = await (await fetch(`${BASE}/applications`)).json()
  for (const a of apps) {
    if (!a.jd_text || a.jd_text.length < 50) continue
    console.log(`处理 #${a.id} ${a.company}（jd_text ${a.jd_text.length} 字）...`)
    const r = await fetch(`${BASE}/ai/jd-parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: a.jd_text })
    })
    const parsed = await r.json()
    if (!r.ok) {
      console.log('  AI 解析失败:', parsed.message)
      continue
    }
    if (!parsed.jd) {
      console.log('  AI 未返回清洗后的 JD，跳过')
      continue
    }
    console.log(`  清洗后 ${parsed.jd.length} 字，预览: ${parsed.jd.slice(0, 80).replace(/\n/g, ' ')}...`)
    const detail = await (await fetch(`${BASE}/applications/${a.id}`)).json()
    const put = await fetch(`${BASE}/applications/${a.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...detail, jd_text: parsed.jd })
    })
    console.log('  保存:', put.status === 200 ? '成功' : await put.text())
  }
}
main()
