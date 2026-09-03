export interface MailCandidateClassification {
  isCandidate: boolean
  score: number
  matchedTerms: string[]
}

interface Rule {
  label: string
  pattern: RegExp
  weight: number
  strong?: boolean
}

const RULES: Rule[] = [
  { label: '面试', pattern: /面试|面邀|面谈|初试|复试|视频面试|ai\s*面/i, weight: 5, strong: true },
  { label: '笔试/考试', pattern: /笔试|机试|在线考试|编程考试|在线作答|在线答题|考试通知/i, weight: 5, strong: true },
  { label: '测评', pattern: /测评|测验|人才评估|性格测试|assessment/i, weight: 5, strong: true },
  { label: 'Offer/录用', pattern: /\boffer\b|录用|签约通知/i, weight: 5, strong: true },
  { label: 'Interview', pattern: /\binterview\b/i, weight: 5, strong: true },
  { label: '招聘', pattern: /招聘|校招|应聘|候选人|网申|职位申请|招聘流程|招聘进展/i, weight: 2 },
  { label: 'Application', pattern: /\bapplication\b|\bcampus\s+recruit/i, weight: 2 },
  { label: '需要操作', pattern: /通知|邀请|安排|截止|限时|须于|请于|确认参加|deadline/i, weight: 1 },
  { label: '招聘系统', pattern: /mokahr|zhiye|nowcoder|牛客|liepin|zhaopin|51job|shixiseng|jobs\.feishu/i, weight: 1 },
  { label: '推广内容', pattern: /职位推荐|岗位推荐|每日职位|招聘资讯|求职课程|培训|直播|公众号|会员|广告|newsletter/i, weight: -4 }
]

export function classifyRecruitmentEnvelope(subject: string, sender: string): MailCandidateClassification {
  const input = `${subject}\n${sender}`.slice(0, 1000)
  let score = 0
  let strong = false
  const matchedTerms: string[] = []
  for (const rule of RULES) {
    if (!rule.pattern.test(input)) continue
    score += rule.weight
    strong ||= Boolean(rule.strong)
    matchedTerms.push(rule.label)
  }
  const uniqueTerms = [...new Set(matchedTerms)]
  return {
    isCandidate: strong || score >= 3,
    score,
    matchedTerms: uniqueTerms
  }
}
