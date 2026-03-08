#!/usr/bin/env bash
set -euo pipefail

REPO="amirotin/telemt_panel"
INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/etc/telemt-panel"
SERVICE_FILE="/etc/systemd/system/telemt-panel.service"

echo "=== Telemt Panel Installer ==="
echo ""

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH="amd64" ;;
  aarch64) ARCH="arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac
echo "Detected architecture: $ARCH"

# Download or build
if command -v go &>/dev/null && command -v node &>/dev/null; then
  echo "Building from source..."
  TMPDIR=$(mktemp -d)
  trap "rm -rf $TMPDIR" EXIT
  git clone "https://github.com/$REPO.git" "$TMPDIR/src"
  cd "$TMPDIR/src"
  cd frontend && npm ci && npm run build && cd ..
  CGO_ENABLED=0 go build -ldflags="-s -w" -o telemt-panel .
  sudo cp telemt-panel "$INSTALL_DIR/telemt-panel"
else
  echo "Downloading prebuilt binary..."
  LATEST=$(curl -sL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)
  if [ -z "$LATEST" ]; then
    echo "Error: Could not determine latest release. Install Go and Node to build from source."
    exit 1
  fi
  curl -sL "https://github.com/$REPO/releases/download/$LATEST/telemt-panel-linux-$ARCH" -o /tmp/telemt-panel
  sudo chmod +x /tmp/telemt-panel
  sudo mv /tmp/telemt-panel "$INSTALL_DIR/telemt-panel"
fi

echo "Installed to $INSTALL_DIR/telemt-panel"

# Create system user
if ! id telemt-panel &>/dev/null; then
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin telemt-panel
  echo "Created system user: telemt-panel"
fi

# Config directory
sudo mkdir -p "$CONFIG_DIR"

if [ ! -f "$CONFIG_DIR/config.toml" ]; then
  echo ""
  echo "Setting up initial configuration..."

  read -rp "Telemt API URL [http://127.0.0.1:2398]: " TELEMT_URL
  TELEMT_URL="${TELEMT_URL:-http://127.0.0.1:2398}"

  read -rp "Telemt API auth header (leave empty if none): " TELEMT_AUTH

  read -rp "Panel admin username [admin]: " ADMIN_USER
  ADMIN_USER="${ADMIN_USER:-admin}"

  read -rsp "Panel admin password: " ADMIN_PASS
  echo ""

  PASS_HASH=$("$INSTALL_DIR/telemt-panel" hash-password <<< "$ADMIN_PASS")
  JWT_SECRET=$(openssl rand -hex 32)

  cat > /tmp/telemt-panel-config.toml << EOF
listen = "0.0.0.0:8080"

[telemt]
url = "$TELEMT_URL"
auth_header = "$TELEMT_AUTH"

[auth]
username = "$ADMIN_USER"
password_hash = "$PASS_HASH"
jwt_secret = "$JWT_SECRET"
session_ttl = "24h"
EOF

  sudo mv /tmp/telemt-panel-config.toml "$CONFIG_DIR/config.toml"
  sudo chmod 600 "$CONFIG_DIR/config.toml"
  sudo chown telemt-panel:telemt-panel "$CONFIG_DIR/config.toml"
  echo "Config saved to $CONFIG_DIR/config.toml"
fi

# Install systemd service
cat > /tmp/telemt-panel.service << 'EOF'
[Unit]
Description=Telemt Panel
After=network.target

[Service]
Type=simple
User=telemt-panel
Group=telemt-panel
ExecStart=/usr/local/bin/telemt-panel --config /etc/telemt-panel/config.toml
Restart=on-failure
RestartSec=5
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/telemt-panel

[Install]
WantedBy=multi-user.target
EOF

sudo mv /tmp/telemt-panel.service "$SERVICE_FILE"
sudo systemctl daemon-reload
sudo systemctl enable telemt-panel
sudo systemctl start telemt-panel

echo ""
echo "=== Installation Complete ==="
echo "Panel is running at http://$(hostname -I | awk '{print $1}'):8080"
echo ""
echo "Commands:"
echo "  sudo systemctl status telemt-panel"
echo "  sudo systemctl restart telemt-panel"
echo "  sudo journalctl -u telemt-panel -f"
