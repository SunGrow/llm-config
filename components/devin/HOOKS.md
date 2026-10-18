# Jev port notes: Devin Desktop (not implemented)

Source: https://docs.devin.ai/desktop/cascade/hooks (English page gave only the overview; details from its translated versions, 2026-10-18).

- Pre-hooks: `pre_user_prompt`, `pre_read_code`, `pre_write_code`, `pre_run_command`, `pre_mcp_tool_use`; post-hooks cannot block.
- Gate: `pre_run_command` blocks with exit code 2; no documented "ask".
- Route: `pre_user_prompt` can block (exit 2), but no documented way to add context to the prompt, so the advisory route note cannot be ported.
- Input: JSON on stdin. Config: JSON files at three levels, merged; exact global path not checked.
