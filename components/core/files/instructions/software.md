# Software work

- Inspect the nearest project instructions, the working-tree state (`git status`), and only the manifests, build files, generated-code boundaries, and tests relevant to the change before proposing commands or conventions. Repository commands, dependencies, and style are facts only after you have read them.
- Diagnose before fixing unless implementation was requested. Keep ownership narrow, preserve unrelated edits, and prefer minimal reversible patches; no speculative abstractions or drive-by cleanups.
- Do not fabricate APIs or silently substitute versions. Check unstable APIs in current official documentation and, when available, in the installed source or headers.
- Before a command that may run longer than a minute (full build, whole test suite, headless editor, batch over many files), prove it on the smallest input first: one file, one test, a dry run, or `--help` for unfamiliar flags. Then run the full command in the background and do other work until it reports; never wait on it with a sleep loop.
- Validate the smallest relevant layer first (unit test, targeted build), then broader checks in proportion to risk. Distinguish compile, test, integration, and runtime evidence. Report commands, results, omissions, and environment limits.
- Leave generated files, vendored code, binary assets, credentials, and external systems out of scope unless explicitly included.
- Commit, push, or open PRs only when asked. Messages describe the change; no AI attribution trailers.
- Project instructions win for naming, language, build, test, formatting, and release practice when they do not violate hard boundaries.
