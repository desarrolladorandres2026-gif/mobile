#!/usr/bin/env bash
# Instala la sonda healthcheck.sh como cron de cada minuto para `zipp`.
#
#   sudo bash /var/www/zipp/deploy/scripts/install-healthcheck.sh
set -euo pipefail

SCRIPT=/var/www/zipp/deploy/scripts/healthcheck.sh
CRON_LINE="* * * * * $SCRIPT"

chmod +x "$SCRIPT"

# Reemplaza cualquier línea previa de esta sonda, deja el resto igual.
tmp=$(mktemp)
crontab -u zipp -l 2>/dev/null | grep -vF "$SCRIPT" > "$tmp" || true
echo "$CRON_LINE" >> "$tmp"
crontab -u zipp "$tmp"
rm -f "$tmp"

echo "Cron instalado para el usuario zipp:"
crontab -u zipp -l | grep -F "$SCRIPT"
