# Panel admin — auditoría completa y plan

Fecha: 2026-09-23. Rama: `explore-builder`.

Auditoría de solo lectura de los 27 ítems de la barra lateral del panel admin, más todo lo que el backend tiene y el panel no muestra. La hicieron ocho especialistas en paralelo (comercios, dinero, operación, domiciliarios, seguridad, crecimiento, contenido y una auditoría transversal). La sesión principal contrastó los puntos donde se contradecían.

**Cómo leer este documento**

- Cada hallazgo con `archivo:línea` fue comprobado en el código. Lo que no está comprobado lleva la marca *(inferencia)*.
- Los hallazgos de dinero marcados como *comprobado* se reprodujeron con una prueba contra MongoDB en memoria, fuera del repo.
- Prioridades:
  - **P0**: pierde dinero, expone datos o bloquea la operación.
  - **P1**: esencial para operar.
  - **P2**: mejora.
  - **P3**: opcional.
- Esfuerzo: **S** (horas), **M** (una sesión), **L** (varias sesiones).

**En tres frases**

1. El backend tiene mucho más de lo que el panel enseña: liquidaciones, comisiones, facturas de publicidad, exportes, interruptores, envíos dirigidos, asignación manual de repartidor, chat y llamadas del pedido, verificaciones con selfie, estado de cuenta del comercio, desbloqueo de usuarios y contracargos ya existen en la API y **no tienen pantalla**.
2. Hay fallas de dinero y de seguridad que van antes que cualquier pantalla nueva. Entre ellas: liquidaciones que se pueden duplicar, reembolsos que no se descuentan, la comisión de cada comercio expuesta al público y cargos del equipo que no restringen nada.
3. Faltan tres fichas completas (pedido, comercio y una versión ampliada del cliente) y una capa común (notas internas, línea de tiempo, navegación entre fichas y alertas). Con ellas el panel deja de ser una colección de listas.

---

## 1. Lo urgente

Estas fallas existen hoy, con independencia de cualquier pantalla nueva. Van primero.

### 1.1 Dinero

| # | Problema | Evidencia | Impacto | Arreglo | Esf. |
|---|---|---|---|---|---|
| D1 | **Liquidación doble.** `settle()` hace `find` y luego `updateMany` sin condición de estado | `payout.service.ts:294,368` | Dos clics simultáneos crean dos liquidaciones por los mismos pagos (*comprobado*) | Reclamar los payouts con `updateMany({_id:{$in}, status:PAYABLE, settlementId:null})` y totalizar solo lo reclamado | S |
| D2 | **Un reembolso posterior a la liquidación nunca se descuenta.** `reverse()` solo sube `reversedAmount` en payouts ya liquidados, y `settle()` solo toma `PAYABLE`. Además usa `findOne → save` | `payout.service.ts:209-225` | ZIPP paga íntegro al comercio un pedido que devolvió (*comprobado*) | Arrastrar el reverso como saldo negativo a la siguiente liquidación, con update atómico | M |
| D3 | **El contracargo parcial descuadra el libro.** `allocateRefund` trata todo contracargo como total; el `Refund` queda `PENDING` para siempre y el reintento lo devuelve como si fuera éxito | `refund.service.ts:63,149-151` | `LedgerImbalanceError` y un cerrojo permanente (*comprobado*) | Repartir el contracargo parcial en proporción y no tratar `PENDING` como éxito | M |
| D4 | **El reembolso parcial con Wompi es imposible por API** (Wompi no lo admite) y no existe el tipo "reembolso hecho fuera, en el dashboard de Wompi" | `wompi.provider.ts:476-484` | Soporte no puede devolver una parte del pedido pagado en línea | Nuevo tipo de reembolso externo con referencia de Wompi, sin llamar a la pasarela | M |
| D5 | **Liquidar no escribe nada en el libro mayor.** `PAYOUT_SETTLED` existe y no se usa en ningún sitio | `enums.ts:411` | `MERCHANT_PAYABLE` y `DRIVER_PAYABLE` crecen para siempre; el libro dice que se debe lo ya pagado | Un asiento por payout con `reference = settlementId` y crédito a una cuenta de salida o banco | M |
| D6 | **`settle` sin `businessId` mezcla a todos los comercios** en una liquidación con `businessId: null` y se salta el descuento de publicidad | `finance.validator.ts:63-71` | Liquidación imposible de conciliar | Exigir beneficiario | S |
| D7 | **El ajuste de fondo rotatorio pisa el saldo.** Hace `currentFund = baseFund` con `findById → save`, sin Zod, sin permiso financiero y sin auditoría; el panel manda `parseFloat` | `driver.service.ts:458-465`, `driver.routes.ts:74`, `Drivers.tsx:141` | Borra las reservas de pedidos en curso, y cada entrega posterior infla el fondo | Cambiar solo `baseFund` y aplicar `$inc` por la diferencia, en un update condicionado, entero, con motivo, auditoría y `requireFinanceAdmin` | S |
| D8 | **"Efectivo en calle" suma solo la página visible**, y el filtro de liquidados se hace en el navegador. `markOverdue()` no se llama nunca | `Financials.tsx:169,567`, `cashReconciliation.service.ts:297,360-371` | Con historial dice "No hay efectivo pendiente"; el estado "Vencido" no aparece jamás | Filtrar en el servidor, totalizar en el servidor y programar `markOverdue` | S |
| D9 | **Las zonas cambian el precio sin barrera financiera.** `baseFee`, `perKm` y `surcharge` los edita cualquier admin, sin versión ni auditoría | `zone.routes.ts:17-31`, `Zone.ts:67-69`, `pricing.service.ts:488-490` | Un pedido viejo no se puede explicar con sus reglas; cualquiera sube precios | Versionar zonas como `PlatformPricingConfig` y exigir permiso financiero | M |
| D10 | **La ficha del domiciliario (hecha hoy) lee `DriverDebt`, un modelo muerto desde la migración 001.** La deuda real está en `cashReconciliationService.outstandingFor()` | `driverProfile360.service.ts:183-191`, `cashReconciliation.service.ts:319` | La sección "Deudas pendientes" siempre dice cero | Leer de `CashReconciliation` | S |
| D11 | **Tres cifras distintas de "ingreso".** Dashboard usa `platformCommission`, Resumen diario `platformGrossRevenue` y Finanzas el libro **de todo el histórico**; el selector de periodo solo mueve el GMV. Además: `settledCommissions` siempre vale 0, Dashboard calcula el % de efectivo y la tasa de entrega **sobre 6 pedidos**, y "hoy" usa la hora del servidor | `finance.controller.ts:195`, `Dashboard.tsx:110-118`, `admin.service.ts:25`, `dailySummary.service.ts:136-140`, `order.service.ts:1065` | Decisiones sobre números que no significan lo que dicen | Una sola definición de ingreso sacada del libro, filtrada por periodo y en `America/Bogota` | M |
| D12 | Liberar un cupón devuelve al presupuesto el descuento de Pro | `coupon.service.ts:409` frente a `order.service.ts:500` | Presupuesto de campaña inflado | Devolver solo lo que sumó el cupón | S |
| D13 | Efectivo con reembolso parcial y luego "el resto" fuerza `kind FULL` | `payment.controller.ts:391`, `refund.service.ts:78-94` | Descuadre *(inferencia)* | Acumular lo ya reembolsado por cuenta | M |
| D14 | "Impuestos retenidos · Retención en la fuente" está mal etiquetado: es el impuesto **cobrado** | `Financials.tsx:268-270`, `pricing.service.ts:691` | Lectura contable errónea | Renombrar | S |

### 1.2 Seguridad

