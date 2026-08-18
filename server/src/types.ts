// 共享类型与枚举定义（前端 web/src/types.ts 保持同步）

export const STATUS_ORDER = [
  'unsent',
  'applied',
  'assessment',
  'testing',
  'ai',
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
  assessment: '心理测评',
  testing: '笔试',
  ai: 'AI面',
  round1: '一面',
  round2: '二面',
  round3: '三面',
  hr: 'HR面',
  offer: 'Offer'
}

/** 看板分组：考核组包含的环节状态 */
export const ASSESSMENT_STATUSES: Status[] = ['assessment', 'testing', 'ai']

/** 看板分组：面试组包含的轮次状态 */
export const INTERVIEW_STATUSES: Status[] = ['round1', 'round2', 'round3', 'hr']

export const STATUS_LABEL_LIST: { value: Status; label: string }[] =
  STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABELS[s] }))

/** 知识库题目分类（需求 3.9.1），后续可细化二级 */
export const KNOWLEDGE_CATEGORIES = ['八股', '项目', '算法', '综合面试', '其他']

/** 知识库掌握度：0 未掌握 / 1 模糊 / 2 已掌握 */
export const MASTERY_LEVELS = [0, 1, 2] as const

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
