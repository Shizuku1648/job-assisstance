from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any


class OpenAIClientError(RuntimeError):
    pass


class OpenAICompatibleClient:
    def __init__(self, base_url: str, api_key: str, model: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model

    def chat_json(self, system_prompt: str, user_prompt: str, timeout: int = 60) -> dict[str, Any]:
        content = self.chat_text(system_prompt, user_prompt, response_format={"type": "json_object"}, timeout=timeout)
        try:
            return json.loads(content)
        except json.JSONDecodeError as exc:
            raise OpenAIClientError(f"OpenAI response is not valid JSON: {content[:500]}") from exc

    def chat_text(
        self,
        system_prompt: str,
        user_prompt: str,
        response_format: dict[str, str] | None = None,
        timeout: int = 60,
    ) -> str:
        if not self.api_key:
            raise OpenAIClientError("OPENAI_API_KEY is not configured")

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.2,
        }
        if response_format is not None:
            payload["response_format"] = response_format

        request = urllib.request.Request(
            url=f"{self.base_url}/chat/completions",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "job-assistance/0.1",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise OpenAIClientError(f"OpenAI HTTP {exc.code}: {body}") from exc
        except urllib.error.URLError as exc:
            raise OpenAIClientError(f"OpenAI request failed: {exc}") from exc

        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise OpenAIClientError(f"Unexpected OpenAI response shape: {data}") from exc
