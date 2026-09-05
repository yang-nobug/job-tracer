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
        self.code_enabled = False
        self.resume_enabled = False
        self.code_calls: list[dict[str, Any]] = []
        self.model_inputs: dict[str, dict[str, Any]] = {}
        self.code_facts: list[dict[str, Any]] = [{
            "kind": "code_fact", "statement": "使用 LangGraph 编排准备流程", "confidence": "high", "evidence_refs": ["C1"], "caveat": None,
        }]

    async def get_run_input(self, run_id: str) -> dict[str, Any]:
        return {
            "run_id": run_id,
            "thread_id": f"prep:{run_id}",
            "request_id": "request-0001",
            "application_id": 1,
            "interview_id": 2,
            "goal": "准备一面",
            "constraints": {"focus": ["前端基础"], "project_ids": [7] if self.code_enabled else [], "resume_id": 8 if self.resume_enabled else None},
            "status": "pending",
        }

    async def get_context(self, _run_id: str) -> dict[str, Any]:
        context = {
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
            "projects": [{"ref": "P1", "type": "project", "item_id": 7, "title": "求职跟踪器", "excerpt": "项目说明"}] if self.code_enabled else [],
        }
        if self.resume_enabled:
            context["resume"] = {"ref": "RES", "type": "resume", "item_id": 8, "title": "候选人简历.pdf", "excerpt": "项目：使用 LangGraph 编排多智能体面试准备流程。"}
            context["resume_status"] = "completed"
        else:
            context["resume"] = None
            context["resume_status"] = None
        return context

    async def search(self, _run_id: str, _queries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [{
            "ref": "E1", "type": "knowledge_item", "item_id": 10, "source_id": 20,
            "title": "Vue 响应式", "excerpt": "Proxy 和依赖收集", "score": 10,
        }]

    async def read_code(self, run_id: str, project_ids: list[int], objective: str, questions: list[str]) -> dict[str, Any]:
        self.code_calls.append({"run_id": run_id, "project_ids": project_ids, "objective": objective, "questions": questions})
        return {"packs": [{
            "project_id": 7, "status": "completed", "session_id": "code-session-1",
            "facts": self.code_facts,
        }]}

    async def model(self, _run_id: str, kind: str, _input_value: dict[str, Any]) -> dict[str, Any]:
        self.model_inputs[kind] = _input_value
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
        self.assertEqual(client.updates[-1]["role_profile"]["must_have_skills"][0]["text"], "Vue")
        self.assertEqual(client.updates[-1]["gap_analysis"]["gaps"][0]["skill"], "Vue")
        self.assertEqual(client.updates[-1]["critic"]["verdict"], "pass")
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

    async def test_selected_project_is_read_and_used_as_code_evidence(self) -> None:
        client = FakeClient()
        client.code_enabled = True
        graph = build_graph(client).compile(checkpointer=InMemorySaver())
        config = {"configurable": {"thread_id": "prep:code-evidence"}, "recursion_limit": 30}
        first = await graph.ainvoke({"run_id": "run-code"}, config)
        self.assertIn("__interrupt__", first)
        self.assertEqual(client.code_calls[0]["project_ids"], [7])
        self.assertEqual(client.model_inputs["gap_analysis"]["code_evidence"][0]["ref"], "CE1")
        self.assertIn("CE1", client.updates[-1]["evidence"][-1]["ref"])

    async def test_ungrounded_code_claim_is_not_passed_to_prep_plan(self) -> None:
        client = FakeClient()
        client.code_enabled = True
        client.code_facts = [{
            "kind": "inference", "statement": "可能使用了缓存", "confidence": "low", "evidence_refs": [], "caveat": "未读取到实现",
        }]
        graph = build_graph(client).compile(checkpointer=InMemorySaver())
        first = await graph.ainvoke({"run_id": "run-ungrounded-code"}, {"configurable": {"thread_id": "prep:ungrounded-code"}, "recursion_limit": 30})
        self.assertIn("__interrupt__", first)
        self.assertEqual(client.model_inputs["gap_analysis"]["code_evidence"], [])
        self.assertTrue(any("没有形成可引用结论" in warning for warning in client.updates[-1]["warnings"]))

    async def test_linked_resume_is_sent_as_traceable_material(self) -> None:
        client = FakeClient()
        client.resume_enabled = True
        graph = build_graph(client).compile(checkpointer=InMemorySaver())
        first = await graph.ainvoke({"run_id": "run-resume"}, {"configurable": {"thread_id": "prep:resume"}, "recursion_limit": 30})
        self.assertIn("__interrupt__", first)
        self.assertEqual(client.model_inputs["role_profile"]["resume"]["ref"], "RES")
        self.assertEqual(client.model_inputs["gap_analysis"]["resume"]["title"], "候选人简历.pdf")
        self.assertEqual(client.model_inputs["plan"]["resume"]["item_id"], 8)
        self.assertIn("RES", client.model_inputs["critic"]["context_refs"])


if __name__ == "__main__":
    unittest.main()
