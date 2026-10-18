# Unreal Engine work

Adds UE-specific discovery and safety to `software.md`. Engine version, plugins, assertion or logging helpers, and build commands come from the active project, never from memory or another project. Before writing C++, read `unreal-cpp.md` next to this file (Claude Code also loads it as a path-scoped rule for `*.h`, `*.cpp`, `*.inl`); project instructions override it.

## Discover

- Read the applicable `.uproject` first (engine association, enabled plugins, modules), then only the plugins, modules, `*.Build.cs` / `*.Target.cs`, assets, and symbols relevant to the task. An engine install or a neighbouring project is not evidence of what this project uses.
- Check API behaviour in the engine headers and source of the version the project uses, not from recall.

## Change safely

- Respect module and target boundaries, reflection macros, generated headers, object ownership, garbage collection, threading, replication, and lifecycle (constructor vs `BeginPlay` vs `PostInitializeComponents`).
- `.uasset`, `.umap`, Blueprint graphs, Data Assets, and other editor-managed binary state are high-risk. Use source control or a backup, prefer documented project tooling, and verify the semantic state after writes.
- Text-level inspection does not prove Blueprint or asset semantics. If a tool exports an asset, keep the original and verify the round trip before claiming safety.
- For visual, animation, audio, physics, Blueprint, or editor behaviour, names, metadata, curves, and dumps select candidates but do not prove the observed effect. Validate one representative case in the editor preview, PIE, or a runtime log before scaling. If that is not possible, report "structurally changed; behaviourally untested".
- Preserve project language, identifiers, gameplay terms, and established patterns.

## Validate

Use the project's own build, cook, test, editor, and CI commands. Validate at the narrowest layer and keep the layers distinct: compile, editor load, automation tests, asset validation, cook/package, runtime and multiplayer behaviour.
