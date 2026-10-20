#!/usr/bin/env bash
# One-time setup of the push relay VPS (Ubuntu, aarch64).
# Run on the server: sudo bash bootstrap.sh
# Idempotent: running it again upgrades packages and keeps existing secrets.
set -euo pipefail

NODE_VERSION=24.21.0
NODE_SHA256=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2   # node-v24.21.0-linux-arm64.tar.xz

[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
[ "$(uname -m)" = aarch64 ] || { echo "expects an aarch64 (A1) machine"; exit 1; }
cd "$(dirname "$0")"

echo "== packages and automatic security updates"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -y -q full-upgrade
apt-get -y -q install unattended-upgrades curl ca-certificates xz-utils
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF

echo "== SSH: keys only, no root"
cat > /etc/ssh/sshd_config.d/10-spendrr.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
CONF
install -d -m 0755 /run/sshd  # sshd -t wants it; only exists while ssh.service runs
sshd -t
# Ubuntu 24.04+ starts sshd per connection from ssh.socket: a new connection
# reads the config anyway, and ssh.service is only running on older setups.
if systemctl is-active --quiet ssh; then systemctl reload ssh; fi

echo "== Node $NODE_VERSION (checksum pinned)"
if [ "$(/usr/local/bin/node --version 2>/dev/null)" != "v$NODE_VERSION" ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz"
  echo "$NODE_SHA256  $tmp/node.tar.xz" | sha256sum -c -
  rm -rf /usr/local/lib/nodejs && mkdir -p /usr/local/lib/nodejs
  tar -xJf "$tmp/node.tar.xz" -C /usr/local/lib/nodejs --strip-components=1
  ln -sf /usr/local/lib/nodejs/bin/node /usr/local/bin/node
  rm -rf "$tmp"
fi
node --version

echo "== cloudflared (Cloudflare's signed apt repository)"
if ! command -v cloudflared >/dev/null; then
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -q
  apt-get -y -q install cloudflared
fi

echo "== relay user, directories, secrets"
id relay >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin relay
install -d -m 0755 -o root -g root /opt/spendrr-relay
install -d -m 0700 -o relay -g relay /var/lib/spendrr-relay
install -d -m 0750 -o root -g relay /etc/spendrr-relay
if [ ! -f /etc/spendrr-relay/env ]; then
  umask 027
  cat > /etc/spendrr-relay/env <<CONF
RELAY_TOKEN=$(openssl rand -hex 32)
HOOK_SECRET=$(openssl rand -hex 32)
HOOK_URL=https://spendrr.app/api/push/hook
ARK_SERVER=https://ark.second.tech
PORT=8788
DB_PATH=/var/lib/spendrr-relay/relay.db
CONF
  chown root:relay /etc/spendrr-relay/env
  chmod 0640 /etc/spendrr-relay/env
fi

echo "== service"
install -m 0644 spendrr-relay.service /etc/systemd/system/spendrr-relay.service
systemctl daemon-reload
systemctl enable spendrr-relay >/dev/null
[ -f /opt/spendrr-relay/relay/relay.ts ] && systemctl restart spendrr-relay

echo
echo "Done. Next: deploy the code (scripts/push-relay/deploy.sh on your Mac) and install the tunnel token:"
echo "  sudo cloudflared service install <TUNNEL_TOKEN>"
