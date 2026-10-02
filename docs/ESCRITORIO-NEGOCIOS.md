# Zipp Negocios — la app de escritorio

Contenedor de Electron para Windows que carga el panel de comercios (`business/`) ya desplegado en el VPS, pensado para quedarse abierto 24/7 en el PC del mostrador. Plan completo y decisiones del usuario: memoria `zipp-escritorio-negocios-plan` y `zipp-escritorio-fase0-empleados-pedidos`. Este documento es el runbook técnico del paquete `desktop/`.

## Qué es y qué no es

- **Es** un navegador de un solo sitio: `BrowserWindow` que carga `https://comercios.<dominio>` y nada más. El panel sigue siendo el mismo código de `business/`; no hay una versión distinta para escritorio.
- **No empaqueta el panel.** Cada despliegue de `business/` llega a todas las instalaciones sin sacar un `.exe` nuevo — eso solo hace falta cuando cambia el **contenedor** (una actualización de Electron, un ajuste de la bandeja, etc.).
- **No tiene credenciales propias.** El proceso principal nunca ve un token de sesión; cuando necesita que el negocio se cierre antes de salir, se lo pide al panel por el puente y es el panel quien hace el `PATCH` con su propia sesión.

## Arquitectura

```
desktop/
├── src/
│   ├── shared/           lógica pura, sin `electron` — lo que prueba vitest
│   │   ├── navigation.ts     qué se queda dentro / sale al navegador / se bloquea
│   │   ├── bridge.ts         validación de cada mensaje renderer → main
│   │   ├── ticket.ts         validación del comprobante de impresión
│   │   ├── manifest.ts       verificación Ed25519 del manifiesto de actualización
│   │   └── channels.ts       nombres de canal IPC, en un solo sitio
│   ├── main/              proceso principal (Node + Electron)
│   │   ├── index.ts          arranque, instancia única, ciclo de vida
│   │   ├── config.ts         URLs y llave pública, incrustadas en build
│   │   ├── window.ts         la ventana, navegación, user agent
│   │   ├── tray.ts           icono de la bandeja, menú, diálogo de Salir
│   │   ├── ipc.ts            extremo de confianza del puente
│   │   ├── store.ts          ajustes persistidos (JSON en userData)
│   │   ├── autostart.ts      inicio con Windows
│   │   ├── power.ts          bloqueo de suspensión
│   │   ├── printing.ts       comanda silenciosa
│   │   ├── updater.ts        electron-updater + verificación de firma
│   │   └── minVersionGate.ts palanca de emergencia (GET /app/version)
│   └── preload.ts         contextBridge: la única puerta hacia el renderer
├── static/offline.html    pantalla mientras no hay red
├── assets/                iconos (ojo: NO se llama `build/`, ver abajo)
├── scripts/
│   ├── keygen.mjs            genera el par de llaves Ed25519 (una vez)
│   ├── release.mjs           build, firma y publica una versión
│   └── afterPack.js          apaga los fuses de Electron tras empaquetar
└── test/                  pruebas de los módulos de `shared/`
```

**Por qué `assets/` y no `build/`:** el `.gitignore` raíz del repo ignora `build/` globalmente (para los builds de Android/Expo). Si los iconos vivieran ahí, nunca se subirían al repo. `electron-builder.yml` y `tray.ts` apuntan explícitamente a `assets/`.

## La cadena de confianza de las actualizaciones

Dos verificaciones independientes, no una:

1. **electron-updater** descarga el `.exe` y lo compara contra `latest.yml` — el mecanismo normal de la librería, firmado por quien construye el instalador.
2. **Firma Ed25519 propia** (`src/shared/manifest.ts`): antes de instalar, se descarga `release.json` (`{version, file, sha512}`) y `release.json.sig`, y se verifica contra la llave pública incrustada en el build. Comprueba además que la versión es **más nueva** que la actual — nunca instala una versión igual o más vieja, aunque la firma sea válida (eso bloquea un ataque de reproducción con una versión firmada legítimamente en el pasado).

La llave privada la genera `scripts/keygen.mjs` **una sola vez**, en un equipo que no es el VPS, y vive fuera del repo (`%USERPROFILE%\.zipp\update-signing-key.pem` + una copia offline). **Nunca toca el servidor.** Así, un VPS comprometido no basta para empujar un instalador falso a todos los comercios: controla el `latest.yml` y el `.exe`, pero no puede firmar un `release.json` válido sin esa llave.

