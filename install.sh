#!/bin/sh
# llm-config bootstrap: checks for Node.js >= 18, then runs installer/install.mjs with all arguments.
# POSIX sh (works with dash and macOS bash 3.2). Usage: ./install.sh [--help]

set -u

case "$0" in
  */*) self=$0 ;;
  *) self=$(command -v -- "$0" 2>/dev/null || printf '%s' "$0") ;;
esac
case "$self" in
  */*) self_dir=${self%/*} ;;
  *) self_dir=. ;;
esac
here=$(CDPATH='' cd -- "${self_dir:-/}" && pwd -P) || {
  echo "install.sh: cannot determine the script directory" >&2
  exit 1
}

node_hint() {
  echo "" >&2
  echo "Install Node.js 18 or newer, then run this script again:" >&2
  os=$(uname -s 2>/dev/null || echo unknown)
  case "$os" in
    Darwin)
      echo "  brew install node" >&2
      echo "  (no Homebrew? see https://brew.sh, or use nvm below)" >&2
      ;;
    Linux)
      id=""; like=""
      if [ -r /etc/os-release ]; then
        # shellcheck disable=SC1091
        id=$(. /etc/os-release && printf '%s' "${ID:-}")
        # shellcheck disable=SC1091
        like=$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")
      fi
      case " $id $like " in
        *" ubuntu "*|*" debian "*)
          echo "  sudo apt-get update && sudo apt-get install -y nodejs npm" >&2
          echo "  (if apt's nodejs is older than 18, use nvm below)" >&2 ;;
        *" fedora "*|*" rhel "*|*" centos "*)
          echo "  sudo dnf install -y nodejs npm" >&2 ;;
        *" arch "*)
          echo "  sudo pacman -S --needed nodejs npm" >&2 ;;
        *" alpine "*)
          echo "  sudo apk add nodejs npm" >&2 ;;
        *" opensuse"*|*" suse "*)
          echo "  sudo zypper install nodejs npm" >&2 ;;
        *)
          echo "  use your distribution's package manager (package: nodejs), or nvm below" >&2 ;;
      esac
      ;;
    MINGW*|MSYS*|CYGWIN*)
      echo "  winget install OpenJS.NodeJS.LTS   (then open a new terminal)" >&2
      ;;
    *)
      echo "  see https://nodejs.org/en/download" >&2
      ;;
  esac
  echo "  any OS, no root:  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && nvm install --lts" >&2
}

node_bin=""
for candidate in node nodejs; do
  if command -v "$candidate" >/dev/null 2>&1; then
    node_bin=$candidate
    break
  fi
done

if [ -z "$node_bin" ]; then
  echo "install.sh: Node.js was not found on PATH." >&2
  node_hint
  exit 1
fi

version=$("$node_bin" -p 'process.versions.node' 2>/dev/null || echo 0)
major=${version%%.*}
case "$major" in
  ''|*[!0-9]*) major=0 ;;
esac
if [ "$major" -lt 18 ]; then
  echo "install.sh: Node.js $version found, but 18 or newer is required." >&2
  node_hint
  exit 1
fi

# Git Bash/mintty: the terminal is a pipe for native programs; tell the installer it may prompt.
if [ -t 0 ] && [ -t 1 ]; then
  LLM_CONFIG_TTY=1
  export LLM_CONFIG_TTY
fi

exec "$node_bin" "$here/installer/install.mjs" "$@"
