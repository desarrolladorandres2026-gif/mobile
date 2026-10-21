# API de Lulubiz

API HTTP con JSON para integrar otros sistemas: facturar, vender, consultar existencias, leer informes. Es la misma API que usa la interfaz; no hay una versión aparte.

## Autenticación

Una **clave de API** se crea en la interfaz (Administración, «Claves de API») o con `POST /v1/tenants/{tenantId}/api-keys`. Solo propietario y administrador pueden crearlas.

```
Authorization: Bearer lbk_1a2b3c4d_<secreto de 43 caracteres>
```

- El token completo **se muestra una sola vez**, al crearla. Lulubiz guarda únicamente una huella del secreto: una copia de la base de datos no permite usar ninguna clave. Si se pierde, se revoca y se crea otra.
- Cada clave pertenece a **una empresa** y lleva sus propios **permisos** (columna «Permiso» de la tabla de rutas). Es un subconjunto de los de quien la crea; nunca incluye administrar la empresa, sus miembros ni sus claves, cambiar la configuración de facturación ni reabrir períodos.
- Cada ruta exige su permiso: con uno que falta, `403`. Una clave inexistente, equivocada, vencida, revocada o de otra empresa responde igual, `401 INVALID_CREDENTIALS`, sin decir cuál de los casos fue.
- Una clave puede vencer (fecha opcional, vale hasta el final de ese día) y se revoca al instante. Sigue valiendo aunque quien la creó deje la empresa: es de la empresa, no de la persona.
- Lo que hace una clave queda en la auditoría a nombre de la clave. Hay un máximo de 20 claves activas por empresa.
- Las rutas de sesión (`/v1/auth/*`, `/v1/me`, `/v1/invitations/*`) no admiten claves.
- Una clave en la cabecera `Authorization` tiene prioridad sobre la cookie de sesión. La cookie es para la interfaz y no debe usarse desde otros sistemas.

## Convenciones

**Dinero**: enteros en la unidad menor de la moneda (centavos), nunca decimales. `1.190.000,50 COP` es `119000050`.

**Cantidades**: enteros en milésimas. `1,5` unidades es `1500`.

**Porcentajes**: puntos básicos. `19 %` es `1900`.

**Fechas de calendario**: `AAAA-MM-DD`, sin hora ni zona horaria.

**Idempotencia**: toda operación que crea un documento (facturas, ventas, compras, pagos, ajustes…) exige la cabecera `Idempotency-Key` (8 a 128 caracteres). Repetir la misma clave devuelve el resultado original con `200` y `replayed: true`, sin duplicar nada. Genera una clave por intento de negocio y reutilízala al reintentar tras un error de red.

**Paginación**: las listas devuelven `{ items, nextCursor }`. Para la página siguiente se pasa `?cursor=<nextCursor>`; `?limit=` fija el tamaño dentro del máximo de cada lista.

**Errores**: `{ "error": "CODIGO", "message": "texto" }` con estos estados.

| Estado | Código | Cuándo |
|---|---|---|
| 400 | `VALIDATION` | el cuerpo, los parámetros o una regla de negocio no se cumplen; el mensaje dice cuál |
| 401 | `INVALID_CREDENTIALS`, `INVALID_SESSION` | falta autenticación o es inválida |
| 403 | `FORBIDDEN` | falta el permiso de la ruta |
| 404 | `NOT_FOUND` | no existe en esta empresa |
| 409 | `DUPLICATE`, `INVALID_STATE`, `INSUFFICIENT_STOCK`, `OVER_PAYMENT`, `OVER_CREDIT`, `SETTINGS_INCOMPLETE`, `NO_SHIFT`, `SHIFT_CLOSED`… | el estado actual no permite la operación |
| 429 | | demasiadas peticiones |
| 503 | | servicio ocupado; reintenta tras el tiempo de `Retry-After` |

**Límite de peticiones**: 300 por minuto por dirección IP. Las respuestas `429` traen `Retry-After`.

**Cuerpos**: se validan estrictamente. Un campo desconocido, un texto donde va un número o un número fuera de rango es un `400`; no hay conversión silenciosa.

## Ejemplos

Crear un artículo:

