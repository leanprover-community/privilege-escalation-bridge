# Contributing

This repo ships two GitHub Actions (`emit` and `consume`) from TypeScript source plus checked-in `dist/` bundles. See `README.md` for the user-facing action reference and the schema v2 artifact contract.

## Prerequisites

- Node 20+ (CI runs on Node 24).
- `npm`.
- Docker and [`act`](https://github.com/nektos/act) — only needed to run the local action smoke tests.

## Setup

```bash
npm install
```

## Rebuild `dist/` after every source change

The actions run from the committed bundles (`action.yml` points at `../dist/{emit,consume}/index.js`), **not** from `src/`. After any change under `src/`, rebuild and commit the result:

```bash
npm run build
git add dist
```

CI fails if `git diff dist` is non-empty. Editing `src/` without rebuilding means your change has no effect on the actual action behavior.

## Develop

```bash
npm test             # vitest run (all tests)
npm run test:watch   # vitest watch mode
npm run lint         # eslint over src, tests, configs
npm run typecheck    # tsc --noEmit
npm run ci           # lint + typecheck + test + build (mirrors CI)
```

Run a single test file or test:

```bash
npx vitest run tests/unit/bridge.test.ts
npx vitest run -t "validateConsumerExpectations"
```

Run `npm run ci` before opening a PR — it's exactly what the `test` CI job runs, including the `dist/` freshness check.

## Tests

- **Unit** (`tests/unit/`) — mock `@actions/core`, `@actions/github`, and `@actions/artifact` and call the exported `run()` directly (entry points skip auto-execution when `VITEST` is set).
- **End-to-end** (`tests/e2e/roundtrip.test.ts`) — emit → consume against the real `bridge/` directory layout.
- **Action smoke** (`tests/actions/`) — `act`-based runner-wiring checks. Run `tests/actions/run_act_smoke.sh`; see `tests/actions/README.md`. These do not exercise the real `workflow_run` privilege boundary.

## Where things live

- `src/lib/schema.ts` — the contract: `SCHEMA_VERSION`, `BridgeMeta`, validators. Bump `SCHEMA_VERSION` when changing the artifact format; consumers reject mismatches.
- `src/lib/bridge.ts` — shared logic, including `validateConsumerExpectations` (the security checks) and the dot-path helpers.
- `src/emit/main.ts`, `src/consume/main.ts` — the two action entry points.

## Releasing

Maintainers cut releases with `scripts/release.sh <x.y.z> [--push]`. See `RELEASING.md`.
