import { access, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const state = {
    inputs: {} as Record<string, string>,
    booleans: {} as Record<string, boolean>,
    outputs: [] as Array<{ name: string; value: string }>,
    env: [] as Array<{ name: string; value: string }>,
    infos: [] as string[],
    failed: [] as string[],
    artifacts: [] as Array<{ id: number; name: string; size_in_bytes: number; created_at: string | null }>,
    zipData: null as Buffer | null,
    repository: 'owner/repo',
    workflowRunId: 123,
    workflowRunAttempt: 1,
    // The triggering workflow_run payload (GitHub's record of the producer run), if any.
    workflowRun: undefined as Record<string, unknown> | undefined,
    // What the REST API returns for getWorkflowRun.
    apiWorkflowRun: {} as Record<string, unknown>,
    // What the REST API returns for verify's lookups.
    pulls: {} as Record<number, unknown>,
    reviews: {} as Record<string, unknown>
  };

  const core = {
    getInput: vi.fn((name: string) => state.inputs[name] ?? ''),
    getBooleanInput: vi.fn((name: string) => state.booleans[name] ?? false),
    setSecret: vi.fn(),
    setOutput: vi.fn((name: string, value: string) => {
      state.outputs.push({ name, value });
    }),
    exportVariable: vi.fn((name: string, value: string) => {
      state.env.push({ name, value });
    }),
    info: vi.fn((message: string) => {
      state.infos.push(message);
    }),
    debug: vi.fn(),
    warning: vi.fn(),
    startGroup: vi.fn(),
    endGroup: vi.fn(),
    setFailed: vi.fn((message: string) => {
      state.failed.push(message);
    })
  };

  const found = (value: unknown) => {
    if (value === undefined) throw Object.assign(new Error('Not Found'), { status: 404 });
    return { data: value };
  };

  const octokit = {
    // The artifact listing is paginated; the fake API returns everything on one page.
    paginate: vi.fn(async (method: (params: unknown) => Promise<{ data: { artifacts: unknown[] } }>, params: unknown) =>
      (await method(params)).data.artifacts
    ),
    rest: {
      pulls: {
        get: vi.fn(async ({ pull_number }: { pull_number: number }) => found(state.pulls[pull_number])),
        getReview: vi.fn(async ({ pull_number, review_id }: { pull_number: number; review_id: number }) =>
          found(state.reviews[`${pull_number}/${review_id}`])
        )
      },
      actions: {
        getWorkflowRun: vi.fn(async () => ({
          data: state.apiWorkflowRun
        })),
        listWorkflowRunArtifacts: vi.fn(async () => ({
          data: {
            artifacts: state.artifacts
          }
        })),
        downloadArtifact: vi.fn(async () => ({
          data: state.zipData as unknown as ArrayBuffer
        }))
      }
    }
  };

  const github = {
    context: {
      repo: { owner: 'owner', repo: 'repo' },
      get payload() {
        return state.workflowRun ? { workflow_run: state.workflowRun } : {};
      }
    },
    getOctokit: vi.fn(() => octokit)
  };

  return { state, core, github, octokit };
});

vi.mock('@actions/core', () => hoisted.core);
vi.mock('@actions/github', () => hoisted.github);

const BASE_REPO_ID = 1;
// A first attempt starts when the run is created; a re-run resets run_started_at.
const RUN_CREATED = '2026-09-28T12:00:10Z';
const DURING_ATTEMPT = '2026-09-28T12:00:30Z';

function workflowRunRecord(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: hoisted.state.workflowRunId,
    run_attempt: hoisted.state.workflowRunAttempt,
    event: 'issue_comment',
    name: 'WF',
    actor: { login: 'alice' },
    head_sha: 'head1',
    head_branch: 'feature',
    created_at: RUN_CREATED,
    run_started_at: RUN_CREATED,
    repository: { id: BASE_REPO_ID },
    head_repository: { id: BASE_REPO_ID },
    ...overrides
  };
}