| # | Problema | Evidencia | Arreglo | Esf. |
|---|---|---|---|---|
| S1 | **La comisión de cada comercio es pública.** `GET /businesses/:id` y `/slug/:slug` no piden sesión y devuelven el documento entero, con `commissionRate(Bps)` y `ownerId`, sin filtrar `isApproved` | `business.routes.ts:32,35`, `publicCatalog.service.ts:51`, `business.service.ts:341-345` | Proyección pública explícita; ocultar los no aprobados | S |
| S2 | **Un comercio puede leer la publicidad, las facturas y la deuda de otro (IDOR)** | `advertisement.routes.ts:78-110` | Comprobar que quien pregunta es dueño del comercio, más un test | S |
| S3 | **Los cargos no restringen nada.** Los permisos efectivos son la unión del set legacy de `role: admin` con los de los roles asignados, y todo staff nace `role: ADMIN`. Un "agente de soporte" puede bloquear usuarios, cambiar roles, aprobar comercios y exportar datos personales | `authorization.service.ts:63,99-113`, `admin.service.ts:489`, `rbac.ts:127-168` | Ver decisión 1: dejar el `admin` legacy en solo `ADMIN_PANEL` y dar a cada miembro un rol explícito por migración | L |
| S4 | **Unas 60 rutas del panel solo exigen el rol admin.** De 58 permisos del catálogo, 33 no los usa ninguna ruta. Nueve módulos no tienen permiso propio: cupones, zonas, publicidad, reseñas, PQRS, legal, SOS, evidencias e interruptores. `App.tsx` no tiene guardas de ruta y solo 6 ítems de la barra declaran permiso | anexo A | Permiso por módulo en rutas, barra y rutas del panel | L |
| S5 | **El socket no exige 2FA.** Un admin sin TOTP entra en la sala `admin` y recibe la ubicación de toda la flota, los SOS y los pedidos | `sockets/index.ts:43-81`, `emitter.ts:83` | Comprobar TOTP en el handshake | S |
| S6 | **Bloquear o revocar sesiones no desconecta los sockets** en 2 de las 3 vías. Un domiciliario bloqueado sigue emitiendo ubicación y estado | `security.controller.ts:277,326` | `sessionManager.revokeAllSessions()` | S |
| S7 | **Los secretos TOTP antiguos siguen en claro.** La migración 004 no los cifra y `decrypt` devuelve el texto plano | `totp.ts:46-49`, `encryption.ts:105` | Migración que cifre los existentes | S |
| S8 | **Cerrar sesión en el panel no revoca en el servidor.** Los tokens viven en `localStorage`, el staff tiene la misma duración de sesión que un cliente (7 días deslizantes, 30 absolutos) y no hay cierre por inactividad | `admin/src/stores/authStore.ts:85-91`, `env.ts:923-925` | Llamar a `/auth/logout`, TTL de staff de 8 a 12 h, cierre por inactividad | S |
| S9 | **Cualquier admin promueve a admin a otra cuenta** | `admin.service.ts:205-221` | Solo el Super Administrador | S |
| S10 | **Datos que no deben salir y salen:** `tokenHash` de sesiones en la ficha 360 y en seguridad; la contraseña temporal del reset la ve el panel | `userProfile360.service.ts:116`, `security.controller.ts:302`, `admin.service.ts:433` | Quitar de la proyección; reset con enlace de un solo uso | S |
| S11 | **Borrar un comercio es un borrado duro**, sin auditoría ni comprobar pedidos o liquidaciones. `toggle` y `featured` no piden permiso. `updateTerms` aprueba un comercio **sin documentos** y sin `approvedBy` | `admin.service.ts:658-679`, `business.service.ts:205-221` frente a `:131-139` | Archivar en vez de borrar; aprobar solo por la puerta de documentos; auditar todo | M |
| S12 | `revokeUserSessions` no tiene guardas: puede cerrar las sesiones del Super Administrador | `security.controller.ts:322-329` | `assertCanModifyPrivilegedUser` y `assertNotSelfTarget` | S |
| S13 | Anonimizar una cuenta no borra las tarjetas guardadas ni cancela Zipp Pro | `accountDeletion.service.ts:146-151` | Incluirlas en la anonimización | S |
| S14 | Acciones sensibles sin `logAudit`: borrar/activar/destacar comercio, cambio de comisión, fondo rotatorio, CRUD de zonas, interruptores, exportes con datos personales, abrir la ficha 360, revisar selfie y cancelar pedidos como admin | `security` anexo | Auditar cada una | M |
| S15 | El staff de un comercio que no es el dueño no entra en la sala de socket del comercio | `sockets/index.ts:204,226` | Resolver la sala por `BusinessStaff` | S |
| S17 | **El listado público `GET /businesses` también exponía comisión y dueño.** Además, cualquiera destapaba los comercios sin aprobar con `?includeInactive=true` o `?all=true`: el chequeo `req.user?.role === 'admin'` nunca aplicaba, porque la ruta no autentica. Encontrado al adaptar el panel tras corregir S1 | `business.controller.ts:267`, `business.service.ts` (`getAll`) | **Corregido (2026-09-23):** lista blanca de campos en ambos caminos (con y sin coordenadas); la ruta pública nunca incluye inactivos; el panel usa `/admin/businesses`; 2 tests nuevos | S |
| S16 | **Las fotos de cédula, licencia y SOAT de los domiciliarios, y sus selfies de verificación, se guardan con URL pública** en Cloudinary. Son datos sensibles según la Ley 1581, y cualquiera que tenga el enlace los ve. Las evidencias de entrega ya usan el patrón correcto: `type: 'authenticated'` con URL firmada en cada lectura | `driver.service.ts:340`, `driverSecurity.ts:177` frente a `orderEvidence.service.ts:193-240` | Guardar como `authenticated` con `storageKey`, firmar al leer y migrar los existentes (`rename` con `to_type`). Los documentos del comercio (O4) nacen así | M |

### 1.3 Operación

| # | Problema | Evidencia | Arreglo | Esf. |
|---|---|---|---|---|
| O1 | **Pedidos nunca muestra al domiciliario.** `getAllOrders` no hace populate de `driverId`, así que siempre dice "Sin asignar" | `admin.service.ts:709-713`, `Orders.tsx:223,337` | Hacer populate | S |
| O2 | **Nadie se entera de un pedido sin repartidor.** El backend emite `order:dispatch:stalled` y ningún oyente lo recibe. Además `enabled = config.dispatch.enabled \|\| fromPanel`, así que si la variable de entorno está encendida el interruptor **no puede apagar** el reparto | `dispatch.service.ts:389`, `:96` | Bandeja de alertas (§4) y que el interruptor gane sobre la variable | M |
| O3 | **Sala de socket equivocada:** se emite a `user:<Driver._id>` en vez de `user:<User._id>`, así que el repartidor no recibe en vivo la asignación ni la cancelación por esa vía | `order.controller.ts:208,271` frente a `sockets/index.ts:112` | Usar el `userId` del Driver, como ya hace `orderFlow.controller.ts:470` | S |
| O4 | **Un comercio real no puede darse de alta.** Ninguna app llama a `POST /businesses/:id/documents`, así que la cola de "Verificar comercios" solo se llena con el seed | grep en `business/`, `mobile/`, `web/` | Subida de documentos en el panel del comercio | M |
| O5 | **Las selfies de verificación del domiciliario nunca se revisan.** El móvil las envía y la cola y la revisión existen en backend, pero no hay pantalla | `driver.routes.ts:75-77`, `mobile/services/endpoints.ts:1041` | Pantalla de revisión (§3.4) | S |
| O6 | Rechazar un documento de domiciliario no pide motivo, y él reintenta a ciegas | `driver.routes.ts:80` | `rejectionReason` obligatorio, visible en la app | S |
| O7 | **Las PQRS no controlan el plazo legal** (Ley 1480: 15 días hábiles; Ley 1581: 10 para consultas y 15 para reclamos). Dos pantallas responden el mismo ticket por rutas distintas: Soporte, con SLA y asignación, y Legal, sin ellos | `support.service.ts:26-31`, `LegalOps.tsx`, `Legal.ts:33` | Plazo legal propio y una sola cola (§3.2) | M |
| O8 | El panel muestra `#_id.slice(-8)` pero busca por `orderNumber`: el operador no encuentra el número que ve en pantalla | `Orders.tsx:212,278`, `admin.service.ts:705` | Mostrar `orderNumber` | S |
| O9 | **Siete páginas muestran un error o un 429 como pantalla vacía** ("no tienes datos"). Verificar y liquidar efectivo fallan sin avisar | `services/api.ts:50-88`, `Financials.tsx:177,186`, anexo B | Tratar el 429 en el interceptor y mostrar el error en cada página | S |
| O10 | La búsqueda global y la campana de la barra superior son decorativas: no hacen nada | `Layout.tsx:227-233,243-248` | Construirlas (§4) o quitarlas | — |
| O11 | Los pedidos programados solo se activan con el reparto automático encendido | `dispatch.service.ts` ~637-654 (hallazgo del 2026-09-18, *no revalidado*) | Revalidar | S |

---

## 2. Barra lateral propuesta

Hoy las categorías son restos de plantilla (MENU, APPS, CUSTOM, COMPONENTS). Los clientes viven dentro de "Seguridad y acceso" y Finanzas dentro de "Components". Propuesta por dominio (★ = nuevo, cada ítem con su permiso):

