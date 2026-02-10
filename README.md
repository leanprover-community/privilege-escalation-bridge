# GitHub Actions Privilege Escalation Bridge

This repository provides two TypeScript-based JavaScript actions implementing a fork-safe two-stage GitHub Actions pattern:

1. Unprivileged workflow (`pull_request`, `issue_comment`, `pull_request_review`, etc.) emits structured data as an artifact.
2. Privileged workflow (`workflow_run`) consumes and validates that artifact before doing writes/secrets operations.

## Actions

| Action | Purpose |
| --- | --- |
| `privilege-escalation-bridge/emit` | Package flat scalar outputs + optional files into a stable artifact schema |
| `privilege-escalation-bridge/consume` | Download and validate producer artifact from `workflow_run`, then re-expose outputs |

## Security Model

The bridge does not bypass GitHub's permissions model.

Defenses included:
- Source run binding: `meta.workflow_run_id` must match expected run.
- Run-attempt binding: `meta.workflow_run_attempt` must match expected attempt when available.
- Repository binding: `meta.repository` must match current repository.
- Optional pinning: workflow name, event type, PR number, and head SHA checks.
- Fail-closed defaults for missing artifact and validation mismatches.

Non-goals:
- Trusting artifact contents as safe.
- Passing secrets through artifacts.
- Preventing logical misuse of untrusted outputs by downstream steps.

## Artifact Contract (Schema v1)

Artifact payload layout:

```text
bridge/
  outputs.json
  meta.json
  files/
    ...optional copied files
```

### `outputs.json`
- Flat object only.
- Keys must match `^[A-Za-z_][A-Za-z0-9_]*$` in `strict` mode.
- Values must be scalars (`string`, `number`, `boolean`, `null`) in `strict` mode.

### `meta.json`
Required fields:
- `schema_version`
- `repository`
- `workflow_name`
- `workflow_run_id`
- `workflow_run_attempt`
- `event_name`
- `head_sha`
- `created_at`

Optional fields:
- `pr_number`
- `producer_job`
- `producer_step`
- Any user metadata provided through `emit.meta`

## `emit` Action

Path: `emit/action.yml`

### Inputs
- `name` (default: `bridge`)
- `outputs` JSON object string
- `outputs_file` path to JSON object file
- `files` newline-separated relative file paths
- `retention_days`
- `sanitize` (`strict` default, or `none`)
- `meta` extra JSON object

At least one of `outputs` or `outputs_file` is required.

### Outputs
- `artifact-name`
- `outputs-json`

## `consume` Action

Path: `consume/action.yml`

### Inputs
- `github_token` (optional; defaults to `GITHUB_TOKEN` env)
- `name` (default: `bridge`)
- `run_id` (defaults to triggering `workflow_run.id`)
- `source_workflow`
- `expected_head_sha`
- `expected_pr_number`
- `require_event` (comma-separated event names)
- `fail_on_missing` (default: `true`)
- `expose` (`outputs`, `env`, `both`; default `outputs`)
- `prefix`
- `path` restore destination for `bridge/files` (default `.bridge`)

### Outputs
- Per-key outputs (subject to `expose`)
- `outputs` (combined JSON)
- `files-path`

## Logging

Both actions use collapsible log groups in the Actions UI for major phases.

- Standard runs show concise `core.info` summaries.
- Detailed internals are emitted via `core.debug` and appear when step debug logging is enabled (`ACTIONS_STEP_DEBUG=true`).

## Quick Example

### Unprivileged Producer

```yaml
on: pull_request

jobs:
  checks:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4

      - run: echo '{"lint_ok":true,"report":"lint.json"}' > bridge.json
      - run: echo '{"ok":true}' > lint.json

      - uses: leanprover-community/privilege-escalation-bridge/emit@v1
        with:
          name: pr-bridge
          outputs_file: bridge.json
          files: |
            lint.json
```

### Privileged Consumer

```yaml
on:
  workflow_run:
    workflows: ["PR Checks"]
    types: [completed]

jobs:
  consume:
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: write
      pull-requests: write
    steps:
      - id: bridge
        uses: leanprover-community/privilege-escalation-bridge/consume@v1
        with:
          name: pr-bridge
          source_workflow: PR Checks
          expected_head_sha: ${{ github.event.workflow_run.head_sha }}
          require_event: pull_request

      - run: echo "lint_ok=${{ steps.bridge.outputs.lint_ok }}"
```

## Development

### Install

```bash
npm ci
```

### Test

```bash
npm test
```

### Build

```bash
npm run build
```

## CI

CI workflow runs on pull requests and main/master pushes:
- `npm ci`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`

## License

Apache-2.0
