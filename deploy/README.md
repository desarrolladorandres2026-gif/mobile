# Despliegue de ZIPP en un VPS de Hostinger (KVM, sin Docker)

Runbook para poner ZIPP en producción sobre un **VPS KVM de Hostinger**
con **Node + PM2 + Nginx**, la base de datos en **MongoDB Atlas** y TLS de
**Let's Encrypt**.

> El dominio todavía no existe: en toda esta guía `REEMPLAZAR_DOMINIO` es
> un marcador. Cuando lo compres, un `grep -rl REEMPLAZAR_DOMINIO deploy/`
> te lista los cuatro archivos que hay que editar.

---

## 1. Arquitectura

```
                        Internet
                           │  443 (TLS)
                    ┌──────▼───────┐
                    │    Nginx     │   (VPS Hostinger)
                    └──┬───┬───┬───┘
        static │       │   │   │       proxy_pass 127.0.0.1:3000
   ┌───────────┼───────┘   │   └───────────────┐
   ▼           ▼           ▼                   ▼
zipp-web   zipp-admin  zipp-business     Node · zipp-api
(landing)   (panel)    (comercios)       Express + Socket.IO
                                          │  (PM2, modo fork, 1 instancia)
                                          ▼
                                  MongoDB Atlas (mongodb+srv)
```

| Componente | Origen | Dónde vive en el VPS | Dominio |
|---|---|---|---|
| API + WebSockets | `backend/` → `dist/` | proceso Node en `:3000` | `api.REEMPLAZAR_DOMINIO` |
| Panel admin | `admin/` → `dist/` | `/var/www/zipp-admin` | `panel.REEMPLAZAR_DOMINIO` |
| Portal comercios | `business/` → `dist/` | `/var/www/zipp-business` | `comercios.REEMPLAZAR_DOMINIO` |
| Landing pública | `web/` → `dist/` | `/var/www/zipp-web` | `REEMPLAZAR_DOMINIO` + `www` |
| App móvil (PWA) | `mobile/` | *(opcional)* la sirve el backend | `app.REEMPLAZAR_DOMINIO` |

### Lo que NO va a Hostinger

- **La app móvil nativa** (`mobile/`, Expo): se compila con **EAS Build** y
  se publica en App Store / Play Store. Hostinger no interviene. Lo único
  que la conecta a este despliegue es su URL de API
  (`api.REEMPLAZAR_DOMINIO`) y el esquema de deep link `zipp://`.
- **MongoDB**: gestionado en Atlas, no en el VPS.

---

## 2. Requisitos previos

- **VPS Hostinger KVM** con Ubuntu 22.04 o 24.04. Mínimo realista: **2 vCPU
  / 4 GB RAM** (el build de los tres frontends con Vite es lo que más pide;
  la API en marcha ronda 150 MB). Con 2 GB, compila los frontends en tu
  máquina y sube solo `dist/`.
- Acceso **SSH como root** (Hostinger lo da en hPanel → VPS → SSH).
- Cuentas externas con credenciales a mano:
  - **MongoDB Atlas** (cluster M0 gratis sirve para empezar). Crea el
    cluster en la **misma región que el VPS** (o la más cercana): cada
    consulta es un viaje de ida y vuelta, y una petición autenticada hace
    varios. Cuando el tráfico crezca, el primer salto de velocidad es pasar
    a **M10** (dedicado, sin los topes de rendimiento del compartido) en
    esa misma región; no requiere cambiar código, solo `MONGODB_URI`.
  - **Cloudinary** (imágenes de producto, evidencias de entrega, flyers).
  - **Mapbox** (token público `pk.`) — opcional, degrada con elegancia.
  - **Wompi Colombia** — opcional al inicio; se arranca en `sandbox`.
  - Proveedor de **WhatsApp/Email** para los OTP — opcional al inicio.
- Un **dominio**. Puedes registrarlo en Hostinger o apuntar los
  nameservers de otro registrador. Sin dominio no hay TLS de Let's Encrypt
  (no emite certificados para IP).

---

## 3. Paso a paso

### 3.1 · DNS

En el panel DNS del dominio, crea registros **A** (y **AAAA** si el VPS
tiene IPv6) apuntando a la IP del VPS:

```
@            A     <IP_DEL_VPS>
www          A     <IP_DEL_VPS>
api          A     <IP_DEL_VPS>
panel        A     <IP_DEL_VPS>
comercios    A     <IP_DEL_VPS>
app          A     <IP_DEL_VPS>      # solo si vas a servir la PWA
```