```
POST /v1/tenants/{tenantId}/items
Authorization: Bearer lbk_...
Content-Type: application/json

{ "sku": "TORN-1", "name": "Tornillo 1/2", "type": "goods", "unit": "UND",
  "inventoryAccount": "143505", "cogsAccount": "613505", "price": 25000, "vatBps": 1900 }
```

Emitir una factura de un artículo del inventario (sale del inventario al contabilizarse):

```
POST /v1/tenants/{tenantId}/invoices
Authorization: Bearer lbk_...
Idempotency-Key: pedido-48213
Content-Type: application/json

{ "customerId": "...", "issueDate": "2026-10-21", "paymentMethod": "cash",
  "lines": [{ "description": "Tornillo 1/2", "itemId": "...", "quantity": 4000, "unitPrice": 25000, "vatBps": 1900 }] }
```

La respuesta trae el documento y su estado: `issued` y `accounting.status: "posted"` si todo salió bien; si el proveedor de facturación no respondió, `202` con la factura `pending_provider` (se reintenta con `POST .../invoices/{id}/sync`).

## Rutas

La tabla se genera desde las rutas registradas y una prueba falla si una ruta nueva no aparece aquí o si cambia su permiso. Para actualizarla: `UPDATE_API_DOCS=1 npx vitest run src/http/apiDocs.test.js` en `backend/`. Las rutas con `{tenantId}` cuelgan de `/v1/tenants/{tenantId}`.

<!-- rutas:inicio -->
### Sesión y cuenta (solo con sesión; no admiten claves)

| Método | Ruta | Permiso |
|---|---|---|
| POST | `/v1/auth/register` | pública |
| POST | `/v1/auth/login` | pública |
| POST | `/v1/auth/mfa/verify` | pública |
| POST | `/v1/auth/logout` | sesión |
| GET | `/v1/me` | sesión |
| POST | `/v1/auth/verify-email` | pública |
| POST | `/v1/auth/resend-verification` | sesión |
| POST | `/v1/auth/password/forgot` | pública |
| POST | `/v1/auth/password/reset` | pública |
| POST | `/v1/auth/mfa/enroll` | sesión |
| POST | `/v1/auth/mfa/confirm` | sesión |
| POST | `/v1/auth/mfa/disable` | sesión |
| POST | `/v1/auth/mfa/recovery-codes` | sesión |
| POST | `/v1/invitations/lookup` | pública |
| POST | `/v1/invitations/accept` | sesión |

### Estado del servicio

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/healthz` | pública |
| GET | `/readyz` | pública |
| GET | `/metrics` | token de métricas |

### Plan de cuentas

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/accounts` | `accounts:read` |
| POST | `/v1/tenants/{tenantId}/accounts` | `accounts:manage` |
| POST | `/v1/tenants/{tenantId}/accounts/seed` | `accounts:manage` |
| POST | `/v1/tenants/{tenantId}/accounts/:code/deactivate` | `accounts:manage` |
| POST | `/v1/tenants/{tenantId}/accounts/:code/activate` | `accounts:manage` |

### Centros de costo

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/cost-centers` | `accounts:read` |
| POST | `/v1/tenants/{tenantId}/cost-centers` | `accounts:manage` |
| PATCH | `/v1/tenants/{tenantId}/cost-centers/:code` | `accounts:manage` |

### Conciliación bancaria

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/bank/lines` | `bank:read` |
| POST | `/v1/tenants/{tenantId}/bank/lines` | `bank:manage` |
| DELETE | `/v1/tenants/{tenantId}/bank/lines/:id` | `bank:manage` |
| GET | `/v1/tenants/{tenantId}/bank/lines/:id/candidates` | `bank:read` |
| POST | `/v1/tenants/{tenantId}/bank/lines/:id/book` | `bank:manage` |
| POST | `/v1/tenants/{tenantId}/bank/matches` | `bank:manage` |
| POST | `/v1/tenants/{tenantId}/bank/matches/manual` | `bank:manage` |
| POST | `/v1/tenants/{tenantId}/bank/matches/auto` | `bank:manage` |
| DELETE | `/v1/tenants/{tenantId}/bank/matches/:id` | `bank:manage` |
| GET | `/v1/tenants/{tenantId}/bank/reconciliation` | `bank:read` |
| GET | `/v1/tenants/{tenantId}/bank/reconciliations` | `bank:read` |
| POST | `/v1/tenants/{tenantId}/bank/reconciliations` | `bank:manage` |
| POST | `/v1/tenants/{tenantId}/bank/reconciliations/:id/reopen` | `bank:manage` |

