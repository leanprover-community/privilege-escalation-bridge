import { describe, expect, it } from 'vitest';

import { resolveAuthToken } from '../../src/consume/token.js';

describe('consume token resolution', () => {
  it('prefers explicit token input over all other sources', () => {
    expect(
      resolveAuthToken({
        tokenInput: 'input-token',
        githubTokenInput: 'legacy-input-token',
        envGithubToken: 'env-github-token',
        envGhToken: 'env-gh-token'
      })
    ).toBe('input-token');
  });

  it('falls back to github_token input alias when token input is empty', () => {
    expect(
      resolveAuthToken({
        tokenInput: '',
        githubTokenInput: 'legacy-input-token',
        envGithubToken: 'env-github-token',
        envGhToken: 'env-gh-token'
      })
    ).toBe('legacy-input-token');
  });

  it('falls back to GITHUB_TOKEN env when no inputs are provided', () => {
    expect(
      resolveAuthToken({
        tokenInput: '',
        githubTokenInput: '',
        envGithubToken: 'env-github-token',
        envGhToken: 'env-gh-token'
      })
    ).toBe('env-github-token');
  });

  it('falls back to GH_TOKEN env when GITHUB_TOKEN is not set', () => {
    expect(
      resolveAuthToken({
        tokenInput: '',
        githubTokenInput: '',
        envGithubToken: '',
        envGhToken: 'env-gh-token'
      })
    ).toBe('env-gh-token');
  });

  it('throws a targeted message when all sources are missing', () => {
    expect(() =>
      resolveAuthToken({
        tokenInput: '',
        githubTokenInput: '',
        envGithubToken: '',
        envGhToken: ''
      })
    ).toThrow(/Checked \(in order\): input "token", input "github_token", env "GITHUB_TOKEN", env "GH_TOKEN"/);
  });
});
