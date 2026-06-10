# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Two TypeScript-based GitHub Actions (`emit` and `consume`) implementing a fork-safe two-stage workflow pattern: an unprivileged workflow (`pull_request`, `issue_comment`, etc.) runs `emit` to package data into an artifact, and a privileged `workflow_run` workflow runs `consume` to download, validate, and expose that data before doing writes/secrets operations. See `README.md` for the full input/output reference and the schema v2 artifact contract.

## Commands

```bash
npm run build        # ncc-bundle src/{emit,consume}/main.ts into dist/{emit,consume}/index.js
npm test             # vitest run (all tests)
npm run test:watch   # vitest watch mode
npm run lint         # eslint over src, tests, configs
npm run typecheck    # tsc --noEmit
npm run ci           # lint + typecheck + test + build (what CI runs)
```

Run a single test file or test: `npx vitest run tests/unit/bridge.test.ts` or `npx vitest run -t "validateConsumerExpectations"`.

## Critical: dist/ is committed and verified

The actions run from checked-in bundles (`action.yml` points at `../dist/emit/index.js`), not from `src/`. **After any change under `src/`, run `npm run build` and commit the updated `dist/`.** CI fails if `git diff dist` is non-empty (the "Check committed dist is up to date" step). Editing `src/` without rebuilding means your change has no effect on the actual action behavior.

## Architecture

- `src/lib/schema.ts` — the contract: `SCHEMA_VERSION`, `BridgeMeta` type, `OUTPUT_KEY_RE`, and the validators (`validateMeta`, `normalizeOutputs`, `parseJsonObject`). Output keys must match the regex and values must be scalars in `strict` mode.
- `src/lib/bridge.ts` — pure logic shared by both actions: building/reading the `bridge/` directory, `validateConsumerExpectations` (the security checks), `parseExtractMappings`, and the dot-path helpers `getByPath`/`pickByPaths` (support `a.b|c.d` fallbacks and array indices; only return scalar leaves).
- `src/lib/logging.ts` — `core`-backed grouped logger; `debugJson` only logs when `RUNNER_DEBUG`/`ACTIONS_STEP_DEBUG` is set.
- `src/emit/main.ts` — reads inputs, builds meta + outputs + optional event payload (`MINIMAL_EVENT_PATHS` defines the curated `minimal` set), stages a temp `bridge/` dir, uploads via `@actions/artifact`.
- `src/consume/main.ts` — resolves token, downloads the artifact via Octokit + `adm-zip` (or uses `override_json` to skip download), validates expectations, restores files, and exposes per-key outputs / extracted mappings.
- `src/consume/token.ts` — token resolution order: `token` input → `github_token` input → `GITHUB_TOKEN` env → `GH_TOKEN` env.

The security model lives entirely in `validateConsumerExpectations`: it binds the artifact to the expected repository, source `run_id`, and `run_attempt`, plus optional workflow-name / head-SHA / PR-number / event-name pins. This does not sandbox artifact *contents* — downstream consumers must still treat output values as untrusted.

When bumping the artifact format, change `SCHEMA_VERSION` in `schema.ts`; consumers reject any `meta.schema_version` that differs.

## Testing

- Entry points export `run()` and only auto-execute when `process.env.VITEST` is unset (`if (!process.env.VITEST)` guard), so tests import and call `run()` directly.
- Unit tests mock `@actions/core`, `@actions/github`, and `@actions/artifact` with `vi.hoisted` + `vi.mock`, driving behavior through a fake `inputs`/`outputs` state object.
- `tests/e2e/roundtrip.test.ts` exercises emit → consume against the real `bridge/` directory layout.
- `tests/actions/run_act_smoke.sh` runs `act`-based runner smoke tests (requires Docker + `act`); each `events/<name>.json` pairs with `workflows/<name>.yml` and an `<name>.expected` file of grep patterns. These check workflow wiring only, not the real `workflow_run` privilege boundary.

## Releasing

Use `scripts/release.sh <x.y.z> [--push]` from a clean `main`. It runs `npm run ci`, creates annotated tag `vX.Y.Z`, and force-moves the major tag `vX`. See `RELEASING.md`.
