// 共享类型与枚举定义（前端 web/src/types.ts 保持同步）

export const STATUS_ORDER = [
  'unsent',
  'applied',
  'round1',
  'round2',
  'round3',
  'hr',
  'offer'
] as const

export type Status = (typeof STATUS_ORDER)[number]

export const STATUS_LABELS: Record<Status, string> = {
  unsent: '未投递',
  applied: '已投递',
  round1: '一面',
  round2: '二面',
  round3: '三面',
  hr: 'HR面',
  offer: 'Offer'
}

/** 看板分组：面试组包含的轮次状态 */
export const INTERVIEW_STATUSES: Status[] = ['round1', 'round2', 'round3', 'hr']

export const STATUS_LABEL_LIST: { value: Status; label: string }[] =
  STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABELS[s] }))

export const DEFAULT_CHANNELS = ['BOSS', '猎聘', '智联', '内推', '官网', '其他']

export const ROUNDS = ['一面', '二面', '三面', 'HR面', '其他']

export interface Application {
  id: number
  company: string
  position: string
  status: Status
  applied_at: string | null
  channel: string | null
  location: string | null
  resume_id: number | null
  jd_link: string | null
  jd_text: string | null
  contact_name: string | null
  contact_info: string | null
  notes: string | null
  rejected_at: string | null
  reject_type: 'company' | 'me' | null
  created_at: string
  updated_at: string
}

export interface Resume {
  id: number
  filename: string
  stored_name: string
  size: number
  note: string | null
  uploaded_at: string
}

export interface AppEvent {
  id: number
  application_id: number
  type: 'note' | 'status' | 'interview' | 'other'
  event_date: string
  content: string
  created_at: string
}

export interface ChecklistItem {
  id: number
  interview_id: number
  content: string
  done: 0 | 1
  sort: number
}

export interface Interview {
  id: number
  application_id: number
  round: string
  scheduled_at: string
  location: string | null
  review_file: string | null
  done: 0 | 1
  created_at: string
  checklist?: ChecklistItem[]
}

export interface ApplicationDetail extends Application {
  events: AppEvent[]
  interviews: Interview[]
  resume?: Resume | null
}
