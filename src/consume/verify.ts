import type { getOctokit } from '@actions/github';

import { getByPath, type UpstreamRun } from '../lib/bridge.js';
import type { BridgeMeta } from '../lib/schema.js';

type Octokit = ReturnType<typeof getOctokit>;

/**
 * How long before the producer run's creation the triggering object may have last changed. Across a
 * year of mathlib4 review runs, the longest real gap between a review and its run was 84 minutes, so
 * this only rejects replays of old objects, not delayed runs.
 */
export const VERIFY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface VerifiedPullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  state: string;
  merged: boolean;
  /** The PR's current head, which can differ from run.head_sha once the PR has moved on. */
  head_sha: string;
  head_ref: string;
  head_repo: string | null;
  is_fork: boolean;
  base_ref: string;
}

export interface VerifiedTrigger {
  kind: 'issue_comment' | 'review' | 'review_comment';
  id: number;
  author: string;
  author_type: string;
  /** The text when consume fetched it, including any edits since the event. */
  body: string;
  url: string;
  created_at: string;
  updated_at: string;
  path?: string;
  state?: string;
  /**
   * Reviews: the commit the review was submitted on. Review comments: the commit the comment now
   * applies to, which GitHub moves forward as the PR is pushed to.
   */
  commit_id?: string;
  /** Review comments: the commit the comment was made on. */
  original_commit_id?: string;
}

export interface Verified {
  pr?: VerifiedPullRequest;
  trigger?: VerifiedTrigger;
}

interface ApiUser {
  login: string;
  type?: string;
}

function hintId(value: unknown, what: string, howToEmit: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  throw new Error(`verify: the artifact has no ${what}. ${howToEmit}`);
}

const EMIT_IDS_HINT =
  'Emit it with include_event: minimal from emit v2, or list comment.id and review.id in event_fields.';

function prNumberHint(meta: BridgeMeta): number {
  return hintId(meta.pr_number, 'meta.pr_number', 'emit records it for pull request events.');
}

function numberFromUrl(url: string): number {
  const match = /\/(\d+)$/.exec(url);
  if (!match) throw new Error(`verify: cannot read an issue or pull request number from ${url}`);
  return Number(match[1]);
}

function isNotFound(error: unknown): boolean {
  return (error as { status?: number }).status === 404;
}

function checkAuthor(user: ApiUser | null | undefined, run: UpstreamRun, what: string): ApiUser {
  if (!user || user.login !== run.actor) {
    throw new Error(
      `verify: ${what} was written by ${user?.login ?? 'a deleted user'}, but the producer run was triggered by ${run.actor}`
    );
  }
  return user;
}

// The object must have been written no later than the run was created (so a producer cannot wait
// for the actor's next comment and claim it), and last changed at most VERIFY_MAX_AGE_MS before
// (so it cannot claim an old one). Using the last change covers edits and inline comments that were
// drafted before their review was submitted.
function checkTiming(what: string, createdAt: string, lastModifiedAt: string, run: UpstreamRun): void {
  const runCreated = Date.parse(run.createdAt as string);
  if (Date.parse(createdAt) > runCreated) {
    throw new Error(`verify: ${what} was written after the producer run was created`);
  }
  if (Date.parse(lastModifiedAt) < runCreated - VERIFY_MAX_AGE_MS) {
    throw new Error(`verify: ${what} last changed more than 24 hours before the producer run was created`);
  }
}

function checkPrHint(meta: BridgeMeta, number: number, what: string): void {
  if (meta.pr_number !== undefined && meta.pr_number !== number) {
    throw new Error(`verify: ${what} belongs to #${number}, but the artifact names #${String(meta.pr_number)}`);
  }
}

async function fetchPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number
): Promise<VerifiedPullRequest> {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
  return {
    number: data.number,
    title: data.title,
    url: data.html_url,
    author: data.user?.login ?? '',
    state: data.state,
    merged: data.merged,
    head_sha: data.head.sha,
    head_ref: data.head.ref,
    head_repo: data.head.repo?.full_name ?? null,
    is_fork: !data.head.repo || data.head.repo.id !== data.base.repo.id,
    base_ref: data.base.ref
  };
}

function trigger(
  kind: VerifiedTrigger['kind'],
  id: number,
  user: ApiUser,
  fields: {
    body?: string | null;
    url: string;
    created_at: string;
    updated_at: string;
    path?: string;
    state?: string;
    commit_id?: string | null;
    original_commit_id?: string;
  }
): VerifiedTrigger {
  return {
    kind,
    id,
    author: user.login,
    author_type: user.type ?? '',
    body: fields.body ?? '',
    url: fields.url,
    created_at: fields.created_at,
    updated_at: fields.updated_at,
    ...(fields.path !== undefined ? { path: fields.path } : {}),
    ...(fields.state !== undefined ? { state: fields.state } : {}),
    ...(fields.commit_id ? { commit_id: fields.commit_id } : {}),
    ...(fields.original_commit_id ? { original_commit_id: fields.original_commit_id } : {})
  };
}

