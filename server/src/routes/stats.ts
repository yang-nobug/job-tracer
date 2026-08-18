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

  const total = apps.length
  const applied = apps.filter((a) => a.applied_at) // 已投出
  const active = applied.filter((a) => !a.rejected_at && a.status !== 'offer')
  const rejected = apps.filter((a) => a.rejected_at)
  const offers = apps.filter((a) => a.status === 'offer' && !a.rejected_at)

  // 漏斗：投递 -> 面试 -> 终面 -> Offer
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

  // 渠道分布
  const channelMap = new Map<string, number>()
  for (const a of apps) {
    const c = a.channel || '未填写'
    channelMap.set(c, (channelMap.get(c) ?? 0) + 1)
  }
  const channels = [...channelMap.entries()].map(([name, value]) => ({ name, value }))

  res.json({
    cards: { total, active: active.length, rejected: rejected.length, offer: offers.length },
    funnel,
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

// 所有未来面试（倒计时数据源）
statsRouter.get('/upcoming', (_req: Request, res: Response) => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const nowStr = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  const rows = db
    .prepare(
      `SELECT i.id, i.round, i.scheduled_at, i.location,
              a.id AS application_id, a.company, a.position
       FROM interviews i JOIN applications a ON i.application_id = a.id
       WHERE i.done = 0 AND i.scheduled_at >= ?
       ORDER BY i.scheduled_at ASC`
    )
    .all(nowStr)
  res.json(rows)
})