- **Operación**: Dashboard · Resumen diario · Pedidos · Flota en vivo · Evidencias · Zonas · ★Sin repartidor
- **Soporte y legal**: Soporte (bandeja única de PQRS) · Incidentes y SOS · ★Datos personales (Ley 1581) · ★Documentos legales
- **Comercios**: Negocios (con ficha) · Verificar comercios · Reseñas
- **Domiciliarios**: Domiciliarios (con ficha) · ★Altas y verificaciones (embudo + documentos + selfie)
- **Clientes**: ★Clientes (hoy es un filtro de Usuarios) · ★Zipp Pro
- **Dinero**: Finanzas · Tarifas y precios · ★Liquidaciones · ★Comisiones · ★Reembolsos y contracargos · ★Pagos (Wompi) · ★Efectivo · ★Facturas y comprobantes · ★Exportes
- **Crecimiento**: Cupones · Publicidad · ★Envíos dirigidos · ★Referidos
- **Contenido de la app**: Constructor de Explorar (luego también Inicio) · Banners · Categorías · Bloques curados · Búsquedas · ★Colecciones
- **Equipo y sistema**: Equipo (staff) · Cargos · Roles · Seguridad · ★Interruptores · ★Salud de la app

---

## 3. Ítem por ítem

### 3.1 Operación

**Dashboard.** Hoy tiene KPIs del día, un gráfico de ingresos y refresco por socket.

Le falta:
- `[P1]` Bloque de alertas: SOS activos, pedidos sin repartidor, PQRS vencidas, efectivo vencido. `incidentCenter.service` ya los calcula — S.
- `[P1]` Cifras reales (D11) — S.
- `[P2]` Tiempos por etapa (aceptar, preparar, recoger, entregar) — M.
- `[P2]` Cancelaciones por actor; `Order.cancelledBy` ya existe — S.
- `[P2]` Cobertura de flota por zona — M.

**Resumen diario.** Es la pantalla más completa del panel.

Le falta:
- `[P2]` Corte por zona y municipio — M.
- `[P3]` Exportar a PDF o Excel — S.
- Arrastra la hora del servidor (D11).

**Pedidos.** Hoy tiene lista por estado, búsqueda por número, un modal con `RefundPanel` y un enlace a Evidencias. Le falta la **ficha 360 del pedido** (§4.1) y además:
- `[P0]` O1 y O8.
- `[P0]` Asignar, desasignar y reasignar repartidor. El backend existe (`PATCH /orders/:id/assign-driver`, `order.routes.ts:91`) pero no tiene pantalla — S/M.
- `[P0]` Cancelar con motivo del catálogo (`Order.cancellationCode`, `cancelledBy`), con auditoría. Hay que confirmar si `PATCH /orders/:id/status` ya lo permite al admin — M.
- `[P1]` Filtros por fecha y ciudad (el backend ya acepta `dateFrom`, `dateTo` y `city`); búsqueda por cliente, comercio o teléfono — S.
- `[P1]` Libro del pedido (`GET /finance/ledger/orders/:orderId`), recibo (`GET /orders/:id/receipt`), chat y llamadas (`/orders/:id/chat|calls`), ofertas de despacho, reseña y PQRS ligadas — M.
- `[P1]` Reenviar notificación y contactar a las partes — M.
- `[P1]` Actualización en vivo por socket; hoy solo la tienen Dashboard, Flota e Incidentes — S.
- `[P2]` Exportar CSV (`/admin/exports/orders` existe) — S.

**Evidencias.** Tiene galería con filtros y el expediente de seguridad del pedido.

Le falta:
- `[P2]` Filtro por comercio o domiciliario; el backend ya lo acepta — S.
- `[P2]` Paginar la bitácora, hoy cortada en 100 eventos (`admin.controller.ts:429-431`) — S.
- `[P3]` Exportar el expediente como PDF o ZIP para un caso legal — M.

**Flota en vivo.** Tiene mapa en vivo, estado de cada repartidor, marca de "sin señal" y pedido activo.

Le falta:
- `[P0]` Señal de GPS falso o velocidad imposible. `checkMockLocation` y `checkLocationVelocity` ya la calculan y se pierde — M.
- `[P1]` Abrir la ficha del domiciliario al tocar el marcador; hoy solo centra el mapa — S.
- `[P1]` Cobertura por zona: disponibles frente a pedidos activos — M.
- `[P2]` SOS como pin en el mapa — S.
- `[P2]` Filtros por zona y vehículo — S.
- `[P2]` Recorrido de un pedido en disputa (`DriverLocation`, con TTL) — M.
- `[P3]` Agrupar marcadores cuando la flota sea grande.

**Zonas.** Tiene CRUD de polígonos con tarifas.

Le falta:
- `[P0]` D9.
- `[P1]` Catálogo de municipios; hoy `city` es texto libre con "Garzón" por defecto y fragmenta los reportes — S.
- `[P2]` Horario de cobertura por zona — M.
- `[P2]` Métricas por zona — M.

### 3.2 Soporte y legal

**Soporte + Legal y PQRS → una sola bandeja.** Hoy Soporte tiene cola con SLA en horas, asignación, métricas y cierre; Legal tiene una tabla plana de PQRS más las solicitudes de datos personales.

Le falta:
- `[P0]` Plazo legal en días hábiles, aparte del SLA operativo, con alerta de vencimiento (O7) — M.
- `[P0]` Una sola cola; Legal deja de responder PQRS por su cuenta — S.
- `[P1]` Mostrar el pedido, comercio y domiciliario del caso. `Pqrs.orderId` existe; `businessId` y `driverId` no — S/M.
- `[P1]` Que comercios y domiciliarios también puedan abrir casos; hoy solo el cliente — M.
- `[P1]` Respuestas predefinidas (macros) — S.
- `[P1]` Abrir la ficha 360 del cliente desde el ticket — S.
- `[P1]` Clasificar (`/pqrs/:id/classify` existe y no tiene pantalla) — S.
- `[P2]` Respuesta formal en PDF — M.

**Datos personales (Ley 1581).** Hoy se resuelven solicitudes dentro de Legal.

Le falta:
- `[P1]` Plazo por tipo de solicitud — S.
- `[P1]` Que anonimizar exija un permiso propio (hoy basta con ser admin, `legal.routes.ts:5`) — S.
- Ver S13.

**Documentos legales.** No existe pantalla.

Le falta:
- `[P1]` Publicar y versionar términos, privacidad y tratamiento de datos (`LegalDocument`), y ver quién aceptó qué versión (`LegalAcceptance`). Hoy solo los carga el seed — M.

**Incidentes.** Tiene una cola unificada (SOS, fraude, efectivo, reclamos, pedidos detenidos) y el panel de SOS en vivo.

Le falta:
- `[P1]` Acciones sobre el pedido detenido (asignar o cancelar) — M.
- `[P1]` Resolver alertas de fraude; `/security/fraud-alerts/:id/resolve` existe sin botón — S.
- `[P2]` Filtros y búsqueda — S.
- `[P2]` Historial de SOS (`/sos/history` sin pantalla) — S.
- Hay que confirmar que las alertas `PROMOTION_ABUSE` de referidos aparecen aquí.

### 3.3 Comercios

**Negocios.** Hoy tiene lista con búsqueda y categoría, alta manual, comisión, activar, destacar y borrar. **No hay ficha**: ningún clic lleva a más detalle. Le falta la **ficha 360 del comercio** (§4.2) y además:
- `[P0]` S1 y S11.
- `[P0]` Datos legales y tributarios estructurados: NIT, DV, razón social, representante legal, régimen y correo de facturación. Hoy solo hay archivos subidos — M.
- `[P0]` Cuenta bancaria o Nequi estructurada para liquidar: banco, tipo, número y titular. Hoy es un PDF — M.
- `[P1]` Historial de cambios de comisión (quién, cuándo, de qué a qué) — M.
- `[P1]` Filtro por ciudad — S.

**Verificar comercios.** Hoy tiene una cola con documentos faltantes, revisión por documento y aprobación con puerta.

Le falta:
- `[P0]` O4.
- `[P1]` Ver vencimientos (`BusinessDocument.expiresAt`) y avisar — S.
- `[P1]` Suspender por documento vencido, con motivo — M.
- `[P2]` Motivo de rechazo visible para el comercio — S.
- `[P2]` Búsqueda y orden — S.
- `[P3]` Historial de rechazos; hoy se sobrescribe por el índice único — M.

**Reseñas.** Hoy permite moderar: ocultar con motivo o restaurar.

Le falta:
- `[P1]` Filtro por comercio y por domiciliario, enlazado desde sus fichas — S.
- `[P2]` Ver las calificaciones que dan el comercio y el domiciliario al cliente — S.
- `[P2]` Paginación — S.
- `[P3]` Métricas de moderación — S.
- Quitar las cajas (`ReviewModeration.tsx:207,218`).

### 3.4 Domiciliarios

**Domiciliarios.** Tiene ficha 360 desde hoy.

