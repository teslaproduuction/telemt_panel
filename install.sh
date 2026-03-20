#!/bin/sh
set -eu

# ── Constants ────────────────────────────────────────────────────────────────
REPO="amirotin/telemt_panel"
INSTALL_DIR="/usr/local/bin"
BINARY_NAME="telemt-panel"
CONFIG_DIR="/etc/telemt-panel"
DATA_DIR="/var/lib/telemt-panel"
SERVICE_NAME="telemt-panel"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# ── Utilities ────────────────────────────────────────────────────────────────
say()  { printf '[INFO]  %s\n' "$*"; }
die()  { printf '[ERROR] %s\n' "$*" >&2; exit 1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

write_root() {
  $SUDO tee "$1" >/dev/null
}

_TMP_FILES=""
cleanup() {
  if [ -n "$_TMP_FILES" ]; then
    # shellcheck disable=SC2086
    rm -f $_TMP_FILES
  fi
}
trap cleanup EXIT

track_tmp() {
  _TMP_FILES="$_TMP_FILES $1"
}

# ── Architecture ─────────────────────────────────────────────────────────────
detect_arch() {
  _arch=$(uname -m)
  case "$_arch" in
    x86_64)  echo "x86_64"  ;;
    aarch64) echo "aarch64" ;;
    *)       die "Unsupported architecture: $_arch" ;;
  esac
}

# ── Telemt binary location ───────────────────────────────────────────────────
detect_telemt() {
  if command -v telemt >/dev/null 2>&1; then
    command -v telemt
  elif [ -x /bin/telemt ]; then
    echo "/bin/telemt"
  elif [ -x /usr/bin/telemt ]; then
    echo "/usr/bin/telemt"
  elif [ -x /usr/local/bin/telemt ]; then
    echo "/usr/local/bin/telemt"
  else
    echo "/bin/telemt"
  fi
}

# ── Install helper ───────────────────────────────────────────────────────────
install_binary() {
  _src="$1"
  _dst="$2"
  if command -v install >/dev/null 2>&1; then
    $SUDO install -m 0755 "$_src" "$_dst"
  else
    $SUDO cp "$_src" "$_dst"
    $SUDO chmod 0755 "$_dst"
  fi
}

# ── Systemd unit ─────────────────────────────────────────────────────────────
generate_service() {
  cat <<'EOF'
[Unit]
Description=Telemt Panel
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/telemt-panel --config /etc/telemt-panel/config.toml
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

# Hardening (compatible with update and config editing features)
NoNewPrivileges=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
}

# ── Read a value with default ────────────────────────────────────────────────
prompt() {
  _prompt="$1"
  _default="$2"
  if [ -n "$_default" ]; then
    printf '%s [%s]: ' "$_prompt" "$_default" >&2
  else
    printf '%s: ' "$_prompt" >&2
  fi
  read -r _val < /dev/tty
  echo "${_val:-$_default}"
}

prompt_secret() {
  _prompt="$1"
  printf '%s: ' "$_prompt" >&2
  stty -echo 2>/dev/null || true
  read -r _val < /dev/tty
  stty echo 2>/dev/null || true
  printf '\n' >&2
  echo "$_val"
}

# ── Usage ────────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Telemt Panel Installer

Usage: $0 <command> [options]

Commands:
  install [version]   Install or update (default: latest release)
  uninstall           Remove binary and systemd service
  purge               Remove everything including config and data
  --help              Show this help

Examples:
  $0                  Install latest version
  $0 install v1.2.0  Install specific version
  $0 uninstall        Remove service and binary
EOF
}

# ═════════════════════════════════════════════════════════════════════════════
#  INSTALL
# ═════════════════════════════════════════════════════════════════════════════
do_install() {
  _version="${1:-}"

  printf '\n  Telemt Panel Installer\n\n'

  # ── Stage 1: Detect architecture ─────────────────────────────────────────
  say "Detecting architecture..."
  ARCH=$(detect_arch)
  say "Architecture: $ARCH"

  # ── Stage 2: Download binary ─────────────────────────────────────────────
  if [ -n "$_version" ]; then
    TAG="$_version"
    say "Requested version: $TAG"
  else
    say "Fetching latest release..."
    TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | grep '"tag_name"' | cut -d'"' -f4) \
      || die "Could not determine latest release"
    [ -n "$TAG" ] || die "Could not determine latest release"
    say "Latest version: $TAG"
  fi

  TARBALL="telemt-panel-${ARCH}-linux-gnu.tar.gz"
  URL="https://github.com/$REPO/releases/download/$TAG/$TARBALL"
  TMP_TAR="/tmp/$TARBALL"
  track_tmp "$TMP_TAR"

  say "Downloading $TARBALL..."
  curl -fSL "$URL" -o "$TMP_TAR" \
    || die "Download failed. Check that version $TAG exists."

  say "Extracting..."
  tar -xzf "$TMP_TAR" -C /tmp
  EXTRACTED="/tmp/telemt-panel-${ARCH}-linux"
  track_tmp "$EXTRACTED"

  $SUDO mkdir -p "$INSTALL_DIR"
  install_binary "$EXTRACTED" "$INSTALL_DIR/$BINARY_NAME"
  say "Installed $INSTALL_DIR/$BINARY_NAME ($TAG)"

  # ── Stage 3: Configure ──────────────────────────────────────────────────
  $SUDO mkdir -p "$CONFIG_DIR"
  $SUDO mkdir -p "$DATA_DIR"

  if [ -f "$CONFIG_DIR/config.toml" ]; then
    say "Config already exists at $CONFIG_DIR/config.toml — skipping"
  else
    say "Setting up initial configuration..."
    echo ""

    TELEMT_URL=$(prompt "Telemt API URL" "http://127.0.0.1:9091")
    TELEMT_AUTH=$(prompt "Telemt API auth header (leave empty if none)" "")
    ADMIN_USER=$(prompt "Admin username" "admin")
    ADMIN_PASS=$(prompt_secret "Admin password")

    [ -n "$ADMIN_PASS" ] || die "Password cannot be empty"

    TELEMT_DEFAULT="/bin/telemt"
    TELEMT_DETECTED=$(detect_telemt)
    TELEMT_PATH=$(prompt "Telemt binary path" "$TELEMT_DETECTED")

    say "Generating password hash..."
    PASS_HASH=$("$INSTALL_DIR/$BINARY_NAME" hash-password <<EOF
$ADMIN_PASS
EOF
    ) || die "Failed to generate password hash"

    JWT_SECRET=$(openssl rand -hex 32)

    # Build config
    _cfg="listen = \"0.0.0.0:8080\"

