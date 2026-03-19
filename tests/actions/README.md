# `act` Smoke Tests

These fixtures are runner-smoke tests for local workflow wiring. They are not intended to prove the real `workflow_run` privilege boundary or cross-run artifact behavior on GitHub.

Run all local `act` smoke tests:

```bash
tests/actions/run_act_smoke.sh
```

Requirements:
- Docker
- `act`
- project dependencies installed

If `GITHUB_TOKEN` is set in the environment, the wrapper passes it through to `act` as a secret. Otherwise it injects a dummy token so local artifact-backed smoke cases still have the runner token plumbing they expect.
