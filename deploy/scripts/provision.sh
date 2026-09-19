#!/usr/bin/env bash
# ZIPP · Aprovisionamiento del VPS (una sola vez, como root)
#
#   ssh root@IP_DEL_VPS
#   # sube o clona el repo primero, luego:
#   bash /var/www/zipp/deploy/scripts/provision.sh
#
# Deja el servidor listo para el primer deploy: Node 22, Nginx, PM2,
# usuario de servicio, cortafuegos y certbot. No compila ni arranca la
# app: de eso se encarga deploy.sh.
#
# Idempotente: se puede volver a correr sin romper nada.

set -euo pipefail

NODE_MAJOR=22
APP_USER=zipp
APP_DIR=/var/www/zipp
LOG_DIR=/var/log/zipp

if [[ $EUID -ne 0 ]]; then
  echo "Corre esto como root (sudo)." >&2
  exit 1
fi

echo "──> Paquetes base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git nginx ufw ca-certificates gnupg rsync

echo "──> Node.js ${NODE_MAJOR}.x (NodeSource)"
if ! command -v node >/dev/null || [[ "$(node -v)" != v${NODE_MAJOR}.* ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node -v && npm -v

echo "──> PM2 global"
npm install -g pm2

echo "──> Redis (caché de lecturas de la API)"
# Solo en loopback y como caché pura: sin persistencia a disco (si se
# reinicia, la API la vuelve a llenar desde Mongo) y con techo de memoria
# que expulsa lo menos usado en vez de fallar al llenarse.
apt-get install -y redis-server
sed -i 's/^#\?\s*bind .*/bind 127.0.0.1 -::1/' /etc/redis/redis.conf
sed -i 's/^#\?\s*maxmemory .*/maxmemory 128mb/' /etc/redis/redis.conf
grep -q '^maxmemory ' /etc/redis/redis.conf || echo 'maxmemory 128mb' >> /etc/redis/redis.conf
sed -i 's/^#\?\s*maxmemory-policy .*/maxmemory-policy allkeys-lru/' /etc/redis/redis.conf
grep -q '^maxmemory-policy ' /etc/redis/redis.conf || echo 'maxmemory-policy allkeys-lru' >> /etc/redis/redis.conf
sed -i 's/^save .*/# &/' /etc/redis/redis.conf
grep -q '^save ""' /etc/redis/redis.conf || echo 'save ""' >> /etc/redis/redis.conf
sed -i 's/^appendonly .*/appendonly no/' /etc/redis/redis.conf
systemctl enable --now redis-server
systemctl restart redis-server
redis-cli ping

echo "──> Usuario de servicio: ${APP_USER}"
if ! id "$APP_USER" >/dev/null 2>&1; then
  # Sin shell de login ni home real: solo corre procesos.
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi

echo "──> Directorios"
mkdir -p "$APP_DIR" "$LOG_DIR"
mkdir -p /var/www/zipp-admin /var/www/zipp-business /var/www/zipp-web
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$LOG_DIR"
# Raíces de los SPA: las escribe `zipp` (deploy.sh corre como ese usuario),
# las lee Nginx (www-data). Dueño zipp, grupo www-data, 755.
chown -R "$APP_USER:www-data" /var/www/zipp-admin /var/www/zipp-business /var/www/zipp-web
chmod 755 /var/www/zipp-admin /var/www/zipp-business /var/www/zipp-web

echo "──> Cortafuegos (UFW)"
ufw allow OpenSSH
ufw allow 'Nginx Full'          # 80 + 443
ufw --force enable
ufw status verbose

echo "──> Nginx: mapa de upgrade para WebSocket"
if [[ -f "$APP_DIR/deploy/nginx/00-websocket-upgrade.conf" ]]; then
  cp "$APP_DIR/deploy/nginx/00-websocket-upgrade.conf" /etc/nginx/conf.d/
  nginx -t && systemctl reload nginx
fi

echo "──> certbot (snap)"
if ! command -v certbot >/dev/null; then
  apt-get install -y snapd
  snap install core && snap refresh core
  snap install --classic certbot
  ln -sf /snap/bin/certbot /usr/bin/certbot
fi

echo "──> Rotación de logs de PM2"
pm2 install pm2-logrotate || true
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true

cat <<'DONE'

──────────────────────────────────────────────────────────────
Aprovisionamiento terminado. Siguiente:

  1. Coloca el repo en /var/www/zipp  (git clone o rsync).
  2. Crea /var/www/zipp/backend/.env  (ver deploy/backend.env.production.example).
  3. Añade la IP de este VPS en MongoDB Atlas → Network Access.
  4. Copia los vhost de Nginx (deploy/nginx/) y lanza certbot por cada dominio.
  5. Ejecuta:  sudo -u zipp bash /var/www/zipp/deploy/scripts/deploy.sh all
  6. Instala el healthcheck:  bash /var/www/zipp/deploy/scripts/install-healthcheck.sh
──────────────────────────────────────────────────────────────
DONE
