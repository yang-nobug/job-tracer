// 与 server/src/types.ts 保持同步
export const STATUS_ORDER = ['unsent', 'applied', 'assessment', 'testing', 'ai', 'round1', 'round2', 'round3', 'hr', 'offer'] as const
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

export const STATUS_LABEL_LIST: { value: Status; label: string }[] = STATUS_ORDER.map((s) => ({
  value: s,
  label: STATUS_LABELS[s]
}))

export const DEFAULT_CHANNELS = ['BOSS', '猎聘', '智联', '内推', '官网', '其他']
export const ROUNDS = ['心理测评', '笔试', 'AI面', '一面', '二面', '三面', 'HR面', '其他']

export interface Application {
  id: number
  company: string
  position: string
  status: Status
  applied_at: string | null
  applied_time: string | null
  channel: string | null
  location: string | null
  resume_id: number | null
  jd_link: string | null
  application_link: string | null
  jd_text: string | null
  contact_name: string | null
  contact_info: string | null
  notes: string | null
  rejected_at: string | null
  reject_type: 'company' | 'me' | null
  created_at: string
  updated_at: string
  /** 列表接口附带的冗余字段：最新一场面试的轮次（一面/二面/…） */
  last_round?: string | null
  /** 列表接口附带的冗余字段：最近一场未完成面试的时间（YYYY-MM-DD HH:mm） */
  next_interview_at?: string | null
}

export interface Resume {
  id: number
  filename: string
  stored_name: string
  size: number
  note: string | null
  uploaded_at: string
  extraction_status?: 'pending' | 'extracting' | 'completed' | 'failed' | 'unsupported'
  extraction_error?: string | null
  extracted_at?: string | null
  text_available?: 0 | 1 | boolean
  extraction_method?: 'vision_pdf' | 'docx_xml' | null
  extraction_model?: string | null
  page_count?: number | null
  pages_completed?: number
  started_at?: string | null
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

export type PrepAgentStatus =
  | 'pending'
  | 'running'
  | 'waiting_review'
  | 'committing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface PrepAgentEvidence {
  ref: string
  type: 'knowledge_item' | 'review' | 'mastery' | 'application' | 'interview' | 'project' | 'resume'
  title: string
  excerpt: string
  source_id?: number | null
  item_id?: number
  score?: number
  company?: string
  position?: string
  round?: string
  retrieval_scope?: 'same_company_position' | 'same_company' | 'general'
  code_session_id?: string
  code_evidence_refs?: string[]
  retrieval_scope?: 'same_company_position' | 'same_company' | 'general'
}

export interface PrepAgentReference {
  ref: string
  type: 'application' | 'interview' | 'review' | 'mastery' | 'knowledge_item' | 'project' | 'resume'
  title: string
  subtitle: string
  excerpt: string
  source_id?: number | null
  item_id?: number | null
  code_session_id?: string | null
  code_evidence_refs?: string[]
}

export interface PrepPlanItem {
  title: string
  category: 'knowledge' | 'project' | 'coding' | 'communication' | 'mock'
  priority: 'high' | 'medium' | 'low'
  focus_areas: string[]
  estimated_minutes: number
  reason: string
  evidence_refs: string[]
  success_criteria: string
}

export interface PrepPlan {
  summary: string
  items: PrepPlanItem[]
}

export interface PrepEvidenceStatement {
  text: string
  source_refs: string[]
  confidence: number
}

export interface PrepRoleProfile {
  responsibilities: PrepEvidenceStatement[]
  must_have_skills: PrepEvidenceStatement[]
  nice_to_have_skills: PrepEvidenceStatement[]
  project_signals: PrepEvidenceStatement[]
  likely_interview_topics: string[]
  unknowns: string[]
}

export interface PrepGap {
  skill: string
  current_level: 'unknown' | 'weak' | 'developing' | 'ready'
  target_level: 'review' | 'practice' | 'interview_ready'
  reason: string
  evidence_refs: string[]
  confidence: number
}