### Cotizaciones

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/quotes` | `invoices:read` |
| POST | `/v1/tenants/{tenantId}/quotes` | `invoices:issue` |
| GET | `/v1/tenants/{tenantId}/quotes/:id` | `invoices:read` |
| POST | `/v1/tenants/{tenantId}/quotes/:id/accept` | `invoices:issue` |
| POST | `/v1/tenants/{tenantId}/quotes/:id/reject` | `invoices:issue` |
| POST | `/v1/tenants/{tenantId}/quotes/:id/void` | `invoices:issue` |
| POST | `/v1/tenants/{tenantId}/quotes/:id/invoice` | `invoices:issue` |

### Órdenes de compra

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/purchase-orders` | `purchases:read` |
| POST | `/v1/tenants/{tenantId}/purchase-orders` | `purchases:create` |
| GET | `/v1/tenants/{tenantId}/purchase-orders/:id` | `purchases:read` |
| POST | `/v1/tenants/{tenantId}/purchase-orders/:id/void` | `purchases:void` |
| POST | `/v1/tenants/{tenantId}/purchase-orders/:id/receive` | `purchases:create` |

### Facturas recurrentes

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/recurring-invoices` | `invoices:read` |
| POST | `/v1/tenants/{tenantId}/recurring-invoices` | `invoices:issue` |
| POST | `/v1/tenants/{tenantId}/recurring-invoices/run` | `invoices:issue` |
| GET | `/v1/tenants/{tenantId}/recurring-invoices/:id` | `invoices:read` |
| PATCH | `/v1/tenants/{tenantId}/recurring-invoices/:id` | `invoices:issue` |
| POST | `/v1/tenants/{tenantId}/recurring-invoices/:id/skip` | `invoices:issue` |

### Terceros

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/parties` | `parties:read` |
| POST | `/v1/tenants/{tenantId}/parties` | `parties:manage` |
| GET | `/v1/tenants/{tenantId}/parties/:id` | `parties:read` |
| PATCH | `/v1/tenants/{tenantId}/parties/:id` | `parties:manage` |
| POST | `/v1/tenants/{tenantId}/parties/:id/active` | `parties:manage` |

### Asientos y saldos

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/journals` | `journals:read` |
| POST | `/v1/tenants/{tenantId}/journals` | `journals:post` |
| GET | `/v1/tenants/{tenantId}/journals/:id` | `journals:read` |
| POST | `/v1/tenants/{tenantId}/journals/:id/reverse` | `journals:reverse` |
| GET | `/v1/tenants/{tenantId}/balances` | `reports:read` |

### Períodos

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/periods` | `journals:read` |
| POST | `/v1/tenants/{tenantId}/periods/:period/close` | `periods:manage` |
| POST | `/v1/tenants/{tenantId}/periods/:period/reopen` | `periods:reopen` |

### Cierre de ejercicio

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/year-end` | `reports:read` |
| GET | `/v1/tenants/{tenantId}/year-end/preview` | `reports:read` |
| POST | `/v1/tenants/{tenantId}/year-end/close` | `periods:manage` |
| POST | `/v1/tenants/{tenantId}/year-end/reopen` | `periods:reopen` |

### Informes

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/reports/trial-balance` | `reports:read` |
| GET | `/v1/tenants/{tenantId}/reports/income-statement` | `reports:read` |
| GET | `/v1/tenants/{tenantId}/reports/balance-sheet` | `reports:read` |
| GET | `/v1/tenants/{tenantId}/reports/general-ledger` | `reports:read` |
| GET | `/v1/tenants/{tenantId}/reports/sales-book` | `reports:read` |
| GET | `/v1/tenants/{tenantId}/reports/purchases-book` | `reports:read` |
| GET | `/v1/tenants/{tenantId}/reports/customer-statement` | `reports:read` |
| GET | `/v1/tenants/{tenantId}/reports/supplier-statement` | `reports:read` |
| GET | `/v1/tenants/{tenantId}/reports/sales-summary` | `reports:read` |
| GET | `/v1/tenants/{tenantId}/reports/cost-center-result` | `reports:read` |
| GET | `/v1/tenants/{tenantId}/reports/party-ledger` | `reports:read` |

