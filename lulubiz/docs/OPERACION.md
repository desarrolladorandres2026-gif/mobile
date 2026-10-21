# Lulubiz: operación

Manual para desplegar Lulubiz, vigilarlo, respaldarlo y dar de alta a un cliente piloto. Lo que ya está probado y lo que no se dice en cada sección; al final hay una lista de lo que todavía no existe.

## 1. Qué se necesita

- **Node.js 22** para la API. La interfaz se compila una vez y se sirve como archivos estáticos.
- **MongoDB como conjunto de réplicas** (MongoDB Atlas lo es siempre; uno propio también). Un MongoDB de un solo nodo sin réplica no sirve: toda operación contable es una transacción. Para un cliente real, un clúster de pago (M10 o más): el nivel gratuito no trae copia de seguridad continua ni el almacenamiento que hace falta.
- **Un dominio con HTTPS** delante de la API y la interfaz, **del mismo origen**: la sesión es una cookie `SameSite=Strict` y no hay CORS. Un proxy inverso (Nginx, Caddy, un balanceador) que reenvíe `/v1/*`, `/healthz`, `/readyz` y `/metrics` a la API y sirva `frontend/dist` para el resto, con la ruta de respaldo a `index.html`.
- **Un servidor SMTP** (Brevo, Amazon SES, Google Workspace…): sin él no llegan la verificación del correo, las invitaciones ni la recuperación de contraseña.
- **Un proveedor de facturación electrónica** autorizado por la DIAN para facturar de verdad. Mientras no esté conectado, el sistema solo tiene el simulador y **sus documentos no valen ante la DIAN**. Ver §11.

## 2. Primer despliegue, paso a paso

1. **Atlas**: crea el clúster y un usuario administrador. Anota su URI como `MONGODB_ADMIN_URI`. Permite la dirección IP del servidor de la API.
2. **Genera los secretos** (guárdalos en un gestor de contraseñas, no en el repositorio):
   - `MFA_ENCRYPTION_KEY`: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
   - `APP_DB_PASSWORD`: 16 caracteres o más, al azar.
   - `METRICS_TOKEN`: al azar, si se quiere `/metrics`.
3. **Prepara la base** con credenciales de administración (crea colecciones, índices, el rol de la aplicación y su usuario; es repetible):
   ```
   cd backend
   npm ci
   MONGODB_ADMIN_URI=... APP_DB_PASSWORD=... npm run db:setup
   ```
   El rol de la aplicación solo puede hacer `find` e `insert` sobre el libro de asientos, los movimientos de inventario y la auditoría: ni un error del código ni una credencial filtrada permiten editar o borrar un asiento. Corregir es reversar.
4. **Compila la interfaz**: `cd frontend && npm ci && npm run build`. Sirve la carpeta `dist`.
5. **Arranca la API** con el usuario de la aplicación y las variables de la tabla de abajo: `cd backend && npm start`. En producción, faltar una variable obligatoria impide arrancar (es a propósito).
6. **Comprueba**: `GET /healthz` responde 200 (la API vive) y `GET /readyz` responde 200 (la base responde).
7. **Registra la primera empresa** desde la interfaz y recorre «Primeros pasos» (§9).

## 3. Variables de entorno

| Variable | Obligatoria | Qué es |
|---|---|---|
| `NODE_ENV=production` | sí | cookie `Secure` y sin crear índices al arrancar |
| `MONGODB_URI` | sí | conexión del **usuario de la aplicación** (`authSource=admin`), no la de administración |
| `MONGODB_DB` | no (`lulubiz`) | nombre de la base |
| `ALLOWED_ORIGINS` | sí | orígenes que pueden escribir, separados por coma: el de la interfaz, con `https://` |
| `APP_BASE_URL` | sí | dirección pública, para los enlaces de los correos |
| `MFA_ENCRYPTION_KEY` | sí | clave AES-256 en base64. **Sin ella los dos pasos activados dejan de funcionar** |
| `SMTP_URL`, `MAIL_FROM` | sí | `smtps://usuario:clave@servidor:465` y el remitente |
| `INVOICING_PROVIDER` | para facturar | proveedor real. **`sandbox` no arranca en producción** |
| `ERROR_WEBHOOK_URL` | no | adónde se envían los errores no controlados |
| `METRICS_TOKEN` | no | habilita `/metrics` (con `Authorization: Bearer <token>`) |
| `TRUST_PROXY=true` | no | detrás de un proxy, para que los límites vean la IP real |
| `PORT` | no (`3000`) | puerto de la API |

Sin proveedor configurado en producción, la facturación queda deshabilitada y la interfaz lo explica; el resto funciona.

## 4. Cada despliegue nuevo

1. `git pull`, `npm ci` en `backend` y `frontend`.
2. `npm run db:setup` (repetible; **rota la contraseña** del usuario de la aplicación, así que actualiza `MONGODB_URI` en el mismo paso si lo corres con una contraseña nueva). Crea los índices que falten.
3. `npm run build` en `frontend`.
4. Reinicia la API (envía `SIGTERM`: cierra con calma las peticiones en curso).
5. Comprueba `/healthz` y `/readyz`.

