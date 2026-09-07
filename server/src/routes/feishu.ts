import { Router } from 'express'
import type { Request, Response } from 'express'
import { db } from '../db.js'
import { STATUS_LABELS, type Status } from '../types.js'
import {
  FeishuShareError,
  feishuShareConfigured,
  shareApplicationToFeishu,
  type FeishuShareApplication
} from '../feishu-share.js'
import { logApp } from '../observability.js'

export const feishuRouter = Router()

feishuRouter.get('/status', (_req: Request, res: Response) => {
  res.json({ configured: feishuShareConfigured() })
})

feishuRouter.post('/applications/:id/share', async (req: Request, res: Response) => {
  const app = db.prepare(`SELECT id, company, position, location, channel, status, jd_link, jd_text
    FROM applications WHERE id=?`).get(req.params.id) as Omit<FeishuShareApplication, 'status'> & { status: Status } | undefined
  if (!app) {
    res.status(404).json({ message: '投递记录不存在' })
    return
  }
  try {
    await shareApplicationToFeishu({ ...app, status: STATUS_LABELS[app.status] ?? app.status })
    logApp({ level: 'info', source: 'feishu', eventName: 'feishu.application_shared', message: '岗位信息已发送到飞书',
      entityType: 'application', entityId: app.id, context: { company: app.company, position: app.position } })
    res.json({ ok: true })
  } catch (error) {
    const known = error instanceof FeishuShareError
    logApp({ level: 'warn', source: 'feishu', eventName: 'feishu.application_share_failed', message: (error as Error).message,
      entityType: 'application', entityId: app.id, errorCode: known ? 'FEISHU_SHARE_FAILED' : 'FEISHU_SHARE_UNKNOWN' })
    res.status(known ? error.status : 500).json({ message: known ? error.message : '飞书发送失败，请稍后重试' })
  }
})