### Facturación electrónica

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/invoicing/status` | `invoices:read` |
| GET | `/v1/tenants/{tenantId}/invoicing/settings` | `invoices:read` |
| PUT | `/v1/tenants/{tenantId}/invoicing/settings` | `settings:manage` |
| GET | `/v1/tenants/{tenantId}/invoicing/resolutions` | `invoices:read` |
| POST | `/v1/tenants/{tenantId}/invoicing/resolutions` | `settings:manage` |
| POST | `/v1/tenants/{tenantId}/invoicing/resolutions/:id/deactivate` | `settings:manage` |
| GET | `/v1/tenants/{tenantId}/invoices` | `invoices:read` |
| GET | `/v1/tenants/{tenantId}/invoices/:id` | `invoices:read` |
| POST | `/v1/tenants/{tenantId}/invoices` | `invoices:issue` |
| POST | `/v1/tenants/{tenantId}/invoices/:id/sync` | `invoices:issue` |
| POST | `/v1/tenants/{tenantId}/invoices/:id/account` | `invoices:issue` |
| POST | `/v1/tenants/{tenantId}/invoices/:id/credit-notes` | `invoices:issue` |
| GET | `/v1/tenants/{tenantId}/credit-notes` | `invoices:read` |
| GET | `/v1/tenants/{tenantId}/credit-notes/:id` | `invoices:read` |
| POST | `/v1/tenants/{tenantId}/credit-notes/:id/sync` | `invoices:issue` |
| POST | `/v1/tenants/{tenantId}/credit-notes/:id/account` | `invoices:issue` |

### Anticipos

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/customer-advances` | `invoices:read` |
| GET | `/v1/tenants/{tenantId}/customer-advances/:id` | `invoices:read` |
| POST | `/v1/tenants/{tenantId}/customer-advances` | `receipts:create` |
| POST | `/v1/tenants/{tenantId}/customer-advances/:id/applications` | `receipts:create` |
| POST | `/v1/tenants/{tenantId}/customer-advances/:id/void` | `receipts:void` |
| POST | `/v1/tenants/{tenantId}/customer-advances/applications/:id/void` | `receipts:void` |
| GET | `/v1/tenants/{tenantId}/supplier-advances` | `purchases:read` |
| GET | `/v1/tenants/{tenantId}/supplier-advances/:id` | `purchases:read` |
| POST | `/v1/tenants/{tenantId}/supplier-advances` | `payments:create` |
| POST | `/v1/tenants/{tenantId}/supplier-advances/:id/applications` | `payments:create` |
| POST | `/v1/tenants/{tenantId}/supplier-advances/:id/void` | `payments:void` |
| POST | `/v1/tenants/{tenantId}/supplier-advances/applications/:id/void` | `payments:void` |

### Cartera y recibos de caja

| Método | Ruta | Permiso |
|---|---|---|
| POST | `/v1/tenants/{tenantId}/receipts` | `receipts:create` |
| GET | `/v1/tenants/{tenantId}/receipts` | `invoices:read` |
| GET | `/v1/tenants/{tenantId}/receipts/:id` | `invoices:read` |
| POST | `/v1/tenants/{tenantId}/receipts/:id/void` | `receipts:void` |
| GET | `/v1/tenants/{tenantId}/receivables/aging` | `invoices:read` |
| GET | `/v1/tenants/{tenantId}/receivables/open` | `invoices:read` |