No hay migraciones de datos automáticas. Si un cambio las necesitara, se documenta en su commit y se corre a mano, antes de arrancar.

## 5. Copias de seguridad y restauración

Es lo más importante de esta página: **un software contable sin una restauración probada no tiene copias de seguridad**.

- **Qué respaldar**: la base de datos (todo está ahí) y, **por separado**, `MFA_ENCRYPTION_KEY`. Si se pierde la clave, los dos pasos de todos los usuarios dejan de funcionar y hay que desactivarlos desde la base. Si se guarda junto a la copia de la base, quien robe la copia puede descifrar los secretos de los dos pasos.
- **Cómo**: en Atlas, activa **Cloud Backup** con instantáneas diarias y, para un cliente real, **restauración a un punto en el tiempo** (continuous backup). Define la retención con tu contador: los libros contables se conservan años.
- **Qué garantiza el diseño**: el libro de asientos, los movimientos de inventario y la auditoría solo se agregan; los saldos, consecutivos e inventario se actualizan dentro de la misma transacción que el asiento. Una instantánea de Atlas es consistente entre colecciones, así que restaurarla no deja saldos a medias.
- **Pruébala antes de la primera empresa real y después cada trimestre**: restaura una instantánea en un clúster aparte y corre sobre él el verificador de integridad (§6): `MONGODB_URI=... MONGODB_DB=... npm run verify` en `backend/`. Además, apunta una API de prueba a ese clúster y comprueba que se puede iniciar sesión. Anota la fecha y cuánto tardó.
- **Esto no está probado todavía** con un clúster real de Atlas: las pruebas automáticas usan una base en memoria.

## 6. Verificador de integridad

`npm run verify` (en `backend/`) recalcula, desde lo que no se puede editar (los asientos), lo que el sistema mantiene aparte, y avisa de cualquier diferencia. Solo lee: basta la conexión de la aplicación. Sale con código 1 si algo no cuadra. Con `TENANT_ID=...` revisa una sola empresa.

```
MONGODB_URI=... MONGODB_DB=lulubiz npm run verify
```

Comprueba, por empresa:

1. Los saldos por cuenta y período coinciden con la suma de los asientos.
2. Todo asiento cuadra (débitos iguales a créditos).
3. La numeración de cada serie de asientos es consecutiva, sin saltos ni repetidos.
4. Las existencias coinciden con el kardex y ninguna es negativa.
5. El valor del inventario coincide con el saldo de su cuenta en el libro.
6. Todo documento contabilizado (facturas, notas, recibos, compras, pagos, ventas de mostrador) apunta a un asiento que existe.
7. Los totales de cada turno de caja coinciden con sus ventas.
8. Los ejercicios cerrados tienen sus cuentas de resultados en cero.
9. El saldo de cada anticipo es su importe menos sus aplicaciones vigentes.
10. Los saldos por centro de costo y por tercero coinciden con los asientos.
11. Cada conciliación bancaria vigente une importes iguales de la misma cuenta, y su línea del libro y la del extracto existen.

Cuándo correrlo: **después de restaurar una copia**, antes y después de cada despliegue que toque datos, y como vigilancia (una vez al día, desde un programador de tareas, con la alerta en un código de salida distinto de cero). Una diferencia **no se corrige a mano**: detén el ingreso de datos y revisa la auditoría y los registros para ver qué pasó. Recorre toda la empresa, así que en una base grande tarda; córrelo fuera de las horas de más uso.

No comprueba que la cartera y las cuentas por pagar sumen lo mismo que sus cuentas del libro: un asiento manual sobre esas cuentas es legítimo y las separaría.

## 7. Facturas recurrentes

Las plantillas de facturas recurrentes se pueden generar desde la interfaz («Generar las vencidas»), pero conviene programar la tarea una vez al día para que no dependa de que alguien entre:

```
MONGODB_URI=... MONGODB_DB=lulubiz npm run recurring
```

Emite las facturas vencidas de todas las empresas (`TENANT_ID=...` limita a una). Es segura de repetir: cada período lleva una clave de idempotencia propia. Sale con código 1 si alguna plantilla falló (cliente inactivo, período cerrado, rechazo del proveedor); esa plantilla queda detenida en ese período con su error visible en la pantalla, y las demás siguen. Necesita las mismas variables de entorno que la API (incluido el proveedor de facturación electrónica). No deja evento de auditoría de sesión: las facturas quedan sin usuario.

## 8. Vigilancia