Le falta:
- `[P0]` D7 y D10.
- `[P1]` Marcar como cobrada una deuda de efectivo: por `CashReconciliation`, verificar **con referencia y comprobante obligatorios** y luego liquidar, con transición atómica y `requireFinanceAdmin` — M.
- `[P1]` Cambiar vehículo o placa, pidiendo nuevo SOAT y tarjeta de propiedad — M.
- `[P1]` Datos de pago estructurados (banco o Nequi) y registro de **quién ejecutó el pago, por qué medio y cuándo** — M.
- `[P2]` Tasa de aceptación y rechazo de ofertas (`DriverOffer`) — M.
- `[P2]` Historial de conexiones o turnos. No existe; habría que modelarlo — M.
- `[P2]` Notas internas (§4) — S.
- `[P3]` Avisos masivos a domiciliarios — S.

**Altas y verificaciones (fusiona "Documentos").** Hoy hay una cola de documentos con foto.

Le falta:
- `[P0]` El embudo invisible: registrado sin perfil, sin documentos, o con todo rechazado y sin reenvío — M.
- `[P1]` Selfies de verificación (O5) — S.
- `[P1]` Motivo de rechazo (O6) — S.
- `[P2]` Asignación por revisor — S.
- `[P3]` Exportar para auditoría — S.

### 3.5 Clientes

**Clientes (hoy dentro de Usuarios).** La ficha 360 existe y cubre pedidos, pagos, reseñas, PQRS, riesgo, sesiones y auditoría.

Le falta (todo `[P1]` y S, salvo donde se indica):
- Direcciones.
- Tarjetas guardadas, solo enmascaradas: marca, 4 últimos y vencimiento.
- Zipp Pro.
- Consentimientos de marketing y aceptaciones legales con versión.
- Solicitudes de datos con plazo.
- Motivo, autor y fecha del bloqueo; hoy el log muestra lo que el usuario **hizo**, no lo que se le hizo.
- Dispositivos y "cerrar todas las sesiones".
- Reembolsos, contracargos y cupones canjeados.
- Auditar quién abrió la ficha.
- Desbloquear (`/security/unblock-user/:id` existe).
- Notificaciones push recibidas — `[P2]`.
- Referidos — `[P2]`.
- Favoritos — `[P2]`.
- Cupones PTS aún vivos — `[P2]`.

**Lo que soporte NO debe ver:**
- `tokenHash` (S10).
- Cédula completa: solo los 4 últimos dígitos.
- Fecha de nacimiento: solo "+18 sí/no".
- IP y geolocalización de sesiones: solo seguridad.
- `Payment.metadata` crudo.
- Identificadores de pasarela y de OAuth.
- Dirección exacta sin un pedido activo.

Propuesta: dos vistas. Soporte, enmascarada; Seguridad, completa y auditada.

**Zipp Pro.** No hay nada en admin; `pro.routes.ts:10` es solo para clientes.

Le falta:
- `[P1]` Suscriptores activos, cobros, renovaciones fallidas, cancelar o reembolsar membresía, e ingreso frente a coste del beneficio — M.

Espera a que se resuelva el `TODO(negocio)` de `config/pro.ts`.

### 3.6 Dinero

**Finanzas.** Hoy tiene semáforo de libro cuadrado, KPIs, pasivos, incidencias y conciliación de efectivo.

Le falta:
- `[P0]` D8, D11 y D14.
- `[P1]` Filtrar el libro por periodo, zona y comercio — S.
- `[P1]` Etiquetas de `errand_advance_payable` y `loyalty_payable` — S.
- `[P1]` Conciliaciones útiles que sustituyan al semáforo:
  - payouts pendientes frente a `MERCHANT_PAYABLE`;
  - efectivo frente a `CASH_IN_TRANSIT`;
  - `RECEIVABLE` de pedidos cerrados, que debería ser 0.

  Esfuerzo M.
- `[P1]` Margen con Wompi, Pro y publicidad — M.
- `[P2]` Cierre de periodo: bloquear, exportar y firmar el mes — L.

**Tarifas y precios.** Hoy tiene 24 campos versionados con motivo e historial.

Le falta:
- `[P1]` El campo `maxDriverCashDebt` — S.
- `[P1]` Simulador de pedido con **todos** los costes, Wompi por método incluido — M.
- `[P2]` Mostrar el antes y después de cada versión (`changes` ya llega) — S.
- `[P3]` `freeRadiusMeters` aparece con signo `$`; las categorías están fijas en 5.

**★Liquidaciones.** `GET/POST /finance/settlements` existen sin pantalla.

Hace falta:
- `[P0]` Arreglar antes D1, D2, D5 y D6.
- `[P0]` Pantalla para ejecutar liquidaciones por comercio y por domiciliario, con historial, estado de cuenta, descuento de publicidad y referencia de pago — M.

**★Comisiones.** `GET /admin/commissions` existe sin pantalla.

Hace falta:
- `[P1]` Pantalla — S.
- Arreglar que `Commission` nunca pasa a `SETTLED`.

**★Reembolsos y contracargos.**

Hace falta:
- `[P0]` D3 y D4.
- `[P0]` Botón de contracargo (`POST /payments/orders/:id/chargeback` existe) — S.
- `[P1]` Bandeja de reembolsos pendientes o fallidos y contracargos por disputar, con plazos — M.

**★Pagos (Wompi).**

Hace falta:
- `[P1]` Listado de pagos por estado y método — M.
- `[P1]` Conciliación diaria de pagos cobrados frente a desembolsos de Wompi — M.
- `[P1]` Registrar la comisión de Wompi en una cuenta `PAYMENT_PROCESSING_EXPENSE` por pedido, estimada con una tarifa por método y ajustada contra el reporte. Hoy **no existe en ningún sitio**, así que toda cifra de margen está inflada — M.

**★Efectivo.** Sale de Finanzas a su propia pantalla, con conciliación por domiciliario, comprobante obligatorio y vencidos.

**★Facturas y comprobantes.** Ver §5.

**★Exportes.**

Hace falta:
- `[P1]` Pantalla sobre `/admin/exports/orders|users`, que hoy no se usan — S.
- `[P1]` Libro por rango, liquidaciones, reembolsos, efectivo y pagos de Wompi, para el contador — M.
- Todo exporte con motivo, auditoría y reautenticación (S14).

### 3.7 Crecimiento

**Cupones.** Hoy tiene CRUD completo con financiador, alcance, tope por pedido, restricción por usuario y canjes.

Le falta:
- `[P1]` Historial de canjes por cupón: quién, cuándo y en qué pedido — S.
- `[P2]` Coste por financiador y campaña frente al presupuesto (datos en `Order.finance`) — S.
- `[P2]` Pedidos incrementales, cohortes y retorno — M.
- `[P2]` Tope de subsidio por comercio — M.
- Permiso propio (S4).

**Publicidad.** Hoy aprueba y rechaza con motivo, reparte impresiones con tope por persona y cierra y factura.

Le falta:
- `[P0]` S2.
- `[P1]` Que cerrar y facturar exija permiso financiero (`advertisement.routes.ts:127`) — S.
- `[P1]` Listado global de facturas (`AdInvoice`) con estado de cobro. Un comercio que solo vende en efectivo **nunca** tiene payouts pagables, así que su publicidad nunca se cobra *(inferencia)* — M.
- `[P1]` Alerta de campañas vencidas sin facturar — S.
- `[P1]` Reporte al anunciante. Hoy `AdEvent` no liga el clic a un pedido — L.
- `[P2]` Alcance del segmento antes de aprobar — M.

**★Envíos dirigidos.** `campaign.service` hace la vista previa y el envío respetando el consentimiento, y no tiene pantalla.

Hace falta:
- `[P1]` Pantalla — S.
- `[P2]` Historial de envíos; hoy no se guardan — M.
- `[P2]` Segmentar a domiciliarios — S.

**★Referidos.** Tiene antiabuso con tres señales y no tiene pantalla.

Hace falta:
- `[P1]` Ver invitaciones, recompensas y abuso — M.
- `[P2]` Coste separado — M.

**Programa de puntos: retirado** (migración 007). No es un hueco.

**Cashback: no existe.** Sería una función nueva, no una pantalla.

### 3.8 Contenido de la app

**Constructor de Explorar.** Es el módulo mejor construido: borrador y versiones, reglas cerradas, vista previa real, programación por franja y fecha, y permisos propios.

Le falta:
- `[P1]` Gobernar también **Inicio**. Hoy Inicio mezcla tres sistemas de orden sin una vista combinada: colecciones automáticas, bloques curados y banners. La salida barata es un segundo alcance (`scope: 'home'`) del mismo constructor — L.
- `[P2]` Un layout por municipio. El modelo ya lo prevé; hoy el alcance siempre es `global` — M.
- `[P2]` Telemetría orgánica: impresiones, clics y pedidos por sección, banner y colección. Solo la publicidad pagada la tiene — M.

**Banners.** Un mismo `PromotionBanner` alimenta Inicio, Descuentos y Explorar.