Espera a que propague (`dig +short api.REEMPLAZAR_DOMINIO` devuelve la IP)
antes de lanzar certbot.

### 3.2 · Subir el código al VPS

```bash
ssh root@<IP_DEL_VPS>
mkdir -p /var/www/zipp
# Opción A — clonar (si el repo está en un remoto accesible):
git clone <URL_DEL_REPO> /var/www/zipp
# Opción B — desde tu máquina, sin remoto:
#   rsync -az --exclude node_modules --exclude dist ./ root@<IP>:/var/www/zipp/
```

### 3.3 · Aprovisionar el servidor (una vez)

```bash
bash /var/www/zipp/deploy/scripts/provision.sh
```

Instala Node 22, Nginx, PM2, Redis, `certbot`, crea el usuario de servicio
`zipp`, abre 80/443 en el cortafuegos y copia el `map` de WebSocket a
`/etc/nginx/conf.d/`.

**Redis** queda escuchando solo en `127.0.0.1:6379`, sin persistencia y con
128 MB que expulsan lo menos usado (`allkeys-lru`): es una caché, no una
base de datos. La API lo usa si el `.env` trae
`REDIS_URL=redis://127.0.0.1:6379`; sin esa variable cachea en su propia
memoria, que funciona igual pero se vacía en cada `pm2 reload`. Si Redis se
cae, la API sigue respondiendo desde Mongo (más lento, nunca con error).
Para vaciarlo a mano tras un cambio de datos hecho fuera de la app:
`redis-cli --scan --pattern 'zipp:production:*' | xargs -r redis-cli unlink`.

### 3.4 · MongoDB Atlas

1. Crea el cluster y una **base de datos llamada `zipp`**.
2. **Database Access** → usuario con rol `readWrite` sobre `zipp`.
3. **Network Access** → añade la **IP pública del VPS** (`curl ifconfig.me`
   desde el VPS te la dice). No uses `0.0.0.0/0`.
4. **Connect → Drivers** → copia el string `mongodb+srv://…` y mételo en
   `MONGODB_URI` (paso siguiente), con `/zipp` antes del `?`.

### 3.5 · Configurar el `.env` del backend

```bash
cp /var/www/zipp/backend/.env.example /var/www/zipp/backend/.env
# Edita y sobrescribe lo de deploy/backend.env.production.example:
nano /var/www/zipp/backend/.env
```

Genera los cuatro secretos, **cada uno por separado**:

```bash
for k in JWT_SECRET JWT_REFRESH_SECRET ENCRYPTION_KEY CSRF_SECRET; do
  echo "$k=$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
done
```

Pega el resultado en el `.env`. Pon `NODE_ENV=production` y las tres URLs
de CORS (`CLIENT_URL`, `ADMIN_URL`, `BUSINESS_URL`) con `https://` y el
dominio real. Deja los permisos cerrados:

```bash
chown zipp:zipp /var/www/zipp/backend/.env
chmod 600 /var/www/zipp/backend/.env
```

> Si un secreto es corto, está vacío o `JWT_SECRET == JWT_REFRESH_SECRET`,
> **el servidor no arranca** y te dice cuál falla. Es intencional.

### 3.6 · Configurar el `.env.production` de cada frontend

```bash
cd /var/www/zipp
cp deploy/admin.env.production.example    admin/.env.production
cp deploy/business.env.production.example business/.env.production
cp deploy/web.env.production.example      web/.env.production
# Edita los tres: sustituye REEMPLAZAR_DOMINIO
sed -i 's/REEMPLAZAR_DOMINIO/tudominio.com/' \
  admin/.env.production business/.env.production web/.env.production
```

> Vite **congela** estas variables en el bundle. Si cambian, hay que
> recompilar y volver a publicar `dist/`.

### 3.7 · Primer build y arranque

```bash
sudo -u zipp bash /var/www/zipp/deploy/scripts/deploy.sh all
```

Antes de que funcione del todo tienes que **implementar
`verify_and_maybe_rollback()`** en `deploy/scripts/deploy.sh` — está
marcado con un bloque `DECISIÓN TUYA` y explicado en la sección 4.

Arranque de PM2 en el reinicio del servidor:

```bash
sudo -u zipp pm2 startup systemd -u zipp --hp /home/zipp   # copia y ejecuta lo que imprime
sudo -u zipp pm2 save
```

### 3.8 · Nginx + TLS

