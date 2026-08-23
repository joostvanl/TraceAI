#!/usr/bin/env bash
# Check out a remote branch even when the clone was --single-branch (main only).
# Usage: git-use-branch.sh <repo-dir> <branch>
set -Eeuo pipefail

repo="${1:?repo dir}"
branch="${2:?branch}"

git -C "$repo" config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
git -C "$repo" fetch --prune origin "refs/heads/${branch}:refs/remotes/origin/${branch}"
git -C "$repo" checkout -B "$branch" "origin/${branch}"
git -C "$repo" pull --ff-only "origin" "$branch"