/**
 * Fetches the pull request and the triggering comment or review from the API, using the artifact
 * only for hints (PR number, comment or review id), and binds them to GitHub's record of the run.
 */
export async function verifyProducerRun(
  octokit: Octokit,
  repository: string,
  run: UpstreamRun,
  meta: BridgeMeta
): Promise<Verified> {
  if (!run.actor || !run.headSha || !run.createdAt) {
    throw new Error(`verify: GitHub's record of run ${run.id} has no actor, head SHA or creation time`);
  }
  const [owner, repo] = repository.split('/');
  const event = meta.event ?? {};

  switch (run.event) {
    case 'pull_request': {
      const number = prNumberHint(meta);
      const pr = await fetchPullRequest(octokit, owner, repo, number);
      if (pr.head_sha !== run.headSha) {
        throw new Error(
          `verify: PR #${number} is at ${pr.head_sha}, not the producer run's ${run.headSha}. ` +
            'Either the PR changed after the run (a newer run will follow), or the PR number is forged.'
        );
      }
      return { pr };
    }
    case 'issue_comment': {
      const id = hintId(getByPath(event, 'comment.id'), 'event.comment.id', EMIT_IDS_HINT);
      const { data } = await octokit.rest.issues.getComment({ owner, repo, comment_id: id });
      const user = checkAuthor(data.user, run, `comment ${id}`);
      checkTiming(`comment ${id}`, data.created_at, data.updated_at, run);
      const number = numberFromUrl(data.issue_url);
      checkPrHint(meta, number, `comment ${id}`);
      let pr: VerifiedPullRequest | undefined;
      try {
        pr = await fetchPullRequest(octokit, owner, repo, number);
      } catch (error: unknown) {
        // Comments on plain issues have no pull request.
        if (!isNotFound(error)) throw error;
      }
      return {
        trigger: trigger('issue_comment', id, user, {
          body: data.body,
          url: data.html_url,
          created_at: data.created_at,
          updated_at: data.updated_at
        }),
        ...(pr ? { pr } : {})
      };
    }
    case 'pull_request_review': {
      const id = hintId(getByPath(event, 'review.id'), 'event.review.id', EMIT_IDS_HINT);
      const number = prNumberHint(meta);
      let data;
      try {
        // The endpoint is scoped to the PR, so a forged PR number does not find the review.
        ({ data } = await octokit.rest.pulls.getReview({ owner, repo, pull_number: number, review_id: id }));
      } catch (error: unknown) {
        if (isNotFound(error)) {
          throw new Error(`verify: review ${id} was not found on PR #${number}, or the token cannot read pull requests`);
        }
        throw error;
      }
      if (!data.submitted_at) {
        throw new Error(`verify: review ${id} has not been submitted`);
      }
      const user = checkAuthor(data.user, run, `review ${id}`);
      // Reviews expose no edit time, so both bounds use submission.
      checkTiming(`review ${id}`, data.submitted_at, data.submitted_at, run);
      return {
        trigger: trigger('review', id, user, {
          body: data.body,
          url: data.html_url,
          created_at: data.submitted_at,
          updated_at: data.submitted_at,
          state: data.state,
          commit_id: data.commit_id
        }),
        pr: await fetchPullRequest(octokit, owner, repo, number)
      };
    }
    case 'pull_request_review_comment': {
      const id = hintId(getByPath(event, 'comment.id'), 'event.comment.id', EMIT_IDS_HINT);
      const { data } = await octokit.rest.pulls.getReviewComment({ owner, repo, comment_id: id });
      const user = checkAuthor(data.user, run, `review comment ${id}`);
      checkTiming(`review comment ${id}`, data.created_at, data.updated_at, run);
      const number = numberFromUrl(data.pull_request_url);
      checkPrHint(meta, number, `review comment ${id}`);
      return {
        trigger: trigger('review_comment', id, user, {
          body: data.body,
          url: data.html_url,
          created_at: data.created_at,
          updated_at: data.updated_at,
          path: data.path,
          commit_id: data.commit_id,
          original_commit_id: data.original_commit_id
        }),
        pr: await fetchPullRequest(octokit, owner, repo, number)
      };
    }
    default:
      throw new Error(`verify: true is not supported for ${run.event} producer runs`);
  }
}