[telemt]
url = \"$TELEMT_URL\""

    if [ -n "$TELEMT_AUTH" ]; then
      _cfg="$_cfg
auth_header = \"$TELEMT_AUTH\""
    fi

    if [ "$TELEMT_PATH" != "$TELEMT_DEFAULT" ]; then
      _cfg="$_cfg
binary_path = \"$TELEMT_PATH\""
    fi

    _cfg="$_cfg

[auth]
username = \"$ADMIN_USER\"
password_hash = \"$PASS_HASH\"
jwt_secret = \"$JWT_SECRET\"
session_ttl = \"24h\""

    printf '%s\n' "$_cfg" | write_root "$CONFIG_DIR/config.toml"
    $SUDO chmod 600 "$CONFIG_DIR/config.toml"
    say "Config saved to $CONFIG_DIR/config.toml"
  fi

  # ── Stage 4: Install service ─────────────────────────────────────────────
  say "Installing systemd service..."
  generate_service | write_root "$SERVICE_FILE"
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "$SERVICE_NAME"
  $SUDO systemctl start "$SERVICE_NAME"
  say "Service $SERVICE_NAME started and enabled"

  # ── Stage 5: Done ───────────────────────────────────────────────────────
  _ip=$(hostname -I 2>/dev/null | awk '{print $1}') || _ip="<server-ip>"
  printf '\n'
  say "Installation complete!"
  printf '\n'
  printf '  Panel URL:  http://%s:8080\n' "$_ip"
  printf '\n'
  printf '  Useful commands:\n'
  printf '    sudo systemctl status  %s\n' "$SERVICE_NAME"
  printf '    sudo systemctl restart %s\n' "$SERVICE_NAME"
  printf '    sudo journalctl -u %s -f\n' "$SERVICE_NAME"
  printf '\n'
}

# ═════════════════════════════════════════════════════════════════════════════
#  UNINSTALL
# ═════════════════════════════════════════════════════════════════════════════
do_uninstall() {
  printf '\n  Telemt Panel Uninstaller\n\n'

  if [ -f "$SERVICE_FILE" ]; then
    say "Stopping service..."
    $SUDO systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    $SUDO systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    $SUDO rm -f "$SERVICE_FILE"
    $SUDO systemctl daemon-reload
    say "Service removed"
  else
    say "Service not found — skipping"
  fi

  if [ -f "$INSTALL_DIR/$BINARY_NAME" ]; then
    $SUDO rm -f "$INSTALL_DIR/$BINARY_NAME"
    say "Binary removed"
  else
    say "Binary not found — skipping"
  fi

  printf '\n'
  say "Uninstall complete"
  say "Config ($CONFIG_DIR) and data ($DATA_DIR) were preserved"
  say "Run '$0 purge' to remove everything"
  printf '\n'
}

# ═════════════════════════════════════════════════════════════════════════════
#  PURGE
# ═════════════════════════════════════════════════════════════════════════════
do_purge() {
  do_uninstall

  say "Removing config and data..."
  $SUDO rm -rf "$CONFIG_DIR"
  $SUDO rm -rf "$DATA_DIR"
  say "Purge complete — all telemt-panel files removed"
  printf '\n'
}

# ═════════════════════════════════════════════════════════════════════════════
#  MAIN
# ═════════════════════════════════════════════════════════════════════════════
_cmd="${1:-install}"
shift 2>/dev/null || true

case "$_cmd" in
  install)    do_install "${1:-}" ;;
  uninstall)  do_uninstall ;;
  purge)      do_purge ;;
  --help|-h)  usage ;;
  *)          usage; exit 1 ;;
esac
