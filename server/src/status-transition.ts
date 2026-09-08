import { STATUS_ORDER, type Status } from './types.js'

const NEXT_INTERVIEW_STATUSES: Partial<Record<Status, readonly Status[]>> = {
  round1: ['round2'],
  // 不少公司只有两轮业务面，二面后可直接进入 HR 面。
  round2: ['round3', 'hr'],
  round3: ['hr'],
  hr: ['offer']
}

/**
 * 自动更新的流程规则：一面前允许按实际通知跳过测评/笔试/AI 面；
 * 从一面开始必须逐级推进，防止旧邮件或异常识别跨越后续轮次。
 * 用户在投递详情手动编辑状态时不受此限制，以便修正真实流程。
 */
export function canAutomaticallyAdvanceStatus(from: Status, to: Status): boolean {
  if (STATUS_ORDER.indexOf(to) <= STATUS_ORDER.indexOf(from)) return false
  const allowedNext = NEXT_INTERVIEW_STATUSES[from]
  return allowedNext ? allowedNext.includes(to) : true
}
