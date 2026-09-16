# Sistema de calificaciones, reseñas y reputación

## Modelo de datos

Todo vive en **un solo documento `Review`** (`src/models/Review.ts`), indexado
`orderId` único. No hay una colección por relación: un pedido ya reúne a los
tres actores (cliente, comercio, domiciliario), así que es el mismo
documento el que acumula las hasta cinco calificaciones que ese pedido puede
producir.

| Campo | Quién califica a quién | Público | Alimenta |
|---|---|---|---|
| `businessRating` (+`businessRatingReasons`) | Cliente → Comercio | Sí | `Business.rating`/`totalReviews` |
| `driverRating` (+`driverRatingReasons`) | Cliente → Domiciliario | Sí | `Driver.rating`/`totalReviews` |
| `driverRatingOfBusiness` (+reasons) | Domiciliario → Comercio | No | `Business.reputationScore` |
| `businessRatingOfDriver` (+reasons) | Comercio → Domiciliario | No | `Driver.reputationScore` |
| `clientRatingByBusiness`/`clientRatingByDriver` (+reasons) | Comercio/Domiciliario → Cliente | No | perfil de riesgo interno |

`comment` es el comentario público del cliente. `businessReply` es la
respuesta pública del comercio (una sola vez). `productFeedback` es el
"sentiment" por plato (pulgar arriba/abajo).

### Por qué un solo documento y no cinco colecciones

Evita un `Review` "genérico" con `targetType`/`targetId` polimórfico, que en
Mongoose pierde validación de esquema por relación. Cada campo tiene su
propio `min/max` y su propio enum de razones. El costo es que el documento
crece con cada relación nueva — aceptable porque son cinco, cerradas y
conocidas, no un número abierto.

### Razones estructuradas (`src/types/enums.ts`)

`ReviewReasonClientToBusiness`, `ReviewReasonClientToDriver`,
`ReviewReasonDriverToBusiness`, `ReviewReasonDriverToClient`,
`ReviewReasonBusinessToDriver`. `ReviewReasonBusinessToClient` reutiliza
`ReviewReasonDriverToClient` (mismo problema — dirección falsa, trato,
espera — visto desde el otro lado del mostrador). Nunca son obligatorias:
el backend las acepta si vienen, no las exige ni siquiera en un rating bajo.

## Reglas de negocio

- Solo se puede calificar un pedido en `OrderStatus.DELIVERED`.
- El `reviewer` debe ser quien de verdad participó: cliente dueño del
  pedido (`order.clientId`), domiciliario asignado (`order.driverId`, vía su
  `Driver._id`, no su `userId`), o dueño del comercio (`Business.ownerId`).
- El `businessId`/`driverId` que manda el frontend en `POST /reviews` se
  valida contra el pedido — **nunca se confía en el payload** (era un hueco
  real que esta implementación cierra: antes cualquier cliente autenticado
  podía calificar cualquier negocio/domiciliario con solo cambiar el id en
  el body, sin importar el pedido).
- Una relación por pedido: `POST /reviews` es único por `orderId` (índice de
  Mongo); `rateClient`, `rateBusinessByDriver` y `rateDriverByBusiness`
  comprueban el campo específico antes del upsert y devuelven 409 si ya
  existe.
- `rating` siempre 1-5 entero (Zod + `min/max` de Mongoose, doble
  verificación).

## Promedios (público) vs. reputación (interno)

- **`rating`/`totalReviews`** (Business y Driver): promedio simple de todas
  las reseñas del cliente, recalculado por agregación completa cada vez que
  cambia algo relevante (`ReviewService.recalculateBusinessRating` /
  `recalculateDriverRating`). Es el número que ve todo el mundo.
- **`reputationScore`** (`src/services/reputation.service.ts`): 0-100,
  interno, `select: false` en el esquema — nunca sale de una consulta
  normal, ni por accidente de un endpoint que devuelve el documento entero.
  Combina rating reciente del cliente (últimos 90 días, 50%), voz operativa
  del otro actor (domiciliario↔comercio, 20%), tasa de cumplimiento
  entregado/cancelado (20%) e incidencias recientes —ratings ≤2— (10%,
  penalización). Ninguna mala calificación aislada lo hunde por diseño.
  **No decide nada automáticamente**: es la señal que usa Admin para
  investigar, nunca un gatillo de sanción.

