import { Router } from 'express'
import type { Request, Response } from 'express'
import { db } from '../db.js'
import { STATUS_ORDER, type Status } from '../types.js'

export const statsRouter = Router()

const statusRank = (s: string): number => {
  const i = (STATUS_ORDER as readonly string[]).indexOf(s)
  return i < 0 ? 0 : i
}

statsRouter.get('/stats', (_req: Request, res: Response) => {
  const apps = db
    .prepare('SELECT status, applied_at, rejected_at, channel FROM applications')
    .all() as { status: Status; applied_at: string | null; rejected_at: string | null; channel: string | null }[]

  // 实际经历过各环节的投递记录数（粒度是岗位/投递，不是公司；可选环节不能按状态排位推断，否则跳过笔试直通一面的会被误算）
  const ivRows = db
    .prepare('SELECT application_id, round FROM interviews')
    .all() as { application_id: number; round: string }[]
  const stageApps = new Map<string, Set<number>>()
  for (const r of ivRows) {
    if (!stageApps.has(r.round)) stageApps.set(r.round, new Set())
    stageApps.get(r.round)!.add(r.application_id)
  }
  const STAGE_ROUNDS = ['心理测评', '笔试', 'AI面', '一面', '二面', '三面', 'HR面']
  const stages = STAGE_ROUNDS.map((name) => ({ name, value: stageApps.get(name)?.size ?? 0 }))
  const etc = stageApps.get('其他')?.size
  if (etc) stages.push({ name: '其他', value: etc })

  const total = apps.length
  // 已投出：状态推进过「未投递」的记录（未投递不算投递量）
  const applied = apps.filter((a) => a.status !== 'unsent' && a.applied_at)
  const active = applied.filter((a) => !a.rejected_at && a.status !== 'offer')
  const rejected = apps.filter((a) => a.rejected_at)
  const offers = apps.filter((a) => a.status === 'offer' && !a.rejected_at)

  // 漏斗：只放单调主干（可选环节放「各环节经历数」，避免漏斗出现中间凹陷）
  const reachedInterview = applied.filter((a) => statusRank(a.status) >= statusRank('round1'))
  const reachedFinal = applied.filter((a) => statusRank(a.status) >= statusRank('round3'))
  const funnel = [
    { name: '投递', value: applied.length },
    { name: '面试', value: reachedInterview.length },
    { name: '终面', value: reachedFinal.length },
    { name: 'Offer', value: offers.length + apps.filter((a) => a.status === 'offer' && a.rejected_at).length }
  ]

  // 近 8 周投递趋势
  const weekly: { week: string; count: number }[] = []
  const now = new Date()
  for (let i = 7; i >= 0; i--) {
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() + 1 - i * 7)
    const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7)
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const s = fmt(weekStart)
    const e = fmt(weekEnd)
    weekly.push({
      week: s.slice(5),
      count: applied.filter((a) => a.applied_at! >= s && a.applied_at! < e).length
    })
  }

  // 渠道分布（只统计已投出的记录）
  const channelMap = new Map<string, number>()
  for (const a of applied) {
    const c = a.channel || '未填写'
    channelMap.set(c, (channelMap.get(c) ?? 0) + 1)
  }
  const channels = [...channelMap.entries()].map(([name, value]) => ({ name, value }))

  res.json({
    cards: { total, active: active.length, rejected: rejected.length, offer: offers.length },
    funnel,
    stages,
    weekly,
    channels
  })
})

// 元信息：枚举 + 公司自动补全（带默认值）
statsRouter.get('/meta', (_req: Request, res: Response) => {
  const companies = db
    .prepare(
      `SELECT company, MAX(location) AS location, MAX(channel) AS channel, COUNT(*) AS count
       FROM applications GROUP BY company ORDER BY count DESC`
    )
    .all()
  res.json({ companies })
})

// 所有未来面试与已确认招聘日程（顶部倒计时数据源）
statsRouter.get('/upcoming', (_req: Request, res: Response) => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const nowStr = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  const interviews = db
    .prepare(
      `SELECT i.id, i.round, i.scheduled_at, i.location,
              a.id AS application_id, a.company, a.position
       FROM interviews i JOIN applications a ON i.application_id = a.id
       WHERE i.done = 0 AND i.scheduled_at >= ?
       ORDER BY i.scheduled_at ASC`
    )
    .all(nowStr) as Array<Record<string, unknown> & { id: number; round: string; scheduled_at: string }>
  const interviewItems = interviews.map(row => ({
    ...row,
    key: `interview:${row.id}`,
    kind: 'interview',
    title: row.round,
    event_type: 'interview',
    time_mode: 'fixed',
    due_at: row.scheduled_at,
    due_kind: 'scheduled',
    window_start_at: null,
    window_end_at: null,
    deadline_at: null,
    duration_minutes: null
  }))

  const schedules = db.prepare(`SELECT s.id, s.application_id, s.event_type, s.title,
      COALESCE(NULLIF(s.company, ''), a.company, '') AS company,
      COALESCE(NULLIF(s.position, ''), a.position, '') AS position,
      s.time_mode, s.scheduled_at, s.window_start_at, s.window_end_at, s.deadline_at,
      s.duration_minutes, s.location
    FROM recruitment_schedule_items s
    LEFT JOIN applications a ON a.id = s.application_id
    WHERE s.status = 'active'
    ORDER BY s.id DESC`).all() as Array<Record<string, unknown> & {
      id: number
      time_mode: string
      scheduled_at: string | null
      window_start_at: string | null
      window_end_at: string | null
      deadline_at: string | null
    }>
  const scheduleItems = schedules.flatMap(row => {
    const moments: Array<{ at: string | null; kind: string }> = row.time_mode === 'window'
      ? [
          { at: row.deadline_at, kind: 'deadline' },
          { at: row.window_start_at, kind: 'window_start' },
          { at: row.window_end_at, kind: 'window_end' }
        ]
      : row.time_mode === 'fixed'
        ? [
            { at: row.deadline_at, kind: 'deadline' },
            { at: row.scheduled_at, kind: 'scheduled' }
          ]
        : [{ at: row.deadline_at, kind: 'deadline' }]
    const next = moments
      .filter((moment): moment is { at: string; kind: string } => Boolean(moment.at && moment.at >= nowStr))
      .sort((a, b) => a.at.localeCompare(b.at))[0]
    return next ? [{ ...row, key: `schedule:${row.id}`, kind: 'schedule', due_at: next.at, due_kind: next.kind }] : []
  })
  res.json([...interviewItems, ...scheduleItems]
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)))
    .slice(0, 30))
})
