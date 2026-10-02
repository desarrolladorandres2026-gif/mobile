#!/usr/bin/env bash
# ZIPP · Publicar en el VPS desde la máquina de desarrollo
#
#   bash deploy/scripts/publish-from-local.sh all
#   bash deploy/scripts/publish-from-local.sh backend
#   bash deploy/scripts/publish-from-local.sh admin business
#
# Por qué existe además de deploy.sh: el proyecto no vive en ningún remoto
# git, así que deploy.sh no tiene de dónde traer el código. Este script lo
# sube por `tar` sobre SSH desde el checkout local. Cuando haya un remoto,
# clona en /var/www/zipp y usa deploy.sh; este script deja de hacer falta.
#
# Reparto del trabajo, y no es arbitrario:
#
#   • Los tres SPA se compilan AQUÍ. El VPS tiene 1 vCPU y tres `vite build`
#     seguidos lo dejan ocupado varios minutos mientras sirve producción.
#     Al servidor solo sube el `dist/` ya hecho.
#   • El backend se compila ALLÍ. `npm ci` tiene que resolver el binario
#     nativo de argon2 para el Linux del servidor; el que instalaría
#     Windows no sirve.
#
# Se usa `tar` sobre SSH y no rsync porque Git Bash en Windows no trae
# rsync. Dentro del VPS sí está, y deploy.sh lo aprovecha.

set -euo pipefail

VPS_HOST="${ZIPP_VPS_HOST:-root@45.93.100.122}"
SSH_KEY="${ZIPP_SSH_KEY:-$HOME/.ssh/zipp_vps}"
REMOTE_DIR="${ZIPP_REMOTE_DIR:-/var/www/zipp}"

# Raíz de Nginx para cada SPA. Espeja SPA_ROOT en deploy.sh.
declare -A SPA_ROOT=(
  [admin]=/var/www/zipp-admin
  [business]=/var/www/zipp-business
  [web]=/var/www/zipp-web
)

log()  { printf '\n\033[1;36m──> %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
sshv() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$VPS_HOST" "$@"; }

cd "$(dirname "$0")/../.."          # raíz del repo
[[ -f "$SSH_KEY" ]] || die "no encuentro la clave SSH en $SSH_KEY (ZIPP_SSH_KEY la cambia)"
[[ $# -ge 1 ]]      || die "Uso: publish-from-local.sh [all|backend|admin|business|web ...]"

TARGETS=("$@")
[[ "${TARGETS[0]}" == "all" ]] && TARGETS=(backend admin business web)

# Sube un directorio del repo a $REMOTE_DIR conservando su nombre.
# Excluye lo que se regenera en destino (node_modules, dist) y lo que
# NUNCA debe viajar: los .env llevan secretos y el del servidor es otro.
upload_source() {
  local dir="$1"
  tar czf - \
    --exclude='node_modules' --exclude='dist' --exclude='build' \
    --exclude='.env' --exclude='.env.*' --exclude='*.log' --exclude='coverage' \
    "$dir" \
  | sshv "mkdir -p '$REMOTE_DIR' && tar xzf - -C '$REMOTE_DIR' && chown -R zipp:zipp '$REMOTE_DIR/$dir'"
}

publish_backend() {
  log "backend: subiendo código"
  upload_source backend

  log "backend: npm ci + build en el VPS"
  sshv "cd '$REMOTE_DIR/backend' && npm ci --no-audit --no-fund && npm run build && chown -R zipp:zipp '$REMOTE_DIR/backend'"

  log "backend: recargando PM2"
  # `reload` y no `restart`: PM2 levanta el proceso nuevo antes de matar el
  # viejo, así que no hay ventana con la API caída.
  sshv "sudo -u zipp -H bash -lc \"pm2 describe zipp-api >/dev/null 2>&1 \
        && pm2 reload zipp-api --update-env \
        || pm2 start '$REMOTE_DIR/deploy/ecosystem.config.cjs' --env production; pm2 save\""
}

publish_spa() {
  local app="$1" root="${SPA_ROOT[$1]:-}"
  [[ -n "$root" ]] || die "SPA desconocido: $app"
  [[ -f "$app/.env.production" ]] \
    || die "falta $app/.env.production (ver deploy/$app.env.production.example)"

  log "$app: build local"
  ( cd "$app" && npm run build )

  # Nada de `rm -rf` sobre la raíz: dejaba un instante sin index.html y
  # borraba los chunks que las pestañas abiertas (y la app de escritorio,
  # que no recarga sola) siguen pidiendo. El build sube a un dir temporal y
  # swap-spa.sh lo coloca en orden; ver su cabecera.
  log "$app: subiendo build"
  local staging
  staging="$(sshv "mktemp -d /tmp/zipp-$app-XXXXXX")"
  tar czf - -C "$app/dist" . | sshv "tar xzf - -C '$staging'"

  log "$app: publicando en $root"
  tr -d '\r' < deploy/scripts/lib/swap-spa.sh | sshv "bash -s -- '$staging' '$root'"
  sshv "rm -rf '$staging' && chown -R zipp:www-data '$root' && chmod -R a+rX '$root'"
}

for t in "${TARGETS[@]}"; do
  case "$t" in
    backend)            publish_backend ;;
    admin|business|web) publish_spa "$t" ;;
    *)                  die "objetivo no válido: $t" ;;
  esac
done

log "Publicado: ${TARGETS[*]}"
