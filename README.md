# job-tracer 求职状态跟踪

本地运行的求职投递跟踪工具：记录公司、职位、渠道、状态、面试与复盘，看板/列表/统计多视图，仅在本机电脑浏览器使用。

- 需求文档：[REQUIREMENTS.md](REQUIREMENTS.md)
- 技术方案：[PLAN.md](PLAN.md)

## 快速开始

1. 已安装 Node.js（≥ 22）
2. **双击 `start.bat`**：首次会自动安装依赖并构建，之后自动启动服务并打开浏览器
3. 访问 <http://localhost:3210>

服务仅监听本机地址 `127.0.0.1:3210`，不向局域网开放。

## 日常使用

| 操作 | 方式 |
|---|---|
| 记一笔 | 右上角「+ 新增投递」，必填仅公司 + 职位 |
| 智能录入 | 新增投递 →「招聘信息智能录入」；可粘贴文字、拖入或 Ctrl+V 粘贴最多 9 张截图，核对识别字段及原文依据后保存 |
| 改状态 | 看板拖拽卡片；或点开详情用状态下拉 |
| 添加面试 | 详情 → 面试 → 添加（自动生成复盘 md 文件） |
| 写复盘 | 面试的「📝 复盘」，应用内编辑或直接改 `server/data/reviews/*.md` |
| 简历 | 表单里上传/选择简历，PDF 支持在线预览 |
| 备份 | 双击 `backup.bat`，数据整体复制到 `backups/` |

## 命令行

```bash
npm run dev     # 开发模式（前端热更新 + 后端 watch）
npm run build   # 构建前端到 server/public
npm start       # 生产模式启动
node test-api.mjs  # 后端 API 冒烟测试（需服务已启动）
```

## AI 功能（可选）

支持接入火山方舟大模型（豆包），提供 **AI JD 解析**（录入时自动提取公司/职位/地点+岗位摘要）和**复盘 AI 点评**（薄弱点分析/改进建议/下轮追问预测）：

1. 复制 `config.example.json` 为 `config.json`
2. 填入火山方舟的 `apiKey`（模型 ID 已预填 `doubao-seed-2-0-mini-260428`，如换模型自行修改）
3. 重启服务即可，入口在录入表单的「粘贴 JD 解析」和复盘编辑器的「✨ AI 点评」

不配置也能正常使用（AI 按钮会提示未配置，本地正则解析不受影响）。API Key 只存在本地 config.json（已 gitignore），仅后端调用，不会发到浏览器。

招聘智能录入使用 `ark.recruitment.model`。有截图时，该模型还必须在 `ark.models` 中明确标记 `"vision": true`。`outputMode` 取 `text`、`json_object` 或 `json_schema`，必须按所用模型实际支持的能力配置；不确定时使用 `text`。截图和文字仅在点击「开始识别」后发送给已配置的 AI 服务，原始材料保存在本机 `data/application_materials/`，随投递记录删除。

**提示词**独立存放在 `server/src/prompts/` 目录（Markdown 文件），可以直接编辑调优，**修改后无需重启**：

| 文件 | 用途 |
|---|---|
| `jd-parse.system.md` | JD 解析的系统提示词（要求模型输出 JSON） |
| `application-extract.system.md` | 多图/文字招聘材料提取规则（字段证据、状态、投递时间和冲突） |
| `review-advice.system.md` | 复盘点评的角色与输出格式要求 |
| `review-advice.user.md` | 点评请求的内容模板，`{{company}}` `{{jd}}` `{{review}}` 等占位符会被实际数据替换 |

## 暂停的功能

BOSS 桌面自动化暂时停用：界面不再显示入口，旧的自动化页面链接会跳回看板；后端不再加载自动化接口、定时调度器或桌面控制模块。源码、原有配置和历史数据保留，其他投递跟踪、复盘与学习功能不受影响。

## 数据位置

全部数据在项目根目录 `data/`（git 忽略）：

- `job-tracer.db` — SQLite 数据库（记录、面试、清单）
- `uploads/` — 上传的简历文件
- `reviews/` — 面试复盘 Markdown
- `application_materials/` — 智能录入保留的原始招聘截图；原始文字和识别结果保存在 SQLite 中

删除程序不影响数据；重装/换电脑时拷走整个 `data` 目录即可迁移。

## 技术栈

Vue 3 + Element Plus + ECharts / Express 5 + better-sqlite3 / Vite + TypeScript
