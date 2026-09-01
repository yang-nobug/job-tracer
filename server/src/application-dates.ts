import { isCalendarDate, isClockTime, type AppliedDateResult, type AppliedDateCandidate, type DateFact, type ImportSource } from '../../shared/application-import.js'

const pad = (n: string | number) => String(n).padStart(2, '0')
const compact = (s: string) => s.normalize('NFKC').replace(/\s/g, '')

/** Only explicit dates, or relative calendar days with a user-confirmed anchor.
 * No Date.parse, machine date, file mtime, or inferred year is used. */
export function resolveAppliedDate(facts: DateFact[], sources: ImportSource[]): AppliedDateResult {
  const candidates: AppliedDateCandidate[] = facts.filter(fact => fact.kind === 'application').map(fact => {
    const item: AppliedDateCandidate = { date: null, time: null, raw: fact.raw, evidence: fact.evidence, issue: null }
    const raw = fact.raw.normalize('NFKC').trim()
    if (!fact.evidence.every(e => compact(e.quote).includes(compact(fact.raw)))) {
      item.issue = '时间原文与引用不一致，请核对原材料'; return item
    }
    const absolute = raw.match(/(?<!\d)(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})(?:日|号)?(?!\d)/g)
    if (absolute?.length === 1) {
      const parts = absolute[0].match(/\d+/g)!
      item.date = `${parts[0]}-${pad(parts[1])}-${pad(parts[2])}`
    } else if (absolute?.length) {
      item.issue = '同一表达包含多个日期，请选择实际投递时间'; return item
    } else {
      const relative = raw.match(/大前天|前天|今天|今日|昨天|昨日|\d+\s*天前/g)
      if (relative?.length !== 1) { item.issue = '缺少年份、完整日期，或时间表达无法确定'; return item }
      const anchors = fact.evidence.map(e => sources.find(s => s.id === e.source_id)?.captured_at)
      if (!anchors.length || anchors.some(anchor => !anchor || !isCalendarDate(anchor)) || new Set(anchors).size !== 1) {
        item.issue = '相对日期需要对应材料的实际截取/复制日期，不能使用上传日期'; return item
      }
      const word = relative[0].replace(/\s/g, '')
      const days = ['今天', '今日'].includes(word) ? 0 : ['昨天', '昨日'].includes(word) ? 1 : word === '前天' ? 2 : word === '大前天' ? 3 : Number(word.replace('天前', ''))
      if (!Number.isInteger(days) || days > 3660) { item.issue = '相对日期范围异常'; return item }
      const [y, m, d] = anchors[0]!.split('-').map(Number)
      item.date = new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10)
    }
    if (!isCalendarDate(item.date)) { item.date = null; item.issue = '不是有效的日历日期'; return item }
    // Do not interpret durations, time ranges, or ambiguous AM/PM as an exact clock time.
    const times = [...raw.matchAll(/(?<!\d)(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?(?!\d)/g)]
    if (times.length > 1 || /上午|下午|晚上|凌晨|AM|PM|约|左右|至|到|小时|分钟|UTC|GMT|Z\b|[+-]\d{2}:\d{2}/i.test(raw)) {
      item.issue = '时间范围、时区或时段表达需要人工核对'; return item
    }
    if (times.length === 1) {
      item.time = `${pad(times[0][1])}:${times[0][2]}${times[0][3] ? ':' + times[0][3] : ''}`
      if (!isClockTime(item.time)) { item.time = null; item.issue = '不是有效的时分秒'; return item }
    } else if (/\d\s*[时点分秒]/.test(raw)) {
      item.issue = '时间以中文时分表达，请人工核对'; return item
    }
    return item
  })
  if (!candidates.length) return { state: 'missing', value: null, time: null, candidates }
  const dates = new Set(candidates.filter(c => c.date).map(c => c.date))
  const times = new Set(candidates.filter(c => c.time).map(c => c.time))
  if (dates.size > 1 || times.size > 1) return { state: 'conflict', value: null, time: null, candidates }
  if (candidates.some(c => c.issue || !c.date)) return { state: 'uncertain', value: null, time: null, candidates }
  return { state: 'resolved', value: candidates[0].date, time: [...times][0] ?? null, candidates }
}