export interface PrepGapAnalysis {
  gaps: PrepGap[]
  strengths: PrepGap[]
  warnings: string[]
}

export interface PrepCriticResult {
  verdict: 'pass' | 'warn' | 'revise'
  issues: Array<{ code: string; item_index: number | null; message: string }>
}

export interface PrepAgentStep {
  id: number
  node: string
  attempt: number
  status: 'running' | 'completed' | 'failed'
  summary: string | null
  duration_ms: number | null
  error_type: string | null
  created_at: string
  finished_at: string | null
}

export interface PrepAgentRun {
  id: string
  request_id: string
  application_id: number
  interview_id: number
  status: PrepAgentStatus
  goal: string
  constraints: { focus: string[]; project_ids: number[] }
  current_node: string | null
  plan: PrepPlan | null
  evidence: PrepAgentEvidence[]
  role_profile: PrepRoleProfile | null
  gap_analysis: PrepGapAnalysis | null
  critic: PrepCriticResult | null
  warnings: string[]
  error_type: string | null
  error_message: string | null
  model_calls: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  steps?: PrepAgentStep[]
  persisted_items?: Array<PrepPlanItem & { id: number; checklist_id: number; sort: number }>
  created_at: string
  updated_at: string
  finished_at: string | null
}

export interface PrepTaskProgress {
  steps: number[]
  checks: number[]
}

export interface PrepExecutionTask extends PrepPlanItem {
  id: number
  run_id: string
  checklist_id: number
  application_id: number
  interview_id: number
  sort: number
  checklist_content: string
  done: 0 | 1
  guide_ready: boolean
  guide_version: number
  guide_generated_at: string | null
  message_count: number
  progress: PrepTaskProgress
  generation: PrepTaskGeneration
}

export type PrepTaskSectionType =
  | 'explanation' | 'example' | 'comparison' | 'pitfall'
  | 'interview_answer' | 'project_template' | 'code_walkthrough'
export type PrepPracticeLevel = 'basic' | 'understanding' | 'application' | 'interview'
export type PrepPracticeType =
  | 'short_answer' | 'scenario' | 'system_design' | 'coding_exercise'
  | 'project_story' | 'behavioral_rehearsal' | 'mock_question'

export interface PrepTaskGuide {
  version: 2
  overview: string
  objectives: string[]
  prerequisites: string[]
  coverage_map: Array<{
    objective: string
    module_ids: string[]
    practice_levels: PrepPracticeLevel[]
  }>
  modules: Array<{
    id: string
    title: string
    purpose: string
    recommended_minutes: number
    learning_outcomes: string[]
    evidence_refs: string[]
    sections: Array<{
      type: PrepTaskSectionType
      title: string
      content: string
      evidence_refs: string[]
    }>
    self_checks: Array<{ question: string; expected_points: string[] }>
  }>
  practice_set: Array<{
    level: PrepPracticeLevel
    type: PrepPracticeType
    prompt: string
    hints: string[]
    answer_outline: string
    reference_answer: string
    follow_ups: string[]
    rubric: Array<{ criterion: string; description: string; score: number }>
    module_ids: string[]
  }>
  completion_checklist: string[]
  quality_review: {
    verdict: 'pass' | 'warn'
    repaired: boolean
    issues: Array<{
      code: string
      target: 'guide' | 'module' | 'practice'
      module_id: string | null
      message: string
      repair_instruction: string
    }>
  }
}

export interface PrepTaskGeneration {
  status: 'idle' | 'running' | 'completed' | 'failed'
  stage: string | null
  progress: number
  error: string | null
  started_at: string | null
  model_calls: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface PrepTaskMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  request_id: string | null
  created_at: string
}

export interface PrepTaskSession {
  task: PrepExecutionTask
  guide: PrepTaskGuide | null
  progress: PrepTaskProgress
  evidence: Array<Record<string, unknown> & { ref?: string; title?: string; excerpt?: string }>
  messages: PrepTaskMessage[]
  generation: PrepTaskGeneration
}

