#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/release.sh <version> [--push]

Examples:
  scripts/release.sh 1.2.0
  scripts/release.sh 1.2.0 --push
EOF
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage
  exit 1
fi

version="$1"
push_tags="false"

if [ "$#" -eq 2 ]; then
  if [ "$2" != "--push" ]; then
    usage
    exit 1
  fi
  push_tags="true"
fi

if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version must be in x.y.z form."
  exit 1
fi

release_tag="v$version"
major_tag="v${version%%.*}"
current_branch="$(git branch --show-current)"

if [ "$current_branch" != "main" ]; then
  echo "Releases must be cut from main. Current branch: $current_branch"
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree must be clean before releasing."
  exit 1
fi

if git rev-parse "$release_tag" >/dev/null 2>&1; then
  echo "Tag $release_tag already exists."
  exit 1
fi

echo "Running release checks..."
npm run release:check

echo "Creating annotated tag $release_tag"
git tag -a "$release_tag" -m "$release_tag"

echo "Updating major tag $major_tag"
git tag -f -a "$major_tag" -m "$major_tag"

if [ "$push_tags" = "true" ]; then
  echo "Pushing $release_tag"
  git push origin "$release_tag"
  echo "Pushing $major_tag"
  git push origin "refs/tags/$major_tag" --force
  echo "Release tags pushed."
else
  cat <<EOF
Release tags created locally.

To publish them:
  git push origin $release_tag
  git push origin refs/tags/$major_tag --force

To create GitHub release notes:
  gh release create $release_tag --generate-notes
EOF
fi
