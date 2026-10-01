import { describe, expect, it, vi } from 'vitest';

import type { UpstreamRun } from '../../src/lib/bridge.js';
import type { BridgeMeta } from '../../src/lib/schema.js';
import { verifyProducerRun } from '../../src/consume/verify.js';

type Octokit = Parameters<typeof verifyProducerRun>[0];

const REPO = 'owner/repo';
const RUN_CREATED = '2026-09-28T12:00:10Z';

interface Fixtures {
  pulls?: Record<number, unknown>;
  reviews?: Record<string, unknown>;
  reviewComments?: Record<number, unknown>;
  issueComments?: Record<number, unknown>;
}

function fakeOctokit(fixtures: Fixtures): Octokit {
  const found = (value: unknown) => {
    if (value === undefined) throw Object.assign(new Error('Not Found'), { status: 404 });
    return { data: value };
  };
  return {
    rest: {
      pulls: {
        get: vi.fn(async ({ pull_number }: { pull_number: number }) => found(fixtures.pulls?.[pull_number])),
        getReview: vi.fn(async ({ pull_number, review_id }: { pull_number: number; review_id: number }) =>
          found(fixtures.reviews?.[`${pull_number}/${review_id}`])
        ),
        getReviewComment: vi.fn(async ({ comment_id }: { comment_id: number }) =>
          found(fixtures.reviewComments?.[comment_id])
        )
      },
      issues: {
        getComment: vi.fn(async ({ comment_id }: { comment_id: number }) => found(fixtures.issueComments?.[comment_id]))
      }
    }
  } as unknown as Octokit;
}

function upstream(event: string, overrides?: Partial<UpstreamRun>): UpstreamRun {
  return {
    id: '99',
    event,
    workflowName: 'WF',
    actor: 'alice',
    headSha: 'head1',
    createdAt: RUN_CREATED,
    ...overrides
  };
}

function meta(overrides?: Partial<BridgeMeta>): BridgeMeta {
  return {
    schema_version: 2,
    repository: REPO,
    workflow_name: 'WF',
    workflow_run_id: '99',
    workflow_run_attempt: '1',
    event_name: 'x',
    head_sha: 'merge-sha',
    created_at: RUN_CREATED,
    pr_number: 7,
    ...overrides
  };
}

const PR_7 = {
  number: 7,
  title: 'Add a thing',
  html_url: 'https://github.com/owner/repo/pull/7',
  user: { login: 'bob' },
  state: 'open',
  merged: false,
  head: { sha: 'head1', ref: 'feature', repo: { id: 2, full_name: 'bob/repo' } },
  base: { ref: 'main', repo: { id: 1 } }
};

function issueComment(overrides?: Record<string, unknown>) {
  return {
    id: 11,
    user: { login: 'alice', type: 'User' },
    body: 'maintainer merge',
    html_url: 'https://github.com/owner/repo/pull/7#issuecomment-11',
    issue_url: 'https://api.github.com/repos/owner/repo/issues/7',
    created_at: '2026-09-28T12:00:06Z',
    updated_at: '2026-09-28T12:00:06Z',
    ...overrides
  };
}

