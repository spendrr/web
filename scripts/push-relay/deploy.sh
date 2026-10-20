#!/usr/bin/env bash
# Copies the relay code to the server and restarts it. Run on your Mac from the
# repo: scripts/push-relay/deploy.sh <server-ip>
# Only relay/*.ts and worker/mailboxProto.ts go over: no dependencies, Node
# runs the TypeScript directly.
set -euo pipefail
HOST=${1:?usage: deploy.sh <server-ip>}
KEY=${SSH_KEY:-$HOME/.ssh/relay_key}
cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain -- relay worker/mailboxProto.ts)" ]; then
  echo "relay/ or worker/mailboxProto.ts has uncommitted changes: commit first, so the server runs a known version"
  exit 1
fi
REV=$(git rev-parse --short HEAD)
echo "deploying $REV to $HOST"
# No macOS metadata: no ._ files or xattr headers on the server.
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -czf - relay/*.ts worker/mailboxProto.ts | ssh -i "$KEY" "ubuntu@$HOST" "
  set -e
  sudo tar -xzf - -C /opt/spendrr-relay --no-same-owner
  echo $REV | sudo tee /opt/spendrr-relay/REVISION >/dev/null
  sudo systemctl restart spendrr-relay
  sleep 2
  systemctl is-active spendrr-relay
  sudo bash -c 'source /etc/spendrr-relay/env && curl -s -H \"Authorization: Bearer \$RELAY_TOKEN\" http://127.0.0.1:\$PORT/health'
  echo
"
