# GitHub Actions Privilege Escalation Bridge

This repository provides two TypeScript-based JavaScript actions implementing a fork-safe two-stage GitHub Actions pattern:

1. Unprivileged workflow (`pull_request`, `issue_comment`, `pull_request_review`, etc.) emits structured data as an artifact.
2. Privileged workflow (`workflow_run`) consumes and validates that artifact before doing writes/secrets operations.

Contributing or developing locally? See [CONTRIBUTING.md](CONTRIBUTING.md).

## Actions

| Action | Purpose |
| --- | --- |
| `privilege-escalation-bridge/emit` | Package outputs, metadata, optional selected event payload, and optional files into a stable artifact schema |
| `privilege-escalation-bridge/consume` | Download and validate producer artifact from `workflow_run`, then expose outputs and extracted fields |

## Security Model

The bridge does not bypass GitHub's permissions model. `consume` binds an artifact to the producer run that triggered it and reports who controlled that run's workflow file. It does not make artifact contents safe.

### Who controls the producer

For most events, GitHub runs the producer workflow file from the default branch, or from another ref that only people with write access can change. For `pull_request`, `pull_request_review` and `pull_request_review_comment`, GitHub runs it from the pull request's merge ref. When the pull request comes from a fork, its author can edit the producer workflow in the PR. They keep its `name:`, which is all `on: workflow_run` matches on. The edited workflow can skip `emit` and upload any artifact under the expected name. Every byte of that artifact is then chosen by the fork author, including `meta.json`, `meta.event` and `outputs.json`. The run-binding checks still pass, because the job knows its own run id, attempt and repository.

`consume` classifies the producer from GitHub's record of the run, never from the artifact. That record is the `workflow_run` event payload, or the REST API when `run_id` names a different run. `consume` exposes the result as the `producer-trust` output:

| `producer-trust` | When |
| --- | --- |
| `untrusted` | Every `pull_request`, `pull_request_review` and `pull_request_review_comment` run, and any other `pull_request*` event except `pull_request_target` |
| `trusted-workflow` | Every other event, including `pull_request_target` |
| `unknown` | `override_json` mode without a matching `workflow_run` payload |

The classification depends on the event alone, not on whether a particular pull request comes from a fork. That means a consumer behaves the same for every run of an event, instead of passing on same-repository pull requests and failing on the first fork. It also doesn't rely on GitHub's `head_repository`, which reports the base repository for review runs even when the pull request comes from a fork.

An `untrusted` run is accepted in one of two ways:
- **`verify: true`** (recommended when acting on a comment, review or PR number). `consume` fetches the pull request and the triggering comment or review from the GitHub API and checks them against GitHub's record of the run. Raw artifact values are then withheld, and only `run.*` and `verified.*` values are exposed. See [Verification](#verification).
- **Listing the event in `untrusted_producer_events`**, which exposes the raw artifact values. Do this only when every bridge value, including `meta` and `event` fields, is treated as untrusted data. For example, a lint result that is posted back to the PR it came from.

Otherwise `consume` fails, with a message saying what may be forged for that event.

`trusted-workflow` means only the workflow file is trusted, not the job's inputs. If the producer job runs pull request code before `emit`, for example an `issue_comment` workflow that builds the PR, that code can tamper with the later steps of the same job, including `emit` itself. The whole artifact can then be forged. Run pull request code in a separate job from `emit`, and pass its results across as data. That job still shares the run's artifacts, so the pattern also relies on job order and on `consume`'s artifact check; see [Which artifact is used](#which-artifact-is-used).

### Which artifact is used

Artifact names are unique only within a run attempt, so after a re-run a producer run can hold several artifacts with the bridge's name. `consume` counts only the artifacts named `artifact` that were created at or after the attempt started (`run_started_at`, which each re-run resets), and requires exactly one:
- The attempt is the triggering `workflow_run`'s attempt. When `run_id` names another run, it is that run's latest attempt, as `GET /actions/runs/{run_id}` reports it.
- "Re-run all jobs" works, because only the new attempt's artifact counts.
- If only an earlier attempt uploaded the artifact, for example after "Re-run failed jobs" didn't re-run the job that runs `emit`, `consume` fails.
- If the attempt uploaded more than one, `consume` fails. `emit` uploads once per attempt, and a second upload under the same name in one attempt fails, so a duplicate means another job uploaded under the bridge's name.
- Both failures happen even with `fail_on_missing: false`, and before anything is downloaded.