describe('verifyProducerRun', () => {
  it('verifies a pull_request run against the PR head', async () => {
    const verified = await verifyProducerRun(fakeOctokit({ pulls: { 7: PR_7 } }), REPO, upstream('pull_request'), meta());
    expect(verified.trigger).toBeUndefined();
    expect(verified.pr).toMatchObject({ number: 7, author: 'bob', head_repo: 'bob/repo', is_fork: true, base_ref: 'main' });
  });

  it('fails a pull_request run whose PR head moved or whose PR number is forged', async () => {
    const octokit = fakeOctokit({ pulls: { 7: { ...PR_7, head: { ...PR_7.head, sha: 'head2' } } } });
    await expect(verifyProducerRun(octokit, REPO, upstream('pull_request'), meta())).rejects.toThrow(
      /PR #7 is at head2, not the producer run's head1.*or the PR number is forged/
    );
  });

  it('requires the hints it dereferences', async () => {
    const octokit = fakeOctokit({ pulls: { 7: PR_7 } });
    await expect(
      verifyProducerRun(octokit, REPO, upstream('pull_request'), meta({ pr_number: undefined }))
    ).rejects.toThrow(/no meta\.pr_number/);
    await expect(verifyProducerRun(octokit, REPO, upstream('issue_comment'), meta())).rejects.toThrow(
      /no event\.comment\.id\. Emit it with include_event: minimal/
    );
  });

  it('verifies an issue comment and its pull request', async () => {
    const octokit = fakeOctokit({ issueComments: { 11: issueComment() }, pulls: { 7: PR_7 } });
    const verified = await verifyProducerRun(octokit, REPO, upstream('issue_comment'), meta({ event: { comment: { id: 11 } } }));
    expect(verified.trigger).toMatchObject({
      kind: 'issue_comment',
      id: 11,
      author: 'alice',
      author_type: 'User',
      body: 'maintainer merge'
    });
    expect(verified.pr?.number).toBe(7);
  });

  it('verifies a comment on a plain issue without a pull request', async () => {
    const octokit = fakeOctokit({ issueComments: { 11: issueComment() } });
    const verified = await verifyProducerRun(octokit, REPO, upstream('issue_comment'), meta({ event: { comment: { id: 11 } } }));
    expect(verified.trigger?.id).toBe(11);
    expect(verified.pr).toBeUndefined();
  });

  it.each([
    ['someone else wrote it', { user: { login: 'mallory', type: 'User' } }, /written by mallory, but the producer run was triggered by alice/],
    ['it was written after the run was created', { created_at: '2026-09-28T12:00:20Z', updated_at: '2026-09-28T12:00:20Z' }, /written after the producer run was created/],
    ['it last changed over 24 hours before the run', { created_at: '2026-09-26T12:00:00Z', updated_at: '2026-09-26T12:00:00Z' }, /more than 24 hours before/],
    ['it belongs to a different PR than the artifact names', { issue_url: 'https://api.github.com/repos/owner/repo/issues/8' }, /belongs to #8, but the artifact names #7/]
  ])('rejects an issue comment when %s', async (_why, overrides, message) => {
    const octokit = fakeOctokit({ issueComments: { 11: issueComment(overrides) }, pulls: { 7: PR_7, 8: PR_7 } });
    await expect(
      verifyProducerRun(octokit, REPO, upstream('issue_comment'), meta({ event: { comment: { id: 11 } } }))
    ).rejects.toThrow(message);
  });

  it('treats an old comment the author just edited as fresh, and the edit after the run as current text', async () => {
    const octokit = fakeOctokit({
      issueComments: {
        11: issueComment({ created_at: '2026-08-01T00:00:00Z', updated_at: '2026-09-28T12:00:30Z', body: 'edited' })
      },
      pulls: { 7: PR_7 }
    });
    const verified = await verifyProducerRun(octokit, REPO, upstream('issue_comment'), meta({ event: { comment: { id: 11 } } }));
    expect(verified.trigger?.body).toBe('edited');
  });

  it('verifies a review through the PR-scoped endpoint, whatever commit it was left on', async () => {
    const review = {
      id: 22,
      user: { login: 'alice', type: 'User' },
      body: 'LGTM, maintainer merge',
      state: 'APPROVED',
      html_url: 'https://github.com/owner/repo/pull/7#pullrequestreview-22',
      submitted_at: '2026-09-28T12:00:07Z',
      // Reviewers often submit from a page that is behind the latest push.
      commit_id: 'older-commit'
    };
    const octokit = fakeOctokit({ reviews: { '7/22': review }, pulls: { 7: PR_7 } });
    const verified = await verifyProducerRun(octokit, REPO, upstream('pull_request_review'), meta({ event: { review: { id: 22 } } }));
    expect(verified.trigger).toMatchObject({ kind: 'review', id: 22, state: 'APPROVED', author: 'alice' });
    expect(verified.pr?.number).toBe(7);

    // A forged PR number does not find the review.
    await expect(
      verifyProducerRun(octokit, REPO, upstream('pull_request_review'), meta({ pr_number: 8, event: { review: { id: 22 } } }))
    ).rejects.toThrow(/review 22 was not found on PR #8/);
  });

  it('verifies an inline comment drafted long before its review was submitted', async () => {
    const comment = {
      id: 33,
      user: { login: 'alice', type: 'User' },
      body: 'splice-bot',
      path: 'src/a.ts',
      html_url: 'https://github.com/owner/repo/pull/7#discussion_r33',
      pull_request_url: 'https://api.github.com/repos/owner/repo/pulls/7',
      // Drafted in a pending review, published when the review was submitted.
      created_at: '2026-09-27T10:00:00Z',
      updated_at: '2026-09-28T12:00:05Z'
    };
    const octokit = fakeOctokit({ reviewComments: { 33: comment }, pulls: { 7: PR_7 } });
    const verified = await verifyProducerRun(
      octokit,
      REPO,
      upstream('pull_request_review_comment'),
      meta({ event: { comment: { id: 33 } } })
    );
    expect(verified.trigger).toMatchObject({ kind: 'review_comment', id: 33, path: 'src/a.ts' });

    await expect(
      verifyProducerRun(octokit, REPO, upstream('pull_request_review_comment'), meta({ pr_number: 8, event: { comment: { id: 33 } } }))
    ).rejects.toThrow(/belongs to #7, but the artifact names #8/);
  });

  it('refuses events it cannot verify and runs without an actor', async () => {
    const octokit = fakeOctokit({});
    await expect(verifyProducerRun(octokit, REPO, upstream('push'), meta())).rejects.toThrow(/not supported for push/);
    await expect(
      verifyProducerRun(octokit, REPO, upstream('pull_request', { actor: undefined }), meta())
    ).rejects.toThrow(/has no actor/);
  });
});