```bash
# API
sudo cp /var/www/zipp/deploy/nginx/api.conf \
        /etc/nginx/sites-available/api.REEMPLAZAR_DOMINIO
sudo sed -i 's/REEMPLAZAR_DOMINIO/tudominio.com/' \
        /etc/nginx/sites-available/api.tudominio.com
sudo ln -s /etc/nginx/sites-available/api.tudominio.com /etc/nginx/sites-enabled/

# Los tres SPA, a partir de la plantilla (ver la tabla dentro del archivo)
for pair in "panel.tudominio.com:/var/www/zipp-admin" \
            "comercios.tudominio.com:/var/www/zipp-business" \
            "tudominio.com:/var/www/zipp-web"; do
  sub=${pair%%:*}; root=${pair##*:}
  sudo sed "s/__SUBDOMINIO__/$sub/; s#__RAIZ__#$root#" \
    /var/www/zipp/deploy/nginx/spa.template.conf \
    | sudo tee /etc/nginx/sites-available/$sub >/dev/null
  sudo ln -s /etc/nginx/sites-available/$sub /etc/nginx/sites-enabled/
done

sudo nginx -t && sudo systemctl reload nginx

# Certificados (uno por dominio; la landing lleva apex + www juntos)
sudo certbot --nginx -d api.tudominio.com
sudo certbot --nginx -d panel.tudominio.com
sudo certbot --nginx -d comercios.tudominio.com
sudo certbot --nginx -d tudominio.com -d www.tudominio.com
```

`certbot` inyecta el bloque `:443` y la redirección `80→443`, y deja
programada la renovación (`systemctl list-timers | grep certbot`).

**Después de certbot, activa HTTP/2** en cada bloque `:443` que generó
(`/etc/nginx/sites-available/<dominio>`): con nginx ≥ 1.25.1 añade la línea
`http2 on;` dentro del `server {}` de 443; en versiones anteriores cambia
`listen 443 ssl;` por `listen 443 ssl http2;`. Luego
`sudo nginx -t && sudo systemctl reload nginx`. Sin HTTP/2 el navegador
encola las peticiones del panel de seis en seis.

### 3.9 · Verificación

```bash
curl -s https://api.tudominio.com/health | jq      # status OK, database "connected"
curl -sI https://panel.tudominio.com                # 200, HTML
curl -sI https://comercios.tudominio.com            # 200
curl -sI https://tudominio.com                      # 200
```

- Abre `panel.tudominio.com`, entra con un admin y comprueba que **no
  salta CORS** en la consola del navegador.
- Con las DevTools en la pestaña Network, filtra `socket.io`: el request
  debe terminar en **101 Switching Protocols**, no quedarse en polling.

### 3.10 · Healthcheck automático

```bash
sudo bash /var/www/zipp/deploy/scripts/install-healthcheck.sh
```

Cada minuto golpea `/health`; tras dos fallos seguidos recarga el proceso
y lo registra (`journalctl -t zipp-health`).

---

## 4. Tu decisión: verificación y rollback del backend

`deploy/scripts/deploy.sh` recarga PM2 y luego llama a
`verify_and_maybe_rollback()`, que **tienes que implementar** (~8-12
líneas). No hay una respuesta única y es una decisión de operación:

- `/health` devuelve **200** solo si Mongo está conectado, **503** si no.
  Tras un reinicio, reconectar a Atlas tarda unos segundos → **reintenta**,
  no compruebes una sola vez.
- El JSON trae `{"database":"connected"|"connecting"|"disconnected"}`.
  ¿Te basta el código 200 o exiges ese campo?
- Si **no** pasa: ¿*rollback* automático (`rollback_backend`, ya está
  escrita) o dejas caído y avisas a un humano? El rollback acorta el
  incidente pero puede tapar un bug que solo el `.env` nuevo destapó.
- ¿Cuántos intentos y cuánta espera entre ellos?

La función **debe terminar en `die "..."`** si no puede dar el deploy por
bueno, para que el script salga con código ≠ 0.

---

## 5. Despliegues siguientes

```bash
sudo -u zipp bash /var/www/zipp/deploy/scripts/deploy.sh all
# o parcial:
sudo -u zipp bash /var/www/zipp/deploy/scripts/deploy.sh backend
sudo -u zipp bash /var/www/zipp/deploy/scripts/deploy.sh admin business
```

`deploy.sh` hace `git reset --hard origin/main`: el VPS queda **exacto** a
la rama, sin cambios locales que arrastrar. Publica cada SPA con
`rsync --delete-after`, que sube los assets nuevos antes de borrar los
viejos para que Nginx nunca quede sirviendo un `index.html` que apunta a
archivos que ya no están.

