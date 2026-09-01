from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import Command

from agent_service.graph import build_graph


class FakeClient:
    def __init__(self) -> None:
        self.steps: list[dict[str, Any]] = []
        self.updates: list[dict[str, Any]] = []
        self.persisted: list[dict[str, Any]] = []

    async def get_run_input(self, run_id: str) -> dict[str, Any]:
        return {
            "run_id": run_id,
            "thread_id": f"prep:{run_id}",
            "request_id": "request-0001",
            "application_id": 1,
            "interview_id": 2,
            "goal": "准备一面",
            "constraints": {"available_minutes": 120, "focus": ["前端基础"]},
            "status": "pending",
        }

    async def get_context(self, _run_id: str) -> dict[str, Any]:
        return {
            "snapshot_hash": "a" * 64,
            "application": {
                "ref": "APP", "id": 1, "company": "星海科技", "position": "前端开发",
                "status": "round1", "location": "杭州", "jd_text": "要求 Vue 和性能优化", "notes": None,
            },
            "interview": {
                "ref": "IV", "id": 2, "round": "一面", "scheduled_at": "2026-09-03 10:00",
                "location": None, "done": 0,
            },
            "existing_checklist": [],
            "reviews": [],
            "mastery": [],
        }

    async def search(self, _queries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [{
            "ref": "E1", "type": "knowledge_item", "item_id": 10, "source_id": 20,
            "title": "Vue 响应式", "excerpt": "Proxy 和依赖收集", "score": 10,
        }]

    async def model(self, kind: str, _input_value: dict[str, Any]) -> dict[str, Any]:
        values: dict[str, Any] = {
            "role_profile": {
                "responsibilities": [],
                "must_have_skills": [{"text": "Vue", "source_refs": ["APP"], "confidence": 1}],
                "nice_to_have_skills": [], "project_signals": [],
                "likely_interview_topics": ["Vue 响应式"], "unknowns": [],
            },
            "query_plan": {
                "queries": [{"query": "Vue 响应式", "reason": "岗位要求", "category": "八股", "owner": None}]
            },
            "gap_analysis": {
                "gaps": [{
                    "skill": "Vue", "current_level": "unknown", "target_level": "interview_ready",
                    "reason": "岗位要求", "evidence_refs": ["E1"], "confidence": 0.6,
                }],
                "strengths": [], "warnings": [],
            },
            "plan": {
                "summary": "准备 Vue 核心原理",
                "items": [{
                    "title": "复习 Vue 响应式原理", "category": "knowledge", "priority": "high",
                    "estimated_minutes": 30, "reason": "岗位要求 Vue", "evidence_refs": ["E1"],
                    "success_criteria": "可以在三分钟内说明 Proxy、依赖收集和触发更新",
                }],
            },
            "critic": {"verdict": "pass", "issues": []},
        }
        return {
            "value": values[kind], "usage": {"promptTokens": 10, "completionTokens": 5, "totalTokens": 15}
        }

    async def start_step(self, run_id: str, node: str, attempt: int, input_hash: str, summary: str) -> int:
        self.steps.append({"run_id": run_id, "node": node, "attempt": attempt, "input_hash": input_hash, "summary": summary})
        return len(self.steps)

    async def finish_step(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    async def update_run(self, _run_id: str, **values: Any) -> None:
        self.updates.append(values)

    async def persist_plan(self, _run_id: str, plan: dict[str, Any]) -> dict[str, Any]:
        self.persisted.append(plan)
        return {"checklistIds": [99], "plan": plan}


class PrepGraphTest(unittest.IsolatedAsyncioTestCase):
    async def test_interrupt_then_approve_and_persist(self) -> None:
        client = FakeClient()
        graph = build_graph(client).compile(checkpointer=InMemorySaver())
        config = {"configurable": {"thread_id": "prep:run-1"}, "recursion_limit": 30}

        first = await graph.ainvoke({"run_id": "run-1"}, config)
        self.assertIn("__interrupt__", first)
        self.assertEqual(client.updates[-1]["status"], "waiting_review")
        self.assertEqual(len(client.persisted), 0)

        completed = await graph.ainvoke(Command(resume={"action": "approve"}), config)
        self.assertEqual(completed["persisted_checklist_ids"], [99])
        self.assertEqual(len(client.persisted), 1)
        self.assertEqual(completed["metrics"]["model_calls"], 5)

    async def test_sqlite_checkpoint_survives_graph_restart(self) -> None:
        client = FakeClient()
        config = {"configurable": {"thread_id": "prep:run-restart"}, "recursion_limit": 30}
        with TemporaryDirectory() as directory:
            checkpoint = str(Path(directory) / "checkpoints.db")
            async with AsyncSqliteSaver.from_conn_string(checkpoint) as saver:
                graph = build_graph(client).compile(checkpointer=saver)
                first = await graph.ainvoke({"run_id": "run-restart"}, config)
                self.assertIn("__interrupt__", first)
                self.assertEqual(len(client.persisted), 0)

            async with AsyncSqliteSaver.from_conn_string(checkpoint) as saver:
                restarted = build_graph(client).compile(checkpointer=saver)
                completed = await restarted.ainvoke(Command(resume={"action": "approve"}), config)
                self.assertEqual(completed["persisted_checklist_ids"], [99])
                self.assertEqual(len(client.persisted), 1)


if __name__ == "__main__":
    unittest.main()