### Compras y pagos

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/purchasing/status` | `purchases:read` |
| POST | `/v1/tenants/{tenantId}/purchases` | `purchases:create` |
| GET | `/v1/tenants/{tenantId}/purchases` | `purchases:read` |
| GET | `/v1/tenants/{tenantId}/purchases/:id` | `purchases:read` |
| POST | `/v1/tenants/{tenantId}/purchases/:id/void` | `purchases:void` |
| POST | `/v1/tenants/{tenantId}/purchases/:id/credit-notes` | `purchases:create` |
| GET | `/v1/tenants/{tenantId}/supplier-notes` | `purchases:read` |
| GET | `/v1/tenants/{tenantId}/supplier-notes/:id` | `purchases:read` |
| POST | `/v1/tenants/{tenantId}/supplier-notes/:id/void` | `purchases:void` |
| POST | `/v1/tenants/{tenantId}/payments` | `payments:create` |
| GET | `/v1/tenants/{tenantId}/payments` | `purchases:read` |
| GET | `/v1/tenants/{tenantId}/payments/:id` | `purchases:read` |
| POST | `/v1/tenants/{tenantId}/payments/:id/void` | `payments:void` |
| GET | `/v1/tenants/{tenantId}/payables/aging` | `purchases:read` |
| GET | `/v1/tenants/{tenantId}/payables/open` | `purchases:read` |

### Inventario

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/items` | `inventory:read` |
| POST | `/v1/tenants/{tenantId}/items` | `inventory:manage` |
| GET | `/v1/tenants/{tenantId}/items/:id` | `inventory:read` |
| PATCH | `/v1/tenants/{tenantId}/items/:id` | `inventory:manage` |
| GET | `/v1/tenants/{tenantId}/warehouses` | `inventory:read` |
| POST | `/v1/tenants/{tenantId}/warehouses` | `inventory:manage` |
| POST | `/v1/tenants/{tenantId}/warehouses/:id/active` | `inventory:manage` |
| GET | `/v1/tenants/{tenantId}/stock` | `inventory:read` |
| GET | `/v1/tenants/{tenantId}/kardex` | `inventory:read` |
| GET | `/v1/tenants/{tenantId}/inventory/valuation` | `inventory:read` |
| GET | `/v1/tenants/{tenantId}/inventory/low-stock` | `inventory:read` |
| POST | `/v1/tenants/{tenantId}/stock/adjustments` | `inventory:adjust` |
| POST | `/v1/tenants/{tenantId}/stock/transfers` | `inventory:adjust` |
| GET | `/v1/tenants/{tenantId}/stock/documents` | `inventory:read` |

### Punto de venta

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/pos/registers` | `pos:read` |
| POST | `/v1/tenants/{tenantId}/pos/registers` | `pos:manage` |
| PATCH | `/v1/tenants/{tenantId}/pos/registers/:id` | `pos:manage` |
| POST | `/v1/tenants/{tenantId}/pos/registers/:id/shifts` | `pos:sell` |
| GET | `/v1/tenants/{tenantId}/pos/shifts` | `pos:read` |
| GET | `/v1/tenants/{tenantId}/pos/shifts/:id` | `pos:read` |
| POST | `/v1/tenants/{tenantId}/pos/shifts/:id/close` | `pos:sell` |
| POST | `/v1/tenants/{tenantId}/pos/sales` | `pos:sell` |
| GET | `/v1/tenants/{tenantId}/pos/sales` | `pos:read` |
| GET | `/v1/tenants/{tenantId}/pos/sales/:id` | `pos:read` |
| POST | `/v1/tenants/{tenantId}/pos/sales/:id/void` | `pos:void` |

### Miembros

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/members` | `users:manage` |
| POST | `/v1/tenants/{tenantId}/members` | `users:manage` |
| PATCH | `/v1/tenants/{tenantId}/members/:userId` | `users:manage` |
| DELETE | `/v1/tenants/{tenantId}/members/:userId` | `users:manage` |

### Claves de API

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/api-keys/scopes` | `apikeys:manage` |
| GET | `/v1/tenants/{tenantId}/api-keys` | `apikeys:manage` |
| POST | `/v1/tenants/{tenantId}/api-keys` | `apikeys:manage` |
| POST | `/v1/tenants/{tenantId}/api-keys/:id/revoke` | `apikeys:manage` |

### Auditoría

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/audit` | `audit:read` |

### Primeros pasos

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/onboarding` | `reports:read` |

<!-- rutas:fin -->

## Límites conocidos

- No hay especificación OpenAPI ni cliente generado: los cuerpos aceptados están en los esquemas de `backend/src/http/app.js`, y un `400` nombra el campo que falla.
- No hay webhooks: para enterarse de un cambio hay que consultar.
- Las claves no se pueden restringir por dirección IP ni tienen cuota propia: comparten el límite de la dirección desde la que llaman.
- Los documentos del simulador de facturación electrónica no tienen validez ante la DIAN (ver `docs/ARQUITECTURA.md`).
