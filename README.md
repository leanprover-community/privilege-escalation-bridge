# GitHub Actions Privilege Escalation Bridge

This repository provides two GitHub Actions that together implement a **two-stage workflow pattern** for GitHub Actions.

The goal is to allow workflows that run in **unprivileged contexts** (for example, `pull_request` workflows from forks with no secrets and read-only tokens) to produce structured “outputs” and files, and then allow a **privileged workflow** (triggered via `workflow_run`) to safely consume those outputs with full permissions.

## Background & Motivation

GitHub Actions intentionally restricts:
- Secrets
- Write access
- Elevated `GITHUB_TOKEN` permissions

for workflows triggered by untrusted sources such as forked pull requests.

A common, recommended pattern is to:
1. Run untrusted code in a restricted workflow
2. Package results as artifacts
3. Trigger a second workflow via `workflow_run`
4. Perform privileged actions using those results

This repository abstracts the **artifact handling, validation, and output reconstruction** so that:
- The pattern is easier to use correctly
- Artifact formats are stable and versioned
- Validation logic is centralized and reusable

## High-Level Design

There are two actions:

| Action | Purpose |
|------|--------|
| `privilege-escalation-bridge/emit` | Runs in an unprivileged workflow and publishes structured outputs + optional files as an artifact |
| `privilege-escalation-bridge/consume` | Runs in a privileged `workflow_run` workflow, validates the artifact, and exposes outputs like normal step outputs |

The artifact acts as a **trusted transport envelope**, but the contents themselves are always treated as **untrusted input** until validated.

## Security Model (Important)

This repository **does not** try to bypass GitHub’s security model.

Instead:
- `privilege-escalation-bridge/emit` runs in a workflow with no secrets and no write access
- `privilege-escalation-bridge/consume` runs only when GitHub emits a real `workflow_run` event
- The consumer validates that the artifact came from the expected workflow run, repository, and commit

Threats explicitly defended against:
- Artifact substitution from a different run
- Cross-PR or cross-SHA confusion
- Replaying old artifacts

Threats explicitly **not** defended against:
- Malicious or misleading artifact contents
- Data poisoning (outputs must be treated as untrusted input)
- Secret transport (these actions must never be used to pass secrets)

## Artifact Format (Contract)

Artifacts produced by `privilege-escalation-bridge/emit` have a **stable, versioned structure**:

```
bridge/
outputs.json
meta.json
files/
...optional copied files...

````

### `outputs.json`

A flat JSON object of key/value pairs.

Rules:
- Keys must match: `^[A-Za-z_][A-Za-z0-9_]*$`
- Values must be JSON scalars (string, number, boolean, null)
- Nested objects and arrays are not allowed
- Intended to map cleanly to GitHub step outputs (strings)

Example:
```json
{
  "lint_ok": true,
  "report_path": "reports/lint.json"
}
````

### `meta.json`

Metadata used for validation and auditing.

Required fields:

* `schema_version`
* `repository`
* `workflow_name`
* `workflow_run_id`
* `event_name`
* `head_sha`
* `created_at`

Optional fields:

* `pr_number`
* `producer_job`
* `producer_step`
* arbitrary user-supplied metadata

## Action: `privilege-escalation-bridge/emit`

### Purpose

Publish structured outputs and optional files from an unprivileged workflow.

### Intended Usage

* `pull_request`
* `issue_comment`
* `pull_request_review`
* Any context without secrets or write access

### Inputs

| Name             | Required | Description                                   |
| ---------------- | -------- | --------------------------------------------- |
| `name`           | no       | Artifact name (default: `bridge`)             |
| `outputs`        | no       | JSON string of outputs                        |
| `outputs_file`   | no       | Path to a JSON file containing outputs        |
| `files`          | no       | Newline-separated list of file paths or globs |
| `retention_days` | no       | Artifact retention period                     |
| `sanitize`       | no       | `strict` (default) or `none`                  |
| `meta`           | no       | Additional metadata (JSON)                    |

At least one of `outputs` or `outputs_file` must be provided.

### Behavior

* Validates output keys and values (unless `sanitize=none`)
* Writes `outputs.json` and `meta.json`
* Copies requested files into `privilege-escalation-bridge/files/`
* Uploads the artifact using `actions/upload-artifact`

### Outputs

| Name            | Description                    |
| --------------- | ------------------------------ |
| `artifact-name` | Name of the uploaded artifact  |
| `outputs-json`  | JSON string of emitted outputs |

## Action: `privilege-escalation-bridge/consume`

### Purpose

Download, validate, and expose outputs from a previous workflow run.

### Intended Usage

* `workflow_run` workflows only
* Must run on the default branch

### Inputs

| Name                 | Required | Description                                             |
| -------------------- | -------- | ------------------------------------------------------- |
| `name`               | no       | Artifact name (default: `bridge`)                       |
| `run_id`             | no       | Workflow run ID (default: triggering `workflow_run.id`) |
| `source_workflow`    | no       | Expected source workflow name                           |
| `expected_head_sha`  | no       | Expected commit SHA                                     |
| `expected_pr_number` | no       | Expected PR number                                      |
| `require_event`      | no       | Allowed source event names                              |
| `fail_on_missing`    | no       | Default `true`                                          |
| `expose`             | no       | `outputs`, `env`, or `both`                             |
| `prefix`             | no       | Prefix for exposed outputs                              |
| `path`               | no       | Directory to extract files into (default: `.bridge`)    |

### Behavior

* Downloads artifact from the specified workflow run
* Validates metadata against expectations
* Fails closed by default if validation fails
* Writes outputs to `$GITHUB_OUTPUT`
* Optionally exposes outputs as environment variables
* Restores files for downstream steps

### Outputs

* Individual outputs by key:

  ```yaml
  steps.bridge.outputs.lint_ok
  ```
* A combined JSON output:

  ```yaml
  steps.bridge.outputs.outputs
  ```

## Example: End-to-End Usage

### Unprivileged Workflow

```yaml
on: pull_request

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - run: ./ci/lint --json > reports/lint.json

      - uses: leanprover-community/privilege-escalation-bridge/emit@v1
        with:
          name: pr-bridge
          outputs: |
            {
              "lint_ok": true,
              "lint_report": "reports/lint.json"
            }
          files: |
            reports/lint.json
```

### Privileged Workflow

```yaml
on:
  workflow_run:
    workflows: ["PR Checks"]
    types: [completed]

jobs:
  consume:
    runs-on: ubuntu-latest
    steps:
      - id: bridge
        uses: leanprover-community/privilege-escalation-bridge/consume@v1
        with:
          name: pr-bridge
          expected_head_sha: ${{ github.event.workflow_run.head_sha }}

      - run: |
          echo "Lint OK? ${{ steps.bridge.outputs.lint_ok }}"
          cat "${{ steps.bridge.outputs.lint_report }}"
```

## Design Principles

* **Fail closed**: validation errors stop the workflow
* **Treat artifacts as untrusted input**
* **Stable artifact format**
* **Explicit validation beats implicit trust**
* **Ergonomic replacement for step outputs**

## Non-Goals

* Transporting secrets
* Trusting fork-provided data
* Replacing GitHub’s permission model
* Providing general artifact management utilities

## Versioning & Compatibility

* Artifact schema is versioned
* Backwards compatibility is maintained within a major version
* Breaking changes require a major version bump

## License

Apache-2.0 License
