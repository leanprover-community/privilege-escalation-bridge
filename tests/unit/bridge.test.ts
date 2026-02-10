import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildBridgeMeta,
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
});
