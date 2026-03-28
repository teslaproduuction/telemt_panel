#!/bin/sh
set -eu

# ── Constants ────────────────────────────────────────────────────────────────
REPO="amirotin/telemt_panel"
BINARY_NAME="telemt-panel"
SERVICE_NAME="telemt-panel"
POLKIT_RULE="/etc/polkit-1/rules.d/10-telemt-restart.rules"

# Non-root installation paths (hardened mode)
SYSTEM_USER="telemt"
BIN_DIR="/opt/bin/telemt"
CONFIG_DIR="/opt/etc/telemt-panel"
DATA_DIR="/var/lib/telemt-panel"
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
  for _candidate in \
    "$BIN_DIR/telemt" \
    /bin/telemt \
    /usr/bin/telemt \
    /usr/local/bin/telemt; do
    if [ -x "$_candidate" ]; then
      echo "$_candidate"
      return
    fi
  done
  echo "/bin/telemt"
}

# ── Install helper ───────────────────────────────────────────────────────────
install_binary() {
  _src="$1"
  _dst="$2"
  $SUDO install -m 0755 "$_src" "$_dst"
}

# ── Create system user ───────────────────────────────────────────────────────
create_system_user() {
  if id "$SYSTEM_USER" >/dev/null 2>&1; then
    say "System user '$SYSTEM_USER' already exists"
  else
    $SUDO useradd --system --shell /usr/sbin/nologin --home /nonexistent "$SYSTEM_USER" 2>/dev/null \
      || $SUDO adduser --system --shell /usr/sbin/nologin --home /nonexistent --disabled-password "$SYSTEM_USER" 2>/dev/null \
      || die "Failed to create system user '$SYSTEM_USER'. Create it manually and re-run."
    say "Created system user '$SYSTEM_USER'"
  fi
}

# ── Check required commands ──────────────────────────────────────────────────
check_deps() {
  for _cmd in curl tar openssl; do
    command -v "$_cmd" >/dev/null 2>&1 || die "Required command '$_cmd' not found. Install it and re-run."
  done
  # sha256sum is optional (used for checksum verification)
  if ! command -v sha256sum >/dev/null 2>&1; then
    say "WARNING: sha256sum not found - checksum verification will be skipped"
  fi
}

# ── Set up directories ──────────────────────────────────────────────────────
setup_directories() {
  say "Setting up directories..."
  $SUDO mkdir -p "$BIN_DIR"
  $SUDO mkdir -p "$CONFIG_DIR"
  $SUDO mkdir -p "$DATA_DIR"
  $SUDO chown "$SYSTEM_USER:$SYSTEM_USER" "$BIN_DIR"
  $SUDO chown "$SYSTEM_USER:$SYSTEM_USER" "$CONFIG_DIR"
  $SUDO chown "$SYSTEM_USER:$SYSTEM_USER" "$DATA_DIR"
}

# ── Polkit rule for service restart (optional) ──────────────────────────────
install_polkit_rule() {
  if [ -f "$POLKIT_RULE" ]; then
    say "Polkit rule already exists - skipping"
    return
  fi
  # Skip if polkit is not installed
  if ! command -v pkaction >/dev/null 2>&1 && [ ! -d "/etc/polkit-1/rules.d" ]; then
    say "Polkit not found - skipping rule installation"
    say "Note: without polkit, the panel cannot restart services as non-root user"
    say "You can install polkit later and re-run the installer, or use sudo"
    return
  fi
  $SUDO mkdir -p "$(dirname "$POLKIT_RULE")"
  say "Installing polkit rule for service restart..."
  cat <<'POLKIT_EOF' | write_root "$POLKIT_RULE"
polkit.addRule(function(action, subject) {
    if (action.id == "org.freedesktop.systemd1.manage-units" &&
        (action.lookup("unit") == "telemt.service" || action.lookup("unit") == "telemt-panel.service") &&
        subject.user == "telemt") {
        var verb = action.lookup("verb");
        if (verb == "restart" || verb == "start") {
            return polkit.Result.YES;
        }
    }
});
POLKIT_EOF
  say "Polkit rule installed to $POLKIT_RULE"
}

