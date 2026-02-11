import { describe, expect, it } from 'vitest';
import { access, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildBridgeMeta,
  getByPath,
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

  it('parses extract mappings', () => {
    expect(parseExtractMappings('pr=meta.pr_number\nauthor=event.comment.user.login')).toEqual([
      { name: 'pr', path: 'meta.pr_number' },
      { name: 'author', path: 'event.comment.user.login' }
    ]);
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
