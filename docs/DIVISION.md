# División: roles y permisos del Panel Business

"División" = rediseño de permisos y navegación del Panel Business (2026-10-02). Un solo panel, 4 roles: propietario, administrador, operador, cajero. Decisiones del usuario: manager→Administrador, staff→Operador, Cajero nuevo; invitación pendiente por teléfono (sin correo, no hay proveedor); entrega por fases.

## Hecho (Fase 1, backend) — typecheck y 115+13 tests en verde antes de cortar
- [BusinessStaff.ts](backend/src/models/BusinessStaff.ts): `BusinessRole` OWNER/MANAGER/OPERATOR/CASHIER, ~30 permisos granulares estilo `catalog:edit`, `COUNTER_ROLES`, `normalizeStaffRole` ('staff'→operator al leer), `status` active/pending/suspended, `invitedName/Email`, `acceptedAt`. Exportado en models/index.ts.
- [businessStaff.service.ts](backend/src/services/businessStaff.service.ts) reescrito: `invite` (pending, sin acceso), `respondToInvitation`, `changeRole`, `setSuspended`, `remove` (borra fila), `assertCan` devuelve access y acepta mensaje, `assertBusinessCan` exportado; el administrador solo gestiona operador/cajero (`assertCanGrant`).
- Guardas por permiso (antes "solo dueño"): product.controller (create/edit/delete/change_price), category.controller, coupon.service (promotions view/manage), review.service reply, advertisement service+routes, business.controller (statement/export→settlements:view, analytics→analytics:view, daily-summary→financial:view, logo/cover→business:edit, documentos→documents:manage).
- Rutas nuevas en business.routes.ts: PATCH /:id/staff/:staffId (rol/suspender), GET /my/invitations, POST /my/invitations/:staffId; POST staff ahora crea invitación (roles manager|operator|cashier + name/email opcionales).
- Migración [025-business-roles-v2.ts](backend/src/migrations/025-business-roles-v2.ts) + script `migrate:business-roles-v2` (manual, no urge: el código ya lee 'staff' como operator).
- Tests: businessStaff.test.ts reescrito; nuevo businessRbacEndpoints.test.ts (403 por endpoint).

## Hecho (cierre de Fase 1) — 2026-10-02
- `normalizeStaffRole` ya estaba en `loadMembers` de businessSecurity.service.ts. admin/ (types.ts, labels.ts) pasa a owner|manager|operator|cashier con etiquetas Propietario/Administrador/Operador/Cajero.

## Hecho (Fase 2, frontend business/)
- [permissions.ts](business/src/lib/permissions.ts): permisos granulares, 4 roles, `ROLE_LABELS`, `normalizeRole` ('staff'→operator). NAV_REQUIREMENT por permiso ('/'→orders:view, menu→catalog:view, promotions→promotions:view, advertising→advertising:manage, reviews→reviews:view, staff→team:view, settlements→settlements:view, documents→documents:manage, settings→settings:view).
- Layout: cabecera con negocio + nombre + rol; para el cajero '/' se llama "Ventas del turno". El aviso de documentos solo se consulta con `documents:manage`.
- [PendingInvitations.tsx](business/src/components/PendingInvitations.tsx): invitaciones pendientes arriba de cada página, aceptar/rechazar (GET/POST /my/invitations).
- [TeamTab.tsx](business/src/pages/profile/TeamTab.tsx): tabla Nombre|Rol|Estado|Último acceso|Acciones; invitar (nombre, correo, teléfono, rol), cambiar rol, suspender/reactivar, eliminar/cancelar invitación. El administrador solo reparte operador/cajero (espejo de `assertCanGrant`).
- Menú en modo consulta sin catalog:create/edit/delete; Publicidad no pide facturas sin settlements:view.

## Hecho (Fase 3, dashboards por rol)
- [businessRoleSummary.service.ts](backend/src/services/businessRoleSummary.service.ts) + GET /businesses/:id/role-summary (solo rol BUSINESS): `operations` (analytics:view, sin neto/comisión/descuentos, lista blanca de campos), `shift` (shift:view: ventas del día por medio de pago, pendientes) y `kitchen` (orders:view: cola por estado). Tests: businessRoleSummary.test.ts.
- business/: `pages/Home.tsx` elige DailySummary (financial:view) o `pages/RoleSummary.tsx`.

## Hecho (cierre, commit 78f546c, 2026-10-05)
- Cancelar ya no cuelga de `orders:manage`: `orders:cancel` para un pedido sin cobrar y `orders:cancel_paid` (solo dueño) para uno pagado, porque cancelar emite un reembolso completo (MEDIO 7 de la auditoría del 2026-10-01). Ver order.service.ts.
- `catalog:availability` permite al operador marcar agotado/repuesto sin `catalog:edit`; solo escribe los campos de disponibilidad (product.controller.ts).

## Hecho (cierre de la interfaz, 2026-10-09)
- El personal (administrador, operador, cajero) ya no recibe comisión ni neto de un pedido: `MERCHANT_STAFF_FINANCE_FIELDS` pasa a ser solo `CUSTOMER_FINANCE_FIELDS` y `merchantStaffOrderView` borra también `platformCommission` y `businessPayout` de la raíz (antes solo `driverPayout`, así que esos dos llegaban sin enmascarar). Cambia la decisión anterior de dejarlos "para que el panel no pinte $0". Test: businessStaffOrders.test.ts.
- OrderDetailPanel: "Detalle financiero", "Liquidación" y "Neto" solo con `financial:view`; los demás ven "Cobro al cliente" (venta de productos y total del pedido). Sin `financial:view` tampoco se pide `statement/lines`.
- Menu: el enlace "En promoción" es texto plano sin `promotions:view` (el operador no puede abrir esa sección).