export interface ApplicationDetail extends Application {
  materials?: import('../../shared/application-import').ImportDraft[]
  events: AppEvent[]
  interviews: Interview[]
  resume?: Resume | null
}

export interface UpcomingItem {
  key: string
  kind: 'interview' | 'schedule'
  id: number
  title: string
  event_type: 'assessment' | 'written_test' | 'interview' | 'ai_interview' | 'offer' | 'other'
  time_mode: 'fixed' | 'window' | 'deadline' | 'duration_after_open' | 'flexible' | 'unknown'
  due_at: string
  due_kind: 'scheduled' | 'window_start' | 'window_end' | 'deadline'
  scheduled_at: string | null
  window_start_at: string | null
  window_end_at: string | null
  deadline_at: string | null
  duration_minutes: number | null
  location: string | null
  application_id: number | null
  company: string
  position: string
}

export interface ProjectArchiveSummary {
  id: number
  name: string
  description: string
  source_path: string
  root_realpath: string
  status: 'ready' | 'scanning' | 'failed' | 'archived'
  last_scan_id: number | null
  created_at: string
  updated_at: string
  scan_status?: 'succeeded' | 'partial_success' | 'failed' | null
  files_indexed?: number | null
  files_seen?: number | null
  bytes_read?: number | null
  truncated?: 0 | 1 | null
  scanned_at?: string | null
  symbol_count?: number
}

export interface ProjectCodeFile {
  id: number
  relative_path: string
  language: string
  size_bytes: number
  line_count: number
  is_generated: 0 | 1
  indexed_at: string
}

export interface ProjectCodeSearchResult {
  id: number
  relative_path: string
  start_line: number
  end_line: number
  content: string
  symbol_name: string | null
  symbol_kind: string | null
}

export interface ProjectFact {
  id: number
  project_id: number
  fact_type: 'architecture' | 'responsibility' | 'technology' | 'decision' | 'metric' | 'risk'
  title: string
  content: string
  confidence: 'inferred' | 'user_confirmed'
  created_at: string
  updated_at: string
}

export type CodeReadingMode = 'explain' | 'architecture' | 'interview_story'
export interface CodeReadingEvidence {
  evidence_ref: string
  relative_path: string
  start_line: number
  end_line: number
  excerpt: string
}
export interface CodeReadingClaim {
  claim_kind: 'code_fact' | 'inference' | 'user_confirmation_required'
  statement: string
  confidence: 'high' | 'medium' | 'low'
  evidence_refs: string[]
  caveat: string | null
}
export interface CodeReadingFinal {
  overview: string
  answer: string
  claims: Array<{ kind: CodeReadingClaim['claim_kind']; statement: string; confidence: CodeReadingClaim['confidence']; evidence_refs: string[]; caveat: string | null }>
  follow_up_questions: string[]
}
export interface CodeReadingSession {
  id: string
  project_id: number
  question: string
  output_mode: CodeReadingMode
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  tool_calls_used: number
  bytes_read: number
  max_tool_calls: number
  max_bytes_read: number
  error_message: string | null
  final: CodeReadingFinal | null
  evidence: CodeReadingEvidence[]
  claims: CodeReadingClaim[]
  steps: Array<{ id: number; sequence: number; kind: 'model' | 'tool' | 'final'; tool_name: string | null; status: 'succeeded' | 'failed'; error_message: string | null; created_at: string }>
  created_at: string
  updated_at: string
  finished_at: string | null
}

export interface Stats {
  cards: { total: number; active: number; rejected: number; offer: number }
  funnel: { name: string; value: number }[]
  /** 各环节实际经历的投递记录数（粒度是岗位，不是公司） */
  stages: { name: string; value: number }[]
  weekly: { week: string; count: number }[]
  channels: { name: string; value: number }[]
}