# ── Systemd unit (hardened, non-root) ───────────────────────────────────────
generate_service() {
  cat <<EOF
[Unit]
Description=Telemt Panel
After=network.target

[Service]
Type=simple
User=$SYSTEM_USER
ExecStart=$BIN_DIR/$BINARY_NAME --config $CONFIG_DIR/config.toml
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

# Sandboxing
NoNewPrivileges=true
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$BIN_DIR $CONFIG_DIR $DATA_DIR

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
Telemt Panel Installer (hardened, non-root mode)

Creates a dedicated system user '$SYSTEM_USER' and uses sandboxed
directories instead of running as root.

Usage: $0 <command> [options]

Commands:
  install [version]   Install or update (default: latest release)
  uninstall           Remove binary, service, and polkit rule
  purge               Remove everything including config, data, and user
  --help              Show this help

Examples:
  $0                  Install latest version
  $0 install v1.2.0  Install specific version
  $0 uninstall        Remove service and binary
  $0 purge            Remove everything

Directories:
  Binary:   $BIN_DIR/$BINARY_NAME
  Config:   $CONFIG_DIR/config.toml
  Data:     $DATA_DIR/
  Service:  $SERVICE_FILE
  Polkit:   $POLKIT_RULE
EOF
}

# ═════════════════════════════════════════════════════════════════════════════
#  INSTALL
# ═════════════════════════════════════════════════════════════════════════════
do_install() {
  _version="${1:-}"

  printf '\n  Telemt Panel Installer (hardened mode)\n\n'

  # ── Stage 0: Check dependencies ────────────────────────────────────────
  check_deps

  # ── Stage 1: Create system user and directories ─────────────────────────
  create_system_user
  setup_directories
  install_polkit_rule

  # ── Stage 2: Detect architecture ─────────────────────────────────────────
  say "Detecting architecture..."
  ARCH=$(detect_arch)
  say "Architecture: $ARCH"

  # ── Stage 3: Download binary ─────────────────────────────────────────────
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

  # Verify SHA256 checksum if available
  if command -v sha256sum >/dev/null 2>&1; then
    CHECKSUM_URL="https://github.com/$REPO/releases/download/$TAG/checksums.txt"
    TMP_CHECKSUMS="/tmp/telemt-panel-checksums.txt"
    track_tmp "$TMP_CHECKSUMS"
    if curl -fsSL "$CHECKSUM_URL" -o "$TMP_CHECKSUMS" 2>/dev/null; then
      say "Verifying SHA256 checksum..."
      EXPECTED=$(grep "$TARBALL" "$TMP_CHECKSUMS" | awk '{print $1}')
      if [ -n "$EXPECTED" ]; then
        ACTUAL=$(sha256sum "$TMP_TAR" | awk '{print $1}')
        if [ "$EXPECTED" != "$ACTUAL" ]; then
          die "Checksum mismatch! Expected: $EXPECTED, Got: $ACTUAL"
        fi
        say "Checksum OK"
      else
        say "WARNING: Checksum file found but no entry for $TARBALL - skipping verification"
      fi
    else
      say "WARNING: Checksum file not available - skipping verification"
    fi
  fi

  say "Extracting..."
  tar -xzf "$TMP_TAR" -C /tmp
  EXTRACTED="/tmp/telemt-panel-${ARCH}-linux"
  track_tmp "$EXTRACTED"

  install_binary "$EXTRACTED" "$BIN_DIR/$BINARY_NAME"
  $SUDO chown "$SYSTEM_USER:$SYSTEM_USER" "$BIN_DIR/$BINARY_NAME"
  say "Installed $BIN_DIR/$BINARY_NAME ($TAG)"

  # ── Stage 4: Configure ──────────────────────────────────────────────────
  if [ -f "$CONFIG_DIR/config.toml" ]; then
    say "Config already exists at $CONFIG_DIR/config.toml - skipping"
  else
    say "Setting up initial configuration..."
    echo ""

    TELEMT_URL=$(prompt "Telemt API URL" "http://127.0.0.1:9091")
    TELEMT_AUTH=$(prompt "Telemt API auth header (leave empty if none)" "")
    ADMIN_USER=$(prompt "Admin username" "admin")
    ADMIN_PASS=$(prompt_secret "Admin password")

    [ -n "$ADMIN_PASS" ] || die "Password cannot be empty"

    TELEMT_DETECTED=$(detect_telemt)
    TELEMT_PATH=$(prompt "Telemt binary path" "$TELEMT_DETECTED")

    TELEMT_SERVICE=$(prompt "Telemt systemd service name" "telemt")

    say "Generating password hash..."
    # Use printf to pipe password to avoid heredoc indentation issues
    PASS_HASH=$(printf '%s\n' "$ADMIN_PASS" | "$BIN_DIR/$BINARY_NAME" hash-password) \
      || die "Failed to generate password hash"

    JWT_SECRET=$(openssl rand -hex 32)

    # Build config with hardened paths
    _cfg="listen = \"0.0.0.0:8080\"

[telemt]
url = \"$TELEMT_URL\""

    if [ -n "$TELEMT_AUTH" ]; then
      _cfg="$_cfg
auth_header = \"$TELEMT_AUTH\""
    fi

    _cfg="$_cfg
binary_path = \"$TELEMT_PATH\"
service_name = \"$TELEMT_SERVICE\"

[panel]
binary_path = \"$BIN_DIR/$BINARY_NAME\"
service_name = \"$SERVICE_NAME\"

[auth]
username = \"$ADMIN_USER\"
password_hash = \"$PASS_HASH\"
jwt_secret = \"$JWT_SECRET\"
session_ttl = \"24h\""

    printf '%s\n' "$_cfg" | write_root "$CONFIG_DIR/config.toml"
    $SUDO chown "$SYSTEM_USER:$SYSTEM_USER" "$CONFIG_DIR/config.toml"
    $SUDO chmod 600 "$CONFIG_DIR/config.toml"
    say "Config saved to $CONFIG_DIR/config.toml"
  fi

  # ── Stage 5: Install service ─────────────────────────────────────────────
  say "Installing systemd service..."
  generate_service | write_root "$SERVICE_FILE"
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "$SERVICE_NAME"
  $SUDO systemctl start "$SERVICE_NAME"
  say "Service $SERVICE_NAME started and enabled"

  # ── Stage 6: Done ───────────────────────────────────────────────────────
  _ip=$(hostname -I 2>/dev/null | awk '{print $1}') || _ip="<server-ip>"
  printf '\n'
  say "Installation complete!"
  printf '\n'
  printf '  Panel URL:     http://%s:8080\n' "$_ip"
  printf '  System user:   %s\n' "$SYSTEM_USER"
  printf '  Binary:        %s\n' "$BIN_DIR/$BINARY_NAME"
  printf '  Config:        %s/config.toml\n' "$CONFIG_DIR"
  printf '  Service:       %s\n' "$SERVICE_NAME"
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
    say "Service not found - skipping"
  fi

  if [ -f "$BIN_DIR/$BINARY_NAME" ]; then
    $SUDO rm -f "$BIN_DIR/$BINARY_NAME"
    say "Binary removed"
  else
    say "Binary not found - skipping"
  fi

  if [ -f "$POLKIT_RULE" ]; then
    $SUDO rm -f "$POLKIT_RULE"
    say "Polkit rule removed"
  fi

  printf '\n'
  say "Uninstall complete"
  say "Config ($CONFIG_DIR) and data ($DATA_DIR) were preserved"
  say "Run '$0 purge' to remove everything including user '$SYSTEM_USER'"
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

  # Remove bin directory if empty
  if [ -d "$BIN_DIR" ] && [ -z "$(ls -A "$BIN_DIR" 2>/dev/null)" ]; then
    $SUDO rmdir "$BIN_DIR"
    say "Removed empty $BIN_DIR"
  fi

  # Remove system user if no other processes depend on it
  if id "$SYSTEM_USER" >/dev/null 2>&1; then
    say "Removing system user '$SYSTEM_USER'..."
    $SUDO userdel "$SYSTEM_USER" 2>/dev/null || true
  fi

  say "Purge complete - all telemt-panel files removed"
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
