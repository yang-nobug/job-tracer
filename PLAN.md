# job-tracer 技术实施方案

> 对应需求基线 REQUIREMENTS.md v1.4 · 方案 v4（2026-08-19，新增录音复盘管道）

## 1. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | Vue 3 + Vite + TypeScript | 组合式 API，`<script setup>` |
| UI 组件 | Element Plus | 表格/表单/抽屉/日期选择器，中文文档完善 |
| 图表 | ECharts (vue-echarts) | 漏斗图 + 柱状图 + 饼图 |
| 拖拽 | vuedraggable（Sortable.js） | 看板卡片拖拽改状态 |
| Markdown | markdown-it | 复盘文档渲染预览 |
| 后端 | Node.js 24 + Express 5 + TypeScript | 本机 Node v24.19.0 |
| 数据库 | SQLite + better-sqlite3 | 同步 API、零配置；安装失败则降级 Node 内置 `node:sqlite` |
| 文件上传 | multer | 简历 PDF/Word 上传 |
| 脚本 | concurrently + tsx | 开发时前后端并行 |

## 2. 项目结构

```
job-tracer/
├── package.json              # 根：统一 scripts 与依赖
├── start.bat                 # 双击启动：起服务 + 打开浏览器
├── backup.bat                # 双击备份：复制 data 目录加日期后缀
├── PLAN.md / REQUIREMENTS.md
├── server/
│   ├── src/
│   │   ├── index.ts          # Express 入口，仅监听 127.0.0.1:3210
│   │   ├── db.ts             # better-sqlite3 初始化 + 建表
│   │   ├── jd-parser.ts      # JD 正则解析
│   │   ├── review-file.ts    # 复盘 md 模板生成/读写
│   │   ├── oss.ts            # 阿里云 OSS 上传/签名 URL/删除（录音转写中转）
│   │   ├── asr.ts            # 火山方舟大模型录音识别（提交任务 + 轮询）
│   │   └── routes/
│   │       ├── applications.ts
│   │       ├── events.ts
│   │       ├── interviews.ts     # 含复盘、准备清单
│   │       ├── recordings.ts     # 录音复盘管道（上传/状态/重试/删除）
│   │       ├── resumes.ts        # 简历上传/列表/预览
│   │       └── stats.ts
│   └── data/                 # 全部用户数据（gitignore）
│       ├── job-tracer.db     # SQLite 单文件
│       ├── uploads/          # 简历文件
│       ├── recordings/       # 面试录音音频
│       └── reviews/          # 面试复盘 md 文档
└── web/
    ├── src/
    │   ├── main.ts / App.vue
    │   ├── api/              # fetch 封装
    │   ├── types/            # 与后端同步的枚举与接口
    │   ├── views/
    │   │   ├── KanbanView.vue
    │   │   ├── ListView.vue
    │   │   ├── StatsView.vue
    │   │   └── ReviewsView.vue    # 复盘汇总页
    │   └── components/
    │       ├── AppFormDrawer.vue   # 录入/编辑抽屉（含多图/文字招聘材料智能录入）
    │       ├── DetailDrawer.vue    # 详情 + 时间线
    │       ├── EventTimeline.vue
    │       ├── InterviewPanel.vue  # 面试日程/复盘/准备清单
    │       ├── ReviewEditor.vue    # md 编辑框 + 预览
    │       ├── ResumePicker.vue    # 简历选择/上传
    │       ├── CountdownBar.vue    # 面试倒计时条
    │       └── FilterBar.vue
    └── vite.config.ts        # dev 代理 /api -> localhost:3210
```

**启动**：
- 开发：`npm run dev`（Vite + tsx 并行）
- 使用：`npm run build` 一次，之后双击 `start.bat`（或 `npm start`），访问 `http://localhost:3210`

## 3. 数据库设计

### 3.1 状态机（与需求 3.1.2 一致）

```
unsent(未投递) -> applied(已投递) -> assessment(心理测评) -> testing(笔试)
-> ai(AI面) -> round1(一面) -> round2(二面) -> round3(三面) -> hr(HR面) -> offer(Offer)
```

