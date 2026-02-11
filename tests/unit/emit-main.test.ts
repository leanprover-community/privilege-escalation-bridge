import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const state = {
    inputs: {} as Record<string, string>,
    outputs: [] as Array<{ name: string; value: string }>,
    uploads: [] as Array<{
      artifactName: string;
      files: string[];
      rootDirectory: string;
      options: Record<string, unknown>;
    }>
  };

  const core = {
    getInput: vi.fn((name: string) => state.inputs[name] ?? ''),
    setOutput: vi.fn((name: string, value: string) => {
      state.outputs.push({ name, value });
    }),
    info: vi.fn(),
    debug: vi.fn(),
    warning: vi.fn(),
    startGroup: vi.fn(),
    endGroup: vi.fn(),
    setFailed: vi.fn()
  };

  const github = {
    context: {
      repo: { owner: 'owner', repo: 'repo' },
      payload: {
        action: 'created',
        sender: { login: 'alice', type: 'User' },
        pull_request: {
          number: 7,
          head: { sha: 'abc123', ref: 'feature', repo: { full_name: 'fork/repo' } },
          base: { sha: 'def456', ref: 'main', repo: { full_name: 'owner/repo' } }
        }
      },
      workflow: 'WF',
      runId: 88,
      eventName: 'pull_request',
      sha: 'abc123'
    }
  };

  class DefaultArtifactClient {
    async uploadArtifact(
      artifactName: string,
      files: string[],
      rootDirectory: string,
      options: Record<string, unknown>
    ): Promise<{ id: number; size: number }> {
      state.uploads.push({ artifactName, files, rootDirectory, options });
      return { id: 1, size: files.length };
    }
  }

  return { state, core, github, DefaultArtifactClient };
});

vi.mock('@actions/core', () => hoisted.core);
vi.mock('@actions/github', () => hoisted.github);
vi.mock('@actions/artifact', () => ({
  DefaultArtifactClient: hoisted.DefaultArtifactClient
}));

describe('emit action entrypoint', () => {
  beforeEach(() => {
    hoisted.state.inputs = {
      artifact: 'bridge',
      outputs: '{"alpha":"1"}',
      outputs_file: '',
      files: '',
      retention_days: '',
      sanitize: 'strict',
      meta: '',
      include_event: 'minimal',
      event_fields: ''
    };
    hoisted.state.outputs = [];
    hoisted.state.uploads = [];
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.GITHUB_WORKFLOW = 'WF';
    process.env.GITHUB_RUN_ID = '88';
    process.env.GITHUB_RUN_ATTEMPT = '1';
    process.env.GITHUB_SHA = 'abc123';
    process.env.GITHUB_JOB = 'job-a';
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_WORKFLOW;
    delete process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_RUN_ATTEMPT;
    delete process.env.GITHUB_SHA;
    delete process.env.GITHUB_JOB;
  });

  it('omits event data when include_event=none', async () => {
    hoisted.state.inputs.include_event = 'none';

    const { run } = await import('../../src/emit/main.js');
    await run();

    const metaJson = hoisted.state.outputs.find((output) => output.name === 'meta-json')?.value;
    expect(metaJson).toBeDefined();
    const meta = JSON.parse(metaJson ?? '{}') as Record<string, unknown>;
    expect(meta.event).toBeUndefined();
  });

  it('includes event data when include_event=full', async () => {
    hoisted.state.inputs.include_event = 'full';

    const { run } = await import('../../src/emit/main.js');
    await run();

    const metaJson = hoisted.state.outputs.find((output) => output.name === 'meta-json')?.value;
    const meta = JSON.parse(metaJson ?? '{}') as Record<string, unknown>;
    expect(meta.event).toEqual(hoisted.github.context.payload);
  });

  it('honors explicit event_fields selection over include_event mode', async () => {
    hoisted.state.inputs.include_event = 'none';
    hoisted.state.inputs.event_fields = 'sender.login,pull_request.number';

    const { run } = await import('../../src/emit/main.js');
    await run();

    const metaJson = hoisted.state.outputs.find((output) => output.name === 'meta-json')?.value;
    const meta = JSON.parse(metaJson ?? '{}') as Record<string, unknown>;
    expect(meta.event).toEqual({
      sender: { login: 'alice' },
      pull_request: { number: 7 }
    });
  });

  it('parses multiline files input with blanks and uploads staged files', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'emit-main-'));
    const previousCwd = process.cwd();
    process.chdir(work);
    try {
      await writeFile(path.join(work, 'a.txt'), 'A', 'utf8');
      await writeFile(path.join(work, 'b.txt'), 'B', 'utf8');
      hoisted.state.inputs.files = '\n a.txt \n\nb.txt\n';

      const { run } = await import('../../src/emit/main.js');
      await run();

      expect(hoisted.state.uploads).toHaveLength(1);
      const uploaded = hoisted.state.uploads[0];
      expect(uploaded.files.some((file) => file.endsWith('/bridge/files/a.txt'))).toBe(true);
      expect(uploaded.files.some((file) => file.endsWith('/bridge/files/b.txt'))).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('passes retention_days to artifact upload options', async () => {
    hoisted.state.inputs.retention_days = '5';

    const { run } = await import('../../src/emit/main.js');
    await run();

    expect(hoisted.state.uploads).toHaveLength(1);
    expect(hoisted.state.uploads[0].options).toEqual({ retentionDays: 5 });
  });

  it('supports outputs_file merge with input precedence', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'emit-main-'));
    const outputsFile = path.join(work, 'outputs.json');
    await writeFile(outputsFile, JSON.stringify({ shared: 'file', only_file: 1 }), 'utf8');
    hoisted.state.inputs.outputs_file = outputsFile;
    hoisted.state.inputs.outputs = JSON.stringify({ shared: 'input', only_input: true });

    const { run } = await import('../../src/emit/main.js');
    await run();

    const outputsJson = hoisted.state.outputs.find((output) => output.name === 'outputs-json')?.value;
    expect(outputsJson).toBeDefined();
    expect(JSON.parse(outputsJson ?? '{}')).toEqual({
      shared: 'input',
      only_file: 1,
      only_input: true
    });
  });
});
