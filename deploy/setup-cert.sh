#!/usr/bin/env bash
# Obtain a Let's Encrypt certificate for the gateway with certbot (standalone
# mode, port 80) and set up automatic renewal. Run once on the server:
#
#   sudo ./deploy/setup-cert.sh claude.semafore.co you@example.com
#
# Afterwards certbot's systemd timer renews the certificate twice a day when
# it's due; the deploy hook copies it into ./certs, and the gateway reloads it
# within an hour without a restart. certbot only runs while renewing, so it
# uses no memory the rest of the time.
set -euo pipefail

DOMAIN="${1:?usage: sudo $0 <domain> [email]}"
EMAIL="${2:-}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo." >&2
  exit 1
fi

GW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="$GW_DIR/certs"
HOOK="/etc/letsencrypt/renewal-hooks/deploy/claude-code-gateway.sh"
OLD_HOOK="/etc/letsencrypt/renewal-hooks/deploy/claude-gateway.sh"   # name before the rename
LIVE="/etc/letsencrypt/live/$DOMAIN"

echo "==> Installing certbot"
apt-get update -qq
apt-get install -y -qq certbot

echo "==> Writing deploy hook: $HOOK"
mkdir -p "$(dirname "$HOOK")"
rm -f "$OLD_HOOK"
cat > "$HOOK" <<HOOK_EOF
#!/bin/sh
# Copies the renewed certificate where the gateway container can read it
# (the container runs as uid 1000; Let's Encrypt keys are root-only).
set -e
[ "\$RENEWED_LINEAGE" = "$LIVE" ] || exit 0
install -d -m 700 -o 1000 -g 1000 "$CERT_DIR"
install -m 644 -o 1000 -g 1000 "\$RENEWED_LINEAGE/fullchain.pem" "$CERT_DIR/fullchain.pem"
install -m 600 -o 1000 -g 1000 "\$RENEWED_LINEAGE/privkey.pem" "$CERT_DIR/privkey.pem"
HOOK_EOF
chmod 755 "$HOOK"

echo "==> Requesting certificate for $DOMAIN (port 80 must be open and DNS must point here)"
if [ -n "$EMAIL" ]; then
  EMAIL_ARGS=(--email "$EMAIL")
else
  EMAIL_ARGS=(--register-unsafely-without-email)
fi
certbot certonly --standalone --non-interactive --agree-tos --keep-until-expiring \
  "${EMAIL_ARGS[@]}" -d "$DOMAIN"

echo "==> Copying certificate to $CERT_DIR"
RENEWED_LINEAGE="$LIVE" "$HOOK"

echo "==> Enabling automatic renewal"
systemctl enable --now certbot.timer >/dev/null 2>&1 || true
certbot renew --dry-run --cert-name "$DOMAIN"

echo
echo "Done. Certificate files:"
ls -l "$CERT_DIR"
echo
echo "Start the gateway with:  docker compose up -d --build"