- 考核环节（assessment/testing/ai）可选，可从 applied 直接跳 round1；添加面试记录自动推进状态（只前进不后退）
- "已挂"为终态标记：`rejected_at` 非空即已挂，进度保留在 `status`
- `reject_type`：`company`（被拒）/ `me`（我拒）
- 服务端校验：置为 applied 及之后状态时 `applied_at` 必填（缺省自动填当天）；改回 unsent 时清空 `applied_at`

### 3.2 表结构

```sql
CREATE TABLE applications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company       TEXT NOT NULL,
  position      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'unsent',
  applied_at    TEXT,                -- 标记已投递时填，YYYY-MM-DD
  channel       TEXT DEFAULT '其他',
  location      TEXT,
  resume_id     INTEGER REFERENCES resumes(id) ON DELETE SET NULL,
  jd_link       TEXT,
  jd_text       TEXT,
  contact_name  TEXT,
  contact_info  TEXT,
  notes         TEXT,
  rejected_at   TEXT,
  reject_type   TEXT,                -- company / me
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_app_status ON applications(status);
CREATE INDEX idx_app_company ON applications(company);

CREATE TABLE resumes (               -- 简历文件（需求 3.6）
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  filename      TEXT NOT NULL,       -- 原始文件名
  stored_name   TEXT NOT NULL,       -- 存储文件名（重名加后缀）
  size          INTEGER NOT NULL,
  note          TEXT,                -- 备注，如"v3-后端方向"
  uploaded_at   TEXT NOT NULL
);

CREATE TABLE events (                -- 时间线
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id  INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,     -- note/status/interview/other
  event_date      TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_event_app ON events(application_id);

CREATE TABLE interviews (            -- 面试日程 + 复盘文件（需求 3.7）
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id  INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  round           TEXT NOT NULL,     -- 心理测评/笔试/AI面/一面/二面/三面/HR面/其他
  scheduled_at    TEXT NOT NULL,     -- YYYY-MM-DD HH:mm
  location        TEXT,              -- 线下地点或会议链接
  review_file     TEXT,              -- 自动生成的复盘 md 路径（相对 data/）
  done            INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_iv_app ON interviews(application_id);
CREATE INDEX idx_iv_time ON interviews(scheduled_at);

CREATE TABLE checklist_items (       -- 面试准备清单（需求 3.7.3）
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id    INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  done            INTEGER NOT NULL DEFAULT 0,
  sort            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE knowledge_sources (     -- 面经/知识库源（需求 3.9.1）
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner           TEXT NOT NULL CHECK(owner IN ('others','mine')),  -- 他人面经 / 我的面试，分开存放
  company         TEXT NOT NULL,
  position        TEXT,              -- 岗位名
  round           TEXT,              -- 几面：一面/二面/…（自由文本，可空）
  source_type     TEXT NOT NULL DEFAULT 'manual',  -- text/image/manual（二期 audio）
  note            TEXT,              -- 备注（如面经出处链接，可空）
  application_id  INTEGER REFERENCES applications(id) ON DELETE SET NULL,  -- 仅 mine，二期录音管道关联
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_ks_owner ON knowledge_sources(owner);

CREATE TABLE knowledge_items (       -- 题目条目（需求 3.9.1）
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id       INTEGER REFERENCES knowledge_sources(id) ON DELETE CASCADE,  -- NULL=手动独立条目
  question        TEXT NOT NULL,
  answer          TEXT,              -- markdown，可空（AI 批量生成或手动填写）
  category        TEXT NOT NULL DEFAULT '其他',  -- 八股/项目/算法/综合面试/其他
  sub_category    TEXT,              -- 预留二级分类（如八股->计网），本期不用
  mastery         INTEGER NOT NULL DEFAULT 0,    -- 0未掌握 / 1模糊 / 2已掌握
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_ki_source ON knowledge_items(source_id);
CREATE INDEX idx_ki_category ON knowledge_items(category);
CREATE INDEX idx_ki_mastery ON knowledge_items(mastery);

CREATE TABLE knowledge_images (      -- 面经截图留底（需求 3.9.1）
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id       INTEGER NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,     -- 原始文件名
  stored_name     TEXT NOT NULL,     -- 存储文件名
  created_at      TEXT NOT NULL
);

CREATE TABLE recordings (           -- 面试录音复盘管道（需求 3.9.5 学习二期）
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id      INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  filename          TEXT NOT NULL,   -- 原始文件名
  stored_name       TEXT NOT NULL,   -- 存储文件名（data/recordings/）
  size              INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'uploading',
  -- 状态机：uploading(转传OSS) -> transcribing(转写中) -> analyzing(分析中) -> done / failed
  transcript        TEXT,            -- ASR 转写全文（留存，复盘页可查看）
  knowledge_source_id INTEGER REFERENCES knowledge_sources(id) ON DELETE SET NULL,  -- 自动创建的面经
  error             TEXT,            -- 失败原因
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_rec_iv ON recordings(interview_id);
```

