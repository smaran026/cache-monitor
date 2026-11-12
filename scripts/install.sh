#!/usr/bin/env bash
# cache-monitor installer
# Installs the Pi extension and/or the OpenCode plugin from this repo.
# Usage:
#   ./scripts/install.sh          # interactive mode (asks what to install)
#   ./scripts/install.sh pi       # Pi extension only
#   ./scripts/install.sh opencode # OpenCode plugin only
#   ./scripts/install.sh all      # both

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-}"
STAMP="$(date +%Y%m%d-%H%M%S)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[cache-monitor]${NC} $*"; }
success() { echo -e "${GREEN}[cache-monitor]${NC} $*"; }
warn()    { echo -e "${YELLOW}[cache-monitor]${NC} $*"; }
error()   { echo -e "${RED}[cache-monitor]${NC} $*"; exit 1; }

# --- Interactive mode ---
if [[ -z "$MODE" ]]; then
  echo ""
  echo "cache-monitor installer"
  echo "------------------------------"
  echo "  1) Pi coding agent extension"
  echo "  2) OpenCode Go plugin"
  echo "  3) Both"
  echo ""
  read -rp "Install [1/2/3]: " choice
  case "$choice" in
    1) MODE="pi" ;;
    2) MODE="opencode" ;;
    3) MODE="all" ;;
    *) error "Invalid choice." ;;
  esac
fi

install_pi() {
  local dest="$HOME/.pi/agent/extensions"
  mkdir -p "$dest"

  if [[ -f "$dest/cache-monitor.ts" ]]; then
    warn "Existing cache-monitor.ts found at $dest — backing up to cache-monitor.ts.$STAMP.bak"
    cp "$dest/cache-monitor.ts" "$dest/cache-monitor.ts.$STAMP.bak"
  fi

  cp "$REPO_DIR/pi/cache-monitor.ts" "$dest/cache-monitor.ts"
  success "Pi extension installed: $dest/cache-monitor.ts"

  echo ""
  info "To verify: bun build $dest/cache-monitor.ts --no-bundle --outfile /tmp/cm-check.js && rm /tmp/cm-check.js && echo OK"
  info "Reload Pi (restart or /reload) for changes to take effect."
}

install_opencode() {
  local dest="$HOME/.config/opencode/local-plugins/oc-mistral-affinity"
  mkdir -p "$dest"

  if [[ -f "$dest/index.ts" ]]; then
    warn "Existing OpenCode plugin found at $dest — backing up"
    for f in index.ts tui.tsx package.json; do
      [[ -f "$dest/$f" ]] && cp "$dest/$f" "$dest/$f.$STAMP.bak"
    done
  fi

  cp "$REPO_DIR/opencode/index.ts"    "$dest/index.ts"
  cp "$REPO_DIR/opencode/tui.tsx"     "$dest/tui.tsx"
  cp "$REPO_DIR/opencode/package.json" "$dest/package.json"
  success "OpenCode plugin installed: $dest"

  # The plugin has two halves registered in two files:
  #   opencode.json  "plugin":  [...]  -> index.ts (request hooks)
  #   cli.json       "plugins": [...]  -> tui.tsx  (footer badge + /cache)
  local cfg_dir="$HOME/.config/opencode"
  local pair file label
  for pair in "opencode.json:\"plugin\"" "cli.json:\"plugins\""; do
    file="${pair%%:*}"; label="${pair#*:}"
    if [[ -f "$cfg_dir/$file" ]] && grep -q "oc-mistral-affinity" "$cfg_dir/$file" 2>/dev/null; then
      info "Plugin already registered in $cfg_dir/$file"
    else
      warn "Add \"./local-plugins/oc-mistral-affinity\" to the $label array in $cfg_dir/$file (see README)."
    fi
  done

  echo ""
  info "Restart OpenCode for changes to take effect."
}

case "$MODE" in
  pi)       install_pi ;;
  opencode) install_opencode ;;
  all)      install_pi; install_opencode ;;
  *)        error "Unknown mode: $MODE. Use: pi | opencode | all" ;;
esac

echo ""
success "Installation complete. See README.md for usage."