// ---- 知识库（需求 3.9，与 server/src/types.ts 保持同步） ----

/** 题目分类（固定可扩充） */
export const KNOWLEDGE_CATEGORIES = ['八股', '项目', '算法', '综合面试', '其他'] as const
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number]

/** 掌握度：0 未掌握 / 1 模糊 / 2 已掌握 */
export const MASTERY_LEVELS = [0, 1, 2] as const
export type Mastery = (typeof MASTERY_LEVELS)[number]
export const MASTERY_LABELS: Record<Mastery, string> = { 0: '未掌握', 1: '模糊', 2: '已掌握' }
export const MASTERY_TAG_TYPES: Record<Mastery, 'danger' | 'warning' | 'success'> = {
  0: 'danger',
  1: 'warning',
  2: 'success'
}

/** 面经来源：others = 别人的面经，mine = 我自己的面试 */
export interface KnowledgeSource {
  id: number
  owner: 'others' | 'mine'
  company: string
  position: string | null
  round: string | null
  source_type: 'text' | 'image' | 'manual'
  note: string | null
  application_id: number | null
  created_at: string
  updated_at: string
  /** 列表接口附带 */
  item_count?: number
  image_count?: number
}

export interface KnowledgeItem {
  id: number
  source_id: number | null
  question: string
  answer: string | null
  category: KnowledgeCategory | string
  mastery: Mastery
  created_at: string
  updated_at: string
  /** 列表接口附带的来源信息 */
  source_company?: string | null
  source_position?: string | null
  source_round?: string | null
  source_owner?: 'others' | 'mine' | null
}

export interface KnowledgeImage {
  id: number
  source_id: number
  filename: string
  stored_name: string
  created_at: string
}

/** 面经详情（GET /knowledge/sources/:id） */
export interface KnowledgeSourceDetail extends KnowledgeSource {
  items: KnowledgeItem[]
  images: KnowledgeImage[]
}

/** AI 拆题候选（extract-text / extract-image 返回） */
export interface KnowledgeCandidate {
  question: string
  answer?: string
  category?: string
}

/** AI 识别结果：面经元信息（可空串）+ 候选题目 */
export interface KnowledgeExtraction {
  company: string
  position: string
  round: string
  questions: KnowledgeCandidate[]
}

// ---------- 录音复盘管道 ----------

export type RecordingStatus = 'uploading' | 'transcribing' | 'analyzing' | 'done' | 'failed'

export const RECORDING_STATUS_LABELS: Record<RecordingStatus, string> = {
  uploading: '转传中',
  transcribing: '转写中',
  analyzing: '分析中',
  done: '已完成',
  failed: '失败'
}

export const RECORDING_STATUS_TAG_TYPES: Record<RecordingStatus, 'info' | 'warning' | 'primary' | 'success' | 'danger'> = {
  uploading: 'info',
  transcribing: 'warning',
  analyzing: 'warning',
  done: 'success',
  failed: 'danger'
}

/** 录音列表行（join 面试/投递信息） */
export interface RecordingRow {
  id: number
  interview_id: number
  filename: string
  size: number
  status: RecordingStatus
  error: string | null
  knowledge_source_id: number | null
  analysis_stage: string
  attempts: number
  chunk_total: number
  chunk_done: number
  created_at: string
  updated_at: string
  round: string
  scheduled_at: string
  company: string
  position: string | null
  has_transcript: 0 | 1
}

/** 录音详情（含转写全文） */
export interface RecordingDetail extends RecordingRow {
  transcript: string | null
}

// ---------- AI 助教会话 ----------

export interface TutorSession {
  id: number
  title: string
  created_at: string
  updated_at: string
  message_count: number
}

export interface TutorMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  created_at: string
  citations?: TutorCitation[]
  feedback?: -1 | 1 | null
}

export interface TutorCitation {
  ref: string
  item_id: number
  source_id: number | null
  question: string
  company: string
  position: string
  round: string
  rank: number
  score: number
}
