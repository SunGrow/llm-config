# Unreal C++ defaults

Defaults in line with Epic's coding standard. The project's own instructions and its established code style win where they differ; check one existing file in the same module before adding a new kind of type.

## Before writing

- Find the project's existing assert, check, and logging helpers (`check`, `ensure`, `ensureMsgf`, a project plugin, a log category) by grepping one call site in the module. Never invent macro names or mix two assert APIs.
- Check signatures in the engine headers of the version in use.

## Declarations

- Include order: own header first in `.cpp`; in `.h`, `CoreMinimal.h` and engine headers, project headers, then `*.generated.h` last. Prefer forward declarations in headers.
- Naming prefixes: `U` UObject, `A` Actor, `F` struct/plain class, `E` enum, `I` interface, `T` template, `S` Slate widget; bools start with `b`.
- Member UObject pointers: `UPROPERTY()` plus `TObjectPtr<>` so GC tracks them; raw pointers in function code. Use `TSoftObjectPtr` / `TSoftClassPtr` for heavy assets loaded on demand.
- Initialise members in the header (in-class initialisers) unless the value depends on the constructor.
- Enums exposed to reflection: `UENUM()` with `enum class EName : uint8`; a `None` first value when validity matters.
- Mark functions `const` when they do not mutate; pass structs by `const&`, small types by value; prefix out parameters (`Out...`).
- Expose the narrowest Blueprint access the design needs (`EditDefaultsOnly` / `VisibleAnywhere` over `EditAnywhere` / `BlueprintReadWrite`).
- Overrides of `UFUNCTION`s do not repeat `UFUNCTION()`. Remove empty overrides (`Tick`, `BeginPlay`) and disable ticking when unused.

## Bodies

- Validate pointers and results of `Cast`, `GetComponent`, `GetSubsystem`, `SpawnActor`, `NewObject`, and loads before use; no chained dereferences without checks. Fail with a message that says what failed and what is abandoned, then return a safe default.
- No side effects inside `check` / `ensure` expressions.
- `switch` on an enum handles every value; an unexpected value is reported (`ensureMsgf` or a log).
- `const` for locals not modified after initialisation; extract complex conditions into named `bool`s; named constants instead of magic numbers.
- `UE_LOG` with a project log category for diagnostics; no on-screen debug messages in shipped code.
- Unbind delegates you bind (`FDelegateHandle`, `RemoveAll(this)`) in `EndPlay`, `Deinitialize`, or the destructor.
