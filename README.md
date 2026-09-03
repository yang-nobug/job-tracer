# job-tracer 求职状态跟踪

本地运行的求职投递跟踪工具：记录公司、职位、渠道、状态、面试与复盘，看板/列表/统计多视图，仅在本机电脑浏览器使用。

- 需求文档：[REQUIREMENTS.md](REQUIREMENTS.md)
- 技术方案：[PLAN.md](PLAN.md)

## 快速开始

1. 安装 Node.js 24.x（推荐与 `.node-version` 一致的 24.20.0）
2. 如需使用“AI 面试准备”，另安装 Python 3.11 或 3.12；`start.bat` 会自动创建 `.venv-agent` 并安装固定版本依赖
3. **双击 `start.bat`**：启动前会检查 Node、依赖锁、`better-sqlite3` ABI、前端产物和 Agent 环境；需要时自动安装、重编译或构建
4. 访问 <http://localhost:3210>

服务仅监听本机地址 `127.0.0.1:3210`，不向局域网开放。

## 日常使用

| 操作 | 方式 |
|---|---|
| 记一笔 | 右上角「+ 新增投递」，必填仅公司 + 职位 |
| 智能录入 | 新增投递 →「招聘信息智能录入」；可粘贴文字、拖入或 Ctrl+V 粘贴最多 9 张截图，核对识别字段及原文依据后保存 |
| 改状态 | 看板拖拽卡片；或点开详情用状态下拉 |
| 添加面试 | 详情 → 面试 → 添加（自动生成复盘 md 文件） |
| AI 面试准备 | 面试卡片 →「✨ AI 准备」生成并审核计划；写入后清单卡会展示理由、完成标准、依据和课程进度，点击「开始准备」进入课程、练习与 AI 陪练 |
| QQ 邮箱与日程 | 右上角「邮箱与日程」→ 连接 QQ 邮箱 → 扫描招聘候选；按封读取正文并由 AI 复核，复核通过后自动写入招聘日程 |
| 写复盘 | 面试的「📝 复盘」，应用内编辑或直接改 `server/data/reviews/*.md` |
| 简历 | 表单里上传/选择简历，PDF 支持在线预览 |
| 备份 | 双击 `backup.bat`，数据整体复制到 `backups/` |

## 命令行

```bash
npm run dev     # 开发模式（前端热更新 + 后端 watch）
npm run build   # 构建前端到 server/public
npm start       # 生产模式启动
node test-api.mjs  # 后端 API 冒烟测试（需服务已启动）
python -m unittest agent_service.test_graph  # Agent 离线编排与断点恢复测试
node scripts/prep-agent-e2e.mjs              # Agent 跨进程 mock 端到端测试
```

## QQ 邮箱与招聘日程（可选）

当前版本完成个人 QQ 邮箱的安全连接、本地候选筛选、按需 AI 识别和复核通过后的自动招聘日程：

1. 在 QQ 邮箱网页设置中开启 IMAP/SMTP，并生成第三方客户端授权码
2. 点击页面右上角「邮箱与日程」
3. 输入完整邮箱地址和授权码，点击「测试并保存」
4. 页面会显示收件箱总数及最近 5 封邮件的主题、发件人、时间和当前已读状态
5. 点击「扫描近期招聘邮件」；首次检查最近 100 封，之后只按 UID 增量读取新邮件，并展示可能属于面试、笔试、测评或 Offer 的候选。候选是主题和发件人的宽松粗筛，包含无关邮件属于正常情况
6. 对需要处理的候选点击「读取正文并 AI 识别」，核对事件、固定时间/时间窗口/截止时间/打开后时长、链接和逐字段原文证据
7. AI 日程复核通过后会自动加入日程；可以再修改公司、岗位、时间规则或执行要求并保存修改。发现不准确时直接取消日程即可
8. 如果希望每天自动扫描新邮件，在“自动确认招聘日程”中开启开关并设置每日执行时间；也可以点击“立即自动处理一次”测试

连接固定使用 `imap.qq.com:993` 和 TLS，并以 IMAP `EXAMINE` 只读方式打开收件箱。连接测试和候选扫描只读取邮件信封；只有用户手动识别，或用户已开启自动处理并轮到该候选时，服务才按 MIME 结构读取该邮件的纯文本/HTML 正文部件，附件部件不会请求。任何流程都不会发送、删除、移动邮件或修改已读状态。候选由本地关键词规则筛选，主题、发件人、时间和命中标签保存在 SQLite，重复扫描不会重复入库，手动忽略后不会再次出现。