Le falta:
- `[P1]` Regla visible de quién gana el hueco frente a publicidad pagada y bloques curados en Inicio — M.

**Bloques curados.**

Les falta:
- `[P1]` Programación por fecha y franja — S.
- `[P2]` Vista previa real — M.

**Categorías de inicio.**

Les falta:
- `[P1]` Categorías de antojo por etiqueta de producto (45 etiquetas en `constants/productTags.ts`) — M.

**Búsquedas.** Hoy solo informan.

Les falta:
- `[P1]` Acciones: sinónimos, redirigir un término sin resultados a una colección o categoría, y marcar como atendido — M.
- `[P3]` Corte por municipio.

**★Colecciones.** `DiscoveryCollection` solo se crea con el seed y no tiene CRUD — `[P2]`, M.

### 3.9 Equipo y sistema

**Equipo, Cargos, Roles y Seguridad.** Ver S3 a S12.

Además hace falta:
- `[P1]` Alta de staff por invitación con enlace de un solo uso, con el TOTP enrolado por el propio titular — M.
- Separar la lista del **staff** de la de clientes.
- Quitar las cajas en `Users.tsx:689`.

**★Interruptores.** `GET/PUT/DELETE /admin/feature-flags` existe sin pantalla. El comentario de `dispatch.service.ts:83-90` promete apagar el reparto "desde el panel", y ese panel no existe.

Hace falta:
- `[P1]` Pantalla con encendido y porcentaje de despliegue — S.

**★Salud de la app.**

Hace falta:
- `[P2]` Crashes de la app (`ClientError` solo tiene POST, sin lectura) — M.
- `[P2]` Consumo del recorte de imágenes (`/admin/image-processing/stats` sin pantalla), para cuadrar la factura de Photoroom — S.

---

## 4. Fichas 360 y capa común

El patrón ya existe para clientes y domiciliarios: un solo endpoint agregado con `Promise.all` y listas acotadas, y un panel lateral. Faltan dos fichas y la capa que las une.

### 4.1 Ficha del pedido `[P1, M/L]`

| Sección | Qué muestra | Fuente |
|---|---|---|
| Resumen | Número, estado, tipo (catálogo o mandado), comercio, cliente, domiciliario, dirección, ítems, totales | `Order` |
| Línea de tiempo | Cada estado con actor y hora | `OrderEvent` |
| Despacho | Ofertas por ronda: a quién, respuesta y motivo de rechazo; reasignaciones | `DriverOffer` |
| Conversación | Chat y llamadas entre las partes | `OrderMessage`, `OrderCall` |
| Traspaso | Estado de los códigos (nunca en claro) y evidencias | `orderSecurity`, `OrderEvidence` |
| Dinero | Pago, reembolsos, contracargo, asientos del libro, payouts y recibo | `Payment`, `Refund`, `LedgerEntry`, `Payout`, `/receipt` |
| Después | Reseña, PQRS, incidentes | `Review`, `Pqrs`, incidentes |
| Acciones | Asignar, reasignar, cancelar con motivo, reembolsar, reenviar aviso, nota interna | `assign-driver`, estado, refund |

### 4.2 Ficha del comercio `[P0 por petición expresa del dueño, L]`

| Sección | Qué muestra | Fuente |
|---|---|---|
| Identidad | Datos legales y tributarios, representante legal, dueño (enlace a su ficha), contacto, categoría, zona y punto de recogida en el mapa, horario | `Business` + campos nuevos |
| Documentos | Cada documento con estado, vencimiento y quién lo revisó | `BusinessDocument` |
| Equipo | Empleados con rol y acceso; revocar | `BusinessStaff` |
| Menú | Productos, precios, stock y disponibilidad, en solo lectura | `Product`, `Category` |
| Ventas | Pedidos, ventas por periodo, ticket, cancelaciones del comercio, tiempos de preparación, rechazos | `Order`, `businessAnalytics.service` |
| Dinero | Comisión y su historial, estado de cuenta línea por línea, liquidaciones, cuenta bancaria, exportar | `payout.service` (`merchantStatement*`, `listSettlements`) |
| Publicidad | Campañas, facturas y lo que debe | `Advertisement`, `AdInvoice` |
| Promociones | Cupones que financia y su coste | `Coupon`, `Order.finance` |
| Reputación | Reseñas y respuestas | `Review` |
| Soporte | PQRS e incidentes ligados a sus pedidos | `Pqrs`, incidentes |
| Historial | Aprobaciones, suspensiones y cambios de comisión, con autor | `AuditLog` |
| Acciones | Suspender o cerrar temporalmente con motivo, cambiar comisión, pedir documentos, nota interna | — |

Todo lo que el comercio ve de sí mismo en `business/` (Dashboard, Pedidos, Menú, Promociones, Publicidad, Reseñas, Liquidaciones, Equipo, Analítica, Ajustes) debe poder verlo soporte aquí.

### 4.3 Capa común

- `[P0]` **Bandeja de alertas del equipo.** Sustituye a la campana falsa. Recibe pedidos sin repartidor, SOS, PQRS por vencer, efectivo vencido, documentos por vencer, fraude, campañas sin facturar y reembolsos fallidos. Tiempo real por socket — M.
- `[P1]` **Búsqueda global.** Sustituye al input falso. Busca pedido por número, cliente por nombre, teléfono o correo, comercio, domiciliario por nombre o placa, y cupón — M.
- `[P1]` **Navegación cruzada.** Desde cualquier ficha se abre cualquier otra relacionada. Hoy el pedido solo enlaza a Evidencias — S.
- `[P1]` **Notas internas genéricas** (`InternalNote {entityType, entityId, autor, texto}`) en pedido, comercio, domiciliario, cliente y ticket — M.
- `[P2]` **Línea de tiempo por entidad** con `AuditLog` filtrado por `entityId` — S.
- `[P2]` **Exportar desde cada lista**, con auditoría — M.
- `[P3]` Filtros en la URL y vistas guardadas — M.
- **Consistencia.** El anexo B enumera, página por página, qué falta de búsqueda, filtros, orden, paginación, error visible, permisos y "sin cajas".

---

## 5. Facturación y documentos

Hoy **no existe nada fiscal**: ni facturación electrónica, ni CUFE, ni datos tributarios. Lo único parecido es el recibo por pedido.

**Se puede construir ya, sin NIT:**
- Datos fiscales y bancarios estructurados en comercio, domiciliario y cliente.
- Un modelo `FiscalDocument` fuera del libro, con consecutivo interno (`INT-`). Tipos:
  - pre-factura de comisión y publicidad por liquidación;
  - comprobante de pago al domiciliario;
  - comprobante de tarifa de servicio y domicilio al cliente;
  - comprobante de Zipp Pro.
- PDF y CSV de todos esos documentos, y el paquete mensual para el contador.

**Depende de constituir Zipp S.A.S. (NIT) y contratar un proveedor tecnológico DIAN:**
- factura electrónica de comisión y publicidad al comercio;
- factura o documento equivalente al cliente (tarifa de servicio, domicilio, Pro);
- documento soporte de pagos a domiciliarios no obligados a facturar;
- certificados de retención.

Mientras tanto, la app no debe decir "S.A.S." ni presentar un comprobante interno como factura.

---

## 6. Decisiones que solo el dueño puede tomar

**Legal y fiscal**
1. ¿ZIPP cobra los productos como mandatario del comercio o como revendedor? Hoy el impuesto grava productos + domicilio + tarifa como pasivo de ZIPP (`pricing.service.ts:691`).
2. IVA sobre comisión, tarifa y domicilio; régimen de la S.A.S.; retención en la fuente; ICA por municipio.
3. Vínculo con los domiciliarios: independientes con documento soporte, o contrato de otro tipo. ¿Tienen que aceptar términos propios?
4. Proveedor de facturación electrónica, y cuándo se constituye la S.A.S. Hay un riesgo en recaudar dinero de terceros en una cuenta Wompi de persona natural antes de abrir más municipios.

**Dinero**
5. Tarifa contratada con Wompi por método (tarjeta, PSE, Nequi) y si se traslada al cliente.
6. Quién asume los contracargos y los reembolsos que llegan después de liquidar.
7. Cadencia y mínimo de liquidación para comercios y domiciliarios. ¿El pago se ejecuta fuera (transferencia manual) y se registra, o se automatiza?
8. ¿Se separa el coste de Zipp Pro y de referidos de `promotion_expense` en el libro?

**Equipo y seguridad**
9. **Cargos restrictivos.** Contradice la decisión "aditiva" documentada en `authorization.service.ts:23-27`, pero hoy el RBAC no protege al staff de sí mismo.
10. ¿Solo el Super Administrador crea y promueve admins, y hace exportes?
11. Duración de la sesión del staff y cierre por inactividad.
12. Qué ve soporte frente a seguridad (enmascarado).
13. ¿Cupones y zonas exigen permiso financiero o un permiso propio de promociones?