状态变更自动写入 `type='status'` 的 event；创建面试时自动生成复盘 md 并回填 `review_file`。
截图存 `data/knowledge_images/`；重复题目**不做去重**（重复=高频信号，见需求 3.9.1）。

### 3.3 复盘 md 模板（review-file.ts 生成）

```
data/reviews/2026-08-20-某公司-一面.md
```

```markdown
# 复盘：某公司 · 一面（2026-08-20）

## 被问的问题
- 

## 自我评价
### 答得好的
- 
### 答得差的
- 

## 改进点 / 下次要准备的
- 
```

## 4. API 设计（前缀 /api，JSON）

### 投递记录

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/applications` | 查询参数：status、channel、keyword、rejected、from/to；按 updated_at 倒序 |
| POST | `/applications` | 必填 company/position；applied 及之后状态校验 applied_at |
| PUT | `/applications/:id` | 更新；status 变化自动追加 status event |
| DELETE | `/applications/:id` | 级联删除 events/interviews/checklist（复盘 md 保留，孤儿文件由备份清理） |
| GET | `/applications/:id` | 详情（含 events、interviews、关联简历） |
| PATCH | `/applications/:id/reject` | `{ reject_type }`；空体撤销 |

### 简历（需求 3.6）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/resumes` | 列表 |
| POST | `/resumes` | multipart 上传（multer），限 pdf/doc/docx，单文件 ≤ 20MB |
| DELETE | `/resumes/:id` | 删除记录与文件（被引用时置空关联） |
| GET | `/resumes/:id/file` | 文件流（Content-Type 按扩展名），供浏览器预览/下载 |

### 时间线 / 面试 / 复盘 / 清单（需求 3.5 / 3.7）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/applications/:id/events` / DELETE `/events/:id` | 时间线增删 |
| POST | `/applications/:id/interviews` | 添加面试，自动生成复盘 md |
| PATCH | `/interviews/:id` | 改时间/标记完成 |
| DELETE | `/interviews/:id` | 删除日程与清单，md 保留在磁盘 |
| GET | `/interviews/:id/review` | 读取复盘 md 内容 |
| PUT | `/interviews/:id/review` | 保存复盘 md 内容 |
| GET | `/reviews` | 全部复盘汇总（join 投递信息，按面试时间倒序，需求 3.7.2 汇总入口） |
| POST | `/interviews/:id/checklist` | 添加清单项 |
| PATCH | `/checklist/:id` | 勾选/编辑 |
| DELETE | `/checklist/:id` | 删除 |