### Migraciones de base de datos

Son un paso **manual y consciente**, nunca dentro de `deploy.sh`:

```bash
cd /var/www/zipp/backend
sudo -u zipp -E npm run migrate:monetisation   # según toque
sudo -u zipp -E npm run migrate:rbac
sudo -u zipp -E npm run migrate:perf-indexes   # 006: índices de pedidos y negocios
```

La 006 solo añade índices (`createIndexes`, no borra nada) y se puede
repetir sin riesgo. Conviene correrla **antes** de desplegar el backend que
los usa: así no se construyen al arrancar con tráfico entrando.

Las miniaturas borrosas incrustadas (2026-09-21) se rellenan **después** de
desplegar, con el mismo cuidado:

```bash
sudo -u zipp -E npm run backfill:image-placeholders -- --dry-run   # cuántas faltan
sudo -u zipp -E npm run backfill:image-placeholders
```

Sin correrlo no se rompe nada: esas fotos siguen sirviendo la miniatura
como URL, como antes. Se puede repetir; solo toca lo que falta.

> **Nunca** ejecutes `npm run seed` en producción: reinicializa datos.

---

## 6. Operación

| Tarea | Comando |
|---|---|
| Logs de la API en vivo | `sudo -u zipp pm2 logs zipp-api` |
| Estado / CPU / RAM | `sudo -u zipp pm2 monit` |
| Reinicio manual | `sudo -u zipp pm2 reload zipp-api` |
| Logs de Nginx | `sudo tail -f /var/log/nginx/{access,error}.log` |
| Log del healthcheck | `journalctl -t zipp-health -f` |
| Renovación TLS (probar) | `sudo certbot renew --dry-run` |

### Copias de seguridad

Atlas M10+ trae backups continuos. En M0/M2/M5 programa un `mongodump`:

```bash
# En el VPS, cron diario (usuario zipp). MONGODB_URI sale del .env.
0 3 * * * cd /var/www/zipp/backend && set -a && . ./.env && set +a && \
  mongodump --uri="$MONGODB_URI" --archive=/var/backups/zipp-$(date +\%F).gz --gzip && \
  find /var/backups -name 'zipp-*.gz' -mtime +14 -delete
```

(`apt-get install -y mongodb-database-tools` para tener `mongodump`.)

### Rotación de secretos

Cambiar `JWT_SECRET` / `JWT_REFRESH_SECRET` en el `.env` y recargar
(`pm2 reload zipp-api`) **invalida todas las sesiones**: todo el mundo
vuelve a iniciar sesión. Hazlo en una ventana de bajo tráfico.

### Actualizar el token de Mapbox

`GET /tracking/config` entrega el token a los clientes, así que basta
editar `MAPBOX_ACCESS_TOKEN` en el `.env` y `pm2 reload` — no hace falta
recompilar nada ni publicar una versión de la app.

---

## 7. Checklist de corte a producción

- [ ] DNS propagado para los 5 subdominios.
- [ ] `provision.sh` ejecutado sin errores.
- [ ] IP del VPS en la allowlist de Atlas (no `0.0.0.0/0`).
- [ ] `backend/.env`: `NODE_ENV=production`, 4 secretos largos y distintos,
      `MONGODB_URI` de Atlas, 3 URLs de CORS con `https://`, `chmod 600`.
- [ ] `TOTP_REQUIRED_ADMINS=true` (2FA obligatorio para admins).
- [ ] `.env.production` de los 3 frontends con el dominio real.
- [ ] `verify_and_maybe_rollback()` implementada.
- [ ] `deploy.sh all` termina en verde.
- [ ] `pm2 save` + `pm2 startup` (sobrevive a un reinicio del VPS).
- [ ] Certificados emitidos para los 5 nombres; `certbot renew --dry-run` OK.
- [ ] `/health` = 200 con `database: connected`.
- [ ] `socket.io` llega a **101** desde el panel (no se queda en polling).
- [ ] Login de admin sin errores de CORS.
- [ ] Healthcheck cron instalado.
- [ ] Backup de Mongo programado (si Atlas no lo cubre).
- [ ] `PAYMENT_PROVIDER`: `sandbox` hasta tener Wompi productivo; luego las
      4 claves `WOMPI_*` y `PAYMENT_PROVIDER=wompi`.
- [ ] App móvil (EAS) apuntando a `https://api.tudominio.com/api/v1`.