```bash
node scripts/keygen.mjs
# Guarda la llave PRIVADA fuera del repo. La PÚBLICA va a ZIPP_UPDATE_PUBLIC_KEY_PEM.
```

**Perder la llave privada** significa no poder publicar más actualizaciones firmadas sin reinstalar a mano en cada comercio — de ahí la copia offline.

**Rotar la llave:** `verifySignedManifest` ya acepta una o varias llaves públicas (`config.updatePublicKeys`, desde `ZIPP_UPDATE_PUBLIC_KEY_PEM` con los dos PEM uno tras otro). El procedimiento: generar la llave nueva, publicar una versión con **ambas** llaves públicas incrustadas (firmada todavía con la vieja), y solo cuando esa versión esté instalada en todos los comercios, publicar la siguiente firmando con la nueva y dejando solo esa llave en el build. Ninguna instalación queda varada a mitad de camino.

## Publicar una versión del contenedor

Solo cuando cambia el **código de `desktop/`**, nunca por un deploy de `business/` (eso lo detecta solo el panel vía `/version.json`, ver `business/src/lib/checkForUpdates.ts`).

```bash
export ZIPP_UPDATE_SIGNING_KEY_PATH=~/.zipp/update-signing-key.pem
export ZIPP_PANEL_URL=https://comercios.<dominio>
export ZIPP_API_URL=https://api.<dominio>/api/v1
export ZIPP_UPDATE_FEED_URL=https://descargas.<dominio>/negocios
export ZIPP_UPDATE_PUBLIC_KEY_PEM="$(cat ~/.zipp/update-public-key.pem)"
cd desktop && npm run dist
```

`scripts/release.mjs`: compila, empaqueta con `electron-builder`, firma el manifiesto, sube todo a un directorio de paso en el VPS y lo mueve de forma atómica — **`latest.yml` siempre al final**, para que ningún cliente instalado vea una versión nueva antes de que su `.exe` y su manifiesto firmado ya estén en su sitio. Conserva las 3 últimas versiones y actualiza el alias estable `Zipp-Negocios-Setup.exe` (el que se linkea desde la guía de instalación).

No forma parte de `deploy.sh` ni de ningún CI: es una decisión consciente, como una migración de base de datos.

## Endurecimiento del contenedor

- **Fuses de Electron** (`scripts/afterPack.js`, corre con `electron-builder`): apaga `RunAsNode`, `NODE_OPTIONS` y `--inspect`, y exige que el `.exe` solo cargue su propio `app.asar` firmado — cierra la vía de usar el binario de Electron empaquetado como un LOLBin para correr JavaScript arbitrario.
- **Permisos del navegador:** lista blanca (`geolocation`, portapapeles) en `session.setPermissionRequestHandler`/`setPermissionCheckHandler`. Todo lo demás —cámara, micrófono, notificaciones de sitio— se niega sin preguntar.
- **Descargas** (CSV de liquidaciones, documentos): van a la carpeta Descargas de Windows y avisan con una notificación al terminar.
- **DevTools apagadas** fuera de desarrollo (`devTools: isDev` en `BrowserWindow`) — ni F12 ni Ctrl+Shift+I abren nada en producción.
- **Desinstalar limpia el inicio automático** (`installer.nsh`, `customUnInstall`): borra la entrada que `autostart.ts` escribió en `HKCU\...\Run`. Sin esto, desinstalar deja un valor huérfano que Windows intenta ejecutar en cada inicio de sesión y falla en silencio — no es un riesgo, pero es basura evitable. **Sin verificar en un desinstalador real todavía** (necesita `electron-builder` corriendo en Windows).

## Versión mínima (palanca de emergencia)

`GET /api/v1/app/version?app=business-desktop` (mismo endpoint que ya usan mobile y Zipp Domiciliarios) devuelve `{minSupported, downloadUrl}`, leído de `MIN_BUSINESS_DESKTOP_VERSION` y `BUSINESS_DESKTOP_DOWNLOAD_URL` en el backend. `minVersionGate.ts` lo consulta al arrancar y cada hora; si la versión instalada quedó por debajo, fuerza una comprobación de actualización inmediata en vez de esperar el ciclo normal de 4 horas. El contenedor ya se actualiza solo — esto es solo para el día en que esa vía falle en silencio.

## Reporte de crashes y diagnóstico

