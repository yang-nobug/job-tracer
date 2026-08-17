# job-tracer 技术实施方案

> 对应需求基线 REQUIREMENTS.md v1.1 · 方案 v2（2026-08-18）

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
│   │   ├── index.ts          # Express 入口，监听 0.0.0.0:3210
│   │   ├── db.ts             # better-sqlite3 初始化 + 建表
│   │   ├── jd-parser.ts      # JD 正则解析
│   │   ├── review-file.ts    # 复盘 md 模板生成/读写
│   │   └── routes/
│   │       ├── applications.ts
│   │       ├── events.ts
│   │       ├── interviews.ts     # 含复盘、准备清单
│   │       ├── resumes.ts        # 简历上传/列表/预览
│   │       └── stats.ts
│   └── data/                 # 全部用户数据（gitignore）
│       ├── job-tracer.db     # SQLite 单文件
│       ├── uploads/          # 简历文件
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
    │       ├── AppFormDrawer.vue   # 录入/编辑抽屉（含 JD 解析入口）
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
unsent(未投递) -> applied(已投递) -> interviewing(约面) -> round1(一面)
-> round2(二面) -> round3(三面) -> hr(HR面) -> offer(Offer)
```

- "已挂"为终态标记：`rejected_at` 非空即已挂，进度保留在 `status`
- `reject_type`：`company`（被拒）/ `me`（我拒）
- 服务端校验：置为 applied 及之后状态时 `applied_at` 必填（前端自动填当天）

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
  round           TEXT NOT NULL,     -- 一面/二面/三面/HR面/其他
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
```

状态变更自动写入 `type='status'` 的 event；创建面试时自动生成复盘 md 并回填 `review_file`。

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
| GET | `/stats` | 数字卡片（总数/进行中/已挂/Offer）、漏斗（投递->约面->终面->Offer）、近 8 周趋势、渠道分布 |
| GET | `/upcoming` | **所有**未来面试（倒计时数据源）+ 元信息 |
| GET | `/meta` | 状态/渠道/轮次枚举，公司自动补全列表 |
| POST | `/jd-parse` | `{ text }` -> `{ company?, position?, location? }`（正则，无薪资） |

错误约定：422 返回 `{ message }`，前端统一 toast。

## 5. 页面与交互要点

- **布局**：顶部导航（看板/列表/统计/复盘）+ "记一笔"主按钮；CountdownBar 固定在导航下方显示所有未来面试；移动端（<768px）导航变底部 Tab
- **看板**：8 状态列 + 已挂列，横向滚动，列内按投递日期倒序；桌面 vuedraggable 拖拽（乐观更新，失败回滚），移动端点卡片进详情改状态
- **列表**：表格（移动端变卡片）+ 状态/渠道/关键词筛选 + 排序；行内操作
- **录入抽屉**：必填仅公司+职位；公司自动补全带默认值；渠道下拉可自建；JD 解析按钮 -> `/api/jd-parse` -> 回填可改；ResumePicker 内联选简历/上传
- **详情抽屉**：字段 + JD 正文 + 时间线（含面试事件）；InterviewPanel 管理日程、勾选清单、打开 ReviewEditor（左编辑右预览，markdown-it 渲染）
- **复盘页**：全部复盘文档列表（公司/轮次/时间），点开即 ReviewEditor
- **简历预览**：PDF 用 `<iframe>` 直读 `/api/resumes/:id/file`；Word 提示下载
- **统计**：漏斗/柱状/饼图 + 数字卡片，空数据给引导；移动端单列堆叠

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
9. 收尾：移动端适配、空状态、start.bat/backup.bat、README

每步本地自测通过再进下一步。

## 8. 验收标准

- 双击 `start.bat` 自动起服务并打开浏览器；`npm run dev` 开发模式正常
- 手机同 WiFi 访问 `http://电脑IP:3210`，各页面正常显示，倒计时条可见
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
| 拖拽在移动端体验差 | 移动端不拖拽，详情内改状态 |

## 10. 后续可扩展（对应需求文档第 6 节，本期不做）

跟进提醒、周待办、拒绝原因统计、深度转化分析、公司信息库、意愿度、薪资字段、Offer 对比、CSV 导出、PWA、浏览器插件。
