# Lulubiz

Software contable y administrativo. React + Node.js + MongoDB, en JavaScript. Diseño y decisiones: [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md). Investigación de referencia: [docs/INVESTIGACION-SIIGO.md](docs/INVESTIGACION-SIIGO.md). Para integrar otros sistemas: [docs/API.md](docs/API.md) (claves de API, convenciones y rutas). Para desplegar, respaldar y dar de alta un cliente: [docs/OPERACION.md](docs/OPERACION.md).

| Carpeta | Qué es |
|---|---|
| `backend/` | API (Fastify), libro contable con centros de costo, informes, cartera, anticipos, compras, inventario, punto de venta, conciliación bancaria, activos fijos, presupuesto, nómina, documentos comerciales, facturación electrónica, autenticación, auditoría |
| `frontend/` | Interfaz (React 19, Vite, Tailwind 4) |
| `e2e/` | Recorrido completo en un navegador real |

## Probar

Cada paquete es independiente: `npm install` en cada carpeta.

```
cd backend  && npm test       # 736 pruebas (descarga un MongoDB de pruebas la primera vez)
cd frontend && npm test       # 238 pruebas
cd e2e      && npm test       # compila la interfaz y corre el recorrido en Chrome
cd backend  && npm run bench  # medición de rendimiento contra un MongoDB local
```

El recorrido de `e2e` usa el Chrome instalado. En otra máquina: `E2E_CHANNEL=chromium npx playwright install chromium`. Deja capturas de pantalla en `e2e/shots/`.

## Desarrollo local

```
cd backend  && npm start             # API en :3000 (necesita MongoDB con réplica en MONGODB_URI)
cd frontend && npm run dev           # interfaz en :3100, con proxy de /v1 hacia la API
```

La interfaz compila su CSS con la herramienta de línea de comandos de Tailwind (`npm run css` en modo vigilancia, incluido en `npm run dev`).

## Despliegue

1. **Preparar la base de datos**, una vez y en cada despliegue (es repetible), con credenciales de administración:
   ```
   MONGODB_ADMIN_URI=... APP_DB_PASSWORD=<16 caracteres o más> npm run db:setup
   ```
   Crea las colecciones, los índices, el rol `lulubiz_app` y su usuario. Volver a correrlo rota la contraseña.
2. **Arrancar la API** con el usuario de la aplicación (`authSource=admin`) y estas variables. En producción faltar una obligatoria impide arrancar.

| Variable | Obligatoria en producción | Para qué |
|---|---|---|
| `NODE_ENV=production` | sí | cookie `Secure`, sin crear índices al arrancar |
| `MONGODB_URI` | sí | conexión del usuario de la aplicación |
| `MONGODB_DB` | no (`lulubiz`) | nombre de la base |
| `ALLOWED_ORIGINS` | sí | orígenes permitidos para escribir, separados por coma |
| `APP_BASE_URL` | sí | dirección pública, para los enlaces de los correos |
| `MFA_ENCRYPTION_KEY` | sí | clave AES-256 en base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Guárdala: sin ella los dos pasos activados dejan de funcionar** |
| `SMTP_URL`, `MAIL_FROM` | sí | envío de correo (`smtps://usuario:clave@servidor:465`) |
| `ERROR_WEBHOOK_URL` | no | destino de los errores no controlados |
| `METRICS_TOKEN` | no | habilita `/metrics` |
| `TRUST_PROXY` | no | detrás de un balanceador, para que la IP real cuente en los límites: número de saltos (`1`) o lista de CIDR; `true` no se admite en producción |
| `INVOICING_PROVIDER` | sí, para facturar | proveedor de facturación electrónica. Fuera de producción el predeterminado es `sandbox` (documentos sin validez); **`sandbox` no arranca en producción** |
| `PORT` | no (`3000`) | puerto |

3. **Servir la interfaz** compilada (`frontend/dist`) y la API desde el mismo origen: la cookie de sesión es `SameSite=Strict` y no hay CORS.
4. **Vigilar**: `/healthz` (vivo), `/readyz` (la base responde) y `/metrics`.
