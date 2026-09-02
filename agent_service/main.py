from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException
os.environ.setdefault("LANGGRAPH_STRICT_MSGPACK", "true")

from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import Command
from pydantic import BaseModel, ConfigDict, Field

from . import __version__
from .client import JobTracerClient, JobTracerClientError
from .graph import build_graph


PROTOCOL_VERSION = 1
BASE_URL = os.environ.get("JOB_TRACER_BASE_URL", "http://127.0.0.1:3210").rstrip("/")
INTERNAL_TOKEN = os.environ.get("PREP_AGENT_INTERNAL_TOKEN", "")
CONTROL_TOKEN = os.environ.get("PREP_AGENT_CONTROL_TOKEN", "")
CHECKPOINT_PATH = Path(os.environ.get("PREP_AGENT_CHECKPOINT_PATH", "data/prep_agent_checkpoints.db"))


class ReviewDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["approve", "edit", "revise", "cancel"]
    edited_plan: dict[str, Any] | None = None
    feedback: str | None = Field(default=None, max_length=1000)


def control_auth(x_prep_agent_control_token: str | None = Header(default=None)) -> None:
    if not CONTROL_TOKEN or x_prep_agent_control_token != CONTROL_TOKEN:
        raise HTTPException(status_code=403, detail="禁止访问 Agent 控制接口")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not INTERNAL_TOKEN:
        raise RuntimeError("PREP_AGENT_INTERNAL_TOKEN 未配置")
    CHECKPOINT_PATH.parent.mkdir(parents=True, exist_ok=True)
    client = JobTracerClient(BASE_URL, INTERNAL_TOKEN)
    checkpoint_context = AsyncSqliteSaver.from_conn_string(str(CHECKPOINT_PATH))
    checkpointer = await checkpoint_context.__aenter__()
    graph = build_graph(client).compile(checkpointer=checkpointer)
    app.state.client = client
    app.state.graph = graph
    app.state.tasks = {}
    try:
        yield
    finally:
        for task in list(app.state.tasks.values()):
            task.cancel()
        await client.close()
        await checkpoint_context.__aexit__(None, None, None)


app = FastAPI(title="job-tracer interview prep agent", lifespan=lifespan)


def config(run_id: str) -> dict[str, Any]:
    return {"configurable": {"thread_id": f"prep:{run_id}"}, "recursion_limit": 30}


async def invoke_initial(run_id: str) -> None:
    try:
        await app.state.graph.ainvoke({"run_id": run_id}, config(run_id))
    except asyncio.CancelledError:
        return
    except Exception as error:
        kind = error.kind if isinstance(error, JobTracerClientError) else "agent_runtime"
        try:
            await app.state.client.update_run(
                run_id,
                status="failed",
                current_node="failed",
                error_type=kind,
                error_message=str(error)[:500],
            )
        except Exception:
            pass


async def invoke_resume(run_id: str, decision: dict[str, Any]) -> None:
    try:
        await app.state.graph.ainvoke(Command(resume=decision), config(run_id))
    except asyncio.CancelledError:
        return
    except Exception as error:
        kind = error.kind if isinstance(error, JobTracerClientError) else "agent_runtime"
        try:
            await app.state.client.update_run(
                run_id,
                status="failed",
                current_node="failed",
                error_type=kind,
                error_message=str(error)[:500],
            )
        except Exception:
            pass


async def invoke_recover(run_id: str) -> None:
    try:
        snapshot = await app.state.graph.aget_state(config(run_id))
        if not snapshot.values:
            await invoke_initial(run_id)
            return
        await app.state.graph.ainvoke(None, config(run_id))
    except asyncio.CancelledError:
        return
    except Exception as error:
        kind = error.kind if isinstance(error, JobTracerClientError) else "agent_recovery"
        try:
            await app.state.client.update_run(
                run_id,
                status="failed",
                current_node="failed",
                error_type=kind,
                error_message=str(error)[:500],
            )
        except Exception:
            pass


def schedule(run_id: str, coroutine) -> None:
    current = app.state.tasks.get(run_id)
    if current and not current.done():
        raise HTTPException(status_code=409, detail="该运行当前正在执行")
    task = asyncio.create_task(coroutine)
    app.state.tasks[run_id] = task

    def done(_: asyncio.Task) -> None:
        if app.state.tasks.get(run_id) is task:
            app.state.tasks.pop(run_id, None)

    task.add_done_callback(done)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "protocol": PROTOCOL_VERSION, "version": __version__}


async def exit_process() -> None:
    await asyncio.sleep(0.2)
    os._exit(0)


@app.post("/shutdown", dependencies=[Depends(control_auth)])
async def shutdown() -> dict[str, bool]:
    asyncio.create_task(exit_process())
    return {"ok": True}


@app.post("/runs/{run_id}/start", dependencies=[Depends(control_auth)], status_code=202)
async def start(run_id: str) -> dict[str, Any]:
    schedule(run_id, invoke_initial(run_id))
    return {"accepted": True, "run_id": run_id}


@app.post("/runs/{run_id}/resume", dependencies=[Depends(control_auth)], status_code=202)
async def resume(run_id: str, decision: ReviewDecision) -> dict[str, Any]:
    if decision.action == "edit" and decision.edited_plan is None:
        raise HTTPException(status_code=422, detail="edited_plan 不能为空")
    if decision.action == "revise" and not (decision.feedback or "").strip():
        raise HTTPException(status_code=422, detail="feedback 不能为空")
    schedule(run_id, invoke_resume(run_id, decision.model_dump(exclude_none=True)))
    return {"accepted": True, "run_id": run_id}


@app.post("/runs/{run_id}/recover", dependencies=[Depends(control_auth)], status_code=202)
async def recover(run_id: str) -> dict[str, Any]:
    schedule(run_id, invoke_recover(run_id))
    return {"accepted": True, "run_id": run_id}


@app.post("/runs/{run_id}/cancel", dependencies=[Depends(control_auth)])
async def cancel(run_id: str) -> dict[str, Any]:
    current = app.state.tasks.get(run_id)
    if current and not current.done():
        current.cancel()
    return {"ok": True, "run_id": run_id}