**Producto y operación**
14. Borrar un comercio: ¿archivar con historial o borrado definitivo?
15. ¿Se fusionan Soporte y Legal en una sola bandeja? ¿El plazo legal va en un campo aparte del SLA?
16. ¿Se adopta la barra lateral propuesta?
17. ¿Catálogo de municipios ahora o al abrir el segundo?
18. ¿Se registran turnos y conexiones de los domiciliarios?

**Contenido y crecimiento**
19. ¿Inicio pasa al constructor de Explorar?
20. Multi-municipio: ¿Inicio y Explorar independientes por municipio, o una base con cambios locales?
21. Búsquedas sin resultado: ¿sinónimos, redirección o ambos?
22. ¿Telemetría orgánica ya, o cuando haya volumen?
23. ¿Pantallas de envíos dirigidos, referidos y Pro ahora o con más comercios? Pro espera el `TODO(negocio)`.

### Decisiones tomadas (2026-09-23)

| Tema | Decisión |
|---|---|
| Arranque | Toda la Fase 0 antes de cualquier pantalla nueva |
| Cargos (9) | **Restrictivos.** El admin genérico solo entra al panel; cada persona tiene un rol explícito; el dueño queda como Super Administrador |
| Reembolso o contracargo después de liquidar (6) | **Se descuenta al comercio** como saldo negativo en su siguiente liquidación |
| Borrar comercio (14) | **Archivar con historial**; nunca borrado duro |
| Zonas y cupones (13) | **Permiso propio por módulo**, con versión y auditoría |
| Sesión del staff (11) | **8 h**, con cierre a los **30 min** de inactividad |
| Crear o ascender admins y exportar datos personales (10) | **Solo el Super Administrador**; los exportes piden motivo y 2FA y se auditan |
| Soporte y Legal (15) | **Una bandeja única**: SLA interno en horas y plazo legal en días hábiles, por separado. Legal queda para datos personales y documentos legales |
| Pago de liquidaciones (7) | **Manual**, registrado en ZIPP con referencia y comprobante; eso cierra la liquidación y el asiento |
| Cadencia (7) | **Semanal** |
| Datos fiscales y bancarios | **Sí, ya**: estructurados para comercios y domiciliarios, aunque ZIPP aún no tenga NIT |
| Comisión de Wompi (5) | **Tarifa por método**, configurable en Tarifas; el dueño la llena con su contrato; se registra como gasto por pedido |
| Roles base del equipo (Fase 1) | **Operaciones + Domiciliarios · Soporte · Finanzas · Comercios + Contenido**, más el Super Administrador |
| Las dos cuentas de admin actuales | **Ambas Super Administrador** hoy; el dueño ajusta a cada persona después |
| Marca `isFinanceAdmin` | **Se convierte en permiso del rol Finanzas**; la marca vieja se migra y deja de usarse |
| Despliegue de los permisos | **Primero registra y avisa durante una semana, luego bloquea** (modo observación con interruptor) |
| Tope de reembolso para Soporte | **Fuera de la Fase 1.** Soporte solo ve reembolsos; los ejecuta Finanzas. Se diseña aparte, con revisión de zipp-finance |
| Solo el Super Administrador (no delegable) | Bloquear usuarios · suprimir datos personales (Ley 1581) · escribir la cuenta de pago de un comercio · crear o ascender admins · exportes con datos personales |
| Tarifas de zona (`zones:manage`) | **Finanzas**; Operaciones solo las ve |
| Publicidad y arrastre compensados en la liquidación | **Se asientan en el libro**, atados al pedido cuyo pasivo se cierra (cuentas `AD_SPEND_OFFSET` y `PAYOUT_OFFSET_CLEARING`). Es una excepción anotada en `CLAUDE.md`; la factura sigue siendo `AdInvoice` |
| Reembolso de un pedido ya entregado y liquidado | **Al domiciliario no se le descuenta**: su tarifa la asume ZIPP como gasto. Solo se le descuenta al comercio |
| Saldo en contra de un comercio que deja de vender | **Alerta a los 14 días**; finanzas registra el cobro con comprobante o lo castiga como pérdida, con motivo |

---

## 7. Plan por fases

Orden por riesgo y dependencia, no por vistosidad. Cada fase cierra con sus pruebas en verde.

| Fase | Contenido | Depende de |
|---|---|---|
| **0 · Urgente** | D1-D14 · S1, S2, S5-S8, S10-S15 · O1-O9 | Nada (D4 y D6: decisión 6) |
| **1 · Permisos reales** | S3, S4 · barra por dominio con permiso por ítem · guardas de ruta en el panel | Decisiones 9, 10, 13 y 16 |
| **2 · Fichas y capa común** | Ficha del pedido con acciones · ficha del comercio · ficha del cliente ampliada con dos vistas · notas internas · navegación cruzada · bandeja de alertas · búsqueda global | Fase 0 |
| **3 · Dinero operable** | Liquidaciones · comisiones · reembolsos y contracargos · pagos Wompi y su comisión · efectivo con comprobante · facturas de publicidad · exportes para el contador · datos fiscales y bancarios · comprobantes internos | Fase 0, decisiones 5-8 |
| **4 · Soporte y legal** | Bandeja única con plazo legal · casos de comercios y domiciliarios · macros · documentos legales versionados · Ley 1581 con plazos | Decisión 15 |
| **5 · Comercios y domiciliarios** | Subida de documentos del comercio (O4) · vencimientos · embudo de alta · selfies · cambio de vehículo · antifraude y SOS en el mapa · cobertura por zona · aceptación de ofertas | Decisiones 3 y 18 |
| **6 · Crecimiento** | Interruptores · envíos dirigidos · referidos · canjes y coste de cupones · publicidad con cobro y reporte · Zipp Pro | Decisión 23 |
| **7 · Contenido** | Inicio en el constructor · programación de bloques · búsquedas accionables · antojos · colecciones · telemetría | Decisiones 19-22 |
| **8 · Escala** | Municipios · resultados y conciliación por zona · cierre de periodo · facturación DIAN · salud de la app | NIT (decisiones 1-4 y 17) |

---

## 8. Bitácora de ejecución

### Fase 0 (arrancó el 2026-09-23)

**Backend de seguridad y operación: hecho.**
- S1, S2, S5 (parcial), S6, S7 (migración 012), S8, S9, S10 (parcial), S11, S12, S13 y S15.
- O1, O2, O3, O5 y O6.
- Tests: `panelAdminSecurityFase0.test.ts` y `socketAuth.test.ts`.

**S17 (listado público de comercios): corregido** por la sesión principal, con 2 tests.

**Panel admin: hecho.**
- Errores y 429 visibles en todas las páginas (O9).
- Número de pedido real (O8).
- Etiquetas de Finanzas (D14 y cuentas faltantes).
- Cola de verificaciones con selfie, cédula y perfil, más motivo de rechazo (O5 y O6).
- Negocios sobre `/admin/businesses`, con archivar y restaurar con motivo.
- Sesión: `logout` que revoca en el servidor, e inactividad de 30 min compartida entre pestañas, con aviso "¿Sigues ahí?".
- Fondo rotatorio entero, con motivo y visible solo para el admin financiero.
- Reembolsos visibles solo para el admin financiero.
- Sin cajas: Documentos, Negocios, Reseñas, ficha del cliente, SOS, reembolsos y Login.
- 0 errores de lint; antes había 4 previos.

**Panel de comercios: hecho.**
- Ajustes lee su propio negocio por `/businesses/my/businesses`, porque la ficha pública ahora da 404 a los no aprobados.

**Revisión de zipp-security sobre lo anterior:** 1 crítico, 6 altos (3 eran regresiones) y 6 medios. El detalle está en el scratchpad de la sesión (`09-revision-seguridad-fase0.md`).
- Regresiones A4 y A6: corregidas en el panel.
- El resto está en curso: C1 (borrado duro por `/businesses/:id`), A1 (archivado reversible por el dueño; se separa "suspendido por ZIPP" de "abierto/cerrado por el dueño"), A2, A3, A5, M1-M5 y S16 (fotos sensibles a almacenamiento privado, migración 015).

**Dinero (backend): hecho.**
- D1: reclamo atómico de liquidación.
- D2: arrastre de reembolsos tardíos mediante un payout `isClawback`. El neto de una liquidación nunca queda negativo.
- D3 y D13: reparto proporcional de parciales y contracargos.
- D4: `POST /payments/orders/:id/refund/external`.
- D5: `POST /finance/settlements/:id/payment` registra el pago manual y escribe el asiento en la nueva cuenta `PAYOUT_DISBURSEMENT`.
- D6: liquidar exige beneficiario.
- D7: fondo por diferencia, entero, con motivo y `requireFinanceAdmin`.
- D8: `GET /finance/cash/totals`, verificación con referencia y comprobante, liquidación atómica y sweeper de vencidos.
- D10 y D12 también.
- Pendientes anotados:
  - La publicidad y el arrastre no tienen asiento propio en el libro.
  - La auditoría del fondo usa `PROFILE_UPDATED`.

