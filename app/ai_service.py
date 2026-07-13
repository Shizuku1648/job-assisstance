from __future__ import annotations

from app.config import Settings
from app.models import JobSnapshot, MatchResult, UserProfile
from app.openai_client import OpenAICompatibleClient
from app.prompts import load_prompt, render_prompt


class AIService:
    def __init__(self, settings: Settings) -> None:
        self.client = OpenAICompatibleClient(
            base_url=settings.openai_base_url,
            api_key=settings.openai_api_key,
            model=settings.openai_model,
        )

    def match_job(self, profile: UserProfile, job: JobSnapshot) -> MatchResult:
        system_prompt = load_prompt("job_match_system.txt")
        user_prompt = render_prompt(
            load_prompt("job_match_user.txt"),
            {
                "expected_salary_min_k": profile.expected_salary_min_k,
                "candidate_cities": "、".join(profile.candidate_cities),
                "profile_description": profile.description,
                "job_title": job.title,
                "company": job.company,
                "salary": job.salary,
                "city": job.city,
                "jd": job.jd,
                "url": job.url,
            },
        )
        result = self.client.chat_json(system_prompt, user_prompt)
        return MatchResult(matched=bool(result.get("matched")), reason=str(result.get("reason", "")).strip())

    def generate_message(self, profile: UserProfile, job: JobSnapshot, match_reason: str) -> str:
        system_prompt = load_prompt("message_generate_system.txt")
        user_prompt = render_prompt(
            load_prompt("message_generate_user.txt"),
            {
                "profile_description": profile.description,
                "job_title": job.title,
                "company": job.company,
                "jd": job.jd,
                "match_reason": match_reason,
            },
        )
        ai_match_note = self.client.chat_text(system_prompt, user_prompt).strip()
        fixed_intro = "您好，这是我本人开发的自动化求职程序发来的消息。"
        return f"{fixed_intro}\n\nAI 对岗位匹配度的判断如下：\n{ai_match_note}"
