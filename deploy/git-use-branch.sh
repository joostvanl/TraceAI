#!/usr/bin/env bash
# Check out a remote branch even when the clone was --single-branch (main only).
# Usage: git-use-branch.sh <repo-dir> <branch>
#
# GitHub may 401 anonymous git protocol v2 and HTTP/2 POST git-upload-pack.
# Git then prompts for a username; over SSH that is "could not read Username".
# Protocol v1 + HTTP/1.1 still fetches this public repo without credentials.
# Do not add a token, gh auth, or SSH deploy key for fetch.
set -Eeuo pipefail

repo="${1:?repo dir}"
branch="${2:?branch}"

git() {
  command git -c protocol.version=1 -c http.version=HTTP/1.1 "$@"
}

git -C "$repo" config protocol.version 1
git -C "$repo" config http.version HTTP/1.1
git -C "$repo" config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
git -C "$repo" fetch --prune origin "refs/heads/${branch}:refs/remotes/origin/${branch}"
git -C "$repo" checkout -B "$branch" "origin/${branch}"
git -C "$repo" pull --ff-only "origin" "$branch"
