#!/bin/sh
# Update llm-config: pull the latest commits (when this is a git checkout), then re-apply every installed
# component with `install.sh --update`. Extra arguments go to the installer (e.g. --dry-run, --yes).
# Set LLM_CONFIG_NO_PULL=1 to skip the pull.

set -u
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || { echo "update.sh: cannot determine the script directory" >&2; exit 1; }

if [ "${LLM_CONFIG_NO_PULL:-}" = 1 ]; then
  :
elif [ -d "$here/.git" ] && command -v git >/dev/null 2>&1; then
  echo "llm-config: pulling the latest version" >&2
  git -C "$here" pull --ff-only --quiet || {
    echo "update.sh: git pull failed (local changes or a diverged branch). Resolve it, or run with LLM_CONFIG_NO_PULL=1." >&2
    exit 1
  }
else
  echo "llm-config: not a git checkout, so nothing to pull; re-run the get.sh one-liner to download the latest files" >&2
fi

exec sh "$here/install.sh" --update "$@"
