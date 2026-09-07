#!/usr/bin/env bash
# ZIPP · Despliegue repetible (cada release, como usuario `zipp`)
#
#   sudo -u zipp bash /var/www/zipp/deploy/scripts/deploy.sh all
#   sudo -u zipp bash /var/www/zipp/deploy/scripts/deploy.sh backend
#   sudo -u zipp bash /var/www/zipp/deploy/scripts/deploy.sh admin business
#
# Qué hace:
#   1. Si el VPS tiene un clon con remoto, trae la rama y la deja EXACTA
#      (git reset --hard). Si no, despliega el código que ya está ahí.
#   2. backend  -> npm ci + build + recarga PM2 + verificación de salud.
#   3. cada SPA -> npm ci + build + copia atómica a su raíz de Nginx.
#
# Qué NO hace: tocar .env, migrar la base (eso es un paso manual y
# consciente), ni reiniciar Nginx (solo se recarga si cambió su config).

set -euo pipefail

REPO="${ZIPP_REPO:-/var/www/zipp}"
BRANCH="${ZIPP_BRANCH:-main}"
HEALTH_URL="${ZIPP_HEALTH_URL:-http://127.0.0.1:3000/health}"

# Raíces que sirve Nginx para cada SPA (deben existir, las crea provision.sh).
declare -A SPA_ROOT=(
  [admin]=/var/www/zipp-admin
  [business]=/var/www/zipp-business
  [web]=/var/www/zipp-web
)

log() { printf '\n\033[1;36m──> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ $# -ge 1 ]] || die "Uso: deploy.sh [all|backend|admin|business|web ...]"
TARGETS=("$@")
[[ "${TARGETS[0]}" == "all" ]] && TARGETS=(backend admin business web)

# ── 1. Sincronizar el código ─────────────────────────────────────────
# Solo si el VPS tiene un clon con remoto. El despliegue actual sube el
# código por `publish-from-local.sh` (tar sobre SSH) porque el proyecto no
# vive en ningún remoto git todavía; en ese caso el código YA está en su
# sitio cuando este script arranca y forzar un `git reset` lo borraría.
cd "$REPO"
if git rev-parse --git-dir >/dev/null 2>&1 && git remote get-url origin >/dev/null 2>&1; then
  log "git: $BRANCH @ $REPO"
  git fetch --prune origin
  git reset --hard "origin/$BRANCH"
  git log -1 --oneline
else
  log "sin remoto git: se despliega el código que ya está en $REPO"
fi

# ── 2. Backend ───────────────────────────────────────────────────────
deploy_backend() {
  log "backend: build"
  cd "$REPO/backend"
  npm ci
  # Guarda el build anterior para poder volver atrás sin recompilar.
  [[ -d dist ]] && rm -rf dist.prev && cp -r dist dist.prev
  npm run build

  log "backend: recarga PM2"
  if pm2 describe zipp-api >/dev/null 2>&1; then
    pm2 reload zipp-api --update-env
  else
    pm2 start "$REPO/deploy/ecosystem.config.cjs" --env production
  fi
  pm2 save

  verify_and_maybe_rollback
}

# ─────────────────────────────────────────────────────────────────────
#  DECISIÓN TUYA · verify_and_maybe_rollback()
# ─────────────────────────────────────────────────────────────────────
#  Tras recargar PM2, ¿cómo decidimos que el deploy está sano y qué
#  hacemos si no lo está? Es una decisión de operación, no hay una
#  respuesta única. Considera:
#
#   • /health devuelve 200 solo si Mongo está conectado; 503 si no.
#     Tras un reinicio, reconectar a Atlas puede tardar 2-10 s: hace
#     falta reintentar, no una sola comprobación.
#   • El JSON de /health trae {"database":"connected"|"connecting"|
#     "disconnected"}. ¿Te fías del código 200 o exiges ese campo?
#   • Si NO pasa: ¿rollback automático (rm -rf dist && mv dist.prev
#     dist && pm2 reload) o dejas el proceso caído y avisas a un
#     humano? El rollback automático acorta el incidente pero puede
#     ocultar un bug que el .env nuevo destapó.
#   • ¿Cuántos intentos y cuánto esperas entre ellos antes de rendirte?
#
#  Implementa el cuerpo (~8-12 líneas). Debe terminar con `die "..."`
#  si el deploy no se puede dar por bueno, para que el script falle
#  con código != 0 y cualquier CI lo marque en rojo.
# ─────────────────────────────────────────────────────────────────────
verify_and_maybe_rollback() {
  log "backend: verificación de salud ($HEALTH_URL)"

  # TODO(tú): reintenta /health con espera entre intentos; valida la
  # respuesta como prefieras; en caso de fallo, decide rollback vs.
  # avisar; termina con `die "..."` si no se puede validar.
  #
  # Pistas útiles:
  #   code=$(curl -s -o /tmp/zipp-health.json -w '%{http_code}' "$HEALTH_URL" || true)
  #   grep -q '"database":"connected"' /tmp/zipp-health.json
  #   rollback_backend   # función de abajo, ya lista para usar

  die "verify_and_maybe_rollback() sin implementar — ver el bloque de arriba"
}

# Ya lista: revierte al build anterior si decides usar rollback automático.
rollback_backend() {
  cd "$REPO/backend"
  [[ -d dist.prev ]] || die "no hay dist.prev para revertir"
  rm -rf dist && mv dist.prev dist
  pm2 reload "$REPO/deploy/ecosystem.config.cjs" --env production
  log "backend: revertido al build anterior"
}

# ── 3. Frontends (SPA estáticos) ─────────────────────────────────────
deploy_spa() {
  local app="$1" root="${SPA_ROOT[$1]:-}"
  [[ -n "$root" ]] || die "SPA desconocido: $app"
  [[ -f "$REPO/$app/.env.production" ]] \
    || die "falta $app/.env.production (ver deploy/$app.env.production.example)"

  log "$app: build"
  cd "$REPO/$app"
  npm ci
  npm run build

  # Copia atómica: build en un dir hermano y swap con mv, para que
  # Nginx nunca sirva un dist a medio escribir.
  # Las raíces las creó provision.sh como zipp:www-data (755): zipp escribe
  # su contenido sin sudo y Nginx (www-data) lo lee. No se renombra el
  # propio dir (zipp no puede en /var/www): rsync sincroniza el contenido.
  # --delete-after borra los assets viejos al final, cuando el index.html
  # nuevo ya está en su sitio, para no dejar una ventana con 404.
  log "$app: publicando en $root"
  rsync -a --delete-after --chmod=a+rX dist/ "$root/"
}

# ── Orquestación ─────────────────────────────────────────────────────
for t in "${TARGETS[@]}"; do
  case "$t" in
    backend)            deploy_backend ;;
    admin|business|web) deploy_spa "$t" ;;
    *)                  die "objetivo no válido: $t" ;;
  esac
done

log "Despliegue completo: ${TARGETS[*]}"
