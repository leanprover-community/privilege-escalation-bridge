export interface AuthTokenSources {
  tokenInput: string;
  githubTokenInput: string;
  envGithubToken?: string;
  envGhToken?: string;
}

export function resolveAuthToken(sources: AuthTokenSources): string {
  const token = sources.tokenInput || sources.githubTokenInput || sources.envGithubToken || sources.envGhToken;
  if (token) {
    return token;
  }

  throw new Error(
    'Missing token for artifact download. Checked (in order): input "token", input "github_token", env "GITHUB_TOKEN", env "GH_TOKEN". ' +
      'Provide `with: token: ${{ github.token }}` (or equivalent token with actions:read).'
  );
}