Every job of the producer run shares the run's artifacts, not only the job that runs `emit`. A job that runs pull request code can upload under the bridge's name, and while it runs it can also replace or delete the run's artifacts, as `actions/upload-artifact`'s `overwrite` option does. So when the producer runs pull request code in a separate job:
- Make the job that runs `emit` need (`needs:`) every job that runs pull request code, and run no pull request code after it. An upload under the bridge's name from an earlier job then makes `emit`'s own upload fail.
- Run the consumer only for a successful producer run (`if: github.event.workflow_run.conclusion == 'success'`). A run whose `emit` failed that way holds exactly one artifact with the name, and it isn't `emit`'s.

### Producer events

| Producer event | Workflow file comes from | `producer-trust` | `run.actor` | Recommended consumer |
| --- | --- | --- | --- | --- |
| `issue_comment` | the default branch | `trusted-workflow` | the commenter | Raw values are fine, as long as the producer job runs no PR code. `verify: true` also works. |
| `pull_request` | the PR's merge ref | `untrusted` | whoever's action triggered the event, such as the pusher | Treat the artifact as data: list the event in `untrusted_producer_events`, and use `verify: true` for the PR number. |
| `pull_request_review` | the PR's merge ref | `untrusted` | the reviewer | `verify: true`. Authorize from `verified.trigger.author` and act on `verified.trigger.body` and `verified.pr.number`. |
| `pull_request_review_comment` | the PR's merge ref | `untrusted` | the commenter | `verify: true`, as for reviews. |
| `pull_request_target` | the PR's base branch | `trusted-workflow` | | Such workflows often check out and run PR code; see the caveat above. |
| `push`, `workflow_dispatch` | the pushed or chosen branch | `trusted-workflow` | the pusher or dispatcher | Anyone who can push to that branch controls the workflow file. |
| `schedule`, `workflow_run` | the default branch | `trusted-workflow` | | |

`run.actor` is GitHub's record of who triggered the producer run, and a forged artifact cannot change it. But for review events the producer runs whenever *anyone* reviews the PR. So a genuine reviewer does not prove the command: a forged artifact can claim they wrote something else, or name a different PR. `verify: true` closes that gap by fetching the review itself.

`run.head_sha` is the PR head for `pull_request*` runs. For review runs, it is the head when GitHub *created* the run, which can be a commit pushed after the review.

### Verified and self-reported fields

