#!/usr/bin/env bash
# Heimdall — native installer (no manual npm install required)
#
# Quick install:
#   curl -fsSL https://raw.githubusercontent.com/billzhuang/heimdall/main/install.sh | bash
#
# Options:
#   --dir <path>     Installation directory (default: ~/.local/share/heimdall)
#   --bin <path>     Binary link directory  (default: ~/.local/bin)
#   --upgrade, -u    Pull latest and rebuild an existing installation
#   --help,    -h    Show this help

set -euo pipefail

REPO_URL="https://github.com/billzhuang/heimdall.git"
DEFAULT_INSTALL_DIR="${HEIMDALL_DIR:-$HOME/.local/share/heimdall}"
DEFAULT_BIN_DIR="${HEIMDALL_BIN_DIR:-$HOME/.local/bin}"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=19

# ---- colours (disabled when stdout is not a tty) -------------------------
if [[ -t 1 ]]; then
  _R='\033[0;31m' _G='\033[0;32m' _Y='\033[1;33m' _B='\033[0;34m' _N='\033[0m'
else
  _R='' _G='' _Y='' _B='' _N=''
fi
info()    { printf "${_B}[heimdall]${_N} %s\n"         "$*"; }
success() { printf "${_G}[heimdall]${_N} %s\n"         "$*"; }
warn()    { printf "${_Y}[heimdall]${_N} warning: %s\n" "$*" >&2; }
die()     { printf "${_R}[heimdall]${_N} error: %s\n"   "$*" >&2; exit 1; }

# ---- argument parsing ----------------------------------------------------
INSTALL_DIR="$DEFAULT_INSTALL_DIR"
BIN_DIR="$DEFAULT_BIN_DIR"
UPGRADE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)       [[ $# -lt 2 ]] && die "--dir requires a path argument"; INSTALL_DIR="$2"; shift 2 ;;
    --dir=*)     INSTALL_DIR="${1#--dir=}"; shift ;;
    --bin)       [[ $# -lt 2 ]] && die "--bin requires a path argument"; BIN_DIR="$2"; shift 2 ;;
    --bin=*)     BIN_DIR="${1#--bin=}"; shift ;;
    --upgrade|-u) UPGRADE=true; shift ;;
    --help|-h)
      cat <<'EOF'
Heimdall native installer — no manual npm install required

Quick install:
  curl -fsSL https://raw.githubusercontent.com/billzhuang/heimdall/main/install.sh | bash

Options:
  --dir <path>     Installation directory (default: ~/.local/share/heimdall)
  --bin <path>     Binary link directory  (default: ~/.local/bin)
  --upgrade, -u    Pull latest and rebuild an existing installation
  --help,    -h    Show this help
EOF
      exit 0
      ;;
    *) die "Unknown argument: $1. Use --help for usage." ;;
  esac
done

# ---- prerequisite checks -------------------------------------------------
check_node() {
  command -v node &>/dev/null || die "Node.js ≥${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} is required. Install from https://nodejs.org"
  local ver
  ver=$(node -e "process.stdout.write(process.versions.node)")
  local major minor
  IFS='.' read -r major minor _ <<< "$ver"
  if (( major < MIN_NODE_MAJOR )) || { (( major == MIN_NODE_MAJOR )) && (( minor < MIN_NODE_MINOR )); }; then
    die "Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ required (found ${ver}). Upgrade from https://nodejs.org"
  fi
  info "Node.js ${ver} ✓"
}

check_git() {
  command -v git &>/dev/null || die "git is required. Install from https://git-scm.com"
  info "git $(git --version | awk '{print $3}') ✓"
}

check_npm() {
  command -v npm &>/dev/null || die "npm is required (bundled with Node.js). Install Node.js from https://nodejs.org"
  info "npm $(npm --version) ✓"
}

check_kubectl() {
  if command -v kubectl &>/dev/null; then
    local kver
    kver=$(kubectl version --client --output=json 2>/dev/null | grep '"gitVersion"' | head -1 | tr -d '" ,' | cut -d: -f2)
    info "kubectl ${kver:-unknown} ✓"
  else
    warn "kubectl not found — install it before using Heimdall: https://kubernetes.io/docs/tasks/tools/"
  fi
}

# ---- download / upgrade --------------------------------------------------
fetch_source() {
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    if [[ "$UPGRADE" == "true" ]]; then
      info "Upgrading existing installation in ${INSTALL_DIR} ..."
      git -C "$INSTALL_DIR" fetch --depth=1 origin main
      git -C "$INSTALL_DIR" reset --hard origin/main
    else
      die "${INSTALL_DIR} already exists. Re-run with --upgrade to update it."
    fi
  else
    if [[ -e "$INSTALL_DIR" ]]; then
      die "${INSTALL_DIR} exists but is not a Heimdall installation. Remove it or choose a different --dir."
    fi
    info "Cloning Heimdall into ${INSTALL_DIR} ..."
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --depth=1 "$REPO_URL" "$INSTALL_DIR"
  fi
}

build_heimdall() {
  info "Installing dependencies (production only) ..."
  npm --prefix "$INSTALL_DIR" ci --omit=dev --silent

  info "Building Heimdall ..."
  npm --prefix "$INSTALL_DIR" run build --silent
}

# ---- wire up the binary --------------------------------------------------
link_binary() {
  local target="${INSTALL_DIR}/bin/heimdall"
  local link="${BIN_DIR}/heimdall"

  chmod +x "$target"
  mkdir -p "$BIN_DIR"

  # Remove a stale link/file so we can re-link after an upgrade.
  [[ -e "$link" || -L "$link" ]] && rm -f "$link"
  ln -s "$target" "$link"
  success "Installed: ${link} → ${target}"
}

patch_path() {
  # Already on PATH — nothing to do.
  [[ ":${PATH}:" == *":${BIN_DIR}:"* ]] && return

  local shell_name
  shell_name="$(basename "${SHELL:-sh}")"

  local cfg export_line
  case "$shell_name" in
    zsh)  cfg="$HOME/.zshrc" ;;
    bash) cfg="$HOME/.bashrc" ;;
    fish) cfg="$HOME/.config/fish/config.fish" ;;
    *)    cfg="$HOME/.profile" ;;
  esac

  if [[ "$shell_name" == "fish" ]]; then
    export_line="fish_add_path ${BIN_DIR}"
  else
    export_line="export PATH=\"\${PATH}:${BIN_DIR}\""
  fi

  # Only append if the bin dir isn't already mentioned in the file.
  if [[ -n "$cfg" ]] && ! grep -qF "$BIN_DIR" "$cfg" 2>/dev/null; then
    printf '\n# Heimdall SRE agent\n%s\n' "$export_line" >> "$cfg"
    info "Added ${BIN_DIR} to PATH in ${cfg}"
  fi
}

# ---- main ----------------------------------------------------------------
echo ""
info "Heimdall native installer"
info "========================="
check_node
check_git
check_npm
check_kubectl
echo ""

fetch_source
build_heimdall
link_binary
patch_path

echo ""
success "Heimdall installed successfully!"
echo ""
info "Get started:"
info "  heimdall --help"
info "  heimdall -p \"Why is my api pod crash-looping?\""
echo ""

if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
  warn "${BIN_DIR} is not in your current shell's PATH. Either restart your shell or run:"
  warn "  export PATH=\"\${PATH}:${BIN_DIR}\""
  echo ""
fi
