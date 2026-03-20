# Releasing

This repository publishes GitHub Actions from committed source plus checked-in `dist/` bundles.

## Versioning

- Use immutable release tags like `v1.2.0`.
- Move the major compatibility tag like `v1` to the same commit as the latest `v1.x.y` release.

## Prerequisites

- Release from `main`.
- Ensure the worktree is clean.
- Ensure CI is green.
- Ensure local `gh` auth is ready if you want to create a GitHub Release from the CLI.

## Release Checks

Run:

```bash
npm run release:check
```

This runs lint, typecheck, tests, and rebuilds `dist/`.

## Create a Release

To prepare tags locally for version `1.2.0`:

```bash
scripts/release.sh 1.2.0
```

To prepare and push tags immediately:

```bash
scripts/release.sh 1.2.0 --push
```

The script:

- verifies you are on `main`
- requires a clean worktree
- runs `npm run release:check`
- creates annotated tag `v1.2.0`
- force-moves annotated tag `v1`

## Publish GitHub Release Notes

After pushing the release tag, create a GitHub Release:

```bash
gh release create v1.2.0 --generate-notes
```

If you used `scripts/release.sh 1.2.0` without `--push`, push:

```bash
git push origin v1.2.0
git push origin refs/tags/v1 --force
```
