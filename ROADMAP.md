# ForgeFlow roadmap

This is a direction for development, not a delivery promise. Priorities may change after real user feedback.

## Current preview

The current code provides scoped task planning, dependency scheduling, up to 256 task slots, bounded retries, checkpoint recovery, provider usage controls, and optional Playwright tools. Live API and browser behavior still needs validation.

## First priority: establish reliability

- Validate small end-to-end runs against a supported provider and record the exact model and environment.
- Exercise interrupted runs, resume behavior, task failures, and dependency blocking.
- Validate Playwright snapshot, click, fill, and screenshot flows on a local fixture.
- Record Windows, macOS, and Linux compatibility results separately.
- Add targeted automated coverage for scope checks, queue behavior, usage limits, and persistence.

## Next: make work easier to inspect

- Improve plan review and explain why each worker owns its file scope.
- Make blocked-task and provider-limit diagnostics easier to understand.
- Document measured usage from reproducible examples, with no invented savings claims.
- Refine progress summaries for long runs and recovery.

## Later: evaluate integrations

- Provider compatibility examples based on verified behavior.
- Reusable workflow examples for documentation, feature work, and UI inspection.
- More explicit approval boundaries for shell and browser operations.

## Help shape priorities

Open an issue describing your workflow and the smallest example that demonstrates the problem. Contributions that improve reliability and documentation are especially useful during the preview.