### 统计与元信息

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/stats` | 数字卡片（总数/进行中/已挂/Offer）、漏斗（投递->面试->终面->Offer，单调主干）、各环节经历岗位数、近 8 周趋势、渠道分布 |
| GET | `/upcoming` | **所有**未来面试（倒计时数据源）+ 元信息 |
| GET | `/meta` | 状态/渠道/轮次枚举，公司自动补全列表 |
| POST | `/jd-parse` | `{ text }` -> `{ company?, position?, location? }`（正则，无薪资） |

### 知识库（需求 3.9）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/knowledge/sources` | `?owner=others\|mine&keyword=`；返回各面经的题目数，按创建时间倒序 |
| POST | `/knowledge/sources` | `{ owner, company, position?, round?, note? }` 创建面经（录入流程先建源再挂条目） |
| PUT | `/knowledge/sources/:id` | 编辑面经元信息 |
| DELETE | `/knowledge/sources/:id` | 级联删除条目与截图记录（截图文件一并删） |
| GET | `/knowledge/sources/:id` | 面经详情：条目列表 + 截图列表 |
| GET | `/knowledge/items` | `?owner=&category=&mastery=&keyword=&source_id=`；keyword 同时搜问题与答案 |
| POST | `/knowledge/items` | 手动录入单条（source_id 可空=独立条目） |
| POST | `/knowledge/items/batch` | `{ source_id, items: [{question, answer?, category}] }` 候选批量入库 |
| PUT | `/knowledge/items/:id` | 编辑问题/答案/分类 |
| PATCH | `/knowledge/items/:id/mastery` | `{ mastery: 0\|1\|2 }` |
| DELETE | `/knowledge/items/:id` | 删除单条 |
| GET | `/knowledge/images/:id/file` | 截图文件流（预览） |
| DELETE | `/knowledge/images/:id` | 删除截图（仅删文件，条目保留） |

### 知识库 AI（需求 3.9.2 / 3.9.4）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/ai/knowledge/extract-text` | `{ text }`（≤1 万字）-> `{ questions: [{question, answer?, category}] }`；自带答案的保留 |
| POST | `/ai/knowledge/extract-image` | multipart 单图 -> 同上；多张由前端逐张调用后合并为一个候选列表（≤9 张） |
| POST | `/ai/knowledge/generate-answers` | `{ ids: [...] }` -> 逐条生成答案落库并返回更新条目；有答案的跳过 |
| POST | `/ai/knowledge/tutor` | `{ messages: [{role, content}] }` -> `{ reply }`；服务端按关键词检索知识库 top-N 条目注入上下文 |

- AI 接口全部走现有 `ai.ts` 的方舟封装；未配置 config.json 时返回明确错误，前端禁用入口
- 图片输入用 chat completions 的 `image_url`（base64 data URL）；**开工前先实测** doubao-seed-2-0-mini 是否支持图片输入，不支持则在 config.json 增加可选 `visionModel` 字段单独指定视觉模型
- 提示词外置：`prompts/knowledge-extract.system.md`（拆题+分类，JSON 输出）、`prompts/knowledge-answer.system.md`（按题生成 markdown 答案）、`prompts/learn-tutor.system.md`（助教风格）

错误约定：422 返回 `{ message }`，前端统一 toast。

### 录音复盘管道（需求 3.9.5 学习二期）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/recordings` | multipart（audio + interview_id）。本地有 ffmpeg 时自动把 m4a/aac/webm 转成 mp3 单声道；建记录后**异步**启动管道并立即返回 |
| GET | `/recordings` | 列表（join 面试/投递信息，按上传时间倒序） |
| GET | `/recordings/:id` | 单条状态详情（前端轮询用；含转写全文） |
| POST | `/recordings/:id/retry` | 失败重试：有转写全文则从分析阶段续跑，否则整条重跑 |
| DELETE | `/recordings/:id` | 删记录 + 本地音频文件（已生成的复盘 md 和面经保留） |

**后台管道**（服务端内存态任务，不阻塞 HTTP）：

```
本地音频 -> (ffmpeg 可选转码) -> 传阿里云 OSS 私有桶 -> 生成 1 小时签名 URL
  -> 提交方舟大模型录音识别标准版（audio.url = 签名 URL）
  -> 轮询查询（10s 间隔，上限 30 分钟；20000001/2=处理中，20000000=完成）
  -> 删除 OSS 临时文件 -> 转写全文入库
  -> 大模型分析（复盘 md + 题目列表）
  -> writeReviewFile 覆盖该面试的复盘 md（复盘只来源于录音）
  -> 自动创建面经（owner=mine, source_type=audio, 关联 application_id）+ 题目批量入库
```

