import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildBridgeMeta,
  parseAndMergeOutputs,
  readBridgeDirectory,
  validateConsumerExpectations,
  writeBridgeDirectory
} from '../../src/lib/bridge.js';

describe('e2e bridge roundtrip', () => {
  it('roundtrips outputs/meta/files for a fork-safe workflow_run scenario', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'bridge-e2e-'));
    const filePath = 'artifact-data.json';
    await writeFile(path.join(work, filePath), JSON.stringify({ hello: 'world' }), 'utf8');
    const previousCwd = process.cwd();
    process.chdir(work);
    try {
      const outputs = parseAndMergeOutputs(
        JSON.stringify({ author: 'alice', pr_number: 12, m_or_d: 'delegated' }),
        '',
        'strict'
      );

      const meta = buildBridgeMeta(
        {
          repository: 'leanprover-community/mathlib4',
          workflowName: 'Maintainer merge',
          runId: '777',
          runAttempt: '1',
          eventName: 'issue_comment',
          headSha: 'abc123',
          prNumber: 12
        },
        { producer_step: 'merge_or_delegate' }
      );

      await writeBridgeDirectory(work, outputs, meta, [filePath]);

      const loaded = await readBridgeDirectory(work);

      expect(loaded.outputs.author).toBe('alice');
      expect(loaded.meta.workflow_run_id).toBe('777');
      expect(await readFile(path.join(loaded.filesDir, filePath), 'utf8')).toContain('world');

      expect(() =>
        validateConsumerExpectations(loaded.meta, {
          repository: 'leanprover-community/mathlib4',
          runId: '777',
          runAttempt: '1',
          sourceWorkflow: 'Maintainer merge',
          expectedHeadSha: 'abc123',
          expectedPrNumber: '12',
          requireEvents: ['issue_comment']
        })
      ).not.toThrow();
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('fails closed for bad source event', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'bridge-e2e-'));
    const outputs = parseAndMergeOutputs(JSON.stringify({ ok: true }), '', 'strict');
    const meta = buildBridgeMeta(
      {
        repository: 'owner/repo',
        workflowName: 'PR Checks',
        runId: '10',
        runAttempt: '1',
        eventName: 'pull_request',
        headSha: 'abc'
      },
      {}
    );

    await writeBridgeDirectory(work, outputs, meta, []);
    const loaded = await readBridgeDirectory(work);

    expect(() =>
      validateConsumerExpectations(loaded.meta, {
        repository: 'owner/repo',
        runId: '10',
        requireEvents: ['issue_comment']
      })
    ).toThrow(/not allowed/);
  });
});