点击 AI 识别时，邮件标题、发件人、发送时间、正文文字和正文链接会明确作为独立字段发送给 `mailRecruitmentExtract` 配置的火山方舟模型；附件不会发送。第一步提取招聘事件，误报候选会作为“非具体流程通知”正常返回；相关但没有可靠时间的邮件会保留事件并标为“时间未知”。模型结果会按字段执行结构、时间一致性、链接白名单和原文证据校验；无依据或冲突的单个字段会被清空并提示人工核对，其余可靠字段仍生成草稿，只有整体结构缺失时才要求模型修复。随后 `mailScheduleReview` 会把原始邮件标题、正文和提取草稿交给独立复核步骤，明确输出“自动确认 / 需要人工核对 / 不建议加入日程”。复核通过时服务会立即自动写入日程；未通过的邮件只保留在候选列表。日程可在之后修改或取消。数据库只保存结构化草稿、复核结果、正文 SHA-256 哈希、是否截断、模型及提示词版本，不保存邮件正文。

AI 识别本身不会写入业务数据。用户确认后的事项保存在通用招聘日程中，可关联已有投递，也可作为独立事项保留；支持固定时间、开放/关闭窗口、截止时间、打开后限时、灵活安排和时间未知。顶部“近期日程”会依次提醒下一个开放、截止、关闭或开始节点；时间未知和灵活安排的事项只显示在邮箱与日程面板，不制造虚假倒计时。日程可标记完成或取消；删除邮箱连接时，已确认日程仍然保留。

开启自动确认后，服务运行期间每天按设定时间增量扫描邮箱。自动流程最多读取 3 批信封、每次最多向 AI 发送 10 封未识别候选正文；每封邮件先提取，再由独立复核模型判断是否是真实、明确、可执行的招聘日程。复核通过的结果会立即写入日程；复核要求人工核对、复核拒绝、正文截断、时间未知、Offer 及其他事项继续留在候选列表，可忽略或重新识别。自动任务不会覆盖已有日程，失败状态和本次扫描、识别、确认、待核对数量会显示在邮箱面板中。

授权码不会进入 `config.json`、SQLite、接口响应或日志；密文保存在 `data/secrets/`，加密密钥保存在当前 Windows 用户的 `%LOCALAPPDATA%\job-tracer\mail-master.key`。只复制项目或数据备份到另一台电脑时，需要重新填写授权码。

## AI 功能（可选）

支持接入火山方舟大模型（豆包），用于招聘材料识别、招聘邮件识别、AI JD 解析、复盘点评、知识库拆题与答案生成、录音复盘、AI 助教和面试准备 Agent：

1. 复制 `config.example.json` 为 `config.json`
2. 填入火山方舟的 `apiKey`（模型 ID 已预填 `doubao-seed-2-0-mini-260428`，如换模型自行修改）
3. 重启服务即可

不配置也能正常使用（AI 按钮会提示未配置，本地正则解析不受影响）。API Key 只存在本地 config.json（已 gitignore），仅后端调用，不会发到浏览器。

AI 参数按 `ark.tasks` 中的任务配置：`applicationImport`、`jdParse`、`knowledgeExtract`、`answerGenerate`、`tutor`、`recordingReview`、`reviewAdvice`、`interviewPrepAgent`、`mailRecruitmentExtract` 和 `mailScheduleReview`。每项任务可单独设置 `enabled`、`model`、`outputMode`、`maxOutputTokens`、`temperature`、`timeoutMs` 和 `thinking`。旧的 `ark.recruitment` 仍兼容，等价于 `tasks.applicationImport`。页面右上角「AI 数据说明」可随时查看数据去向并在本机停用或重新启用各项能力。

图片任务所选模型必须在 `ark.models` 中明确标记 `"vision": true`；没有明确声明时不会发送图片。`outputMode` 可取 `text`、`json_object` 或 `json_schema`，只有确认模型支持结构化输出时才使用 `json_schema` 并在模型上声明 `"structuredOutput": true`，不确定时使用 `text`。即使使用文本模式，服务端仍会执行 JSON Schema 对应的运行时校验，并在格式失败时最多修复一次。

截图和文字仅在点击相应 AI 操作后发送给已配置的服务。招聘材料和知识截图的原图保存在本机；浏览器另生成最长边不超过 2048 像素、去掉 EXIF 的 JPEG 推理副本，AI 只读取该副本。每次 AI 请求只记录任务、模型、耗时、token、状态和提示内容哈希，不保存提示词或模型原始回答，最近记录可在「AI 数据说明」查看。

AI 助教的知识检索使用本机 SQLite FTS5 trigram/BM25 与 LIKE 回退做混合召回，再按题目命中、来源和历史反馈重排。回答使用本地资料时会标注 `[K1]` 并在消息下方显示可点击来源；👍/👎 只作为有界排序信号，不会保存一份新的提问原文。当前脱敏固定集 Recall@5 和 MRR 均为 1.0，暂不引入 Embedding 或外部向量数据库。