**Plazos legales (backend): hecho.**
- Días hábiles de Colombia con festivos (Ley 51 de 1983 + Emiliani + Pascua): los 18 de 2026 coinciden con el calendario oficial.
- `legalDueAt` en PQRS (15 días hábiles) y en datos personales (10 o 15). Los plazos están marcados para confirmar con un asesor legal.
- La bandeja ordena primero lo vencido por ley.
- Una sola ruta de respuesta para las PQRS.
- Incidentes nuevos de vencimiento legal.
- Migración 013: `npm run migrate:pqrs-legal-deadline`.
- O11: los pedidos programados se activan aunque el reparto automático esté apagado.

**Panel adaptado a esos cambios:**
- **Soporte:** plazo legal y SLA por separado, partes del caso, filtros, métricas legales y ficha del cliente.
- **Datos personales** (antes "Legal y PQRS"): solo solicitudes de datos, con plazo y supresión explícita.
- **Incidentes:** vencimientos legales.
- **Finanzas:** efectivo por estado con totales del servidor, y verificación con referencia y comprobante.
- **Reembolsos:** pasarela, hecho por fuera y contracargo.
- **Pedidos:** abre el detalle con `?orderId=`; antes era un enlace roto desde Incidentes.

**Correcciones de la revisión de seguridad (backend): hechas.**
- C1: `DELETE /businesses/:id` responde 405.
- A1: suspensión separada del abierto/cerrado del dueño (`isSuspended`); el dueño no la puede quitar. `VISIBLE_BUSINESS` y la creación de pedidos exigen aprobado, no archivado y no suspendido.
- A2: lista blanca en búsqueda, ofertas y favoritos (S17 cerrado).
- A3: el handshake del socket rechaza al admin sin 2FA.
- A5: el reset por OTP limpia `mustChangePassword`.
- M1: `updateUserRole` revoca las sesiones del usuario; migración 014 revoca las sesiones activas de todos los admin; la caducidad por inactividad del staff se desliza; el socket se corta al llegar el `exp` del token.
- M2: los exportes pasan a POST con motivo y TOTP, con tope de 5 intentos.
- M3, M4 y M5.
- S16: documentos y selfies de domiciliarios en almacenamiento privado (migración 015). **La firma de la URL no caduca**, porque el complemento de Cloudinary para eso es de pago.
- Pendiente real: el recibo de los mandados (`errand.service.ts`) sigue guardando una URL sin firmar.

**Correcciones de la revisión de dinero (backend): hechas.**
- Migración 016 (índice de `Payout`), **a correr ANTES de desplegar**.
- Reclamo con foto (`reversedAtClaim`).
- Reclamos huérfanos liberados.
- Asiento de publicidad y arrastre compensados (cuentas `AD_SPEND_OFFSET` y `PAYOUT_OFFSET_CLEARING`).
- El domiciliario no se descuenta: lo asume ZIPP (`DRIVER_FEE_ABSORBED_EXPENSE`).
- Saldos en contra: `GET /finance/clawbacks` y `POST /finance/clawbacks/:id/collect|write-off`, con alerta a los 14 días.
- Reembolso externo idempotente por referencia.
- `verifyByAdmin` atómico y con monto.
- `receiptUrl` obligatorio al pagar una liquidación.

**Panel adaptado también a esto:** verificación de efectivo con monto, saldos en contra en Finanzas, incidente de saldo en contra, Negocios con suspensión y panel de comercios con el motivo de la suspensión.

**D11 (backend y panel): hecho.**
- `platformResultService.forRange()` es la única fuente de ingreso, calculada del libro mayor y siempre marcada `incomplete` (falta la comisión de Wompi).
- Periodos en hora de Colombia (UTC-5).
- Dashboard, Resumen diario y Finanzas leen el mismo número.
- Los porcentajes de efectivo/digital y la tasa de entrega salen del servidor sobre todos los pedidos del día, no sobre 6.
- `settledCommissions` se eliminó: era un 0 permanente.
- `Math.abs` sobre el margen de domicilio corregido: un subsidio ya resta.

**O4, datos fiscales y bancarios, y D9 (backend y paneles): hecho.**
- **Documentos del comercio:** subida real de archivos (JPG/PNG/WEBP/PDF, 8 MB) a almacenamiento privado con URL firmada al leer. Historial de versiones y motivo de rechazo visible para el comercio.
- **Datos fiscales:** DV del NIT calculado con la DIAN.
- **Cuenta de pago:** cifrada en reposo y siempre enmascarada. La verifica finanzas y quien la registró no puede verificarla. Cambiarla exige una nueva verificación. Ver la cuenta completa queda auditado.
- **Aprobar un comercio** exige documentos, datos fiscales completos y cuenta verificada.
- **Zonas:** permisos `zones:view` y `zones:manage`. Cada cambio de tarifa crea una versión con motivo, y el pedido guarda `zoneVersion`.
- **Panel admin:**
  - Verificar comercios con miniatura de archivos, motivo de rechazo, datos fiscales y verificación de la cuenta.
  - Zonas con motivo obligatorio e historial.
- **Panel de comercios:** nueva pantalla "Documentos" con subida, datos fiscales y cuenta.
- **Migración 017:** da versión inicial a las zonas, añade los permisos de zonas a `super_admin` y reporta cuántos comercios ya aprobados no tienen datos fiscales o cuenta verificada.

**Revisión del flujo fiscal (backend y paneles): hecha.**
- `settle()` exige cuenta verificada y guarda su foto en la liquidación; si la cuenta cambia después, el pago se detiene.
- Cambiar la cuenta pide contraseña o un código al celular, y avisa al dueño con los últimos 4 dígitos.
- Cambiar los datos fiscales devuelve la cuenta a "sin verificar".
- Un admin ya no puede aprobar su propio negocio ni verificarse su propia cuenta.
- Cambiar a una categoría de alimentos después de aprobado exige el concepto sanitario.
- El PDF se revisa por contenido activo antes de subirlo.
- El PDF privado ya usa una URL que caduca a los 5 minutos; la imagen sigue sin caducar (requiere un complemento de pago de Cloudinary que no está contratado).
- `GET /zones` público ya no expone lo que se le paga al domiciliario; las tarifas quedan tras el permiso de zonas, en `GET /zones/admin`.
- El documento del titular y el NIT se cifran; se detecta si la misma cuenta está en varios comercios.
- Migración 018.
- **Panel:** cola de "Cuentas de pago sin verificar" en Finanzas, y reautenticación al cambiar la cuenta en el panel de comercios.

**Sin resolver, anotado para la Fase 3:** no existe todavía una pantalla de Liquidaciones en el panel; por eso "revelar la cuenta desde la liquidación" tiene el endpoint listo (`GET /finance/settlements/:id/payout-account`) pero ninguna pantalla lo usa todavía.

**Migraciones manuales de la Fase 0 (correr desde `backend/`, siempre `--dry-run` primero):**

| # | Comando | Cuándo |
|---|---|---|
| 012 | `migrate:encrypt-totp-secrets` | Cifra los secretos TOTP antiguos |
| 013 | `migrate:pqrs-legal-deadline` | Calcula plazos legales de las PQRS abiertas |
| 014 | `migrate:revoke-admin-sessions` | Revoca las sesiones activas de todos los admin (todos volverán a iniciar sesión) |
| 015 | `migrate:driver-docs-private` | Pasa a privado los documentos y selfies de domiciliarios; se detiene si una URL no encaja |
| 016 | `migrate:payout-clawback-index` | **ANTES de desplegar el código nuevo**: cambia el índice de `Payout` |
| 017 | `migrate:zone-versions` | Versiones de zona y permisos de zonas |

**Decisiones que tomó la sesión principal (reversibles):**
- Una desactivación de ZIPP es una suspensión que el dueño no puede quitar.
- La inactividad avisa un minuto antes de cerrar.

**Pendientes anotados:**
- **M6:** obligar a cambiar la contraseña temporal exige pantallas en las apps; hoy solo caduca a las 24 h.
- **`order:incoming` con datos de dinero** llega al personal de mostrador.
- **`purgeAt` forense de sesiones.**
- **Retención de selfies.**
- **Migración 011:** no tiene script en `package.json`.

### Fase 1 · permisos reales por cargo (2026-09-24)

