const baseUrl = (process.env.PREP_AGENT_BASE_URL || 'http://127.0.0.1:3211').replace(/\/+$/, '')
const token = process.env.PREP_AGENT_CONTROL_TOKEN || process.env.PREP_AGENT_INTERNAL_TOKEN || ''
const command = process.argv[2]

async function healthy() {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1200) })
    if (!response.ok) return false
    const body = await response.json()
    return body?.protocol === 1
  } catch {
    return false
  }
}

if (command === 'health') {
  process.exit(await healthy() ? 0 : 1)
}

if (command === 'wait') {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await healthy()) process.exit(0)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  process.exit(1)
}

if (command === 'stop') {
  try {
    await fetch(`${baseUrl}/shutdown`, {
      method: 'POST',
      headers: { 'x-prep-agent-control-token': token },
      signal: AbortSignal.timeout(1500)
    })
  } catch { /* 服务已经退出时无需报错 */ }
  process.exit(0)
}

console.error('Usage: node scripts/prep-agent-process.mjs <health|wait|stop>')
process.exit(2)
