# Jev port notes: goose (not implemented)

Not verified this session beyond the task brief: no documented prompt-context or pre-tool gate hook was found for goose.

- Route: no per-prompt hook. The nearest equivalent is static text in the global AGENTS.md (already installed by this adapter).
- Gate: none documented. Options for a port would be a custom MCP extension that wraps shell execution (gate inside the tool) or goose's own permission settings; both need checking against current goose docs.
