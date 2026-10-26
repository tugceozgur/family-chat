#!/bin/bash
# First-time setup on the AWS server. Usage: bash deploy/setup.sh chat.example.com [you@email]
set -e
DOMAIN="$1"
EMAIL="$2"
[ -z "$DOMAIN" ] && { echo "Usage: bash deploy/setup.sh <subdomain>"; exit 1; }
cd /home/ubuntu/family-chat
npm ci --omit=dev
mkdir -p /home/ubuntu/family-chat-data

if [ ! -f .env ]; then
  echo "Creating .env (edit USERS passwords after this)"
  { echo 'USERS="Serdar:change-me-1,Partner:change-me-2"'; echo "VAPID_SUBJECT=mailto:${EMAIL:-admin@$DOMAIN}"; node scripts/keys.js; } > .env
  chmod 600 .env
fi

sudo cp deploy/family-chat.service /etc/systemd/system/family-chat.service
sudo systemctl daemon-reload
sudo systemctl enable --now family-chat

sed "s/chat.example.com/$DOMAIN/" deploy/nginx.conf | sudo tee /etc/nginx/sites-available/family-chat >/dev/null
sudo ln -sf /etc/nginx/sites-available/family-chat /etc/nginx/sites-enabled/family-chat
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d "$DOMAIN" --redirect --non-interactive --agree-tos ${EMAIL:+-m $EMAIL} ${EMAIL:---register-unsafely-without-email}

sleep 2
curl -fsS http://127.0.0.1:8790/healthz && echo " family chat is up at https://$DOMAIN"
