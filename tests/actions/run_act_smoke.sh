#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
events_dir="$script_dir/events"
workflows_dir="$script_dir/workflows"

require_cmd() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "missing required command: $name" >&2
    exit 1
  fi
}

run_act_with_log() {
  local log_file="$1"
  shift

  if ! DOCKER_CONFIG="$docker_config_dir" DOCKER_AUTH_CONFIG='{}' "$@" >"$log_file" 2>&1; then
    echo "act command failed; log follows:" >&2
    echo "--- begin act log ---" >&2
    cat "$log_file" >&2
    echo "--- end act log ---" >&2
    return 1
  fi
}

check_expected_patterns() {
  local expected_file="$1"
  local log_file="$2"

  while IFS= read -r pattern || [ -n "$pattern" ]; do
    if [ -z "$pattern" ]; then
      continue
    fi
    if ! grep -F -- "$pattern" "$log_file" >/dev/null 2>&1; then
      echo "missing expected log pattern: $pattern" >&2
      echo "--- begin act log ---" >&2
      cat "$log_file" >&2
      echo "--- end act log ---" >&2
      return 1
    fi
  done <"$expected_file"
}

require_cmd docker
require_cmd npm
require_cmd act

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/act-smoke.XXXXXX")"
docker_config_dir="$tmp_dir/docker-config"
artifacts_dir="$tmp_dir/artifacts"
logs_dir="$tmp_dir/logs"
mkdir -p "$docker_config_dir" "$artifacts_dir" "$logs_dir"
trap 'rm -rf "$tmp_dir"' EXIT

cd "$repo_root"
npm run build

common_args=(
  --container-architecture linux/amd64
  --platform ubuntu-latest=catthehacker/ubuntu:act-latest
  --no-cache-server
  --artifact-server-path "$artifacts_dir"
)

act_args=(act)
act_args+=(--secret "GITHUB_TOKEN=${GITHUB_TOKEN:-act-smoke-token}")

found_cases=0

for event_file in "$events_dir"/*.json; do
  if [ ! -e "$event_file" ]; then
    continue
  fi

  found_cases=1
  stem="$(basename "$event_file" .json)"
  workflow_file="$workflows_dir/$stem.yml"
  expected_file="$events_dir/$stem.expected"
  log_file="$logs_dir/$stem.log"

  if [ ! -f "$workflow_file" ]; then
    echo "missing workflow fixture: $workflow_file" >&2
    exit 1
  fi
  if [ ! -f "$expected_file" ]; then
    echo "missing expected output fixture: $expected_file" >&2
    exit 1
  fi

  echo "==> act smoke: $stem"
  run_act_with_log \
    "$log_file" \
    "${act_args[@]}" workflow_dispatch \
    -W "$workflow_file" \
    -e "$event_file" \
    "${common_args[@]}"
  check_expected_patterns "$expected_file" "$log_file"
done

if [ "$found_cases" -eq 0 ]; then
  echo "no act smoke fixtures found in $events_dir" >&2
  exit 1
fi

echo "act smoke tests passed"