面试准备 Agent 使用本机 FastAPI + LangGraph 做受控工作流。它通过 Express 的内部只读工具读取岗位、JD、历史复盘、知识掌握度和相关面经，模型调用仍统一经过 Node AI Gateway 并写入 `ai_runs`。计划会先暂停在人工审核节点；用户批准或编辑确认后，Express 才在事务中批量写入该场面试的清单。Graph 状态保存在本机 SQLite，可在进程重启后恢复；Agent 不执行任意 SQL、文件操作、外部搜索或桌面控制。

确认后的 AI 清单项使用独立任务卡展示优先级、类别、理由、完成标准、依据、课程状态和学习进度，并带有执行工作区。课程在后台依次完成蓝图设计、2～6 个教学模块、6～12 道分层练习和质量审查；每个模块包含实际讲解、示例或对比、易错点、面试表达与自测，练习覆盖基础、理解、应用和面试四个层次。页面显示真实生成阶段，关闭弹窗不影响后台生成；失败时保留旧指引，旧版简要指引也能兼容查看并按需重新生成。任务和模块只显示建议时长，不限制学习内容或完成状态。

复盘、知识答案、AI 助教、准备课程和陪练回答统一使用安全的 Markdown 富文本渲染，支持标题、段落、列表、引用、表格、代码块和链接。没有 Markdown 结构的旧版长正文会仅在展示时按完整句子自动分段，数据库原文不变。

**提示词**独立存放在 `server/src/prompts/` 目录（Markdown 文件），可以直接编辑调优，**修改后无需重启**：

| 文件 | 用途 |
|---|---|
| `jd-parse.system.md` | JD 解析的系统提示词（要求模型输出 JSON） |
| `application-extract.system.md` | 多图/文字招聘材料提取规则（字段证据、状态、投递时间和冲突） |
| `mail-recruitment-extract.system.md` | 招聘邮件事件、时间窗口、截止时间、链接白名单和逐字段原文证据提取 |
| `mail-schedule-review.system.md` | 独立复核招聘日程是否真实、明确、可执行，并要求引用邮件原文 |
| `review-advice.system.md` | 复盘点评的角色与输出格式要求 |
| `review-advice.user.md` | 点评请求的内容模板，`{{company}}` `{{jd}}` `{{review}}` 等占位符会被实际数据替换 |
| `knowledge-extract.system.md` | 面经文字/截图拆题与分类 |
| `knowledge-answer.system.md` | 批量生成结构化题目答案 |
| `recording-analysis.system.md` | 录音转写生成复盘和题目列表 |
| `recording-chunk.system.md` | 长录音逐段提取实际问答和表现 |
| `recording-merge.system.md` | 合并长录音分段、去重并生成整体复盘 |
| `learn-tutor.system.md` | AI 助教的对话规则和资料边界 |
| `prep-role-profile.system.md` | 面试准备 Agent 的岗位画像提取 |
| `prep-query-plan.system.md` | 面试准备 Agent 的知识检索计划 |
| `prep-gap-analysis.system.md` | 面试准备 Agent 的岗位与能力差距分析 |
| `prep-plan.system.md` | 面试准备 Agent 的内容优先准备计划生成与建议时长 |
| `prep-critic.system.md` | 面试准备 Agent 的事实、引用和可执行性审查 |
| `prep-task-blueprint.system.md` | 将已确认计划项拆成课程目标、模块和覆盖关系 |
| `prep-task-module.system.md` | 分模块生成完整讲解、示例、易错点、面试表达和自测 |
| `prep-task-practice.system.md` | 生成覆盖基础、理解、应用和面试层次的练习、答案、追问与评分标准 |
| `prep-task-critic.system.md` | 审查课程覆盖、内容深度、练习重复和个人事实风险 |
| `prep-task-coach.system.md` | 围绕单项任务进行讲解、模拟提问和作答点评 |

## 数据位置

全部数据在项目根目录 `data/`（git 忽略）：

- `job-tracer.db` — SQLite 数据库（记录、面试、清单）
- `uploads/` — 上传的简历文件
- `reviews/` — 面试复盘 Markdown
- `application_materials/` — 智能录入的原始招聘截图和 AI 推理副本；原始文字、关联关系和识别结果保存在 SQLite 中
- `prep_agent_checkpoints.db` — LangGraph 运行状态与人工审核断点
- `secrets/` — QQ 邮箱授权码密文；解密密钥不放在项目或数据备份中

数据库升级由 001～015 编号迁移执行，已应用版本记录在 `schema_migrations`。迁移只做向前兼容的增量升级，启动前仍建议按需使用 `backup.bat` 备份整个 `data/`。

删除程序不影响数据；重装/换电脑时拷走整个 `data` 目录即可迁移。

## 技术栈

Vue 3 + Element Plus + ECharts / Express 5 + better-sqlite3 + ImapFlow / Python 3.11～3.12 + FastAPI + LangGraph / Vite + TypeScript
