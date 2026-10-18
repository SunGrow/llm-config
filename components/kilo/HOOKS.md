# Jev port notes: Kilo Code (not implemented)

Not verified this session: Kilo's hook or plugin API was not checked against its docs.

- Assumption: Kilo is an opencode fork, so the likely route is an opencode-style plugin (JavaScript module) with a tool-execution "before" callback that can throw to block, and a chat or system-prompt transform for a route note. Confirm the event names, the plugin folder under `~/.config/kilo/`, and whether an "ask" result exists before porting.
- Needed: whichever plugin entry Kilo documents, calling the shared Jev gate and route code in `~/.agents/tools/jev/`.