- ASR 接口：`POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit` / `query`；`X-Api-Resource-Id: volc.seedasr.auc`（2.0）；`X-Api-Request-Id` 为 UUID 任务号；音频 ≤512MB，支持 raw/wav/mp3/ogg；开启 `enable_itn` + `enable_punc` + `enable_ddc`
- 鉴权两种模式兼容：新版控制台 `X-Api-Key` 单 key；旧版 `X-Api-App-Key + X-Api-Access-Key`
- 分析提示词外置 `prompts/recording-analysis.system.md`：输入转写全文 + 公司/岗位/轮次；输出用分隔符格式（沿用生成答案的防转义经验）：`@@@REVIEW@@@` 包 markdown 复盘（沿用被问的问题/自我评价/改进点结构）+ `@@@QUESTIONS@@@` 包题目 JSON 数组（question/answer=我当时回答的要点/category）
- config.json 新增两段（照旧 gitignore）：`asr: { apiKey? , appId?+accessToken?, resourceId }`、`oss: { accessKeyId, accessKeySecret, bucket, region }`；缺配置时接口返回明确错误

## 5. 页面与交互要点

- **布局（双工作区，需求 3.10）**：顶部居中分段切换器「投递跟踪 / 学习成长」，记忆上次停留（localStorage）；投递跟踪 = 看板/列表/统计 + 面试倒计时条 + 「+ 新增投递」；学习成长 = 复盘/学习 + 「+ 录入面经」；路由分组 `/track/...` `/learn/...`，旧路由重定向
- **看板**：前段（未投递/已投递，未投递可折叠）/ 考核组（心理测评/笔试/AI面）/ 面试组（一面~HR面）/ 后段（Offer/已挂，已挂可折叠），横向滚动，列内按投递日期倒序；桌面 vuedraggable 拖拽（乐观更新，失败回滚），拖入考核/面试列弹窗补时间
- **列表**：表格+ 范围（进行中/全部/已挂）+ 状态/渠道/关键词筛选 + 排序；整行点开详情；行内操作
- **录入弹窗**：必填公司+职位；支持最多 9 张招聘截图与文字混合输入，AI 返回字段、状态、日期及原文证据，核对后回填；材料日期明确时优先采用，缺失或冲突时不自动补今天；原始材料与记录关联留存；保留纯文字本地 JD 解析；ResumePicker 内联选简历/上传
- **详情弹窗**：字段 + JD 正文 + 时间线（含面试事件）；InterviewPanel 管理日程、勾选清单、打开 ReviewEditor（左编辑右预览，markdown-it 渲染）
- **复盘页**：全部复盘文档列表（公司/轮次/时间），点开即 ReviewEditor；顶部「⬆ 上传录音」弹窗（选面试记录 + 拖入音频文件，格式校验 mp3/wav/ogg/m4a/aac/webm）；上传后卡片实时显示状态徽标（转写中/分析中/完成/失败+重试），完成后复盘 md 与面经自动就绪；面试卡片可展开查看转写全文
- **简历预览**：PDF 用 `<iframe>` 直读 `/api/resumes/:id/file`；Word 提示下载
- **统计**：漏斗/环节条形/周趋势/饼图 2x2 + 数字卡片，空数据给引导
- **学习页（需求 3.9.3）**：顶部「他人面经 / 我的面试」切换；双视图：按题目（列表+分类/掌握度/关键词筛选，答案默认收起点击展开）/ 按面经（面经卡片展开题目）；录入流程：粘贴文本或传截图（≤9 张）-> AI 候选列表（可改分类、默认全选）-> 勾选入库 -> 对无答案条目批量「生成答案」；掌握度一键三档切换
- **AI 助教（需求 3.9.4）**：学习页右侧抽屉，多轮对话，回答自动带知识库相关条目上下文；会话内存态，刷新清空；未配 key 禁用

## 6. start.bat / backup.bat

```bat
:: start.bat（示意）
@echo off
cd /d %~dp0
start "" http://localhost:3210
npm start
```

- `start.bat`：先起浏览器再前台跑服务（窗口保留看日志，关窗即停服务）
- `backup.bat`：把 `server/data` 整目录复制为 `backups/data-2026-08-18-003200`（db + 简历 + 复盘一起备份）

## 7. 实施步骤

