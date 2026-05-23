#!/usr/bin/env python3
"""Agent SDK worker process.

Receives a JSON request on stdin, runs a Claude Code Agent session,
and streams NDJSON chunks to stdout. Each chunk has:
  {"type": "text"|"tool_use"|"tool_result"|"result"|"error", "content": "...", "sessionId?": "..."}

Streaming via StreamEvent (content_block_delta / text_delta) for real-time token output.
"""

import asyncio
import json
import os
import sys
import traceback

from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions
from claude_agent_sdk.types import (
    AssistantMessage,
    ResultMessage,
    StreamEvent,
    ToolResultBlock,
    UserMessage,
)


def emit(chunk: dict) -> None:
    sys.stdout.write(json.dumps(chunk, ensure_ascii=False) + "\n")
    sys.stdout.flush()


async def run() -> None:
    raw = sys.stdin.readline()
    if not raw.strip():
        emit({"type": "error", "content": "Empty request"})
        return

    req = json.loads(raw)

    cwd = req.get("cwd")
    if cwd and not os.path.isdir(cwd):
        emit({"type": "error", "content": f"Working directory does not exist: {cwd}"})
        return

    persona = req.get("persona", "")
    system_prompt: str | dict
    if persona:
        system_prompt = {
            "type": "preset",
            "preset": "claude_code",
            "append": persona,
        }
    else:
        system_prompt = {"type": "preset", "preset": "claude_code"}

    options = ClaudeAgentOptions(
        system_prompt=system_prompt,
        cwd=cwd,
        resume=req.get("sessionId"),
        permission_mode=req.get("permissionMode", "default"),
        model=req.get("model"),
        disallowed_tools=["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"],
        include_partial_messages=True,
        fork_session=req.get("forkSession", False),
    )

    async with ClaudeSDKClient(options) as client:
        await client.query(req["message"])

        # State for accumulating current tool_use block input
        current_block_type: str | None = None
        current_tool_name: str | None = None
        current_tool_json: str = ""

        async for msg in client.receive_response():
            if isinstance(msg, StreamEvent):
                event = msg.event
                etype = event.get("type", "")

                if etype == "content_block_start":
                    block = event.get("content_block", {})
                    current_block_type = block.get("type")
                    if current_block_type == "tool_use":
                        current_tool_name = block.get("name", "")
                        current_tool_json = ""

                elif etype == "content_block_delta":
                    delta = event.get("delta", {})
                    dtype = delta.get("type", "")
                    if dtype == "text_delta":
                        text = delta.get("text", "")
                        if text:
                            emit({"type": "text", "content": text})
                    elif dtype == "input_json_delta":
                        current_tool_json += delta.get("partial_json", "")

                elif etype == "content_block_stop":
                    if current_block_type == "tool_use" and current_tool_name:
                        content = (
                            f"{current_tool_name}: {current_tool_json}"
                            if current_tool_json
                            else current_tool_name
                        )
                        emit({"type": "tool_use", "content": content})
                        current_tool_name = None
                        current_tool_json = ""
                    current_block_type = None

            elif isinstance(msg, UserMessage):
                # Tool results come back as UserMessage with ToolResultBlock content
                blocks = msg.content if isinstance(msg.content, list) else []
                for block in blocks:
                    if not isinstance(block, ToolResultBlock):
                        continue
                    raw = ""
                    if isinstance(block.content, str):
                        raw = block.content
                    elif isinstance(block.content, list):
                        for item in block.content:
                            if isinstance(item, dict) and item.get("type") == "text":
                                raw += item.get("text", "")
                    if not raw:
                        continue
                    line_count = raw.count("\n") + 1
                    truncated = raw[:3000] + ("..." if len(raw) > 3000 else "")
                    emit({
                        "type": "tool_result",
                        "content": truncated,
                        "lineCount": line_count,
                        "isError": bool(block.is_error),
                    })

            elif isinstance(msg, AssistantMessage):
                # TextBlock already handled via StreamEvent; nothing needed here
                pass

            elif isinstance(msg, ResultMessage):
                emit({
                    "type": "result",
                    "content": msg.result or "",
                    "sessionId": msg.session_id,
                })


def main() -> None:
    try:
        asyncio.run(run())
    except Exception:
        emit({"type": "error", "content": traceback.format_exc()})
        sys.exit(1)


if __name__ == "__main__":
    main()
