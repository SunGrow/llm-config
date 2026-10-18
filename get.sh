#!/bin/sh
# llm-config one-line installer for Linux and macOS:
#   curl -fsSL https://raw.githubusercontent.com/SunGrow/llm-config/main/get.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/SunGrow/llm-config/main/get.sh | sh -s -- --yes --components claude,opencode
# Downloads (or updates) the repository into ~/.llm-config/repo, then runs install.sh there with the given
# arguments. With no arguments: the interactive picker on a first install, `--update` when something is installed.
# Environment: LLM_CONFIG_DIR (checkout path), LLM_CONFIG_REPO (git URL), LLM_CONFIG_BRANCH (default main).

set -u

repo=${LLM_CONFIG_REPO:-https://github.com/SunGrow/llm-config.git}
branch=${LLM_CONFIG_BRANCH:-main}
dest=${LLM_CONFIG_DIR:-$HOME/.llm-config/repo}

say() { printf '%s\n' "llm-config: $*" >&2; }
die() { say "$*"; exit 1; }

fetch() { # url -> stdout
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"
  else die "neither curl nor wget is available"; fi
}

download_tarball() {
  case "$repo" in
    https://github.com/*) ;;
    *) die "git is not installed and $repo is not a GitHub URL, so no tarball fallback; install git first" ;;
  esac
  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t llm-config) || die "cannot create a temp directory"
  say "git not found; downloading ${repo%.git} ($branch) as a tarball"
  fetch "${repo%.git}/archive/refs/heads/$branch.tar.gz" | tar -xzf - -C "$tmp" || { rm -rf "$tmp"; die "download or extraction failed"; }
  src=$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  [ -n "$src" ] && [ -f "$src/installer/install.mjs" ] || { rm -rf "$tmp"; die "the downloaded archive has no installer"; }
  if [ -d "$dest" ]; then
    # keep the private overlay (local/) of an earlier tarball install
    if [ -d "$dest/local" ]; then mv "$dest/local" "$src/local" || { rm -rf "$tmp"; die "cannot carry over $dest/local"; }; fi
    rm -rf "$dest"
  fi
  mkdir -p "$(dirname "$dest")" && mv "$src" "$dest" || { rm -rf "$tmp"; die "cannot move the files to $dest"; }
  rm -rf "$tmp"
}

if [ -d "$dest/.git" ]; then
  command -v git >/dev/null 2>&1 || die "$dest is a git checkout but git is not installed"
  say "updating $dest"
  git -C "$dest" pull --ff-only --quiet || die "git pull failed in $dest (local changes or a diverged branch); resolve it there and run again"
elif [ -e "$dest" ] && [ ! -f "$dest/installer/install.mjs" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ]; then
  die "$dest exists and is not an llm-config checkout; set LLM_CONFIG_DIR to another path"
elif command -v git >/dev/null 2>&1 && [ ! -e "$dest/installer/install.mjs" ]; then
  say "cloning $repo into $dest"
  mkdir -p "$(dirname "$dest")" || die "cannot create $(dirname "$dest")"
  git clone --quiet --depth 1 --branch "$branch" "$repo" "$dest" || die "git clone failed"
else
  download_tarball
fi

[ $# -eq 0 ] && [ -f "$HOME/.llm-config/manifest.json" ] && set -- --update

# Under `curl | sh` stdin is the script itself; give the installer the terminal so the picker and prompts work.
if [ ! -t 0 ] && (: </dev/tty) 2>/dev/null; then
  exec sh "$dest/install.sh" "$@" </dev/tty
fi
exec sh "$dest/install.sh" "$@"
