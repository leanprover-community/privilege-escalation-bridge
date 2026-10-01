import { describe, expect, it } from 'vitest';
import { access, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildBridgeMeta,
  classifyProducerTrust,
  getByPath,
  parseAndMergeOutputs,
  parseExtractMappings,
  parseUntrustedProducerEvents,
  pickByPaths,
  restoreBridgeFiles,
  runRecord,
  selectAttemptArtifact,
  validateConsumerExpectations,
  validateExtractRoots,
  validateUpstreamRun,
  writeBridgeDirectory,
  type UpstreamRun
} from '../../src/lib/bridge.js';

function upstreamRun(overrides?: Partial<UpstreamRun>): UpstreamRun {
  return {
    id: '123',
    runAttempt: '1',
    event: 'issue_comment',
    workflowName: 'WF',
    ...overrides
  };
}

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

describe('producer trust', () => {
  it.each([
    ['issue_comment', 'trusted-workflow'],
    ['push', 'trusted-workflow'],
    ['workflow_dispatch', 'trusted-workflow'],
    ['pull_request_target', 'trusted-workflow'],
    // Untrusted by event alone, whether or not the PR comes from a fork.
    ['pull_request', 'untrusted'],
    ['pull_request_review', 'untrusted'],
    ['pull_request_review_comment', 'untrusted'],
    ['pull_request_some_future_event', 'untrusted']
  ] as const)('classifies %s as %s', (event, expected) => {
    expect(classifyProducerTrust(event)).toBe(expected);
  });

  it('decides raw access from the event, untrusted_producer_events and verify', () => {
    const review = upstreamRun({ event: 'pull_request_review' });
    expect(validateUpstreamRun(upstreamRun(), {})).toEqual({ trust: 'trusted-workflow', raw: true });
    expect(validateUpstreamRun(review, { untrustedProducerEvents: ['pull_request_review'] })).toEqual({
      trust: 'untrusted',
      raw: true
    });
    // Accepted through verify, but raw artifact values are withheld.
    expect(validateUpstreamRun(review, { verify: true })).toEqual({ trust: 'untrusted', raw: false });
    // Listing a different event does not help.
    expect(() => validateUpstreamRun(review, { untrustedProducerEvents: ['pull_request'] })).toThrow(
      /Producer run 123 \(pull_request_review\) is untrusted/
    );
  });

  it('explains what may be forged for each untrusted event', () => {
    expect(() => validateUpstreamRun(upstreamRun({ event: 'pull_request_review' }), {})).toThrow(
      /reviewer \(run\.actor\) is genuine, but the review body/
    );
    expect(() => validateUpstreamRun(upstreamRun({ event: 'pull_request' }), {})).toThrow(
      /including meta\.pr_number, may be forged.*#producer-events/
    );
  });

  it('checks require_event and source_workflow against the producer run', () => {
    const run = upstreamRun({ event: 'pull_request_review', workflowName: 'Real' });
    expect(() => validateUpstreamRun(run, { requireEvents: ['issue_comment'], verify: true })).toThrow(
      /Source event pull_request_review is not allowed/
    );
    expect(() => validateUpstreamRun(run, { sourceWorkflow: 'Other', verify: true })).toThrow(/Workflow mismatch/);
    expect(() =>
      validateUpstreamRun(run, { requireEvents: ['pull_request_review'], sourceWorkflow: 'Real', verify: true })
    ).not.toThrow();
  });

  it('parses untrusted_producer_events and rejects meaningless entries', () => {
    expect(parseUntrustedProducerEvents('pull_request, pull_request_review', [])).toEqual([
      'pull_request',
      'pull_request_review'
    ]);
    expect(parseUntrustedProducerEvents('', ['issue_comment'])).toEqual([]);
    expect(() => parseUntrustedProducerEvents('true', [])).toThrow(/takes event names, not a boolean/);
    expect(() => parseUntrustedProducerEvents('issue_comment', [])).toThrow(/never untrusted/);
    expect(() => parseUntrustedProducerEvents('pull_request', ['issue_comment'])).toThrow(
      /pull_request is not allowed by require_event/
    );
  });

  it('gates extract roots on raw access and verify', () => {
    const mappings = (paths: string[]) => paths.map((p, i) => ({ name: `k${i}`, path: p }));
    const raw = { raw: true, verify: true };
    const verifiedOnly = { raw: false, verify: true };
    expect(() => validateExtractRoots(mappings(['event.comment.user.login', 'run.actor', 'verified.pr.number']), raw)).not.toThrow();
    expect(() => validateExtractRoots(mappings(['verified.pr.number']), { raw: true, verify: false })).toThrow(
      /requires verify: true/
    );
    expect(() => validateExtractRoots(mappings(['run.actor', 'verified.trigger.body']), verifiedOnly)).not.toThrow();
    // A raw root anywhere in a fallback chain is refused.
    expect(() => validateExtractRoots(mappings(['verified.trigger.author|event.comment.user.login']), verifiedOnly)).toThrow(
      /reads event\.\*, but this untrusted producer run exposes only run\.\* and verified\.\*/
    );
    expect(() => validateExtractRoots(mappings(['evnt.comment.id']), raw)).toThrow(/unknown root 'evnt'/);
  });

  it('builds the run.* root from GitHub\'s record', () => {
    expect(runRecord(upstreamRun({ actor: 'alice', headSha: 'abc', headBranch: 'b', createdAt: 'now' }))).toEqual({
      id: '123',
      attempt: '1',
      event: 'issue_comment',
      workflow: 'WF',
      actor: 'alice',
      head_sha: 'abc',
      head_branch: 'b',
      created_at: 'now'
    });
  });

  it('binds meta event_name and workflow_name to the producer run', () => {
    const meta = buildBridgeMeta(
      {
        repository: 'owner/repo',
        workflowName: 'WF',
        runId: '123',
        runAttempt: '1',
        eventName: 'issue_comment',
        headSha: 'merge-sha'
      },
      {}
    );
    const base = { repository: 'owner/repo', runId: '123', runAttempt: '1' };

    expect(() => validateConsumerExpectations(meta, { ...base, upstream: upstreamRun() })).not.toThrow();
    expect(() =>
      validateConsumerExpectations(meta, { ...base, upstream: upstreamRun({ event: 'pull_request_review' }) })
    ).toThrow(/Event mismatch/);
    expect(() =>
      validateConsumerExpectations(meta, { ...base, upstream: upstreamRun({ workflowName: 'Other' }) })
    ).toThrow(/Workflow mismatch/);
  });
});

