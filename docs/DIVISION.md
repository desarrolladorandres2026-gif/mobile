# División: roles y permisos del Panel Business

"División" = rediseño de permisos y navegación del Panel Business (2026-10-02). Un solo panel, 4 roles: propietario, administrador, operador, cajero. Decisiones del usuario: manager→Administrador, staff→Operador, Cajero nuevo; invitación pendiente por teléfono (sin correo, no hay proveedor); entrega por fases.

## Hecho (Fase 1, backend) — typecheck y 115+13 tests en verde antes de cortar
- [BusinessStaff.ts](backend/src/models/BusinessStaff.ts): `BusinessRole` OWNER/MANAGER/OPERATOR/CASHIER, ~30 permisos granulares estilo `catalog:edit`, `COUNTER_ROLES`, `normalizeStaffRole` ('staff'→operator al leer), `status` active/pending/suspended, `invitedName/Email`, `acceptedAt`. Exportado en models/index.ts.
- [businessStaff.service.ts](backend/src/services/businessStaff.service.ts) reescrito: `invite` (pending, sin acceso), `respondToInvitation`, `changeRole`, `setSuspended`, `remove` (borra fila), `assertCan` devuelve access y acepta mensaje, `assertBusinessCan` exportado; el administrador solo gestiona operador/cajero (`assertCanGrant`).
- Guardas por permiso (antes "solo dueño"): product.controller (create/edit/delete/change_price), category.controller, coupon.service (promotions view/manage), review.service reply, advertisement service+routes, business.controller (statement/export→settlements:view, analytics→analytics:view, daily-summary→financial:view, logo/cover→business:edit, documentos→documents:manage).
- Rutas nuevas en business.routes.ts: PATCH /:id/staff/:staffId (rol/suspender), GET /my/invitations, POST /my/invitations/:staffId; POST staff ahora crea invitación (roles manager|operator|cashier + name/email opcionales).
- Migración [025-business-roles-v2.ts](backend/src/migrations/025-business-roles-v2.ts) + script `migrate:business-roles-v2` (manual, no urge: el código ya lee 'staff' como operator).
- Tests: businessStaff.test.ts reescrito; nuevo businessRbacEndpoints.test.ts (403 por endpoint).

## Pendiente inmediato (el usuario cortó antes de aplicarlo)
- En businessSecurity.service.ts: `MemberRole` ya ampliado a owner|manager|operator|cashier; FALTA `normalizeStaffRole(s.role)` en `loadMembers` (línea ~134) e importarlo, luego `npm run typecheck`, `npm run lint`, `npm test` completos en backend.
- Verificar que admin/ (BusinessSecurity, types.ts, SecurityGlance) no rompa con los nuevos valores de rol ('operator','cashier'; el viejo 'staff' ya no sale).

## Fase 2 (frontend business/)
- [permissions.ts](business/src/lib/permissions.ts): reflejar los nuevos permisos/roles; NAV_REQUIREMENT hoy usa 'owner' para casi todo → pasar a permisos (menu→catalog:view, promotions→promotions:view, reviews→reviews:view, staff→team:view, settlements→settlements:view, documents→documents:view, settings→settings:view, '/'→ según rol). Añadir "Ventas del turno" para cajero.
- Layout.tsx: header con negocio + nombre + rol; sidebar dinámico (ya usa `canSee`/`homeFor`).
- Equipo ([TeamTab.tsx](business/src/pages/profile/TeamTab.tsx)): tabla Nombre|Rol|Estado|Último acceso|Acciones, invitar (nombre, correo, teléfono, rol), cambiar rol, suspender, eliminar; pantalla para aceptar invitaciones pendientes tras login (GET /my/invitations).
- Frontend en modo lectura para operador en Menú (ocultar crear/editar/precio/eliminar) y respetar 403 con el mensaje del backend. Reglas del usuario: sin cajas/fondos, nunca `text-muted`, lucide, sin emojis; verificar con `npx tsc -b` y `npm run lint`.

## Fase 3 (dashboards por rol)
- daily-summary hoy exige `financial:view` (solo propietario). Falta un resumen con forma por rol: administrador (operativo, sin neto/comisión), operador (pedidos nuevos/preparando/listos/completados), cajero (ventas del turno, métodos de pago, pendientes). Endpoint(s) nuevos o respuesta recortada por permiso; nunca exponer comisión/neto sin `financial:view`.

## Notas / desviaciones a confirmar con el usuario
- Se mantuvo el estilo `catalog:edit` (dos puntos) del código existente, no `catalog.edit`.
- El administrador SÍ tiene `catalog:delete` y `orders:cancel` (la petición no lo listaba); el operador no tiene store:toggle perdido (lo conserva del viejo Mostrador); el cajero no.
- Invitar exige cuenta ZIPP existente con rol BUSINESS (restricción previa); sin cuenta → 404. "Eliminar" borra la fila (pedidos apuntan al User).
- PUT/DELETE /businesses/:id siguen solo-dueño en el servicio (ownerId) a propósito.
- Consultar a zipp-security/zipp-architect/zipp-qa antes de dar por cerrado (hooks lo piden).
