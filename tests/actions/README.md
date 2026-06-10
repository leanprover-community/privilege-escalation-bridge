# `act` Smoke Tests

These fixtures are runner-smoke tests for local workflow wiring. They are not intended to prove the real `workflow_run` privilege boundary or cross-run artifact behavior on GitHub.

Run all local `act` smoke tests:

```bash
tests/actions/run_act_smoke.sh
```

Each `events/<name>.json` pairs with a `workflows/<name>.yml` and an `events/<name>.expected` file of `grep -F` patterns that must all appear in the act log.

## What the fixtures assert

- Failure cases (`consume-missing-run-id`, `consume-missing-token`, `emit-invalid-outputs`) assert the **specific error reason** (e.g. `run_id is required`), not merely that the step failed. Asserting only `outcome == failure` would pass for any failure — including a crashing bundle — so it would not catch a regression in the validation being tested.
- `consume-success` is the happy path. It uses `override_json` so the run needs no artifact server or network, exercising override parsing, metadata + repository-binding validation, `extract`, and output exposure end to end.
- emit's happy path is **not** covered here: its artifact upload uses the v4 `@actions/artifact` protocol, which act's `--artifact-server-path` server does not accept (uploads fail with `Error unauthorized`). emit's success path is covered by the unit tests (`tests/unit/emit-main.test.ts`) and the e2e roundtrip (`tests/e2e/roundtrip.test.ts`).

## Requirements

- Docker daemon reachable. act talks to the daemon socket directly and does not need the `docker` CLI on `PATH`; the harness's check accepts either a runnable `docker` CLI or a reachable socket (`$DOCKER_HOST`, else `/var/run/docker.sock`).
- `act`
- project dependencies installed

If `GITHUB_TOKEN` is set in the environment, the wrapper passes it through to `act` as a secret. Otherwise it injects a dummy token so local artifact-backed smoke cases still have the runner token plumbing they expect.