**Hecho (sin commit; el sistema arranca en modo observación: nadie pierde acceso hasta activar el flag `rbac_enforce`):**
- Núcleo: 19 permisos nuevos y 4 roles base (`operaciones`, `soporte`, `finanzas`, `comercios_contenido`) en `security/rbac.ts`. `resolveAuthorization` calcula `strict` (lo que de verdad tiene) y `legacyUnion` (lo que usaba antes). `can`, `adminRequires` y `requirePermission` se apilan sobre `authorize(ADMIN)`, nunca lo sustituyen.
- Rutas cableadas: dinero y admin, contenido y crecimiento, pedidos, SOS, PQRS, legal, seguridad, tracking. Dashboard y resumen diario sin cifras de dinero si falta `finance:view`. `/admin/driver-debts` retirada.
- Sockets: la sala `admin` se divide en `admin:orders`, `admin:fleet` y `admin:sos`; cambiar roles, cargos o el flag desconecta los sockets afectados.
- Solo Super Administrador: bloquear usuarios y revocar sesiones, anonimizar datos personales, escribir la cuenta de pago de un comercio.
- Ficha 360 del cliente enmascarada sin `users:view_sensitive` (y sin comisiones sin `commissions:view`); centro de incidentes filtrado por el permiso de cada tipo.
- Guarda de escalada: nadie otorga más permisos de los que posee ni edita su propio cargo; los roles solo aplican a cuentas admin.
- Informe `GET /security/authz-shadow?days=7` (solo Super Administrador) y pestaña "Revisión de accesos" en Roles con el botón para activar el bloqueo.
- Panel: barra lateral y rutas por permiso, página "Sin acceso", pantalla "Aún no tienes un rol asignado", acciones con `PermissionGate`; `isFinanceAdmin` ya no se usa en el panel.
- Revisión de zipp-security: 2 críticos, 1 alto, 3 medios y varios bajos, todos corregidos (entre ellos un `legacyUnion` demasiado amplio y la escalada por asignación de roles).

**Migración manual:** 019 `migrate:staff-roles` (siempre `-- --dry-run` primero; con más de 2 admins activos exige `--super-admins=a@x.co,b@x.co`; no sobrescribe roles editados a mano salvo `--force-roles`).

**Pasos manuales tras desplegar:** correr la 019; asignar el rol final a la segunda persona; observar 7 días en "Revisión de accesos"; activar `rbac_enforce` (audiencia `staff`); después, migración 020 para borrar `isFinanceAdmin`.

**Pendientes anotados:**
- Orders.tsx no tiene controles de cancelar, forzar estado ni asignar domiciliario: solo el reembolso quedó con permiso en la UI.
- Reordenar categorías y banners sin gate en la UI (el backend sí protege).
- Si `rbac_enforce` ya tenía una audiencia `percentage` guardada, sigue vigente hasta cambiarla.
- Cualquier admin que asigne roles sin poseer sus permisos recibe 403: el panel debe mostrarlo bien.
- Cambiar `rbac_enforce` corta los sockets admin y el panel reconecta de golpe.
- Tope de reembolso por rol: fuera de esta fase.

## Anexo A · Rutas que usa el panel sin `requirePermission`

Solo exigen el rol admin:

| Archivo | Rutas |
|---|---|
| `admin.routes.ts` | dashboard, financials, revenue-chart, daily-summary, campaigns/preview, **campaigns/send**, feature-flags GET/**PUT/DELETE**, businesses GET, **toggle**, **featured**, **DELETE**, orders, evidences, orders/:id/security, commissions, driver-debts |
| `driver.routes.ts` | decline-reasons, **:id/base-fund**, verifications/queue, **verifications/:id/review**, :id/request-verification, documents/queue, :id/documents, **documents/:id/review** |
| `business.routes.ts` | pending, **:id/approve**, **documents/:id/review**, POST/PUT/DELETE /:id, logo/cover, staff, analytics, statement (+export/lines) |
| `finance.routes.ts` | todos los GET; las escrituras usan `requireFinanceAdmin`, que es un booleano y no un permiso del catálogo |
| `payment.routes.ts` | GET orders/:id/refunds |
| `coupon.routes.ts` | GET, :id/redemptions, **POST, PATCH, DELETE** |
| `zone.routes.ts` | **POST, PATCH, DELETE** |
| `promotionBanner` · `curatedHomeBlock` · `homeCategory` | todo el CRUD y las subidas |
| `advertisement.routes.ts` | **approve/reject/close**, list, stats, CRUD |
| `review.routes.ts` | moderation, **:id/moderate** |
| `pqrs.routes.ts` | GET, respond, support/queue, metrics, assign, classify, close |
| `legal.routes.ts` | admin/data-requests GET, **PATCH (anonimizar)** |
| `sos.routes.ts` | active, history, acknowledge, resolve |
| `security.routes.ts` | incidents, incidents/summary |
| `tracking.routes.ts` | fleet, nearest |
| `search.routes.ts` | insights |
| `order.routes.ts` | PATCH /:id/status, assign-driver |
| `product` · `category` | POST/PUT/DELETE |

Ya tienen permiso: usuarios, cargos, roles, seguridad (excepto incidentes), Explorar y, desde hoy, domiciliarios (listado, ficha, aprobar, suspender y reactivar).

## Anexo B · Consistencia por página

S = sí · P = parcial · N = no · C = solo filtra en el navegador.

| Página | Búsqueda | Filtros | Orden | Paginación | Ficha | Exportar | Permisos | Error visible | Cajas decorativas |
|---|---|---|---|---|---|---|---|---|---|
| Dashboard | — | P | N | — | N | N | N | **N** | N |
| Resumen diario | — | S | N | — | N | N | N | **N** | N |
| Pedidos | P | P | N | S | P | N | S | **N** | N |
| Evidencias | P | S | N | P | S | N | N | **N** | N |
| Domiciliarios | S | S | S | S | S | N | S | S | N |
| Documentos | N | N | N | N | N | N | N | S | N |
| Flota | C | P | N | — | P | N | N | P | N |
| Negocios | S | S | N | S | **N** | N | N | S | N |
| Verificar comercios | N | N | N | N | P | N | N | S | N |
| Reseñas | N | P | N | N | N | N | N | S | **S** |
| Tarifas | — | — | — | — | — | N | N | S | N |
| Cupones | S | S | P | S | S | N | N | S | N |
| Zonas | C | P | N | N | N | N | N | S | N |
| Banners | C | S | N | N | N | N | N | S | N |
| Categorías | C | P | N | N | N | N | N | S | N |
| Bloques curados | N | S | N | N | N | N | N | S | N |
| Publicidad | C | S | N | N | S | N | N | S | N |
| Búsquedas | N | N | N | N | N | N | N | S | N |
| Constructor Explorar | — | — | — | — | S | N | P | S | N |
| Usuarios | S | S | N | S | S | N | S | **N** | **S** |
| Cargos / Roles | C | P | N | N | S | N | S | P | N |
| Seguridad | N | S | N | P | P | N | N | S | N |
| Incidentes | N | S | N | N | P | N | N | **N** | N |
| Finanzas | N | P | N | S | P | N | N | **N** | N |
| Legal y PQRS | N | N | N | N | P | N | N | S | N |
| Soporte | N | P | N | N | P | N | N | **N** | N |

Componentes con cajas decorativas: `SosPanel.tsx:178,214,223`, `RefundPanel.tsx:150`, `UserProfile360.tsx:145`, `Login.tsx`.

## Anexo C · Endpoints que el panel puede usar y ninguna pantalla consume

- `/admin/exports/orders|users`
- `/admin/users/:id/contact|birth-date|toggle`
- `/admin/driver-debts` — modelo muerto; no usar
- `/admin/commissions`
- `/admin/feature-flags`
- `/admin/campaigns/preview|send`
- `/admin/image-processing/stats`
- `/finance/settlements`
- `/finance/config/versions`
- `/finance/ledger/orders/:orderId`
- `/security/fraud-stats`
- `/security/fraud-alerts/:id/resolve`
- `/security/blocked-users`
- `/security/unblock-user/:id`
- `/security/devices`
- `/security/risk-profile/:id`
- `POST /payments/orders/:id/chargeback`
- `/sos/history`
- `/pqrs/:id/classify`
- `/drivers/verifications/queue` y `/review`
- `/drivers/:id/request-verification`
- `/drivers/:id/documents`
- `PATCH /orders/:id/assign-driver`
- `/orders/:id/receipt|timeline|chat|calls`
- `/businesses/:id/analytics|statement|statement/export|staff`

## Anexo D · Documentación desactualizada encontrada de paso

- `CLAUDE.md` habla de "seis migraciones manuales" y hoy hay once (`backend/src/migrations/001` a `011`).
- El programa de puntos se retiró en la migración 007. Cualquier nota que lo dé por activo está desactualizada.
