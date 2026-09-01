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
        self._client = httpx.AsyncClient(
            base_url=f"{base_url.rstrip('/')}/api/internal/prep-agent",
            headers={"x-prep-agent-token": token},
            timeout=httpx.Timeout(100.0, connect=5.0),
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any | None = None,
        retry_safe: bool = False,
    ) -> Any:
        attempts = 2 if retry_safe else 1
        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                response = await self._client.request(method, path, json=json)
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
        return await self._request("GET", f"/runs/{run_id}/input", retry_safe=True)

    async def get_context(self, run_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/runs/{run_id}/context", retry_safe=True)

    async def search(self, queries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        payload = await self._request("POST", "/search", json={"queries": queries}, retry_safe=True)
        return list(payload.get("evidence", []))

    async def model(self, kind: str, input_value: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", "/model", json={"kind": kind, "input": input_value})

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
            json={"node": node, "attempt": attempt, "input_hash": input_hash, "summary": summary},
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
            },
        )

    async def update_run(self, run_id: str, **values: Any) -> None:
        await self._request("POST", f"/runs/{run_id}/status", json=values)

    async def persist_plan(self, run_id: str, plan: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", f"/runs/{run_id}/persist", json={"plan": plan})

