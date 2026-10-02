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

## Pendiente
- `orders:cancel` está en el modelo pero ningún endpoint lo consulta: cancelar lo decide `orders:manage` + el candado "pedido pagado → solo dueño" en order.service. Decidir si el administrador debe poder cancelar pagados (hoy no) y si operador/cajero deben poder cancelar no pagados (hoy sí).
- Disponibilidad (agotado) pide catalog:edit, así que el operador no puede marcar un plato agotado. Confirmar si debe poder.
- "Turno" = día de Bogotá; no hay modelo de turnos.

## Notas / desviaciones a confirmar con el usuario
- Se mantuvo el estilo `catalog:edit` (dos puntos) del código existente, no `catalog.edit`.
- El administrador SÍ tiene `catalog:delete` y `orders:cancel` (la petición no lo listaba); el operador no tiene store:toggle perdido (lo conserva del viejo Mostrador); el cajero no.
- Invitar exige cuenta ZIPP existente con rol BUSINESS (restricción previa); sin cuenta → 404. "Eliminar" borra la fila (pedidos apuntan al User).
- PUT/DELETE /businesses/:id siguen solo-dueño en el servicio (ownerId) a propósito.
- Consultar a zipp-security/zipp-architect/zipp-qa antes de dar por cerrado (hooks lo piden).
