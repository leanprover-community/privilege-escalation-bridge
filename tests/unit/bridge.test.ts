import { describe, expect, it } from 'vitest';
import { access, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildBridgeMeta,
  getByPath,
  parseAndMergeOutputs,
  parseExtractMappings,
  pickByPaths,
  restoreBridgeFiles,
  validateConsumerExpectations,
  writeBridgeDirectory
} from '../../src/lib/bridge.js';

describe('bridge expectations', () => {
  it('validates matching consumer expectations', () => {
    const meta = buildBridgeMeta(
      {
        repository: 'owner/repo',
        workflowName: 'Maintainer merge',
        runId: '123',
        runAttempt: '2',
        eventName: 'issue_comment',
        headSha: 'deadbeef',
        prNumber: 42
      },
      {}
    );

    expect(() =>
      validateConsumerExpectations(meta, {
        repository: 'owner/repo',
        runId: '123',
        runAttempt: '2',
        sourceWorkflow: 'Maintainer merge',
        expectedHeadSha: 'deadbeef',
        expectedPrNumber: '42',
        requireEvents: ['issue_comment', 'pull_request_review']
      })
    ).not.toThrow();
  });

  it('fails on run mismatch', () => {
    const meta = buildBridgeMeta(
      {
        repository: 'owner/repo',
        workflowName: 'A',
        runId: '123',
        runAttempt: '1',
        eventName: 'pull_request',
        headSha: 'sha'
      },
      {}
    );

    expect(() =>
      validateConsumerExpectations(meta, {
        repository: 'owner/repo',
        runId: '124'
      })
    ).toThrow(/Run mismatch/);
  });

  it('fails on repository mismatch', () => {
    const meta = buildBridgeMeta(
      {
        repository: 'owner/repo',
        workflowName: 'A',
        runId: '123',
        runAttempt: '1',
        eventName: 'pull_request',
        headSha: 'sha'
      },
      {}
    );

    expect(() =>
      validateConsumerExpectations(meta, {
        repository: 'other/repo',
        runId: '123'
      })
    ).toThrow(/Repository mismatch/);
  });

  it('fails on run attempt mismatch', () => {
    const meta = buildBridgeMeta(
      {
        repository: 'owner/repo',
        workflowName: 'A',
        runId: '123',
        runAttempt: '1',
        eventName: 'pull_request',
        headSha: 'sha'
      },
      {}
    );

    expect(() =>
      validateConsumerExpectations(meta, {
        repository: 'owner/repo',
        runId: '123',
        runAttempt: '2'
      })
    ).toThrow(/Run attempt mismatch/);
  });

  it('fails on workflow mismatch', () => {
    const meta = buildBridgeMeta(
      {
        repository: 'owner/repo',
        workflowName: 'WF-A',
        runId: '123',
        runAttempt: '1',
        eventName: 'pull_request',
        headSha: 'sha'
      },
      {}
    );

    expect(() =>
      validateConsumerExpectations(meta, {
        repository: 'owner/repo',
        runId: '123',
        sourceWorkflow: 'WF-B'
      })
    ).toThrow(/Workflow mismatch/);
  });

  it('fails on head sha mismatch', () => {
    const meta = buildBridgeMeta(
      {
        repository: 'owner/repo',
        workflowName: 'WF',
        runId: '123',
        runAttempt: '1',
        eventName: 'pull_request',
        headSha: 'sha-a'
      },
      {}
    );

    expect(() =>
      validateConsumerExpectations(meta, {
        repository: 'owner/repo',
        runId: '123',
        expectedHeadSha: 'sha-b'
      })
    ).toThrow(/Head SHA mismatch/);
  });

  it('fails on PR number mismatch including missing producer PR number', () => {
    const meta = buildBridgeMeta(
      {
        repository: 'owner/repo',
        workflowName: 'WF',
        runId: '123',
        runAttempt: '1',
        eventName: 'pull_request',
        headSha: 'sha'
      },
      {}
    );

    expect(() =>
      validateConsumerExpectations(meta, {
        repository: 'owner/repo',
        runId: '123',
        expectedPrNumber: '42'
      })
    ).toThrow(/PR mismatch/);
  });

  it('merges outputs with input values overriding file values', () => {
    const merged = parseAndMergeOutputs(
      JSON.stringify({ shared: 'from-input', only_input: true }),
      JSON.stringify({ shared: 'from-file', only_file: 1 }),
      'strict'
    );

    expect(merged).toEqual({
      shared: 'from-input',
      only_file: 1,
      only_input: true
    });
  });

  it('supports sanitize=none in parseAndMergeOutputs', () => {
    const merged = parseAndMergeOutputs(
      JSON.stringify({ 'bad-key': { nested: true } }),
      '',
      'none'
    );
    expect(merged).toEqual({ 'bad-key': { nested: true } });
  });

  it('throws labeled parse errors for invalid output JSON sources', () => {
    expect(() => parseAndMergeOutputs('{', '', 'strict')).toThrow(/outputs must be valid JSON/);
    expect(() => parseAndMergeOutputs('', '{', 'strict')).toThrow(/outputs_file must be valid JSON/);
  });

  it('rejects absolute file entries when writing bridge files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-unit-'));
    const source = path.join(root, 'a.txt');
    await writeFile(source, 'x');

    await expect(
      writeBridgeDirectory(
        root,
        { ok: true },
        buildBridgeMeta(
          {
            repository: 'owner/repo',
            workflowName: 'WF',
            runId: '1',
            runAttempt: '1',
            eventName: 'pull_request',
            headSha: 'sha'
          },
          {}
        ),
        [source]
      )
    ).rejects.toThrow(/relative paths/);
  });

  it('rejects workspace-escaping relative file entries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-unit-'));

    await expect(
      writeBridgeDirectory(
        root,
        { ok: true },
        buildBridgeMeta(
          {
            repository: 'owner/repo',
            workflowName: 'WF',
            runId: '1',
            runAttempt: '1',
            eventName: 'pull_request',
            headSha: 'sha'
          },
          {}
        ),
        ['../secret.txt']
      )
    ).rejects.toThrow(/may not escape workspace/);

    await expect(
      writeBridgeDirectory(
        root,
        { ok: true },
        buildBridgeMeta(
          {
            repository: 'owner/repo',
            workflowName: 'WF',
            runId: '1',
            runAttempt: '1',
            eventName: 'pull_request',
            headSha: 'sha'
          },
          {}
        ),
        ['safe/../../escape.txt']
      )
    ).rejects.toThrow(/may not escape workspace/);
  });

  it('throws when requested file source does not exist', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-unit-'));
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await expect(
        writeBridgeDirectory(
          root,
          { ok: true },
          buildBridgeMeta(
            {
              repository: 'owner/repo',
              workflowName: 'WF',
              runId: '1',
              runAttempt: '1',
              eventName: 'pull_request',
              headSha: 'sha'
            },
            {}
          ),
          ['missing-file.txt']
        )
      ).rejects.toThrow();
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('parses extract mappings', () => {
    expect(parseExtractMappings('pr=meta.pr_number\nauthor=event.comment.user.login')).toEqual([
      { name: 'pr', path: 'meta.pr_number' },
      { name: 'author', path: 'event.comment.user.login' }
    ]);
  });

  it('rejects malformed extract mappings', () => {
    expect(() => parseExtractMappings('missing_separator')).toThrow(/Invalid extract mapping/);
    expect(() => parseExtractMappings('bad-key=meta.pr_number')).toThrow(/Invalid extract output key/);
    expect(() => parseExtractMappings('x=')).toThrow(/Invalid extract mapping/);
  });

  it('supports fallback paths and selected-event picks', () => {
    const event = {
      comment: { user: { login: 'alice' } },
      pull_request: { number: 17 }
    };
    expect(getByPath({ event }, 'event.review.user.login|event.comment.user.login')).toBe('alice');

    expect(pickByPaths(event, ['comment.user.login', 'pull_request.number'])).toEqual({
      comment: { user: { login: 'alice' } },
      pull_request: { number: 17 }
    });
  });

  it('supports array indexing in getByPath and rejects invalid accesses', () => {
    const value = { arr: [{ name: 'a' }, { name: 'b' }] };
    expect(getByPath(value, 'arr.1.name')).toBe('b');
    expect(getByPath(value, 'arr.2.name')).toBeUndefined();
    expect(getByPath(value, 'arr.x.name')).toBeUndefined();
  });

  it('returns undefined for object-valued getByPath results', () => {
    expect(getByPath({ root: { nested: { x: 1 } } }, 'root.nested')).toBeUndefined();
  });

  it('treats missing bridge/files as optional when restoring', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-unit-'));
    const destination = path.join(root, 'dest');

    const restored = await restoreBridgeFiles(path.join(root, 'missing-files'), destination);

    expect(restored).toBe(false);
    await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores files when bridge/files exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-unit-'));
    const sourceDir = path.join(root, 'bridge', 'files');
    const destination = path.join(root, 'dest');
    const nestedFile = path.join(sourceDir, 'nested', 'payload.txt');
    await mkdir(path.dirname(nestedFile), { recursive: true });
    await writeFile(nestedFile, 'ok', 'utf8');

    const restored = await restoreBridgeFiles(sourceDir, destination);

    expect(restored).toBe(true);
    await expect(readFile(path.join(destination, 'nested', 'payload.txt'), 'utf8')).resolves.toBe('ok');
  });

  it('treats non-directory bridge/files path as optional when restoring', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-unit-'));
    const sourceFile = path.join(root, 'bridge-files.txt');
    const destination = path.join(root, 'dest');
    await writeFile(sourceFile, 'not-a-dir', 'utf8');

    const restored = await restoreBridgeFiles(sourceFile, destination);

    expect(restored).toBe(false);
    await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores from empty bridge/files directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-unit-'));
    const sourceDir = path.join(root, 'bridge', 'files');
    const destination = path.join(root, 'dest');
    await mkdir(sourceDir, { recursive: true });

    const restored = await restoreBridgeFiles(sourceDir, destination);

    expect(restored).toBe(true);
    const destinationStat = await stat(destination);
    expect(destinationStat.isDirectory()).toBe(true);
  });

  it('overwrites existing destination files during restore', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-unit-'));
    const sourceDir = path.join(root, 'bridge', 'files');
    const destination = path.join(root, 'dest');
    await mkdir(path.join(sourceDir, 'nested'), { recursive: true });
    await mkdir(path.join(destination, 'nested'), { recursive: true });
    await writeFile(path.join(sourceDir, 'nested', 'payload.txt'), 'new', 'utf8');
    await writeFile(path.join(destination, 'nested', 'payload.txt'), 'old', 'utf8');

    const restored = await restoreBridgeFiles(sourceDir, destination);

    expect(restored).toBe(true);
    await expect(readFile(path.join(destination, 'nested', 'payload.txt'), 'utf8')).resolves.toBe('new');
  });
});
