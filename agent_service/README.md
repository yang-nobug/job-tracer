# 面试准备 Agent 服务

该目录是 job-tracer 的 Python + FastAPI + LangGraph 编排服务。它不直接访问业务数据库，只能通过 Express 提供的本机内部接口读取上下文、调用统一 AI 客户端，并在用户确认后请求批量写入准备清单。

运行依赖由根目录 `start.bat` 管理。手动开发时可以执行：

```powershell
python -m venv .venv-agent
.\.venv-agent\Scripts\python.exe -m pip install -r agent_service\requirements.txt
```

服务必须由 Express 启动或提供以下环境变量：

```text
JOB_TRACER_BASE_URL
PREP_AGENT_INTERNAL_TOKEN
PREP_AGENT_CONTROL_TOKEN
PREP_AGENT_CHECKPOINT_PATH
```

业务状态在 `job-tracer.db`，LangGraph Checkpoint 单独存放在 `data/prep_agent_checkpoints.db`。

