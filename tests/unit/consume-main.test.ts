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
    artifacts: [] as Array<{ id: number; name: string; size_in_bytes: number }>,
    zipData: null as Buffer | null,
    repository: 'owner/repo',
    workflowRunId: 123,
    workflowRunAttempt: 1
  };

  const core = {
    getInput: vi.fn((name: string) => state.inputs[name] ?? ''),
    getBooleanInput: vi.fn((name: string) => state.booleans[name] ?? false),
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

  const octokit = {
    rest: {
      actions: {
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
      payload: {
        workflow_run: {
          id: state.workflowRunId,
          run_attempt: state.workflowRunAttempt
        }
      }
    },
    getOctokit: vi.fn(() => octokit)
  };

  return { state, core, github, octokit };
});

vi.mock('@actions/core', () => hoisted.core);
vi.mock('@actions/github', () => hoisted.github);

function createBridgeZip(options?: { includeFilesDir?: boolean }): Buffer {
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
        event_name: 'issue_comment',
        head_sha: 'abc',
        created_at: new Date().toISOString(),
        event: { comment: { user: { login: 'alice' } } }
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
    hoisted.state.artifacts = [{ id: 1, name: 'bridge', size_in_bytes: 123 }];
    hoisted.state.zipData = createBridgeZip();
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
});