## Hecho (correcciones de la auditoría de seguridad, 2026-10-09)
- **Cancelar (ALTO 1):** el rol BUSINESS —propietario incluido— solo cancela en PENDING/ACCEPTED/PREPARING/READY. En ON_WAY responde 409 `BUSINESS_CANCEL_TOO_LATE`: lo resuelve soporte (aún no existe ese procedimiento). `BUSINESS_CANCELLABLE_STATUSES` en order.service.ts.
- **`orders:cancel_paid` es solo del propietario** (decisión 2026-10-09): se quitó al administrador del modelo, de la UI (Orders.tsx, `ROLE_DESCRIPTIONS`) y de los tests. El administrador global de ZIPP (`UserRole.ADMIN` + `refunds:create`) no cambia.
- **Invitaciones (ALTO 2):** `invite` solo busca cuentas con rol BUSINESS y responde 201 con cuerpo `null` exista o no la cuenta (ya no hay 404 ni fila en la respuesta). `list()` no trae nombre, correo, último acceso ni `userId` de una invitación pendiente; sale `invitedPhone`, lo que escribió quien invitó. Limitador propio `businessStaffInviteRateLimiter` (20/hora por cuenta) en `POST /:id/staff`.
- **Suspensiones (MEDIO 3):** `BusinessStaff.suspendedBy/suspendedByRole`. Lo que suspendió el propietario solo lo levanta el propietario: reactivar, reinvitar y retirar devuelven 403 `SUSPENDED_BY_OWNER`. `setSuspended` es atómico y volver a suspender no cambia el autor. Filas suspendidas antes de este cambio no tienen autor y las puede levantar un administrador.
- **Rastro y avisos (MEDIO 5):** cancelaciones desde el panel → `AuditAction.ORDER_CANCELLED` (actor, papel, motivo); cambios de catálogo → `PRODUCT_PRICE_CHANGED` / `PRODUCT_AVAILABILITY_CHANGED` / `PRODUCT_UPDATED` / `PRODUCT_DELETED` con valores antes/después; si cancela un empleado, el propietario recibe `notifyOwnerOrderCancelledByStaff` (no menciona reembolsos).
- **Promociones (fase 7):** el tope del 90 % de un descuento porcentual de comercio vive en el `pre('validate')` de `Coupon` (`MAX_MERCHANT_PERCENT_DISCOUNT`), así que rige al crear y al editar, por comercio y por admin. Se puede apagar una promoción heredada que ya pasaba del tope, no subirla ni reactivarla.
- **Cancelar un pedido cobrado (P0 financiero):** `payoutService.hold` devuelve a ACCRUED los payouts no reclamados antes de pedir el reembolso, para que un void fallido no deje el pedido cancelado y liquidable.

## Pendiente
- "Turno" = día de Bogotá; no hay modelo de turnos (abrir/cerrar caja). Decidir si el cajero lo necesita.
- Migración 025 es manual: correrla en Atlas cuando convenga (el código ya lee 'staff' como operator).
- Antes de desplegar: `db.coupons.find({fundedBy:'business', type:'percentage', value:{$gt:90}})` para contar promociones heredadas sobre el tope.
- Fuga residual de 1 bit: un teléfono con cuenta de comercio deja una fila pendiente visible en el equipo; uno sin cuenta, no. Cerrarla exige filas "fantasma" por teléfono (cambia el modelo). Decisión pendiente.
- Bajos sin tocar: sockets no excluyen negocios archivados; `discountPrice`/`extras` piden `catalog:edit` y no `catalog:change_price`; reponer stock y reinvitar usan leer→guardar; calificar cliente/domiciliario sigue siendo solo del dueño.
- Soporte: no existe procedimiento para cancelar un pedido ON_WAY. Hasta que exista, lo cancela un admin global con `orders:cancel` (+ `refunds:create` si está pagado).
- Finanzas, con decisión del dueño del producto (ver informe de fase 4): tarifas de Wompi y quién asume el costo de un reembolso; marcar COMPLETED solo tras confirmar el void con el proveedor; cerrojo PENDING sin salida; alcance del tope del 90 % (fijo, admin, plataforma); parciales por ítem.

## Notas / desviaciones a confirmar con el usuario
- Se mantuvo el estilo `catalog:edit` (dos puntos) del código existente, no `catalog.edit`.
- El administrador SÍ tiene `catalog:delete` y `orders:cancel` (la petición no lo listaba); el operador no tiene store:toggle perdido (lo conserva del viejo Mostrador); el cajero no.
- Invitar exige cuenta ZIPP existente con rol BUSINESS; sin cuenta no se crea nada y la respuesta es la misma (ver correcciones del 2026-10-09). "Eliminar" borra la fila (pedidos apuntan al User).
- PUT/DELETE /businesses/:id siguen solo-dueño en el servicio (ownerId) a propósito.
- Consultar a zipp-security/zipp-architect/zipp-qa antes de dar por cerrado (hooks lo piden).
