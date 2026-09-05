from __future__ import annotations

import asyncio
from typing import Any

import httpx


class JobTracerClientError(RuntimeError):
    def __init__(self, message: str, status_code: int = 502, kind: str = "node_api") -> None:
        super().__init__(message)
        self.status_code = status_code
        self.kind = kind


class JobTracerClient:
    def __init__(self, base_url: str, token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=f"{self._base_url}/api/internal/prep-agent",
            headers={"x-prep-agent-token": token},
            timeout=httpx.Timeout(100.0, connect=5.0),
        )
        self._code_client = httpx.AsyncClient(
            base_url=f"{self._base_url}/api/internal/code-reading",
            headers={"x-prep-agent-token": token},
            timeout=httpx.Timeout(600.0, connect=5.0),
        )
        self._trace_ids: dict[str, str] = {}

    async def close(self) -> None:
        await self._client.aclose()
        await self._code_client.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any | None = None,
        retry_safe: bool = False,
        run_id: str | None = None,
    ) -> Any:
        attempts = 2 if retry_safe else 1
        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                headers = {"x-trace-id": self._trace_ids[run_id]} if run_id and run_id in self._trace_ids else None
                response = await self._client.request(method, path, json=json, headers=headers)
                payload = response.json() if response.content else {}
                if response.status_code >= 500 and retry_safe and attempt + 1 < attempts:
                    await asyncio.sleep(0.25)
                    continue
                if not response.is_success:
                    message = payload.get("message") if isinstance(payload, dict) else None
                    error_type = payload.get("error_type") if isinstance(payload, dict) else None
                    raise JobTracerClientError(
                        str(message or f"job-tracer API 请求失败 ({response.status_code})"),
                        response.status_code,
                        str(error_type or "node_api"),
                    )
                return payload
            except JobTracerClientError:
                raise
            except (httpx.TimeoutException, httpx.NetworkError) as error:
                last_error = error
                if attempt + 1 < attempts:
                    await asyncio.sleep(0.25)
                    continue
        raise JobTracerClientError(f"无法连接 job-tracer 服务：{last_error}", 503, "node_unavailable")

    async def get_run_input(self, run_id: str) -> dict[str, Any]:
        payload = await self._request("GET", f"/runs/{run_id}/input", retry_safe=True, run_id=run_id)
        trace_id = payload.get("trace_id")
        if isinstance(trace_id, str):
            self._trace_ids[run_id] = trace_id
        return payload

    async def get_context(self, run_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/runs/{run_id}/context", retry_safe=True, run_id=run_id)

    async def search(self, run_id: str, queries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        payload = await self._request("POST", "/search", json={"run_id": run_id, "queries": queries}, retry_safe=True, run_id=run_id)
        return list(payload.get("evidence", []))

    async def read_code(self, run_id: str, project_ids: list[int], objective: str, questions: list[str]) -> dict[str, Any]:
        headers = {"x-trace-id": self._trace_ids[run_id]} if run_id in self._trace_ids else None
        try:
            response = await self._code_client.post("/investigate", json={
                "project_ids": project_ids, "objective": objective, "questions": questions,
            }, headers=headers)
            payload = response.json() if response.content else {}
            if not response.is_success:
                message = payload.get("message") if isinstance(payload, dict) else None
                raise JobTracerClientError(str(message or f"代码调查失败 ({response.status_code})"), response.status_code, "code_reading")
            return dict(payload) if isinstance(payload, dict) else {}
        except JobTracerClientError:
            raise
        except (httpx.TimeoutException, httpx.NetworkError) as error:
            raise JobTracerClientError(f"代码调查服务不可用：{error}", 503, "code_reading") from error

    async def model(self, run_id: str, kind: str, input_value: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", "/model", json={"run_id": run_id, "kind": kind, "input": input_value}, run_id=run_id)

    async def start_step(
        self,
        run_id: str,
        node: str,
        attempt: int,
        input_hash: str,
        summary: str,
    ) -> int:
        payload = await self._request(
            "POST",
            f"/runs/{run_id}/steps",
            json={"node": node, "attempt": attempt, "input_hash": input_hash, "summary": summary}, run_id=run_id,
        )
        return int(payload["id"])

    async def finish_step(
        self,
        run_id: str,
        step_id: int,
        *,
        status: str,
        duration_ms: int,
        summary: str,
        output_hash: str | None = None,
        error_type: str | None = None,
    ) -> None:
        await self._request(
            "PATCH",
            f"/runs/{run_id}/steps/{step_id}",
            json={
                "status": status,
                "duration_ms": duration_ms,
                "summary": summary,
                "output_hash": output_hash,
                "error_type": error_type,
            }, run_id=run_id,
        )

    async def update_run(self, run_id: str, **values: Any) -> None:
        await self._request("POST", f"/runs/{run_id}/status", json=values, run_id=run_id)

    async def persist_plan(self, run_id: str, plan: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", f"/runs/{run_id}/persist", json={"plan": plan}, run_id=run_id)
