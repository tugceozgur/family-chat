#!/bin/bash
# Update to the latest code. Usage: cd ~/family-chat && bash deploy/deploy.sh
set -e
cd /home/ubuntu/family-chat
git pull
npm ci --omit=dev
sudo systemctl restart family-chat
sleep 2
curl -fsS http://127.0.0.1:8790/healthz && echo " family chat restarted"
