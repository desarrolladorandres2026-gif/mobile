#!/usr/bin/env bash
# ZIPP · Sonda de salud (la corre cron cada minuto)
#
# Reemplaza el HEALTHCHECK que traía la imagen de Docker: golpea
# /health y, si falla dos veces seguidas, pide a PM2 que reinicie el
# proceso y deja un rastro en el log del sistema (journald / syslog).
#
# /health ya devuelve 503 cuando Mongo está caído, así que un 200 aquí
# significa "el proceso responde Y puede leer la base".

set -uo pipefail

URL="${ZIPP_HEALTH_URL:-http://127.0.0.1:3000/health}"
STATE_FILE=/tmp/zipp-health.fails
MAX_FAILS=2

code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$URL" || echo 000)

if [[ "$code" == "200" ]]; then
  echo 0 > "$STATE_FILE"
  exit 0
fi

fails=$(( $(cat "$STATE_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$fails" > "$STATE_FILE"
logger -t zipp-health "unhealthy: HTTP $code (fallo $fails/$MAX_FAILS)"

if (( fails >= MAX_FAILS )); then
  logger -t zipp-health "reiniciando zipp-api tras $fails fallos"
  pm2 reload zipp-api --update-env >/dev/null 2>&1 \
    || systemctl restart zipp-api  # por si se usa el unit en vez de PM2
  echo 0 > "$STATE_FILE"
fi
