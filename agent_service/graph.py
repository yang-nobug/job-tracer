from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Literal, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from .client import JobTracerClient, JobTracerClientError


class PrepAgentState(TypedDict, total=False):
    run_id: str
    thread_id: str
    request_id: str
    application_id: int
    interview_id: int
    user_goal: str
    constraints: dict[str, Any]
    context_snapshot_hash: str
    context: dict[str, Any]
    role_profile: dict[str, Any]
    retrieval_queries: list[dict[str, Any]]
    evidence: list[dict[str, Any]]
    code_evidence: list[dict[str, Any]]
    gap_analysis: dict[str, Any]
    draft_plan: dict[str, Any]
    critic_result: dict[str, Any]
    revision_count: int
    review_feedback: str
    review_action: dict[str, Any]
    persisted_checklist_ids: list[int]
    warnings: list[str]
    metrics: dict[str, int]


NodeResult = dict[str, Any]
NodeFunction = Callable[[PrepAgentState], Awaitable[NodeResult]]


def stable_hash(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def clipped_error(error: Exception) -> str:
    return str(error).strip()[:500] or error.__class__.__name__


def metrics(state: PrepAgentState) -> dict[str, int]:
    current = state.get("metrics", {})
    return {
        "model_calls": int(current.get("model_calls", 0)),
        "prompt_tokens": int(current.get("prompt_tokens", 0)),
        "completion_tokens": int(current.get("completion_tokens", 0)),
        "total_tokens": int(current.get("total_tokens", 0)),
    }


def add_model_metrics(state: PrepAgentState, response: dict[str, Any]) -> dict[str, int]:
    result = metrics(state)
    usage = response.get("usage") or {}
    result["model_calls"] += 1
    result["prompt_tokens"] += int(usage.get("promptTokens") or 0)
    result["completion_tokens"] += int(usage.get("completionTokens") or 0)
    result["total_tokens"] += int(usage.get("totalTokens") or 0)
    return result


def unique_warnings(*groups: list[str]) -> list[str]:
    result: list[str] = []
    for group in groups:
        for value in group:
            text = str(value).strip()[:300]
            if text and text not in result:
                result.append(text)
    return result[:30]


def normalized_focus(value: Any) -> str:
    """用于校验用户重点是否被原样映射到计划任务，忽略大小写与空白差异。"""
    return "".join(str(value).strip().casefold().split())


def plan_issues(state: PrepAgentState, plan: dict[str, Any]) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    items = plan.get("items") if isinstance(plan, dict) else None
    if not isinstance(items, list) or not items:
        return [{"code": "VAGUE_ACTION", "item_index": None, "message": "计划没有任务"}]
    valid_refs = {"APP", "IV"}
    context = state.get("context", {})
    if context.get("resume"):
        valid_refs.add(str(context["resume"].get("ref", "RES")))
    valid_refs.update(str(item.get("ref")) for item in context.get("reviews", []))
    valid_refs.update(str(item.get("ref")) for item in context.get("mastery", []))
    valid_refs.update(str(item.get("ref")) for item in context.get("projects", []))
    valid_refs.update(str(item.get("ref")) for item in state.get("evidence", []))
    valid_refs.update(str(item.get("ref")) for item in state.get("code_evidence", []))
    existing = [
        "".join(ch.lower() for ch in str(item.get("content", "")) if ch.isalnum())
        for item in context.get("existing_checklist", [])
    ]
    seen: set[str] = set()
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            issues.append({"code": "VAGUE_ACTION", "item_index": index, "message": "任务格式非法"})
            continue
        title = str(item.get("title", "")).strip()
        key = "".join(ch.lower() for ch in title if ch.isalnum())
        if not title or len(title) < 4:
            issues.append({"code": "VAGUE_ACTION", "item_index": index, "message": "任务标题过于模糊"})
        if key in seen or any(value and (value.find(key) >= 0 or key.find(value) >= 0) for value in existing):
            issues.append({"code": "DUPLICATED_ITEM", "item_index": index, "message": "任务与计划或已有清单重复"})
        seen.add(key)
        if not str(item.get("success_criteria", "")).strip():
            issues.append({"code": "MISSING_SUCCESS_CRITERIA", "item_index": index, "message": "缺少完成标准"})
        for ref in item.get("evidence_refs", []):
            if str(ref) not in valid_refs:
                issues.append({"code": "INVALID_REFERENCE", "item_index": index, "message": f"无效引用 {ref}"})
    # 用户手动输入的重点是显式约束。不能只在总览文字里提到，也不能让模型静默忽略。
    requested_focus: list[str] = []
    for value in state.get("constraints", {}).get("focus", []):
        text = str(value).strip()
        if text and normalized_focus(text) not in {normalized_focus(item) for item in requested_focus}:
            requested_focus.append(text)
    covered_focus = {
        normalized_focus(area)
        for item in items if isinstance(item, dict)
        for area in (item.get("focus_areas", []) if isinstance(item.get("focus_areas", []), list) else [])
        if str(area).strip()
    }
    for focus in requested_focus:
        if normalized_focus(focus) not in covered_focus:
            issues.append({
                "code": "USER_FOCUS_NOT_COVERED", "item_index": None,
                "message": f"没有为用户重点方向“{focus}”安排对应任务",
            })
    # 一旦命中同公司同岗位面经，它就是比通用八股更强的准备依据，计划必须实际使用。
    company_role_refs = {
        str(item.get("ref"))
        for item in state.get("evidence", [])
        if item.get("retrieval_scope") == "same_company_position" and str(item.get("ref", "")).strip()
    }
    plan_refs = {
        str(ref)
        for item in items if isinstance(item, dict)
        for ref in (item.get("evidence_refs", []) if isinstance(item.get("evidence_refs", []), list) else [])
    }
    if company_role_refs and not company_role_refs.intersection(plan_refs):
        issues.append({
            "code": "ROLE_REQUIREMENT_NOT_COVERED", "item_index": None,
            "message": "已检索到同公司同岗位面经，但计划没有引用其中任何一条",
        })
    return issues


def build_graph(client: JobTracerClient):
    attempts: dict[tuple[str, str], int] = {}

    def tracked(name: str, start_summary: str, done_summary: str):
        def decorate(function: NodeFunction) -> NodeFunction:
            async def wrapper(state: PrepAgentState) -> NodeResult:
                run_id = state["run_id"]
                key = (run_id, name)
                attempts[key] = attempts.get(key, 0) + 1
                started = time.perf_counter()
                step_id = await client.start_step(
                    run_id, name, attempts[key], stable_hash(state), start_summary
                )
                try:
                    result = await function(state)
                    await client.finish_step(
                        run_id,
                        step_id,
                        status="completed",
                        duration_ms=round((time.perf_counter() - started) * 1000),
                        summary=done_summary,
                        output_hash=stable_hash(result),
                    )
                    return result
                except Exception as error:
                    kind = error.kind if isinstance(error, JobTracerClientError) else "unexpected"
                    try:
                        await client.finish_step(
                            run_id,
                            step_id,
                            status="failed",
                            duration_ms=round((time.perf_counter() - started) * 1000),
                            summary=clipped_error(error),
                            error_type=kind,
                        )
                    except Exception:
                        pass
                    raise

            return wrapper

        return decorate

    @tracked("validate_request", "校验运行参数", "运行参数有效")
    async def validate_request(state: PrepAgentState) -> NodeResult:
        run = await client.get_run_input(state["run_id"])
        if run.get("status") == "cancelled":
            raise JobTracerClientError("运行已取消", 409, "cancelled")
        return {
            "thread_id": str(run["thread_id"]),
            "request_id": str(run["request_id"]),
            "application_id": int(run["application_id"]),
            "interview_id": int(run["interview_id"]),
            "user_goal": str(run["goal"]),
            "constraints": dict(run["constraints"]),
            "revision_count": int(state.get("revision_count", 0)),
            "warnings": list(state.get("warnings", [])),
            "metrics": metrics(state),
        }

    @tracked("load_context", "读取岗位、面试和历史资料", "岗位和历史资料已加载")
    async def load_context(state: PrepAgentState) -> NodeResult:
        context = await client.get_context(state["run_id"])
        warnings = list(state.get("warnings", []))
        if not context.get("application", {}).get("jd_text"):
            warnings.append("当前投递没有 JD，计划将主要依据职位名称和本地知识。")
        if not context.get("reviews"):
            warnings.append("没有可用的历史复盘，无法确认个人过往薄弱点。")
        if not context.get("mastery"):
            warnings.append("没有未掌握或掌握模糊的知识条目。")
        if context.get("resume"):
            warnings.append("本次会使用关联简历中的项目表述；简历内容仅代表候选人自述，项目实现仍以代码证据为准。")
        elif context.get("resume_status") and context.get("resume_status") != "completed":
            warnings.append("当前投递关联的简历尚未成功提取文本，未纳入本次准备；可在投递表单中重新提取或上传 PDF/DOCX。")
        await client.update_run(
            state["run_id"],
            status="running",
            current_node="load_context",
            snapshot_hash=context["snapshot_hash"],
            warnings=unique_warnings(warnings),
            metrics=metrics(state),
        )
        return {
            "context": context,
            "context_snapshot_hash": str(context["snapshot_hash"]),
            "warnings": unique_warnings(warnings),
        }

    @tracked("extract_role_profile", "提取岗位能力画像", "岗位能力画像已生成")
    async def extract_role_profile(state: PrepAgentState) -> NodeResult:
        context = state["context"]
        response = await client.model(state["run_id"], "role_profile", {
            "application": context["application"],
            "interview": context["interview"],
            "resume": context.get("resume"),
            "project_archives": context.get("projects", []),
            "user_goal": state["user_goal"],
        })
        return {"role_profile": response["value"], "metrics": add_model_metrics(state, response)}

    @tracked("plan_retrieval_queries", "规划知识检索", "检索查询已生成")
    async def plan_retrieval_queries(state: PrepAgentState) -> NodeResult:
        response = await client.model(state["run_id"], "query_plan", {
            "role_profile": state["role_profile"],
            "application": state["context"]["application"],
            "interview": state["context"]["interview"],
            "user_goal": state["user_goal"],
            "focus": state["constraints"].get("focus", []),
        })
        queries = list(response["value"].get("queries", []))
        if not queries:
            application = state["context"]["application"]
            queries = [{
                "query": f"{application['position']} 面试",
                "reason": "模型没有生成查询，使用职位名称作为安全回退",
                "category": None,
                "owner": None,
            }]
        return {"retrieval_queries": queries, "metrics": add_model_metrics(state, response)}

    @tracked("read_code_evidence", "按岗位重点读取项目代码", "项目代码证据已收集")
    async def read_code_evidence(state: PrepAgentState) -> NodeResult:
        project_ids: list[int] = []
        for value in state["constraints"].get("project_ids", []):
            try:
                candidate = int(value)
                if candidate > 0 and candidate not in project_ids:
                    project_ids.append(candidate)
            except (TypeError, ValueError):
                continue
        if not project_ids:
            return {
                "code_evidence": [],
                "warnings": unique_warnings(state.get("warnings", []), ["未选择项目档案，已跳过代码证据调查。"]),
            }
        profile = state.get("role_profile", {})
        signals = [str(item.get("text", "")).strip() for item in profile.get("project_signals", []) if isinstance(item, dict)]
        skills = [str(item.get("text", "")).strip() for item in profile.get("must_have_skills", []) if isinstance(item, dict)]
        application = state["context"]["application"]
        role = str(application.get("position") or "目标岗位")
        focus = [str(item).strip() for item in state["constraints"].get("focus", []) if str(item).strip()]
        objective = f"为 {application.get('company') or '目标公司'} 的 {role} 面试准备：{state['user_goal']}"
        if focus:
            objective += f"。用户指定重点：{'、'.join(focus)}"
        questions = [
            f"定位项目的启动入口和核心调用链，提取最适合向 {role} 面试官解释的真实实现。",
            "找出项目的异常处理、边界校验、状态管理、可观测性或测试等可靠性设计；不存在时要明确说明。",
            *[f"围绕用户指定重点“{item}”，在代码中查找可用于面试表达的真实实现或明确说明不存在。" for item in focus[:2]],
            *[f"围绕岗位关注点“{item}”，在代码中查找对应实现或证明其不存在。" for item in signals[:2] if item],
            *[f"围绕技能“{item}”，找出可用于项目表达的具体模块、调用关系或设计取舍。" for item in skills[:2] if item],
        ][:6]
        try:
            payload = await client.read_code(state["run_id"], project_ids, objective, questions)
        except JobTracerClientError as error:
            return {
                "code_evidence": [],
                "warnings": unique_warnings(state.get("warnings", []), [f"项目代码调查未完成：{clipped_error(error)}"]),
            }
        project_names = {
            int(item.get("item_id")): str(item.get("title", "项目"))
            for item in state["context"].get("projects", [])
            if item.get("item_id") is not None
        }
        collected: list[dict[str, Any]] = []
        warnings = list(state.get("warnings", []))
        for pack in payload.get("packs", []):
            if not isinstance(pack, dict):
                continue
            project_id = int(pack.get("project_id") or 0)
            project_name = project_names.get(project_id, f"项目 {project_id}")
            if pack.get("status") != "completed":
                error_message = str(pack.get("error_message") or "代码调查未完成").strip()
                warnings.append(f"项目“{project_name}”代码调查未完成：{error_message}")
                continue
            for fact in pack.get("facts", []):
                if not isinstance(fact, dict) or fact.get("kind") == "user_confirmation_required":
                    continue
                kind = str(fact.get("kind") or "")
                statement = str(fact.get("statement", "")).strip()
                if not statement:
                    continue
                refs = [str(value) for value in fact.get("evidence_refs", []) if str(value).strip()]
                # 面试计划只能消费可以回到源码的结论。没有 C 证据的模型推断保留在
                # 读代码会话中供人工查看，但不能伪装成可用于计划的项目证据。
                if not refs:
                    continue
                caveat = str(fact.get("caveat") or "").strip()
                is_inference = kind == "inference"
                excerpt = ("工程推断（非代码事实）：" if is_inference else "代码事实：") + statement
                if caveat:
                    excerpt += "\n限制：" + caveat
                if refs:
                    excerpt += "\n代码证据：" + "、".join(refs)
                collected.append({
                    "ref": f"CE{len(collected) + 1}", "type": "project", "item_id": project_id,
                    "title": f"{project_name} · {('推断：' if is_inference else '')}{statement[:120]}",
                    "excerpt": excerpt,
                    "score": 1.0 if kind == "code_fact" else 0.6,
                    "code_session_id": pack.get("session_id"), "code_evidence_refs": refs,
                })
        if not collected:
            warnings.append("项目代码调查没有形成可引用结论；请检查项目路径、模型配置或补充调查目标。")
        return {"code_evidence": collected[:20], "warnings": unique_warnings(warnings)}

    @tracked("retrieve_evidence", "检索相关面经和知识", "相关证据已检索")
    async def retrieve_evidence(state: PrepAgentState) -> NodeResult:
        evidence = await client.search(state["run_id"], state["retrieval_queries"])
        warnings = list(state.get("warnings", []))
        if not evidence:
            warnings.append("知识库没有检索到相关资料，计划将只使用岗位和历史信息。")
        return {"evidence": evidence, "warnings": unique_warnings(warnings)}

    @tracked("analyze_gaps", "分析能力差距", "能力差距已分析")
    async def analyze_gaps(state: PrepAgentState) -> NodeResult:
        context = state["context"]
        response = await client.model(state["run_id"], "gap_analysis", {
            "role_profile": state["role_profile"],
            "historical_reviews": context.get("reviews", []),
            "mastery_items": context.get("mastery", []),
            "resume": context.get("resume"),
            "project_archives": context.get("projects", []),
            "code_evidence": state.get("code_evidence", []),
            "retrieved_evidence": state.get("evidence", []),
            "user_goal": state["user_goal"],
            "user_focus": state["constraints"].get("focus", []),
        })
        value = dict(response["value"])
        warnings = unique_warnings(state.get("warnings", []), list(value.get("warnings", [])))
        return {"gap_analysis": value, "warnings": warnings, "metrics": add_model_metrics(state, response)}

    async def generate_plan(state: PrepAgentState, revision: bool) -> NodeResult:
        context = state["context"]
        response = await client.model(state["run_id"], "plan", {
            "role_profile": state["role_profile"],
            "gap_analysis": state["gap_analysis"],
            "evidence": state.get("evidence", []),
            "resume": context.get("resume"),
            "project_archives": context.get("projects", []),
            "code_evidence": state.get("code_evidence", []),
            "existing_checklist": context.get("existing_checklist", []),
            "interview": context["interview"],
            "user_goal": state["user_goal"],
            "constraints": state["constraints"],
            "current_time": datetime.now(timezone(timedelta(hours=8), "Asia/Shanghai")).isoformat(),
            "revision": {
                "is_revision": revision,
                "critic": state.get("critic_result"),
                "user_feedback": state.get("review_feedback", ""),
            },
        })
        return {"draft_plan": response["value"], "metrics": add_model_metrics(state, response)}

    @tracked("draft_plan", "生成面试准备计划", "面试准备计划已生成")
    async def draft_plan(state: PrepAgentState) -> NodeResult:
        return await generate_plan(state, False)

    @tracked("critic_plan", "检查计划依据和可执行性", "计划质量检查完成")
    async def critic_plan(state: PrepAgentState) -> NodeResult:
        context = state["context"]
        deterministic = plan_issues(state, state["draft_plan"])
        response = await client.model(state["run_id"], "critic", {
            "plan": state["draft_plan"],
            "role_profile": state["role_profile"],
            "evidence_refs": [
                *[item.get("ref") for item in state.get("evidence", [])],
                *[item.get("ref") for item in state.get("code_evidence", [])],
                *( [context["resume"].get("ref", "RES")] if context.get("resume") else [] ),
            ],
            "code_evidence": state.get("code_evidence", []),
            "context_refs": [
                "APP", "IV",
                *( [context["resume"].get("ref", "RES")] if context.get("resume") else [] ),
                *[item.get("ref") for item in state["context"].get("reviews", [])],
                *[item.get("ref") for item in state["context"].get("mastery", [])],
                *[item.get("ref") for item in state["context"].get("projects", [])],
                *[item.get("ref") for item in state.get("code_evidence", [])],
            ],
            "user_focus": state["constraints"].get("focus", []),
            "deterministic_issues": deterministic,
        })
        value = dict(response["value"])
        combined = deterministic + list(value.get("issues", []))
        deduplicated: list[dict[str, Any]] = []
        seen: set[str] = set()
        for issue in combined:
            key = f"{issue.get('code')}:{issue.get('item_index')}:{issue.get('message')}"
            if key not in seen:
                seen.add(key)
                deduplicated.append(issue)
        verdict = "revise" if any(issue.get("code") in {
            "INVALID_REFERENCE", "UNSUPPORTED_CLAIM", "DUPLICATED_ITEM",
            "VAGUE_ACTION", "MISSING_SUCCESS_CRITERIA", "USER_FOCUS_NOT_COVERED",
        } for issue in deduplicated) else str(value.get("verdict", "warn"))
        return {
            "critic_result": {"verdict": verdict, "issues": deduplicated[:30]},
            "metrics": add_model_metrics(state, response),
        }

    @tracked("revise_plan", "根据检查或用户反馈修订计划", "面试准备计划已修订")
    async def revise_plan(state: PrepAgentState) -> NodeResult:
        result = await generate_plan(state, True)
        revision_count = int(state.get("revision_count", 0)) + 1
        remaining = plan_issues({**state, **result}, result["draft_plan"])
        warnings = list(state.get("warnings", []))
        if remaining:
            warnings.append("修订后的计划仍有规则警告，请在写入前人工检查。")
        return {
            **result,
            "revision_count": revision_count,
            "critic_result": {"verdict": "warn" if remaining else "pass", "issues": remaining},
            "review_feedback": "",
            "warnings": unique_warnings(warnings),
        }

    async def human_review(state: PrepAgentState) -> NodeResult:
        await client.update_run(
            state["run_id"],
            status="waiting_review",
            current_node="human_review",
            snapshot_hash=state["context_snapshot_hash"],
            plan=state["draft_plan"],
            evidence=[*state.get("evidence", []), *state.get("code_evidence", [])],
            role_profile=state.get("role_profile"),
            gap_analysis=state.get("gap_analysis"),
            critic=state.get("critic_result"),
            warnings=state.get("warnings", []),
            metrics=metrics(state),
        )
        decision = interrupt({
            "run_id": state["run_id"],
            "plan": state["draft_plan"],
            "evidence": [*state.get("evidence", []), *state.get("code_evidence", [])],
            "warnings": state.get("warnings", []),
            "critic": state.get("critic_result"),
            "revision_count": state.get("revision_count", 0),
        })
        if not isinstance(decision, dict):
            return {"review_action": {"action": "invalid"}}
        action = str(decision.get("action", ""))
        if action == "edit" and isinstance(decision.get("edited_plan"), dict):
            return {"review_action": {"action": "edit"}, "draft_plan": decision["edited_plan"]}
        if action == "revise":
            if int(state.get("revision_count", 0)) >= 2:
                return {
                    "review_action": {"action": "limit"},
                    "warnings": unique_warnings(
                        state.get("warnings", []),
                        ["本次运行已达到修订次数上限，请直接编辑、批准或取消。"],
                    ),
                }
            return {
                "review_action": {"action": "revise"},
                "review_feedback": str(decision.get("feedback", ""))[:1000],
            }
        if action in {"approve", "cancel"}:
            return {"review_action": {"action": action}}
        return {
            "review_action": {"action": "limit"},
            "warnings": unique_warnings(state.get("warnings", []), ["审核操作无效，请重新选择。"]),
        }

    @tracked("persist_plan", "写入已确认的准备清单", "准备清单已写入")
    async def persist_plan(state: PrepAgentState) -> NodeResult:
        await client.update_run(
            state["run_id"], status="committing", current_node="persist_plan", metrics=metrics(state)
        )
        result = await client.persist_plan(state["run_id"], state["draft_plan"])
        return {"persisted_checklist_ids": list(result.get("checklistIds", []))}

    @tracked("cancel_run", "取消运行", "运行已取消")
    async def cancel_run(state: PrepAgentState) -> NodeResult:
        await client.update_run(
            state["run_id"], status="cancelled", current_node="cancelled", metrics=metrics(state)
        )
        return {}

    def critic_route(state: PrepAgentState) -> Literal["revise_plan", "human_review"]:
        if state.get("critic_result", {}).get("verdict") == "revise" and int(state.get("revision_count", 0)) < 1:
            return "revise_plan"
        return "human_review"

    def review_route(state: PrepAgentState) -> Literal["revise_plan", "persist_plan", "cancel_run", "human_review"]:
        action = state.get("review_action", {}).get("action")
        if action == "revise":
            return "revise_plan"
        if action in {"approve", "edit"}:
            return "persist_plan"
        if action == "cancel":
            return "cancel_run"
        return "human_review"

    builder = StateGraph(PrepAgentState)
    builder.add_node("validate_request", validate_request)
    builder.add_node("load_context", load_context)
    builder.add_node("extract_role_profile", extract_role_profile)
    builder.add_node("read_code_evidence", read_code_evidence)
    builder.add_node("plan_retrieval_queries", plan_retrieval_queries)
    builder.add_node("retrieve_evidence", retrieve_evidence)
    builder.add_node("analyze_gaps", analyze_gaps)
    builder.add_node("draft_plan", draft_plan)
    builder.add_node("critic_plan", critic_plan)
    builder.add_node("revise_plan", revise_plan)
    builder.add_node("human_review", human_review)
    builder.add_node("persist_plan", persist_plan)
    builder.add_node("cancel_run", cancel_run)

    builder.add_edge(START, "validate_request")
    builder.add_edge("validate_request", "load_context")
    builder.add_edge("load_context", "extract_role_profile")
    builder.add_edge("extract_role_profile", "read_code_evidence")
    builder.add_edge("read_code_evidence", "plan_retrieval_queries")
    builder.add_edge("plan_retrieval_queries", "retrieve_evidence")
    builder.add_edge("retrieve_evidence", "analyze_gaps")
    builder.add_edge("analyze_gaps", "draft_plan")
    builder.add_edge("draft_plan", "critic_plan")
    builder.add_conditional_edges("critic_plan", critic_route)
    builder.add_edge("revise_plan", "human_review")
    builder.add_conditional_edges("human_review", review_route)
    builder.add_edge("persist_plan", END)
    builder.add_edge("cancel_run", END)
    return builder