El proceso principal nunca tiene sesión, así que no puede llamar él mismo a `POST /telemetry/crash` (requiere `authenticate`). Cuando la ventana se cae (`render-process-gone`) o se congela más de 15 s (`unresponsive`), `window.ts` guarda el reporte en `store.ts` y recarga; al volver a cargar, `business/src/lib/desktop.ts` lo recoge y lo manda con la sesión real, y solo lo borra si el `POST` salió bien. "Enviar diagnóstico" en la bandeja usa el mismo camino con `fatal: false` y las últimas líneas del log de electron-log adjuntas.

`crashReportRateLimiter` (backend) es un limitador propio para esta ruta, separado del de operaciones sensibles — antes compartía cupo con cambiar contraseña, apagar el 2FA y cerrar todas las sesiones, así que un bucle de crash podía agotárselo a la misma persona por rebote.

## Sesión y conexión

- **Fin de sesión real:** `business/src/lib/session.ts` (`endSession`, que dispara `SessionEndedError` — token de refresco expirado o revocado) reporta `session: 'ended'` al contenedor antes de redirigir a `/login`. El main process lo detecta y trae la ventana al frente con una notificación — nadie se queda mirando sin querer una pantalla de login en segundo plano mientras el negocio sigue "Abierto" sin recibir nada. Un **logout manual** (botón "Cerrar sesión") no lo dispara a propósito: es una decisión explícita, no una anomalía que avisar.
- **Conexión caída:** el panel reporta `connection` en cuanto cambia, pero el aviso en la bandeja espera **60 segundos** (`CONNECTION_DOWN_NOTICE_MS`, `main/ipc.ts`) antes de sonar — un parpadeo de red de unos segundos no debe interrumpir a nadie.

## Rollback

No hay un comando de rollback automático. Para volver a una versión anterior: publicar el código de esa versión con un número **mayor** que el actual (`npm version patch` o similar) — la verificación anti-degradación de `manifest.ts` rechazaría, con razón, cualquier intento de publicar un número menor o igual.

## Qué todavía depende de infraestructura que no existe

- **Dominio propio.** Mientras `ZIPP_PANEL_URL` siga apuntando a `sslip.io` o a una IP pelada, no se distribuye el `.exe` a ningún comercio real (ver Fase 0.1 del plan). Se puede desarrollar y probar sin él.
- **`descargas.<dominio>`** con su propio certificado de certbot. El bloque de nginx ya está escrito (`deploy/nginx/downloads.conf`: `latest.yml`/`release.json*` en `no-store`, el `.exe`/`.blockmap` en `immutable`, sin listado de directorio ni fallback de SPA) — falta crear el registro DNS, correr `provision.sh`-style el `mkdir`/`chown` de `/var/www/zipp-downloads/negocios` y pasar `certbot --nginx -d descargas.<dominio>`, exactamente como los demás subdominios en `deploy/README.md`.
- **Certificado Authenticode** a nombre de Zipp S.A.S: hasta entonces, Windows muestra "Windows protegió tu PC" al instalar (se pasa con "Más información → Ejecutar de todas formas"). No afecta a la seguridad de las actualizaciones, que depende solo de la firma Ed25519.

## Lo que falta de QA real

Todo lo de aquí se verificó con `npm run typecheck` + `npm test` (lógica pura, sin Electron) y con el `npm run build` del contenedor. **Nadie ha instalado el `.exe` en un Windows real todavía.** La lista completa de QA manual (instalar con SmartScreen, pantalla completa al reiniciar, bandeja, pedido con la app minimizada, impresión silenciosa, actualización real, etc.) está en el plan aprobado (`~/.claude/plans/busines-exe-instalable-vamos-adaptive-waterfall.md`, sección «Verificación»).

## Decisiones que siguen abiertas

- **"Abierto sin app conectada":** se implementó con un umbral de **15 minutos** y aviso solo al dueño (notificación normal, `NotificationType.SYSTEM`) — una elección razonable, no la que el usuario confirmó explícitamente. Si no sirve, ajustar `PANEL_SEEN_THRESHOLD_MS` en `backend/src/services/businessPresence.service.ts`.
- **Comandas:** cuándo se imprimen (al llegar el pedido o al aceptarlo), cuántas copias, y si el contenido necesita algo más que lo que ya valida `shared/ticket.ts`.
- **Cómo llega el instalador al comercio:** hoy solo existe el alias estable `Zipp-Negocios-Setup.exe` en el VPS; falta decidir si se enlaza desde `business/` (pantalla de Ajustes → "Este equipo" ya tiene el hueco), desde `web/`, o si lo entrega el equipo de ZIPP a mano en el piloto.
- **Antelación del aviso de los 30 días** de tope de sesión (`sessions.ts`): no implementado todavía.
