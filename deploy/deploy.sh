#!/usr/bin/env bash
# Deploy what's on GitHub main to the VM: pull, install, restart, show status.
#   npm run deploy      (MOKRILLION_VM / MOKRILLION_ZONE override the defaults below)
set -euo pipefail
VM=${MOKRILLION_VM:-mo-krillion}
ZONE=${MOKRILLION_ZONE:-us-west1-a}

git fetch -q origin main
if [ -n "$(git log --oneline origin/main..main)" ]; then
  echo "Local main has commits GitHub doesn't. Run git push first." >&2
  exit 1
fi
echo "Deploying $(git log -1 --format='%h %s' origin/main)"

gcloud compute ssh "$VM" --zone "$ZONE" --command '
set -e
sudo -u bot -H bash -c "cd ~/mokrillion && git pull -q --ff-only && npm ci --silent"
sudo systemctl restart mokrillion
sleep 3
if systemctl is-active --quiet mokrillion; then
  echo "Bot is running:"
  sudo journalctl -u mokrillion -n 3 --no-pager -o cat
else
  echo "Bot failed to start:"
  sudo journalctl -u mokrillion -n 30 --no-pager -o cat
  exit 1
fi'