After validation, these fields match GitHub's record of the producer run:
- `meta.workflow_run_id`, and `meta.workflow_run_attempt` when `consume` runs from the triggering `workflow_run` event.
- `meta.repository`, which must equal the current repository.
- `meta.event_name`, which must equal `workflow_run.event`. `require_event` is evaluated against `workflow_run.event`.
- `meta.workflow_name`, which must equal `workflow_run.name`. `source_workflow` is evaluated against `workflow_run.name`.
- Every `run.*` value, which comes from that record directly.
- Every `verified.*` value, which `consume` fetched from the API and checked (see [Verification](#verification)).

These fields are self-reported by the producer. They are only as trustworthy as the producer's workflow file:
- `meta.head_sha`, checked by `expected_head_sha`. This is the producer's `GITHUB_SHA`, which for `pull_request*` events is the PR merge commit, not `workflow_run.head_sha`.
- `meta.pr_number`, checked by `expected_pr_number`.
- `meta.event`, including actor fields such as `event.comment.user.login` and `event.review.user.login`.
- `outputs.json`, `bridge/files`, and any extra `meta` keys.

### Carrying an identity or PR number

When a consumer acts on behalf of whoever wrote a comment or review, take the identity from `verified.trigger.author`, never from `event.*`. Take the PR from `verified.pr.number`, never from `meta.pr_number`. With an `issue_comment`-only producer, the `event.*` actor fields are written by a trusted workflow. `verify: true` still gives the same values for every event.

### Verification

With `verify: true`, `consume` re-fetches what the consumer acts on from the GitHub API. It uses the artifact only for hints: `meta.pr_number`, and `event.comment.id` or `event.review.id`. A forged hint makes a check fail; it cannot redirect `consume` to someone else's object.

| Producer event | Fetches | Checks |
| --- | --- | --- |
| `pull_request` | `GET /pulls/{n}` | The PR's head is `run.head_sha`. |
| `issue_comment` | `GET /issues/comments/{id}`, then the PR from its `issue_url` (omitted for a plain issue) | Author, timing, and `meta.pr_number` if present |
| `pull_request_review` | `GET /pulls/{n}/reviews/{id}`, which only finds the review on PR `n`; then the PR | Author, timing |
| `pull_request_review_comment` | `GET /pulls/comments/{id}`, then the PR from its `pull_request_url` | Author, timing, and `meta.pr_number` if present |

- **Author:** the object's author must be `run.actor`. For an edit event, the actor is the editor. So an author editing their own comment counts as a fresh command, and an edit by anyone else fails.
- **Timing:** the object must have been written no later than the producer run was created. That stops a producer from waiting for the actor's next comment and claiming it. It must also have last changed at most 24 hours before the run was created, which stops replays of old commands. The last change is used because edits and inline comments drafted in a pending review are published later than they were written. Reviews expose only `submitted_at`, so both limits use it. Across a year of mathlib4 review runs, the longest real gap between a review and its run was 84 minutes.
- **Stale `pull_request` runs:** if the PR has been pushed to since the producer ran, its head no longer matches and `consume` fails. That can't be told apart from a forged PR number. A newer run follows the push.
- Every failed check fails the step. It never exits with empty outputs.

Verified values, as the `verified.*` extract root and the `verified-json` output:
- `verified.pr`: `number`, `title`, `url`, `author`, `state`, `merged`, `head_sha` (the PR's current head), `head_ref`, `head_repo`, `is_fork`, `base_ref`.
- `verified.trigger` (comment and review events): `kind` (`issue_comment`, `review` or `review_comment`), `id`, `author`, `author_type` (`User` or `Bot`), `body` (the text when `consume` fetched it, including later edits), `url`, `created_at`, `updated_at`, `path` (review comments) and `state` (reviews).
  - `commit_id` (reviews and review comments): for a review, the commit it was submitted on. For a review comment, the commit it now applies to, which GitHub moves forward as the PR is pushed to.
  - `original_commit_id` (review comments): the commit the comment was made on. Use it to act on exactly the code the commenter saw.
  - `verify` doesn't check either commit. They can differ from `run.head_sha` and `verified.pr.head_sha`.

`verify` needs `pull-requests: read`, plus `issues: read` for issue comments. It needs the IDs in the artifact: `include_event: minimal` in `emit` v2 includes them, and with `event_fields`, list `comment.id` and `review.id`. Other producer events are not supported and fail with `verify: true`.

### Non-goals

- Trusting artifact contents as safe.
- Passing secrets through artifacts.
- Preventing logical misuse of untrusted outputs by downstream steps.

## Artifact Contract (Schema v2)

Artifact payload layout:

```text
bridge/
  outputs.json
  meta.json
  files/
    ...optional copied files
```

### `outputs.json`
- JSON object.
- Keys must match `^[A-Za-z_][A-Za-z0-9_]*$` in `strict` mode.
- Values must be scalars (`string`, `number`, `boolean`, `null`) in `strict` mode.

### `meta.json`
Required fields (always provided by `emit`):
- `schema_version` - Internal contract version. Current value is `2`; consumers fail if it differs.
- `repository` - `owner/repo` of the producer run.
- `workflow_name` - Producer workflow name (`GITHUB_WORKFLOW`).
- `workflow_run_id` - Producer run id as a string.
- `workflow_run_attempt` - Producer run attempt as a string.
- `event_name` - Producer event name (for example `pull_request`, `issue_comment`).
- `head_sha` - Producer commit SHA (`GITHUB_SHA`). For `pull_request*` events this is the PR merge commit.
- `created_at` - ISO timestamp generated by `emit`.

Optional fields (provided by `emit` when available):
- `pr_number` - Numeric PR/issue number when one exists in the event payload.
- `producer_job` - Producer job id (`GITHUB_JOB`) when available.
- `producer_step` - Reserved for compatibility; may be absent.
- `event` - Event payload object, controlled by `include_event` / `event_fields`.
- Any additional keys from `emit.meta`.

Notes:
- `meta` is validated strictly on consume for required fields/types and schema version.
- `emit.meta` can override default keys if you reuse the same names; avoid overriding core keys unless intentional.
- `event` only contains scalar leaves (strings/numbers/booleans/null) when selected via `minimal`/`event_fields`.

## `meta.event` Shapes

- `include_event: none` - no `meta.event` key is added.
- `include_event: minimal` - a fixed curated subset is included (listed below).
- `include_event: full` - entire `github.context.payload` is included.
- `event_fields` present - overrides `include_event` and includes only the listed paths.

Exact `include_event: minimal` paths:
- `action`
- `sender.login`
- `sender.type`
- `issue.number`
- `issue.title`
- `issue.html_url`
- `issue.user.login`
- `comment.id`
- `comment.body`
- `comment.path`
- `comment.user.login`
- `review.id`
- `review.body`
- `review.state`
- `review.user.login`
- `pull_request.number`
- `pull_request.title`
- `pull_request.html_url`
- `pull_request.user.login`
- `pull_request.base.ref`
- `pull_request.base.sha`
- `pull_request.base.repo.full_name`
- `pull_request.head.ref`
- `pull_request.head.sha`
- `pull_request.head.repo.full_name`

Path rules:
- Paths use dot notation (`pull_request.user.login`).
- Multiple paths are comma or newline separated.
- Missing paths are ignored.
- Nested objects are reconstructed from the selected scalar leaves.

## `emit` Action

Path: `emit/action.yml`

### Inputs
- `artifact` (default: `bridge`)
  - Artifact name to upload.
- `outputs`
  - JSON object string of outputs.
  - Merge precedence: wins over keys from `outputs_file` when both specify the same key.
- `outputs_file`
  - Path to a JSON object file of outputs.
- `files`
  - Newline-separated paths copied into `bridge/files/`.
  - Must be relative paths and may not escape the workspace (`..` is rejected).
- `retention_days`
  - Artifact retention passed to GitHub artifact upload.
- `sanitize` (`strict` default, or `none`)
  - `strict`: enforce output key regex and scalar-only output values.
  - `none`: skip those checks (consumer still reads with strict output validation).
- `meta`
  - Extra metadata JSON object merged into `meta.json`.
- `include_event` (`none`, `minimal`, `full`; default `minimal`)
  - Controls whether/how `meta.event` is populated when `event_fields` is not set.
- `event_fields`
  - Optional comma/newline-separated allowlist of event paths.
  - If non-empty, it overrides `include_event`.

### Outputs
- `artifact`
- `outputs-json`
- `meta-json`

## `consume` Action

Path: `consume/action.yml`

### Inputs
- `token` (recommended)
  - Token with `actions:read` for downloading artifacts. With `verify: true`, it also needs `pull-requests: read`, plus `issues: read` for issue comments.
  - No default is set by this action.
  - In reusable workflows, pass explicitly: `token: ${{ github.token }}`.
- `github_token` (deprecated alias for `token`)
  - Supported for backward compatibility.
- Env fallback
  - If neither input is set, `consume` checks `GITHUB_TOKEN` then `GH_TOKEN`.
  - Caller `env` values are not automatically inherited by reusable workflows.
  - Must allow `actions:read` in the target repository.
- `artifact` (default: `bridge`)
  - Artifact name to download from the producer run. Exactly one artifact with this name must have been uploaded during the producer run's attempt; see [Which artifact is used](#which-artifact-is-used).
- `override_json`
  - Optional JSON object with canonical bridge payload fields `meta` and `outputs`.
  - When non-empty, `consume` skips artifact download and uses this payload instead. It resolves a token only when `verify: true`.
  - `meta` must satisfy the normal bridge metadata schema; `outputs` must be a JSON object with scalar values.
  - `bridge/files` restore is not supported in this mode, so `files-path` is not emitted.
- `run_id` (defaults to triggering `workflow_run.id`)
  - Required unless the action is running under a `workflow_run` event.
  - When it names a run other than the triggering one, `consume` reads GitHub's record of that run from the REST API (`GET /repos/{repo}/actions/runs/{run_id}`, covered by `actions:read`). The attempt is then that run's latest attempt: only its artifact counts, and `meta.workflow_run_attempt` is not checked.
  - In `override_json` mode, this binding is only checked when a run id is available from input or event context.
- `source_workflow`
  - Optional exact match against the producer run's workflow name in GitHub's record (`workflow_run.name`).
- `expected_head_sha`
  - Optional exact match against `meta.head_sha`, which is self-reported by the producer.
  - Usually not needed for `workflow_run` consumers because `run_id` (and `run_attempt` when present) are already validated by default.
  - For `pull_request*` producers, this is the synthetic merge commit SHA (`refs/pull/<n>/merge`), not `github.event.workflow_run.head_sha`. It changes when the base branch moves, which makes this check brittle.
- `expected_pr_number`
  - Optional exact match against `meta.pr_number`, which is self-reported by the producer.
- `require_event` (comma/newline-separated event names)
  - Allowlist for the event that triggered the producer run, in GitHub's record (`workflow_run.event`).
- `untrusted_producer_events` (comma/newline-separated event names)
  - Untrusted events whose producer runs may still expose raw artifact values. Every such value may be forged by a fork PR author (see [Producer events](#producer-events)).
  - Only `pull_request*` events other than `pull_request_target` may be listed, and only ones that `require_event` allows. `true` is rejected.
- `verify` (default: `false`)
  - Fetch and check the pull request and the triggering comment or review. See [Verification](#verification).
  - An untrusted producer run whose event isn't listed in `untrusted_producer_events` is accepted only with `verify: true`. It then exposes only `run.*` and `verified.*` values.
- `fail_on_missing` (default: `true`)
  - `true`: missing artifact fails the action.
  - `false`: missing artifact does not fail; JSON outputs are emitted as `{}` and no per-key outputs are emitted.
  - An artifact uploaded only by an earlier attempt, or more than one uploaded by this attempt, still fails (see [Which artifact is used](#which-artifact-is-used)).
- `expose` (`outputs`, `env`, `both`; default `outputs`)
  - Controls where per-key bridge outputs and extracted mappings are written.
  - `outputs`: step outputs only.
  - `env`: exported environment variables only.
  - `both`: both outputs and env vars.
- `prefix` prefix for per-key bridge outputs
  - Applied only to direct bridge output keys from `outputs.json`.
  - Not applied to names from `extract` mappings.
- `extract` newline-separated mappings: `NAME=source.path`
  - Supported roots:
    - `outputs`, `meta`, `event`: raw artifact values.
    - `run`: GitHub's record of the producer run. Keys are `id`, `attempt`, `event`, `workflow`, `actor`, `head_sha`, `head_branch` and `created_at`.
    - `verified`: requires `verify: true`; see [Verification](#verification).
  - When raw values are withheld, a mapping that reads `outputs`, `meta` or `event` fails the action, even as a fallback.
  - Every configured mapping must resolve to a scalar value or `null`; missing paths fail the action.
  - Fallback paths are supported: `a.b|c.d` (first found wins).
- `path` restore destination for `bridge/files` (default `.bridge`)
  - Files are copied into this directory recursively.

### Outputs
- Per-key outputs (subject to `expose` and `prefix`)
- Extracted outputs from `extract` mappings
- `outputs-json`
- `meta-json`
- `event-json`
- `run-json`: GitHub's record of the producer run (the `run.*` root), when available.
- `verified-json`: the `verified.*` root, with `verify: true`.
- `producer-trust`: `trusted-workflow`, `untrusted` or `unknown` (see [Who controls the producer](#who-controls-the-producer)). Also emitted when the artifact is missing and `fail_on_missing=false`.
- `files-path` restore destination, emitted in artifact mode (never in `override_json` mode)
  - Emitted whenever the action runs against a downloaded artifact, even when that artifact had no `bridge/files` content. In that case nothing is restored and the directory may not exist, so check for its presence before reading from it.

When raw artifact values are withheld, per-key outputs, `outputs-json`, `meta-json`, `event-json` and `files-path` are not emitted, and no files are restored.

When `fail_on_missing=false` and the artifact is not found, `outputs-json` is `{}`. You can skip downstream work with a guard like `if: ${{ steps.bridge.outputs.outputs-json != '{}' }}`.

## Validation Checks Performed by `consume`

`consume` downloads the artifact only after checks against GitHub's record of the producer run pass:

1. Check the configuration: `untrusted_producer_events` entries, and the `extract` roots.
2. Read GitHub's record of the producer run: the `workflow_run` payload, or the REST API for another `run_id`.
3. Look up the artifact by name. This reads only GitHub's artifact metadata. Only artifacts created since the producer run's attempt started count, and there must be exactly one (see [Which artifact is used](#which-artifact-is-used)). If the run has no artifact with the name, fail, or exit with empty outputs when `fail_on_missing=false`.
4. Check the producer run:
   - `source_workflow` -> `workflow_run.name`
   - `require_event` -> `workflow_run.event` membership
   - An `untrusted` run needs its event in `untrusted_producer_events`, or `verify: true`, which withholds raw values.
5. Download and parse the artifact.
6. Check the artifact metadata:
   - `meta.repository` matches the current repository.
   - `meta.workflow_run_id` matches `run_id`.
   - `meta.workflow_run_attempt` matches the triggering `workflow_run.run_attempt`, when available.
   - `meta.event_name` and `meta.workflow_name` match `workflow_run.event` and `workflow_run.name`.
   - Optionally, `expected_head_sha` -> `meta.head_sha` and `expected_pr_number` -> `meta.pr_number` (both self-reported).
7. With `verify: true`, fetch and check the pull request and trigger (see [Verification](#verification)).

In `override_json` mode, steps 4 and 6 use the `workflow_run` payload when it describes `run_id`, and are otherwise limited to the metadata checks that need no GitHub record.

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

      - run: echo '{"lint_ok":true}' > bridge.json
      - run: echo '{"ok":true}' > lint.json

      - uses: leanprover-community/privilege-escalation-bridge/emit@v2
        with:
          artifact: pr-bridge
          outputs_file: bridge.json
          include_event: minimal
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
      pull-requests: write
    steps:
      - id: bridge
        uses: leanprover-community/privilege-escalation-bridge/consume@v2
        with:
          token: ${{ github.token }}
          artifact: pr-bridge
          source_workflow: PR Checks
          require_event: pull_request
          # pull_request runs are untrusted: for a fork PR, every raw value from this
          # artifact, including meta and event fields, may be forged by the PR author.
          # Here the lint result only goes back to the PR it came from.
          untrusted_producer_events: pull_request
          # Take the PR number from the API, checked against the producer run's head.
          verify: true
          extract: |
            pr_number=verified.pr.number
            lint_ok=outputs.lint_ok

      - name: Report lint result
        env:
          GH_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ steps.bridge.outputs.pr_number }}
          LINT_OK: ${{ steps.bridge.outputs.lint_ok }}
        run: gh pr comment "${PR_NUMBER}" --repo "${GITHUB_REPOSITORY}" --body "lint_ok=${LINT_OK}"
```

### Command From a Comment or Review

The producer only has to run on the events and emit `include_event: minimal`. The consumer acts only on verified values, so it needs no `untrusted_producer_events`.

```yaml
      - id: bridge
        uses: leanprover-community/privilege-escalation-bridge/consume@v2
        with:
          token: ${{ github.token }}
          artifact: command
          source_workflow: Commands
          require_event: issue_comment, pull_request_review, pull_request_review_comment
          verify: true
          extract: |
            author=verified.trigger.author
            body=verified.trigger.body
            pr_number=verified.pr.number

      # Parse the command from the verified body, not from the artifact.
      - name: Handle command
        env:
          BODY: ${{ steps.bridge.outputs.body }}
          AUTHOR: ${{ steps.bridge.outputs.author }}
          PR_NUMBER: ${{ steps.bridge.outputs.pr_number }}
        run: ./handle-command.sh
```

## Changes in v2.1

- `consume` uses only the artifact uploaded during the producer run's attempt. It fails when that attempt uploaded more than one artifact with the name, or when only an earlier attempt uploaded one, even with `fail_on_missing: false`. See [Which artifact is used](#which-artifact-is-used).
- When `run_id` names another run, only that run's latest attempt counts. v2.0 accepted an artifact from any attempt in that mode.
- `verified.trigger` has `commit_id` for reviews, and `commit_id` and `original_commit_id` for review comments.

## Upgrading from v1

v2 changes how `consume` validates artifacts. The artifact format is unchanged (still schema v2), so artifacts from `emit@v1` are accepted. `verify: true` also needs the comment and review IDs that `emit` v2 includes.

- `consume` fails for `untrusted` producer runs: every `pull_request`, `pull_request_review` and `pull_request_review_comment` run, including runs for same-repository pull requests. Either switch to `verify: true` and read `verified.*` and `run.*` values, or list the event in `untrusted_producer_events` if every bridge value is treated as untrusted.
- `require_event` and `source_workflow` are evaluated against GitHub's record of the producer run. `meta.event_name` and `meta.workflow_name` must match that record.
- When `run_id` names a run other than the triggering one, `consume` reads that run from the REST API, and no longer compares its attempt with the triggering run's attempt.
- The producer run checks run before the artifact is downloaded. A missing artifact with `fail_on_missing=false` still exits cleanly.
- `extract` rejects unknown roots.
- New inputs `untrusted_producer_events` and `verify`; new `extract` roots `run` and `verified`; new outputs `producer-trust`, `run-json` and `verified-json`.
- `emit`'s `include_event: minimal` now includes `comment.id` and `review.id`.

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


## License

Apache-2.0