function createBridgeZip(options?: {
  includeFilesDir?: boolean;
  eventName?: string;
  meta?: Record<string, unknown>;
}): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    'bridge/meta.json',
    Buffer.from(
      JSON.stringify({
        schema_version: 2,
        repository: hoisted.state.repository,
        workflow_name: 'WF',
        workflow_run_id: String(hoisted.state.workflowRunId),
        workflow_run_attempt: String(hoisted.state.workflowRunAttempt),
        event_name: options?.eventName ?? 'issue_comment',
        head_sha: 'abc',
        created_at: new Date().toISOString(),
        event: { comment: { user: { login: 'alice' } } },
        ...options?.meta
      }),
      'utf8'
    )
  );
  zip.addFile('bridge/outputs.json', Buffer.from(JSON.stringify({ answer: '42' }), 'utf8'));
  if (options?.includeFilesDir) {
    zip.addFile('bridge/files/nested/data.txt', Buffer.from('hello', 'utf8'));
  }
  return zip.toBuffer();
}

describe('consume action entrypoint', () => {
  beforeEach(() => {
    hoisted.state.inputs = {
      artifact: 'bridge',
      run_id: String(hoisted.state.workflowRunId),
      token: 'tkn',
      expose: 'outputs',
      prefix: '',
      path: ''
    };
    hoisted.state.booleans = { fail_on_missing: true };
    hoisted.state.outputs = [];
    hoisted.state.env = [];
    hoisted.state.infos = [];
    hoisted.state.failed = [];
    hoisted.state.artifacts = [{ id: 1, name: 'bridge', size_in_bytes: 123, created_at: DURING_ATTEMPT }];
    hoisted.state.zipData = createBridgeZip();
    hoisted.state.workflowRun = workflowRunRecord();
    hoisted.state.apiWorkflowRun = {};
    hoisted.state.pulls = {};
    hoisted.state.reviews = {};
    process.env.GITHUB_REPOSITORY = hoisted.state.repository;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.GITHUB_REPOSITORY;
  });

  it('returns empty JSON outputs when artifact is missing and fail_on_missing=false', async () => {
    hoisted.state.artifacts = [];
    hoisted.state.booleans.fail_on_missing = false;

    const { run } = await import('../../src/consume/main.js');
    await run();

    expect(hoisted.state.outputs).toContainEqual({ name: 'outputs-json', value: '{}' });
    expect(hoisted.state.outputs).toContainEqual({ name: 'meta-json', value: '{}' });
    expect(hoisted.state.outputs).toContainEqual({ name: 'event-json', value: '{}' });
  });

  it('throws when artifact is missing and fail_on_missing=true', async () => {
    hoisted.state.artifacts = [];
    hoisted.state.booleans.fail_on_missing = true;

    const { run } = await import('../../src/consume/main.js');
    await expect(run()).rejects.toThrow(/Artifact bridge was not found/);
  });

  it('supports expose=env and extract mappings', async () => {
    const destination = await mkdtemp(path.join(os.tmpdir(), 'consume-main-'));
    hoisted.state.inputs.path = destination;
    hoisted.state.inputs.expose = 'env';
    hoisted.state.inputs.prefix = 'pre_';
    hoisted.state.inputs.extract = 'commenter=event.comment.user.login\nrepo=meta.repository';
    hoisted.state.zipData = createBridgeZip({ includeFilesDir: true });

    const { run } = await import('../../src/consume/main.js');
    await run();

    expect(hoisted.state.env).toContainEqual({ name: 'pre_answer', value: '42' });
    expect(hoisted.state.env).toContainEqual({ name: 'commenter', value: 'alice' });
    expect(hoisted.state.env).toContainEqual({ name: 'repo', value: hoisted.state.repository });
    expect(hoisted.state.outputs).not.toContainEqual({ name: 'pre_answer', value: '42' });
    expect(hoisted.state.outputs).toContainEqual({ name: 'files-path', value: destination });
    expect(hoisted.octokit.rest.actions.listWorkflowRunArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'bridge' })
    );
  });

  it('fails when an extract mapping does not resolve', async () => {
    hoisted.state.inputs.extract = 'missing=event.comment.id';

    const { run } = await import('../../src/consume/main.js');
    await expect(run()).rejects.toThrow(/Missing extracted value for 'missing'/);
  });

  it('supports override_json without token or artifact download', async () => {
    hoisted.state.inputs = {
      override_json: JSON.stringify({
        meta: {
          schema_version: 2,
          repository: hoisted.state.repository,
          workflow_name: 'WF',
          workflow_run_id: String(hoisted.state.workflowRunId),
          workflow_run_attempt: '1',
          event_name: 'issue_comment',
          head_sha: 'abc',
          created_at: new Date().toISOString(),
          event: { comment: { user: { login: 'alice' } } }
        },
        outputs: { answer: '42' }
      }),
      expose: 'both',
      extract: 'commenter=event.comment.user.login',
      path: ''
    };

    const { run } = await import('../../src/consume/main.js');
    await run();

    expect(hoisted.github.getOctokit).not.toHaveBeenCalled();
    expect(hoisted.state.outputs).toContainEqual({ name: 'answer', value: '42' });
    expect(hoisted.state.outputs).toContainEqual({ name: 'commenter', value: 'alice' });
    expect(hoisted.state.outputs).toContainEqual({ name: 'outputs-json', value: JSON.stringify({ answer: '42' }) });
    expect(hoisted.state.outputs).not.toContainEqual({ name: 'files-path', value: expect.any(String) });
  });

  it('fails on invalid override_json', async () => {
    hoisted.state.inputs = {
      override_json: '{',
      path: ''
    };

    const { run } = await import('../../src/consume/main.js');
    await expect(run()).rejects.toThrow(/override_json must be valid JSON/);
  });

  it('fails when override_json is not an object', async () => {
    hoisted.state.inputs = {
      override_json: '[]',
      path: ''
    };

    const { run } = await import('../../src/consume/main.js');
    await expect(run()).rejects.toThrow(/override_json must be a JSON object/);
  });

  it('does not fail when bridge/files is absent in downloaded artifact', async () => {
    const destination = await mkdtemp(path.join(os.tmpdir(), 'consume-main-'));
    const restorePath = path.join(destination, 'restore');
    hoisted.state.inputs.path = restorePath;
    hoisted.state.zipData = createBridgeZip({ includeFilesDir: false });

    const { run } = await import('../../src/consume/main.js');
    await expect(run()).resolves.toBeUndefined();

    await expect(access(restorePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(hoisted.state.outputs).toContainEqual({ name: 'files-path', value: restorePath });
  });

  it('reports trusted-workflow for an issue_comment producer', async () => {
    hoisted.state.inputs.require_event = 'issue_comment';

    const { run } = await import('../../src/consume/main.js');
    await run();

    expect(hoisted.state.outputs).toContainEqual({ name: 'producer-trust', value: 'trusted-workflow' });
    expect(hoisted.state.outputs).toContainEqual({ name: 'answer', value: '42' });
  });

  it('rejects a forged artifact from a pull_request_review run before downloading it', async () => {
    // GitHub reports the base repository as head_repository for review events, even for fork PRs.
    hoisted.state.workflowRun = workflowRunRecord({ event: 'pull_request_review' });
    hoisted.state.inputs.require_event = 'issue_comment,pull_request_review';
    hoisted.state.zipData = createBridgeZip({ eventName: 'pull_request_review' });

    const { run } = await import('../../src/consume/main.js');
    await expect(run()).rejects.toThrow(/Producer run 123 \(pull_request_review\) is untrusted/);
    expect(hoisted.octokit.rest.actions.downloadArtifact).not.toHaveBeenCalled();
  });

  it('rejects a pull_request run even when GitHub reports a same-repository head', async () => {
    hoisted.state.workflowRun = workflowRunRecord({ event: 'pull_request' });
    hoisted.state.zipData = createBridgeZip({ eventName: 'pull_request' });

    const { run } = await import('../../src/consume/main.js');
    await expect(run()).rejects.toThrow(/is untrusted/);
    expect(hoisted.octokit.rest.actions.downloadArtifact).not.toHaveBeenCalled();
  });

  it('accepts an untrusted producer listed in untrusted_producer_events and reports it', async () => {
    hoisted.state.workflowRun = workflowRunRecord({ event: 'pull_request' });
    hoisted.state.inputs.untrusted_producer_events = 'pull_request';
    hoisted.state.zipData = createBridgeZip({ eventName: 'pull_request' });

    const { run } = await import('../../src/consume/main.js');
    await run();

    expect(hoisted.state.outputs).toContainEqual({ name: 'producer-trust', value: 'untrusted' });
    expect(hoisted.state.outputs).toContainEqual({ name: 'answer', value: '42' });
  });

  it('evaluates require_event against the producer run, not the artifact', async () => {
    hoisted.state.workflowRun = workflowRunRecord({ event: 'pull_request_review' });
    hoisted.state.booleans.verify = true;
    hoisted.state.inputs.require_event = 'issue_comment';
    // The artifact claims the allowed event.
    hoisted.state.zipData = createBridgeZip({ eventName: 'issue_comment' });

    const { run } = await import('../../src/consume/main.js');
    await expect(run()).rejects.toThrow(/Source event pull_request_review is not allowed/);
    expect(hoisted.octokit.rest.actions.downloadArtifact).not.toHaveBeenCalled();
  });

  it('fails when the artifact event does not match the producer run', async () => {
    hoisted.state.workflowRun = workflowRunRecord({ event: 'push' });

    const { run } = await import('../../src/consume/main.js');
    await expect(run()).rejects.toThrow(
      /Event mismatch: producer run was triggered by push, artifact claims issue_comment/
    );
  });

  it('checks source_workflow against the producer run before downloading', async () => {
    hoisted.state.workflowRun = workflowRunRecord({ name: 'Other' });
    hoisted.state.inputs.source_workflow = 'WF';

    const { run } = await import('../../src/consume/main.js');
    await expect(run()).rejects.toThrow(/Workflow mismatch: expected WF, producer run belongs to Other/);
    expect(hoisted.octokit.rest.actions.downloadArtifact).not.toHaveBeenCalled();
  });

  it('exits cleanly for a missing artifact from an untrusted producer when fail_on_missing=false', async () => {
    hoisted.state.workflowRun = workflowRunRecord({ event: 'pull_request_review' });
    hoisted.state.artifacts = [];
    hoisted.state.booleans.fail_on_missing = false;

    const { run } = await import('../../src/consume/main.js');
    await run();

    expect(hoisted.state.outputs).toContainEqual({ name: 'outputs-json', value: '{}' });
    expect(hoisted.state.outputs).toContainEqual({ name: 'producer-trust', value: 'untrusted' });
  });

  it('looks up the producer run via the API when run_id is not the triggering run', async () => {
    hoisted.state.workflowRun = undefined;
    // The API reports the latest attempt, so it is not used for the attempt binding.
    hoisted.state.apiWorkflowRun = workflowRunRecord({ run_attempt: 5 });

    const { run } = await import('../../src/consume/main.js');
    await run();

    expect(hoisted.octokit.rest.actions.getWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: hoisted.state.workflowRunId })
    );
    expect(hoisted.state.outputs).toContainEqual({ name: 'producer-trust', value: 'trusted-workflow' });
  });

  it('reports unknown producer trust for override_json without a triggering run', async () => {
    hoisted.state.workflowRun = undefined;
    hoisted.state.inputs = {
      override_json: JSON.stringify({
        meta: {
          schema_version: 2,
          repository: hoisted.state.repository,
          workflow_name: 'WF',
          workflow_run_id: '1',
          workflow_run_attempt: '1',
          event_name: 'issue_comment',
          head_sha: 'abc',
          created_at: new Date().toISOString()
        },
        outputs: { answer: '42' }
      }),
      path: ''
    };

    const { run } = await import('../../src/consume/main.js');
    await run();

    expect(hoisted.github.getOctokit).not.toHaveBeenCalled();
    expect(hoisted.state.outputs).toContainEqual({ name: 'producer-trust', value: 'unknown' });
  });

  it('accepts an untrusted producer through verify and exposes only run.* and verified.* values', async () => {
    const destination = path.join(await mkdtemp(path.join(os.tmpdir(), 'consume-main-')), 'restore');
    hoisted.state.inputs.path = destination;
    hoisted.state.workflowRun = workflowRunRecord({ event: 'pull_request_review' });
    hoisted.state.booleans.verify = true;
    hoisted.state.inputs.extract = 'reviewer=verified.trigger.author\npr=verified.pr.number\nactor=run.actor';
    hoisted.state.zipData = createBridgeZip({
      eventName: 'pull_request_review',
      includeFilesDir: true,
      meta: { pr_number: 7, event: { review: { id: 22, user: { login: 'forged' } } } }
    });
    hoisted.state.reviews = {
      '7/22': {
        id: 22,
        user: { login: 'alice', type: 'User' },
        body: 'maintainer merge',
        state: 'APPROVED',
        html_url: 'https://github.com/owner/repo/pull/7#pullrequestreview-22',
        submitted_at: '2026-09-28T12:00:07Z'
      }
    };
    hoisted.state.pulls = {
      7: {
        number: 7,
        title: 'T',
        html_url: 'https://github.com/owner/repo/pull/7',
        user: { login: 'bob' },
        state: 'open',
        merged: false,
        head: { sha: 'head1', ref: 'feature', repo: { id: 2, full_name: 'bob/repo' } },
        base: { ref: 'main', repo: { id: BASE_REPO_ID } }
      }
    };

    const { run } = await import('../../src/consume/main.js');
    await run();

    const names = hoisted.state.outputs.map((o) => o.name);
    expect(hoisted.state.outputs).toContainEqual({ name: 'reviewer', value: 'alice' });
    expect(hoisted.state.outputs).toContainEqual({ name: 'pr', value: '7' });
    expect(hoisted.state.outputs).toContainEqual({ name: 'actor', value: 'alice' });
    expect(hoisted.state.outputs).toContainEqual({ name: 'producer-trust', value: 'untrusted' });
    expect(names).toContain('run-json');
    expect(names).toContain('verified-json');
    // No raw artifact values: per-key outputs, raw JSON outputs and files are all withheld.
    for (const raw of ['answer', 'outputs-json', 'meta-json', 'event-json', 'files-path']) {
      expect(names).not.toContain(raw);
    }
    await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses raw extract roots for an untrusted producer accepted through verify', async () => {
    hoisted.state.workflowRun = workflowRunRecord({ event: 'pull_request_review' });
    hoisted.state.booleans.verify = true;
    hoisted.state.inputs.extract = 'reviewer=event.review.user.login';

    const { run } = await import('../../src/consume/main.js');
    await expect(run()).rejects.toThrow(/exposes only run\.\* and verified\.\* values/);
    expect(hoisted.octokit.rest.actions.downloadArtifact).not.toHaveBeenCalled();
  });

  it('rejects a boolean untrusted_producer_events before any API call', async () => {
    hoisted.state.inputs.untrusted_producer_events = 'true';

    const { run } = await import('../../src/consume/main.js');
    await expect(run()).rejects.toThrow(/takes event names, not a boolean/);
    expect(hoisted.github.getOctokit).not.toHaveBeenCalled();
  });

  it('emits run-json when the artifact is missing', async () => {
    hoisted.state.artifacts = [];
    hoisted.state.booleans.fail_on_missing = false;

    const { run } = await import('../../src/consume/main.js');
    await run();

    const runJson = hoisted.state.outputs.find((o) => o.name === 'run-json')?.value;
    expect(JSON.parse(runJson ?? '{}')).toMatchObject({ id: '123', event: 'issue_comment', actor: 'alice' });
  });

  describe('artifact of the producer run attempt', () => {
    const RERUN_STARTED = '2026-09-28T13:00:00Z';

    beforeEach(() => {
      // Attempt 2: run_started_at is reset, created_at is still the run's.
      hoisted.state.workflowRunAttempt = 2;
      hoisted.state.workflowRun = workflowRunRecord({ run_started_at: RERUN_STARTED });
      hoisted.state.zipData = createBridgeZip();
    });

    afterEach(() => {
      hoisted.state.workflowRunAttempt = 1;
    });

    it('uses only the artifact uploaded during the triggering attempt after a re-run', async () => {
      hoisted.state.artifacts = [
        { id: 1, name: 'bridge', size_in_bytes: 1, created_at: DURING_ATTEMPT },
        { id: 2, name: 'bridge', size_in_bytes: 1, created_at: '2026-09-28T13:00:20Z' }
      ];

      const { run } = await import('../../src/consume/main.js');
      await run();

      expect(hoisted.octokit.paginate).toHaveBeenCalledWith(
        hoisted.octokit.rest.actions.listWorkflowRunArtifacts,
        expect.objectContaining({ run_id: hoisted.state.workflowRunId, name: 'bridge', per_page: 100 })
      );
      expect(hoisted.octokit.rest.actions.downloadArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ artifact_id: 2 })
      );
      expect(hoisted.state.outputs).toContainEqual({ name: 'answer', value: '42' });
    });

    it('counts an artifact created in the second the attempt started', async () => {
      hoisted.state.artifacts = [{ id: 2, name: 'bridge', size_in_bytes: 1, created_at: RERUN_STARTED }];

      const { run } = await import('../../src/consume/main.js');
      await run();

      expect(hoisted.octokit.rest.actions.downloadArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ artifact_id: 2 })
      );
    });

    it('fails on two artifacts with the name in one attempt, even with fail_on_missing=false', async () => {
      hoisted.state.booleans.fail_on_missing = false;
      hoisted.state.artifacts = [
        { id: 2, name: 'bridge', size_in_bytes: 1, created_at: '2026-09-28T13:00:20Z' },
        { id: 3, name: 'bridge', size_in_bytes: 1, created_at: '2026-09-28T13:00:40Z' }
      ];

      const { run } = await import('../../src/consume/main.js');
      await expect(run()).rejects.toThrow(
        /Found 2 artifacts named 'bridge' uploaded during attempt 2 of run 123, expected one/
      );
      expect(hoisted.octokit.rest.actions.downloadArtifact).not.toHaveBeenCalled();
    });

    it('fails when only an earlier attempt uploaded the artifact, even with fail_on_missing=false', async () => {
      // "Re-run failed jobs" that did not re-run the job running emit.
      hoisted.state.booleans.fail_on_missing = false;
      hoisted.state.artifacts = [{ id: 1, name: 'bridge', size_in_bytes: 1, created_at: DURING_ATTEMPT }];

      const { run } = await import('../../src/consume/main.js');
      await expect(run()).rejects.toThrow(
        /Artifact 'bridge' was uploaded only by an earlier attempt of run 123, not by attempt 2 of run 123\. A re-run must also re-run the job that runs emit/
      );
      expect(hoisted.octokit.rest.actions.downloadArtifact).not.toHaveBeenCalled();
    });

    it("uses the latest attempt's start when run_id names another run", async () => {
      hoisted.state.workflowRun = undefined;
      hoisted.state.apiWorkflowRun = workflowRunRecord({ run_attempt: 2, run_started_at: RERUN_STARTED });
      hoisted.state.artifacts = [
        { id: 1, name: 'bridge', size_in_bytes: 1, created_at: DURING_ATTEMPT },
        { id: 2, name: 'bridge', size_in_bytes: 1, created_at: '2026-09-28T13:00:20Z' }
      ];

      const { run } = await import('../../src/consume/main.js');
      await run();

      expect(hoisted.octokit.rest.actions.downloadArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ artifact_id: 2 })
      );
    });
  });
});