Cuidado al añadir una consulta nueva sobre `Business`/`Driver` con
`.aggregate()`: las etapas de agregación (`$geoNear`, `$lookup`, …) no
respetan `select: false` del esquema. `business.service.ts::list` ya tiene
un `$project` explícito que lo excluye en el camino geoespacial — cualquier
pipeline nuevo sobre estas colecciones necesita el mismo cuidado.

## Endpoints (`src/routes/review.routes.ts`)

| Método | Ruta | Quién | Qué hace |
|---|---|---|---|
| POST | `/reviews` | cliente | Califica comercio (+domiciliario opcional) de un pedido entregado |
| GET | `/reviews/pending` | cliente | Pedidos entregados (≤7 días) sin calificar |
| POST | `/reviews/order/:orderId/rate-client` | comercio o domiciliario | Califica al cliente (privado) |
| POST | `/reviews/order/:orderId/rate-business` | domiciliario | Califica al comercio (operacional) |
| POST | `/reviews/order/:orderId/rate-driver` | comercio | Califica al domiciliario (operacional) |
| GET | `/reviews/order/:orderId/status` | cliente/domiciliario/comercio | Qué le falta calificar a ese actor en ese pedido |
| GET | `/reviews/business/:businessId` | público | Reseñas públicas del comercio, paginadas |
| GET | `/reviews/driver/:driverId` | autenticado | Reseñas del domiciliario, paginadas |
| GET | `/reviews/order/:orderId` | autenticado | La reseña de un pedido concreto |
| POST | `/reviews/:id/reply` | dueño del comercio | Respuesta pública, una sola vez |
| GET/PATCH | `/reviews/moderation`, `/reviews/:id/moderate` | admin | Cola de moderación, ocultar/restaurar |

Todos los `POST` de creación pasan por `reviewCreateRateLimiter` (20/15min
por IP, `src/middlewares/security.ts`) además del límite global de la API.

## Moderación

Hoy sigue siendo el booleano `isHidden` (+`hiddenReason`/`hiddenBy`/
`hiddenAt`) que ya existía — deliberadamente no se migró a un enum
`ACTIVE/HIDDEN/REMOVED` en esta entrega para no tocar el comportamiento de
`setHidden`/`moderationQueue` ya probado. El enum `ReviewModerationStatus`
queda definido en `types/enums.ts` para cuando se necesite distinguir
"oculta, reversible" de "eliminada, definitiva". Ocultar una reseña
recalcula `rating`/`totalReviews`/`reputationScore` en el mismo golpe: nunca
queda una reseña oculta contando para la media.

## Cómo añadir una relación nueva

1. Enum de razones en `types/enums.ts` (patrón `ReviewReasonXToY`).
2. Dos campos en `Review.ts`: `xRatingOfY` + `xRatingOfYReasons` (schema +
   interfaz).
3. Método en `review.service.ts` que valide participación contra el pedido,
   compruebe duplicado y haga el upsert — copiar `rateBusinessByDriver` como
   plantilla.
4. Si debe alimentar un agregado público, sumar al `$match` de
   `recalculate*Rating`; si es operacional, sumar a `reputation.service.ts`.
5. Schema Zod + ruta + entrada en `reviewStatusForOrder`.

## Pendiente (no implementado en esta entrega)

- **UI móvil**: la app de clientes ya tiene `RatingSheet.tsx`/
  `ReviewsSheet.tsx` conectados. Falta la UI para que el domiciliario
  califique comercio/cliente y para que el comercio califique al
  domiciliario — el backend ya lo soporta end-to-end.
- **Perfil del domiciliario**: pantalla que muestre `getByDriver` (reseñas)
  en la app de domiciliarios.
- **Admin**: endpoint/dashboard de métricas (promedio global, ratings
  bajos, entidades con `reputationScore` en caída) — el dato ya se calcula
  y persiste, falta la superficie de consulta.
- **Datos de TESTE**: sembrar reviews de ejemplo (positivas/medias/
  negativas, distintas relaciones) en `scripts/teste/`.
- **Distribución de estrellas por comercio** (5★ 82%, 4★ 11%…) para la
  ficha pública — se puede derivar con una agregación sobre `Review`, no
  implementada todavía.