describe('selectAttemptArtifact', () => {
  const run = upstreamRun({ attemptStartedAt: '2026-09-28T12:00:00Z' });
  const artifact = (id: number, createdAt: string | null, name = 'bridge') => ({ id, name, created_at: createdAt });

  it('selects the one artifact with the name created since the attempt started', () => {
    const artifacts = [
      artifact(1, '2026-09-28T11:00:00Z'),
      artifact(2, '2026-09-28T12:00:00Z'),
      artifact(3, '2026-09-28T12:00:05Z', 'bridge-other')
    ];
    expect(selectAttemptArtifact(artifacts, 'bridge', run)?.id).toBe(2);
  });

  it('returns undefined when the run has no artifact with the name', () => {
    expect(selectAttemptArtifact([artifact(3, '2026-09-28T12:00:05Z', 'other')], 'bridge', run)).toBeUndefined();
  });

  it('fails on duplicates in the attempt, or when only an earlier attempt uploaded one', () => {
    expect(() =>
      selectAttemptArtifact([artifact(1, '2026-09-28T12:00:01Z'), artifact(2, '2026-09-28T12:00:02Z')], 'bridge', run)
    ).toThrow(/Found 2 artifacts named 'bridge' uploaded during attempt 1 of run 123, expected one/);
    expect(() => selectAttemptArtifact([artifact(1, '2026-09-28T11:59:59Z')], 'bridge', run)).toThrow(
      /uploaded only by an earlier attempt of run 123, not by attempt 1 of run 123/
    );
    expect(() =>
      selectAttemptArtifact([artifact(1, '2026-09-28T11:59:59Z')], 'bridge', { ...run, runAttempt: undefined })
    ).toThrow(/not by the latest attempt of run 123/);
  });

  it('fails closed without the times it compares', () => {
    expect(() => selectAttemptArtifact([artifact(1, null)], 'bridge', run)).toThrow(/has no creation time/);
    expect(() => selectAttemptArtifact([], 'bridge', upstreamRun())).toThrow(/has no attempt start time \(run_started_at\)/);
  });
});