- `GET /healthz` (la API responde) y `GET /readyz` (la base responde): configúralos en tu monitor de disponibilidad, cada minuto.
- `GET /metrics` (con `METRICS_TOKEN`): formato Prometheus, con peticiones y latencias por ruta (por patrón de ruta, no por URL real).
- `ERROR_WEBHOOK_URL`: recibe cada error no controlado (500) y los fallos del proceso. Apúntalo a un canal que alguien lea.
- Alertas mínimas: `readyz` fallando 2 minutos; más de unos pocos 500 por hora; respuestas 503 sostenidas.
- Los registros salen por la salida estándar en JSON, sin cookies ni cabeceras de autorización. Guárdalos donde tu plataforma los conserve.

## 9. Dar de alta un cliente piloto

Lista de verificación, en orden. «Primeros pasos» (Administración) calcula casi todo esto solo y dice qué falta.

**Antes de empezar (tú)**
- [ ] El proveedor de facturación electrónica está conectado y en producción, no el simulador.
- [ ] Un contador del cliente (o el tuyo) revisó el plan de cuentas.
- [ ] El correo SMTP envía de verdad: registra una cuenta de prueba y confirma que llega el enlace.
- [ ] Las copias de seguridad están activas y la restauración se probó.

**Con el cliente**
1. **Crea la empresa** (el propietario se registra y confirma su correo).
2. **Plan de cuentas**: carga el de Colombia y ajústalo con el contador.
3. **Facturación**: datos del emisor (razón social, NIT, régimen, dirección) y cuentas contables (por cobrar, ingresos, IVA por pagar; y proveedores e IVA descontable para compras).
4. **Resoluciones de numeración** de la DIAN: una para facturas y una para notas crédito, con su rango y vigencia.
5. **Importa** clientes, proveedores y artículos desde sus archivos (Administración → Importar).
6. **Saldos iniciales**: los de inventario con «Ajustes y traspasos» (entrada con costo unitario), los demás con asientos manuales. Hazlo en un período que luego se cierre.
7. **Invita** a su contador y a quien venda (rol cajero si usa mostrador). Cada persona con su propio correo.
8. **Punto de venta** (si aplica): crea la caja con sus cuentas de efectivo, tarjeta, faltantes y sobrantes.
9. **Primera factura de prueba** con el proveedor en su entorno de habilitación, antes de facturar de verdad.

**La primera semana**
- Revisa la auditoría y los 500 del registro.
- Con el contador: cuadre de caja, balance de prueba y cartera contra su sistema anterior.
- Antes de cerrar el primer año: «Cierre de ejercicio» con una vista previa; ensáyalo con el contador.

## 10. Incidentes frecuentes

| Síntoma | Causa y salida |
|---|---|
| Una factura queda «emitida» con la contabilización pendiente | El proveedor la validó, pero el asiento falló (período cerrado, cuenta inactiva, sin existencias). La factura **no se pierde**. Corrige la causa y usa «Contabilizar». |
| Una factura queda «pendiente de envío» | El proveedor no respondió. Es idempotente: «Reintentar envío». |
| `409 SHIFT_CLOSED`, `NO_SHIFT` | La caja no tiene turno abierto, o se cerró mientras se vendía. Abre un turno. |
| `409 INSUFFICIENT_STOCK` | No hay existencias suficientes. Revisa «Existencias» y el kardex. |
| `409` al registrar un asiento en un período | El período (o su ejercicio) está cerrado. Reabrirlo requiere permiso y queda en la auditoría. |
| `503` con `Retry-After` | Cola de escritura de una empresa llena: demasiadas operaciones a la vez. Reintenta. Si es sostenido, mira la carga (§11). |
| Una clave de API se filtró | Revócala en Administración → Claves de API: deja de servir al instante. Revisa en la auditoría qué hizo. |
| Un usuario perdió su teléfono de dos pasos | Usa sus códigos de recuperación. Si no los tiene, hay que desactivar sus dos pasos desde la base, tras verificar su identidad. |
| `npm run verify` reporta diferencias, o el balance de prueba o el inventario no cuadran | No debería pasar: es una alerta seria. No corrijas a mano; detén el ingreso de datos y revisa la auditoría y los registros. |

## 11. Lo que todavía no existe

- **Proveedor de facturación electrónica real**: el contrato está definido y probado con un simulador; falta el adaptador de un proveedor concreto.
- **Restauración probada en Atlas** y **medición de carga en Atlas**: lo medido es de un solo nodo local (≈130 asientos por segundo por empresa, estables). El verificador de integridad está probado contra alteraciones simuladas, no contra una base restaurada real.
- **Varias instancias de la API**: el límite de peticiones por IP y el límite de escrituras por empresa viven en la memoria de cada proceso. Con una sola instancia no hay problema; con varias, el límite por IP debe aplicarse también en el proxy o balanceador.
- **Rotación de `MFA_ENCRYPTION_KEY`**: no está implementada. Cambiar la clave invalida los dos pasos activos.
- **Exportación completa de los datos de una empresa** (para entregarlos al cliente que se va) y **borrado definitivo** de una empresa: no existen todavía.
- **Webhooks, OpenAPI y cuotas por clave de API** (ver `API.md`).
- **Alertas y paneles**: hay métricas y un destino de errores, pero ningún panel ni regla de alerta configurados.