1. 项目骨架：根 package.json + scripts、server/web 初始化、Vite 代理、.gitignore
2. 后端主链路：db 建表 -> applications + events 路由 -> curl 验证
3. 后端扩展：interviews（含复盘文件生成）-> checklist -> resumes（multer）-> stats/upcoming/meta/jd-parse -> 逐个验证
4. 前端主链路：布局/api 封装/类型 -> 列表页 -> 录入编辑抽屉 -> 详情时间线
5. 面试与复盘：InterviewPanel -> ReviewEditor -> ReviewsView -> CountdownBar
6. 看板 + 拖拽
7. 简历上传与预览
8. 统计页
9. 收尾：空状态、start.bat/backup.bat、README
10. 双工作区导航重组：路由分组与重定向、顶部切换器、头部随区切换
11. 知识库后端：三张表建表 -> knowledge 路由（源/条目/截图 CRUD + 批量入库）-> curl 验证
12. 知识库 AI：提示词三件套 -> extract-text / extract-image / generate-answers / tutor 接口；先实测视觉模型支持
13. 学习页前端：双视图 + 录入流程（文本/截图候选列表）+ 掌握度交互
14. AI 助教抽屉
15. 录音复盘管道：recordings 建表 -> oss.ts / asr.ts 封装 -> recordings 路由（上传/异步管道/轮询/重试）-> 分析提示词 -> 复盘页上传弹窗与状态展示

每步本地自测通过再进下一步。

## 8. 验收标准

- 双击 `start.bat` 自动起服务并打开浏览器；`npm run dev` 开发模式正常
- 电脑浏览器访问 `http://localhost:3210`，各页面正常显示，倒计时条可见；服务仅监听本机回环地址
- 走通全流程：录入（30 秒内）-> 拖拽改状态 -> 添加面试（自动生成复盘 md）-> 应用内编辑复盘且磁盘文件同步变化 -> 勾选清单 -> 标记挂掉/撤销 -> 统计数字正确
- 上传 PDF 简历可在线预览并关联到投递记录
- 删除投递后关联事件/面试/清单级联清除
- backup.bat 产出完整数据目录副本

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| better-sqlite3 原生模块 Windows 编译失败 | 降级 Node 内置 `node:sqlite`（API 略改，封装在 db.ts 内） |
| Word 在线预览浏览器不支持 | 需求已约定：Word 提供下载即可 |
| 磁盘上的复盘 md 与删除的面试脱钩成孤儿文件 | 删除面试时 md 保留（用户可能自己写过内容），备份时统一收纳；不做自动删 |
| doubao-seed-2-0-mini 不支持图片输入 | config.json 加可选 `visionModel` 单独指定视觉模型；再不行降级为「截图只留底、提取仅文本」 |
| 长截图/口语化面经识别质量差 | 提示词外置可随时迭代；识别失败明确提示不静默丢弃 |
| tutor 上下文过长超 token 限制 | 知识库检索只注入 top-N（默认 5）相关条目，按问题+答案关键词 LIKE 匹配 |
| 批量生成答案耗时长 | 前端按钮 loading + 逐条生成进度提示；单批上限 20 条 |
| 录音是 m4a/aac 等不支持的格式且机器未装 ffmpeg | 上传接口明确报错提示安装 ffmpeg 或自行转成 mp3；检测到 ffmpeg 则服务端自动转码 |
| OSS / ASR 未配置或欠费 | 各阶段失败原因落库（recordings.error），失败可一键重试，不静默丢弃 |
| 长录音转写耗时数分钟 | 后台异步任务 + 前端 3s 轮询状态；服务重启丢内存态任务则靠「重试」恢复 |
| 复盘 md 被 AI 结果覆盖 | 产品约定：复盘只来源于录音，覆盖即预期；转写全文与生成的复盘均在 recordings 留底 |

## 10. 后续可扩展（对应需求文档第 6 节，本期不做）

跟进提醒、周待办、拒绝原因统计、深度转化分析、公司信息库、意愿度、薪资字段、Offer 对比、CSV 导出、浏览器插件；学习二期剩余（复习抽测、间隔复习、高频题统计、去重筛选视图、二级分类细化）。
