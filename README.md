# ZIPP

Plataforma de domicilios. Monorepo con seis aplicaciones:

| Carpeta | Qué es | Stack | Puerto |
|---|---|---|---|
| [backend/](backend/) | API REST + WebSockets | Express 4 · Mongoose 8 · Socket.IO · TypeScript | `3000` |
| [mobile/](mobile/) | App de clientes y domiciliarios | Expo Router 55 · React Native · Zustand · React Query | `8081` |
| [business/](business/) | Panel de comercios | Vite · React 19 · Tailwind 4 | `3002` |
| [admin/](admin/) | Panel de administración | Vite · React 19 · Tailwind 4 · Recharts | `3001` |
| [web/](web/) | Sitio público y cliente web de pedidos | Vite · React 19 · Tailwind 4 | `3003` |
| [desktop/](desktop/) | Zipp Negocios: contenedor de escritorio de `business/` para Windows | Electron · TypeScript | — |

---

## Requisitos

- **Node.js 20+** (probado en 24)
- **MongoDB 6+**, local o Atlas
- **Expo Go** en un teléfono, o un emulador Android/iOS

---

## Puesta en marcha

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env      # y completa los valores (ver abajo)
npm run seed              # datos de demostración
npm run dev               # http://localhost:3000
```

Comprueba que responde: `curl http://localhost:3000/health`

#### Generar los secretos obligatorios

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Ejecútalo una vez por cada uno de `JWT_SECRET`, `JWT_REFRESH_SECRET`,
`ENCRYPTION_KEY` y `CSRF_SECRET`. **`JWT_SECRET` y `JWT_REFRESH_SECRET` deben
ser distintos entre sí.**

En **producción el servidor se niega a iniciar** si falta alguno, si es
demasiado corto o si usa un valor conocido. Es intencional: un secreto
predecible permite firmar tokens válidos para cualquier cuenta. En desarrollo
se generan claves efímeras al arrancar (las sesiones se invalidan al
reiniciar) y se avisa por consola.

### 2. App móvil

```bash
cd mobile
npm install
npm start                 # escanea el QR con Expo Go
```

Detecta sola la IP del backend a través del host de Metro, así que en la
misma red WiFi no hay que configurar nada. El teléfono y el computador deben
estar en la misma red.

### 3. Paneles web

```bash
cd admin     && npm install && npm run dev    # http://localhost:3001
cd business  && npm install && npm run dev    # http://localhost:3002
```

Ambos leen `VITE_API_URL` (por defecto `http://localhost:3000/api/v1`).

### 4. Sitio público

```bash
cd web && npm install && npm run dev          # http://localhost:3003
```

Es el sitio de ZIPP y un cliente completo del producto: catálogo por ciudad, cuenta
(celular, Google, 2FA), carrito, pedido con efectivo o pago en línea por Wompi,
historial y seguimiento con mapa en tiempo real. Además tiene soporte sin sesión
(`/soporte`), solicitud de comercio y de repartidor (`/unete-comercio`,
`/repartidores`), el Centro legal completo y `/eliminar-cuenta` (la URL pública
que pide Google Play).

Variables (`web/.env.example`): `VITE_API_URL`, `VITE_SOCKET_URL`,
`VITE_BUSINESS_URL` y `VITE_GOOGLE_CLIENT_ID` (vacío = sin botón de Google).

Decisiones que conviene conocer:

- **Todo el dinero lo calcula el servidor.** El carrito guarda precios solo para
  mostrar; cada total sale de `POST /orders/quote`.
- **Sesión:** el access token vive en memoria y el refresh token en `localStorage`
  (`web/src/lib/session.ts`). Es una decisión consciente frente a la cookie
  httpOnly; la mitigación es la CSP de `deploy/nginx/csp-web.conf`, que arranca en
  solo-informe y debe pasarse a bloqueo tras recorrer el sitio.
- **Pago en línea** por redirección al Web Checkout de Wompi: la tarjeta nunca
  pasa por este sitio. El pago nativo en el navegador (tokenizar tarjeta aquí)
  está sin hacer a propósito: ampliaría el alcance PCI a SAQ A-EP y exige la CSP
  en modo bloqueo antes.
- **CORS:** el origen de `WEB_URL` entra en `config.cors.origins` del backend
  (fetch, Socket.IO y `redirectUrl` de pago).
- **Pruebas:** `cd web && npm test` (vitest).

---

## Credenciales de demostración

Tras `npm run seed`, la contraseña de **todas** las cuentas es `Zipp.2026`.

Los paneles `admin` y `business` entran por **correo y contraseña**; la app
móvil (cliente y domiciliario) sigue entrando por **celular**.

| Rol | Usuario | Dónde entra |
|---|---|---|
| Administrador | `admin@zipp.co` | panel `admin` |
| Cliente 1 | `3101234567` | app móvil (trae 2 direcciones guardadas) |
| Cliente 2 | `3201234567` | app móvil |
| Comercio 1 | `juan.restaurantes@zipp.demo` | panel `business` (Burger House, Rincón Paisa, Super Fresh) |
| Comercio 2 | `ana.cafeterias@zipp.demo` | panel `business` (Café Aroma, Droguería Salud+) |
| Domiciliario 1 | `3111234567` | app móvil |
| Domiciliario 2 | `3121234567` | app móvil |

### Cupones sembrados

| Código | Beneficio | Condición |
|---|---|---|
| `BIENVENIDO` | 20% (tope $10.000) | sólo primer pedido, mínimo $15.000 |
| `ENVIOGRATIS` | envío gratis | mínimo $25.000, 3 usos por persona |
| `AHORRA5` | $5.000 | mínimo $30.000, 100 usos totales |
| `BURGER15` | 15% (tope $8.000) | sólo en Burger House |
| `EXPIRADO` | — | vencido a propósito, para probar el rechazo |

---

## Cómo probar cada rol

**Cliente (app móvil)** — inicia sesión con `3101234567`, explora comercios,
abre uno, agrega productos con adicionales, entra al carrito. Verás el
desglose (subtotal, envío por distancia, propina, total) calculado por el
servidor. Aplica `ENVIOGRATIS` y confirma el pedido.

**Comercio (panel `business`)** — inicia sesión con `juan.restaurantes@zipp.demo`. El pedido
recién creado aparece en tiempo real. Acéptalo → prepáralo → márcalo listo.
Cuando el domiciliario llegue verás su nombre, si ya tomó la foto y el
**código de recogida** que tienes que dictarle. El ojo de cada fila abre la
ficha completa: productos, repartidor, evidencia, desglose del dinero e
historial con quién hizo cada cosa. En **Liquidaciones** está lo que ZIPP
te debe y en qué consignación se pagó cada venta.

> El interruptor *Abierto / Cerrado* del menú lateral escribe en el
> servidor: con el local cerrado, ZIPP deja de aceptarte pedidos nuevos.
> Los que ya tengas en cocina siguen su curso.

**Domiciliario (app móvil)** — inicia sesión con `3111234567`. Los pedidos en
estado *listo* aparecen como disponibles. Acepta uno y recórrelo: marca la
llegada al local, toma la foto, teclea el código que te dicta el comercio,
ponte en camino, marca la llegada al cliente, toma la segunda foto y teclea
el código que te dicta el cliente. No hay forma de marcar "entregado" sin
ese último código.

> Un domiciliario no puede ponerse *Disponible* sin identidad, licencia y
> SOAT aprobados — es una validación de cumplimiento, no de producto. El
> seed le crea esos tres documentos **solo a las dos cuentas de prueba**,
> con referencias marcadas `DEMO-` para que nunca se confundan con
> documentos reales. Si tu base ya existía antes de este cambio:
>
> ```bash
> cd backend && npm run seed:demo-drivers   # no borra nada; se niega a correr en producción
> ```

**Administrador (panel `admin`)** — inicia sesión con `admin@zipp.co` para ver
pedidos, comercios, domiciliarios, usuarios, finanzas y seguridad.

---

## Pruebas

```bash
cd backend
npm test          # suite completa (vitest)
npm run typecheck # tsc --noEmit
npm run lint      # eslint src/
```

En el resto de aplicaciones:

```bash
cd admin     && npm run lint && npm run build
cd business  && npm run lint && npm run build
cd web       && npm run lint && npx tsc -b && npm test && npm run build
cd mobile    && npm run typecheck && npx expo-doctor
```

Las pruebas levantan un MongoDB en memoria; no tocan ninguna base real ni
necesitan servicios externos. Cubren:

- **Precios** — distancia, zonas, topes, comisiones, propinas
- **Cupones** — porcentaje, fijo, envío gratis, vigencia, límites, canje y devolución
- **Checkout** — que el total cotizado sea exactamente el total cobrado
- **Estados del pedido** — transiciones válidas y permisos por rol
- **Catálogo** — alta de producto con datos incompletos, categorías de
  otro comercio, y campos que el comercio no decide
- **Imágenes** — lectura de dimensiones desde la cabecera, mínimos,
  binarios que solo dicen ser imágenes, y que no queden archivos huérfanos
- **Traspaso** — códigos de un solo uso, doble uso, caducidad, bloqueo por
  intentos, evidencia obligatoria y quién puede ver cada código
- **Línea de tiempo** — que los catorce hitos quedan registrados con su
  actor, en orden causal, y que la telemetría solo la ve administración
- **Liquidaciones** — que venta − comisión ± ajustes = neto, y que un
  pedido y su liquidación se enlazan en los dos sentidos
- **Pagos** — aprobación, rechazo, reembolso y firma de webhooks
- **Autenticación** — hash Argon2id, registro, login, autorización por rol
- **Handshake del socket** — que un usuario borrado, bloqueado, desactivado o
  que acaba de cambiar su contraseña no conserve la conexión en vivo
- **Concurrencia** — que dos domiciliarios no se queden el mismo pedido, que
  un doble toque en "entregar" no abone el fondo dos veces, que un cupón de
  un uso por persona no se canjee dos veces a la vez, y que una misma
  transferencia no salde más efectivo del que vale
- **Cierre del día** — la tabla comparativa y los umbrales de las alertas
- **Datos de demostración** — que lo que siembra `npm run seed` sea
  exactamente lo que este README promete

---

## Cómo se calcula el dinero

Todo pasa por [pricing.service.ts](backend/src/services/pricing.service.ts),
que es la **única** fuente de verdad. Las aplicaciones cliente nunca calculan
importes: piden una cotización y muestran lo que el servidor responde.

```
POST /api/v1/orders/quote     → desglose, sin crear nada ni consumir el cupón
POST /api/v1/orders           → vuelve a calcular y cobra ese mismo total
```

```
total = subtotal + envío + impuestos + propina − descuento
```

- **Subtotal**: precios de producto y adicionales leídos de la base de datos.
  Los precios que envía el cliente se ignoran por completo.
- **Envío**: `base + (km facturables × tarifa por km)`, acotado entre
  `DELIVERY_MIN_FEE` y `DELIVERY_MAX_FEE`. Una zona que contenga la dirección
  puede sobreescribir la tarifa.
- **Propina**: va íntegra al domiciliario.
- **Descuento**: si el cupón es de un comercio, lo asume ese comercio; si es
  de plataforma, lo asume la plataforma.

### Envío gratis, promociones y sus límites

- **El umbral se mide en neto.** El envío gratis del comercio —y el mínimo de
  Zipp Pro— se evalúan sobre lo que el cliente paga **por los productos**
  después de los descuentos que los afectan (cupón de producto y promociones
  automáticas). El domicilio, la tarifa de servicio y sus descuentos no
  cuentan. Decisión del 2026-10-14. Una sola función lo calcula
  (`settleDiscounts`), la misma para el cobro, el sugeridor y la simulación.
- **El comercio nunca queda con un pago negativo.** Una promoción automática
  o el envío gratis que dejarían su pago en negativo simplemente no se aplican
  en ese pedido; un **cupón que escribe el cliente** que lo provoque se
  rechaza con `422 COUPON_EXCEEDS_MERCHANT_PAYOUT`. El pago no se recorta a
  cero: así `assertBalanced` sigue siendo una prueba de verdad.
- **Un cupón de domicilio no se consume sobre un envío ya gratis** (por el
  umbral del comercio o por Zipp Pro): `422 DELIVERY_ALREADY_FREE`, antes de
  canjear nada.
- **`budgetLimit` es lo que la campaña le cuesta a quien la financia**: el
  subsidio de plataforma si la paga ZIPP, lo que sale de la liquidación si la
  paga el comercio. Se gasta y se devuelve (`CouponRedemption.budgetConsumed`)
  dentro de escrituras condicionales, así que ni dos pedidos simultáneos ni un
  cambio de límite a mitad de un canje lo superan.
- **El piso de margen descuenta la pasarela.** Una campaña de plataforma se
  evalúa con la comisión estimada de Wompi restada (`estimateGatewayFee`, las
  tarifas de la configuración; en línea con la tarifa más alta si aún no se
  sabe el método; 0 en efectivo y 0 mientras las tarifas sigan sin configurar).
- **«Primer pedido»** = ninguna orden previa que no esté cancelada. Es la misma
  regla para el cupón de código y la promoción automática; esta última no se
  pinta en la carta (cache compartida) y se aplica al pagar.
- **Simular antes de activar**: `POST /coupons/business/:businessId/preview`
  (comercio) y `POST /coupons/preview` (administración) evalúan un borrador con
  el motor real. No escriben nada.
- **Zipp Pro está cerrado a nuevas suscripciones** hasta que se encienda el
  interruptor `pro_subscriptions_open` (Interruptores en administración). El
  tope mensual de envíos gratis sigue sin decidirse; la simulación está en
  `GET /admin/growth/pro/simulation`.
- **Zipp Pro no puede dejar un pedido en pérdida (M-012, 2026-10-19).**
  `settleDiscounts` mide el margen del pedido —comisión + tarifa de servicio +
  margen de domicilio − lo que regala ZIPP − la comisión estimada de la
  pasarela— y, si con el trato completo queda por debajo de 0
  (`PRO_MIN_ORDER_MARGIN`), busca una versión más chica del mismo trato (sin la
  tarifa de servicio perdonada, o sin el envío gratis, la que más ahorre al
  cliente y deje margen); si ninguna cabe, el pedido sale sin beneficio de Pro.
  La cotización lo dice en `proBenefitNotice` (la app lo muestra antes de
  confirmar) y el pedido guarda `finance.proBenefitSkipped`. Un pedido ya creado
  nunca se recalcula, y `expectedTotal` en `POST /orders` (el total que el
  cliente vio) hace que un total distinto responda `409 PRICE_CHANGED` con el
  total nuevo en vez de cobrarse en silencio. La cuota mensual de la membresía
  es un ingreso aparte: no se reparte entre pedidos.

### Reembolsos y el pago del domiciliario (M-013)

Devolverle el dinero al cliente no es desconocer el trabajo del domiciliario.

- **Entregado + reembolso total**: el domiciliario conserva TODO su pago
  (tarifa y propina), sin importar si ya se liquidó, y lo asume ZIPP
  (`DRIVER_FEE_ABSORBED_EXPENSE`). Antes dependía del día en que se emitiera el
  reembolso. Si la causa es suya (`cause: 'driver'`) tampoco se le retira solo:
  conserva el pago y el reembolso queda en la cola de revisión
  (`GET /payments/refunds?driverReview=pending`); `PATCH
  /payments/refunds/:id/driver-review` la cierra (`keep` o `escalate`) con
  motivo. Esa decisión no mueve dinero: a un domiciliario no se le arrastra
  deuda por una tarifa ya ganada (decisión vigente).
- **Reembolso parcial**: nunca toca al domiciliario.
- **Cancelación antes de entregar**: según hasta dónde llegó el pedido (asignado /
  recogido o en camino) y salvo que cancele el propio domiciliario, conserva el
  porcentaje de su tarifa que ZIPP configure en `driverCancelPayAssignedBps` /
  `driverCancelPayPickedUpBps`. Ambos nacen en 0 (la regla de siempre): las cifras
  las decide el negocio. Queda en `order.driverCancelPay`.
- Cada `Refund` guarda `cause` y `driverPay` (política, monto conservado, quién
  lo asume y la revisión). El comercio no se carga con el pago del domiciliario:
  sería una regla comercial nueva que nadie ha decidido.

### Impuestos por concepto (M-014)

Había una tasa global (`taxBps`) aplicada por igual a productos, domicilio y tarifa
de servicio. Ahora cada concepto —productos, domicilio, tarifa de servicio,
comisión, publicidad, suscripción Pro, otros— tiene sus reglas (`TaxRule`,
[taxRule.service.ts](backend/src/services/taxRule.service.ts)): tratamiento,
tarifa, base, si el impuesto va encima o incluido, condiciones y vigencia.

- **Ninguna tarifa viene de fábrica.** Una regla nace en borrador y no se usa
  para nada hasta que alguien con `finance:manage` la **valida** con el documento
  que la respalda (`validationRef`). No se valida hacia el pasado y una regla
  validada no se edita: se publica otra con su fecha de inicio y la anterior
  termina ese instante. Sin regla, el concepto es «pendiente» y el impuesto no se
  calcula ni se presenta como definitivo.
- **Checkout**: `taxRulesEnabled` (apagado de fábrica) calcula el impuesto con la
  regla de cada concepto; el servidor no deja encenderlo si falta alguna de las tres
  del checkout. Cada pedido guarda `finance.taxStatus` (`definitive` / `legacy` /
  `provisional`) y `finance.taxBreakdown`; un faltante se recalcula con las tarifas
  con que se cobró, no con las de hoy.
- **Publicidad**: la factura informa cuánto del precio es impuesto; no cambia lo
  que se cobra. Comisión, suscripción Pro y otros: solo la regla, sin integración.
- **No hay facturación electrónica**: los comprobantes `INT-` son internos.
  `GET /finance/config/readiness` y la pantalla *Impuestos* listan, concepto por
  concepto, lo que el responsable contable debe validar antes de habilitarla.

### Costo de Wompi (M-005 / M-006)

- Una sola fórmula ([gatewayFee.ts](backend/src/utils/gatewayFee.ts)): porcentaje +
  fijo por método, IVA sobre la comisión, y costo por reembolso/anulación y por
  contracargo. **Ninguna tarifa viene inventada**: todas nacen en 0.
- La comisión se calcula una vez al cobrar y se guarda con el pago
  (`metadata.gatewayFee`); los informes la leen de ahí. Cambiar las tarifas no
  reescribe cobros históricos; los anteriores a este registro se siguen estimando y
  el informe lo marca (`feeSource: 'estimate'`).
- Al reembolsar, se ajusta sobre la comisión YA asentada: lo que Wompi devuelve
  (`gatewayFeeRefundBps`; sin definir = nada) en proporción a lo reembolsado, y el
  costo de la operación. Solo gasto de ZIPP: no toca al comercio, al domiciliario
  ni al impuesto. Idempotente por reembolso.
- `gatewayContractRef` es el documento que respalda las tarifas. Vacío = sin
  verificar: el panel lo dice. `GET /finance/config/readiness` enseña qué falta.

---

## Imágenes del catálogo

Un comercio sube una foto tomada con su celular y el catálogo tiene que
verse uniforme. El sistema no le pide que sepa fotografía: le pide que
encuadre.

```
ELEGIR FOTO
  └→ EDITOR (recortar, acercar, mover, girar)   en el navegador
     └→ POST /products/:id/image                un master cuadrado de 1200 px
        └→ VARIANTES EN LA URL                  thumb · catalog · detail · large
```

### Un master, cuatro variantes

Se guarda **una sola imagen** por producto: cuadrada, 1200 px, ya
recortada por el comercio. La foto de 8 MB que sale del celular no se
guarda nunca — no aporta nada visible y se paga en almacenamiento y en
transferencia.

Los cuatro tamaños que sirve el catálogo salen de transformaciones en la
URL, no de cuatro archivos:

| Variante | Lado | Dónde se usa |
|---|---|---|
| `thumb` | 200 px | fila del menú (84 pt en móvil) |
| `catalog` | 400 px | rejillas y tarjetas |
| `detail` | 800 px | ficha del producto |
| `large` | 1200 px | pantallas grandes |

`f_auto` deja que Cloudinary negocie el formato con el navegador: AVIF a
quien lo acepta, WebP al resto, JPG a lo demás. No hay tres copias que
mantener ni una lista de navegadores que actualizar.

Cada producto trae además un `placeholder`: la misma foto a 24 px y muy
desenfocada, un par de cientos de bytes. Ocupa exactamente el mismo hueco
que la definitiva, así que la lista **no da el salto de maquetación** al
cargar.

### Por qué todo es cuadrado

El catálogo mezcla fotos de decenas de comercios distintos, y la
uniformidad de proporción es justo lo que hace que una rejilla parezca un
catálogo y no un tablón de anuncios. El editor bloquea la relación de
aspecto en 1:1 y el desplazamiento está acotado para que el cuadro
siempre esté lleno: nunca aparece un borde vacío, y la foto **nunca se
estira** — `crop: 'fill'` recorta, y `gravity: 'auto'` elige el recorte
por contenido, que es lo que centra el producto y se come el mantel
sobrante.

### La mejora es un interruptor, no un viaje de ida

`e_auto_brightness`, `e_auto_contrast`, `e_auto_color`, `e_vibrance` y
`e_sharpen` se aplican **en la URL de entrega**, nunca sobre el archivo
guardado. Dos consecuencias que importan:

- El master queda intacto, así que "Mejorar" se puede apagar sin volver a
  subir nada (`PATCH /products/:id/image`).
- El comercio siempre puede volver a la foto que tomó.

Todos los efectos van por debajo de la mitad de su rango a propósito. El
objetivo es que un producto fotografiado con luz de cocina se vea bien,
no que se vea *distinto*: si al cliente le llega algo que no se parece a
la foto, el problema que se crea es peor que el que se resolvió. Por eso
se usa `vibrance` y no `saturation` — el segundo subiría todos los tonos
y volvería radiactiva cualquier bebida.

### Lo que se rechaza, y por qué se dice

Las dimensiones se leen de la **cabecera del binario antes de subir
nada**: firma PNG e IHDR, RIFF/WEBP, o los segmentos de un JPEG hasta el
marcador SOF. Dejar que Cloudinary devuelva el tamaño obligaría a pagar
la subida de cada foto mala y a borrarla después.

| Caso | Respuesta |
|---|---|
| Menos de 500 px de lado | `PRODUCT_IMAGE_TOO_SMALL`, diciendo el tamaño real |
| Más de 8 MB | `PRODUCT_IMAGE_TOO_LARGE` |
| Bytes que no son de una imagen | `PRODUCT_IMAGE_INVALID_FILE` |
| Tipo declarado ≠ tipo real | `PRODUCT_IMAGE_INVALID_FILE` |

El `Content-Type` y la extensión los escribe el cliente y las dos se
falsifican escribiendo texto; lo único que no se puede fingir sin cambiar
el archivo son sus primeros bytes.

### Nada queda huérfano

- Reemplazar la foto borra la anterior de Cloudinary.
- Borrar la foto borra el archivo.
- **Borrar el producto borra su foto** — sin esto, cada producto
  eliminado dejaba una imagen que nada referenciaba y que nadie sabría
  identificar después.

### Recorte de fondo

La foto principal puede quedar **sin fondo, sobre transparencia**. El
proveedor (hoy Photoroom, `services/imageProcessing/`) está detrás de una
interfaz: cambiarlo no toca productos, rutas ni panel. La clave
(`PHOTOROOM_API_KEY`) solo existe en el backend. El panel sabe si el
recorte está disponible por `GET /products/image-capabilities`, que
devuelve un booleano.

- **Dos archivos, nunca uno retocado.** Los campos de siempre de
  `imageAsset` siguen siendo la **foto original**, y el recorte es otro
  archivo (`imageAsset.cutout`, `<producto>-<sha12>-cutout`). "Usar
  imagen original" es un interruptor (`PATCH /products/:id/image` con
  `useOriginal`) que no vuelve a subir nada ni gasta un crédito.
- **Asíncrono.** La subida responde al instante con la original y el
  estado `pending`. El recorte lo hace `backgroundRemoval.service.ts` en
  segundo plano, y el estado vive en el producto
  (`imageAsset.backgroundRemoval`), no en memoria. Reservar y cerrar son
  escrituras condicionadas: una sola ejecución por foto, y un recorte
  tardío no pisa una foto nueva. Un barrido cada 30 s retoma los
  reintentos y las reservas de procesos caídos.
- **Entrega.** Las variantes de siempre (`image`, `images.thumb/…`)
  sirven el recorte **compuesto** —centrado, con margen, sobre
  `#F6F8FA`—, así que las apps viejas no notan nada.
  `images.cutout` es la versión transparente, para las pantallas que
  quieran ponerla sobre otro fondo.
- **Coste.** Cada foto recortada es un crédito. No se reprocesa la misma
  foto (mismo SHA-256) ni al editar el producto. Hay un tope por comercio
  al día (`BACKGROUND_REMOVAL_DAILY_LIMIT_PER_BUSINESS`, en hora de Bogotá),
  un limitador de subidas por usuario y un máximo de 3 intentos
  automáticos por foto. Cada intento queda en `ImageProcessingEvent`
  (`billable` = crédito cobrado). `GET /admin/image-processing/stats`
  (`reports:view`) lo suma para cuadrar la factura. No va al libro mayor:
  es un coste operativo sin pedido detrás.
- **Solo la foto principal.** La galería no se recorta.

---

## El traspaso del pedido

Un pedido cambia de manos dos veces —del comercio al domiciliario y del
domiciliario al cliente— y esos son los dos únicos momentos que alguien
podría declarar en falso desde el sofá. Cada uno exige su propio código
de un solo uso y su propia fotografía.

```
CLIENTE hace el pedido
   └→ BUSINESS acepta            ← aquí se emiten los dos códigos
      └→ prepara → LISTO
         └→ REPARTIDOR asignado
            └→ llega al comercio          POST /orders/:id/pickup/arrive
               ├→ foto de lo que recibe   POST /orders/:id/pickup/evidence
               └→ el COMERCIO le dicta el código de recogida
                  └→ lo teclea            POST /orders/:id/pickup/verify
                     └→ RECOGIDO → EN CAMINO
                        └→ llega al cliente   POST /orders/:id/delivery/arrive
                           ├→ foto de la entrega
                           └→ el CLIENTE le dicta el código de entrega
                              └→ lo teclea    POST /orders/:id/delivery/verify
                                 └→ ENTREGADO → cuenta para la liquidación
```

### Quién ve cada código

Cada secreto se le enseña a **una sola** parte y solo en la etapa en la
que le toca enseñarlo:

| Código | Lo ve | Cuándo |
|---|---|---|
| Recogida | el comercio | mientras el pedido está *listo* y sin recoger |
| Entrega | el cliente | solo cuando el pedido ya va en camino |

El domiciliario **no ve ninguno de los dos**: si los viera, teclearlos no
probaría nada. El administrador tampoco — le basta el estado, y un panel
de soporte que muestra secretos es un panel del que se filtran secretos.
Las notificaciones nunca los llevan: una notificación se lee en la
pantalla bloqueada, que es justo el ataque contra el que existe el código.

### Por qué no se pueden saltar

`order.service.updateStatus` exige que el código correspondiente ya esté
consumido antes de dejar pasar a `picked_up` o a `delivered`. El estado es
**consecuencia** de la validación: la app no manda un `status`, manda un
código, y el servidor decide. Un administrador sí puede forzarlo —soporte
tiene que poder cerrar un pedido con el teléfono del cliente descargado—
pero eso queda registrado como `SUSPICIOUS_ACTIVITY`, no como una entrega
verificada.

El código se guarda **hasheado** (`sha256(orderId + tipo + código)`) y
además cifrado, para poder mostrárselo a quien corresponde. Se consume con
un único `findOneAndUpdate` condicional: el filtro exige a la vez el
pedido, la huella, el estado `PENDING`, que no esté caducado y que no esté
castigado. Si dos dispositivos mandan el código correcto en el mismo
milisegundo, exactamente uno encuentra el documento en `PENDING`; el otro
recibe "código ya utilizado". Eso hace innecesaria una transacción —que
además no existe en un MongoDB de un solo nodo—: la carrera se resuelve
donde ocurre.

La foto va **antes** que el código a propósito. Si el código fuera lo
último que falta, un domiciliario apurado cerraría la entrega y "ya
subiría la foto luego", que en la práctica es nunca.

### Configuración

| Variable | Para qué | Por defecto |
|---|---|---|
| `ORDER_CODE_LENGTH` | Dígitos del código | `6` |
| `ORDER_CODE_MAX_ATTEMPTS` | Fallos antes de bloquear | `5` |
| `ORDER_CODE_LOCK_MINUTES` | Cuánto dura el bloqueo | `15` |
| `ORDER_CODE_TTL_HOURS` | Vida del código (`0` = sin caducidad) | `24` |
| `ORDER_EVIDENCE_MAX_BYTES` | Tamaño máximo de la foto | `5242880` |
| `ORDER_EVIDENCE_URL_TTL_MIN` | Vida de la URL firmada | `10` |

---

## La historia del pedido

Cada hito queda en `OrderEvent` con su actor, y se lee entera en una sola
llamada:

```
GET /api/v1/orders/:id/timeline
```

```
PEDIDO CREADO → ACEPTADO → EN PREPARACIÓN → LISTO → REPARTIDOR ASIGNADO
  → LLEGÓ AL COMERCIO → EVIDENCIA → CÓDIGO VALIDADO → PRODUCTO RECIBIDO
  → EN CAMINO → LLEGÓ AL CLIENTE → EVIDENCIA → CÓDIGO VALIDADO → ENTREGADO
```

La responden cliente, comercio, domiciliario y administración: no hay
secretos en un hito, y ocultarle al cliente que hubo tres intentos
fallidos en su puerta solo sirve para que la discusión posterior sea a
ciegas. Lo único reservado a administración es la telemetría del actor
—IP, dispositivo y coordenadas—, que son datos personales de quien
ejecutó la acción y no del pedido.

El hito del código se escribe **antes** de mover el estado. La causalidad
es esa —el estado avanza *porque* el código se validó— y una bitácora que
la invierte contesta al revés lo único que se le pregunta en una disputa.

Los pedidos anteriores a esta bitácora no tienen eventos, pero sí
`acceptedAt`, `preparedAt` y `deliveredAt`. Esos hitos se reconstruyen a
partir de las fechas del propio pedido y llegan marcados `derived: true`,
sin actor: una línea de tiempo que empieza a mitad de la historia parece
decir que el pedido nació ya recogido.

---

## Liquidaciones del comercio

Una venta entregada entra automáticamente en la liquidación del comercio,
y el panel `business` la enseña en **Liquidaciones**.

```
GET /api/v1/businesses/:id/statement          resumen, semanas y consignaciones
GET /api/v1/businesses/:id/statement/lines    las ventas, una por fila
```

La fórmula, con los mismos números que se cobraron:

```
VENTA (productSubtotal)
− COMISIÓN ZIPP (merchantCommission)
− DESCUENTOS que asume el comercio (merchantFundedDiscount)
− REVERSIONES por reembolso o contracargo (reversedAmount)
= NETO COMERCIO
```

Ninguno de esos importes se recalcula al leerlos: salen del `finance`
congelado del pedido y del `Payout` que lo acompaña. Un extracto que
vuelve a calcular es un extracto que un día deja de cuadrar con lo que se
pagó.

`/statement/lines` se recorre en los dos sentidos, que es lo que hace
posible auditar una diferencia:

- `?settlementId=…` → qué pedidos pagó esa consignación;
- `?orderId=…` → en qué consignación se cobró ese pedido;
- `?status=accrued,payable` → qué entrará en la próxima.

Es el mismo pipeline en los tres casos, así que el total del encabezado y
la suma de las filas no pueden divergir.

Las semanas se cortan con `$dateTrunc` en la zona horaria del negocio
(`SETTLEMENT_TIMEZONE`, por defecto `America/Bogota`). Agrupar en UTC
movería la frontera cinco horas y los pedidos del domingo por la noche
caerían en la liquidación de la semana siguiente — un descuadre que solo
existiría en el informe.

> Los importes de estas pantallas **no se suman en el navegador**. El
> listado de pedidos viene paginado: sumarlo en el cliente enseñaba como
> "ganancia neta" la suma de los pedidos que cupieron en la primera
> página.

---

## Seguimiento en vivo y mapas

Los mapas son de **Mapbox**. La app móvil renderiza Mapbox GL JS dentro de
un WebView (y de un `<iframe>` en el export web) para seguir funcionando en
Expo Go; el panel admin usa `mapbox-gl` directamente. `Zones.tsx` sigue con
Leaflet: dibujar polígonos de cobertura funciona y no había nada que ganar
reescribiéndolo.

### La clave nunca está en el código

El token público (`pk.`) vive solo en `backend/.env`. Las apps lo piden en
`GET /api/v1/tracking/config`, que exige sesión. Se sirve por API en vez de
compilarlo dentro de la app para poder **rotarlo sin publicar una versión
nueva en las tiendas**.

En producción el servidor **se niega a iniciar** si detecta un token
secreto (`sk.`) en esa variable: ese token da acceso a la cuenta de Mapbox
y el servidor lo repartiría a cada teléfono.

**Sin token la plataforma funciona igual**: no hay mapa, el ETA se estima
con distancia en línea recta corregida por un factor de rodeo, y el
seguimiento por socket sigue idéntico. Un proveedor de mapas caído no
detiene un domicilio.

### Cómo viaja una posición

```
GPS del repartidor
   └→ hooks/useDriverTracking          muestreo adaptativo (lib/samplingPolicy.ts)
      ├→ socket  driver:location       app abierta
      └→ POST /tracking/ping           app dormida (tarea de fondo)
         └→ tracking.service.ingestPing
            ├─ descarta: coordenada inválida · precisión > 100 m
            │            · < 5 s desde el último · < 15 m de movimiento
            ├→ Driver.currentLocation  (dónde está)
            ├→ DriverLocation          (por dónde pasó — solo con pedido activo)
            └→ emitDriverLocation      → sala admin · sala del pedido · seguidores
```

El filtro importa: antes cada fix del GPS provocaba **dos** escrituras
(socket + REST) sin control ninguno. Un repartidor conectado ocho horas
eran ~14.000 escrituras al día, la mayoría repitiendo que seguía en el
mismo semáforo.

### El latido, y por qué son dos mitades

`distanceInterval` no adelanta fixes: **los bloquea**. Un domiciliario que
no recorre esa distancia no recibe ni una lectura del GPS, así que no envía
nada y a los 90 s el servidor lo da por perdido — con el teléfono
perfectamente vivo.

Por eso hay dos mitades que tienen que existir a la vez:

- **Servidor** (`HEARTBEAT_MS`, 30 s) — acepta un ping sin movimiento
  pasado ese plazo, en vez de descartarlo por "no se ha movido".
- **Cliente** (`heartbeatMs`, 35 s) — reenvía la última posición conocida
  cuando el GPS lleva rato callado.

El ritmo lo publica el servidor en `GET /tracking/config`, no lo fija una
constante en la app: dos números en dos repos se desincronizan, y el
síntoma sería otra vez un domiciliario desapareciendo del mapa.

El margen de 5 s no es decorativo — un latido exacto de 30 s caería en el
borde del filtro del servidor y la mitad se perdería por décimas.

### Cuando algo no aparece en el mapa

```bash
cd backend && npm run tracking:status
```

Dice, por domiciliario: si está en servicio, hace cuánto reportó, con qué
precisión, cuánta batería y cuántos puntos de rastro lleva. El seguimiento
GPS falla en silencio por naturaleza —nadie lanza un error cuando un punto
deja de llegar— así que sin esta foto la única alternativa es adivinar.

Avisa además cuando la precisión roza el techo: en interiores los fixes se
descartan por imprecisos y ese es el motivo más común de "desaparece del
mapa". Para probar bajo techo, sube `TRACKING_MAX_ACCURACY_METERS`.

### Qué ve cada rol

| Rol | Dónde | Qué |
|---|---|---|
| Cliente | seguimiento del pedido | repartidor en vivo, ruta, rastro recorrido y ETA real |
| Repartidor | pedido activo | ruta óptima al local o al cliente, con recálculo al desviarse |
| Admin | **Flota en Vivo** | todos los repartidores, su estado, batería y pedido en curso |

La ruta del repartidor cambia sola al recoger el pedido: antes de recoger
apunta al local, después al cliente. El desvío se detecta en el teléfono
—mide contra el punto más cercano del trazado, no contra el destino— y se
**avisa** en vez de recalcular en silencio: a veces el desvío es
intencionado y la ruta no debe cambiar bajo los pies de quien conduce.

### Permisos de ubicación

Se piden **al conectarse**, no al abrir la app: un diálogo sin contexto se
rechaza casi siempre, y en Android ese rechazo puede ser definitivo.
Primero "mientras uso la app" y solo después "siempre" — pedir el de fondo
primero es un rechazo automático en Android 11+ e iOS.

Con permiso solo de primer plano el seguimiento funciona con la app
abierta, y se avisa de la limitación. No se bloquea el trabajo por ello.

> El seguimiento en segundo plano **no funciona en Expo Go**: requiere un
> development build. Todo lo demás —mapas, rutas, ETA, seguimiento con la
> app abierta— sí funciona en Expo Go.

### Asignación automática (preparada, no activada)

`findNearestDrivers()` en `tracking.service.ts` devuelve el ranking de
repartidores **por tiempo real de llegada**, no por línea recta: MongoDB
recorta candidatos con el índice `2dsphere` que ya existía y la Matrix API
de Mapbox los reordena. El más cercano en línea recta puede estar al otro
lado de un río y llegar diez minutos después.

Hoy se consulta desde el panel (`GET /tracking/nearest`) para comparar
contra la asignación manual. Activarla es conectar esa misma función a la
creación del pedido en `order.service.ts`.

---

## Pagos

La plataforma no depende de ningún proveedor concreto: habla con la interfaz
[`PaymentProvider`](backend/src/services/payments/provider.ts).

`PAYMENT_PROVIDER=sandbox` (por defecto) usa un proveedor local
**completamente funcional**: crea intentos con identificadores reales, los
mueve entre estados, firma y verifica webhooks con HMAC y soporta
reembolsos. Los importes cuyos dos últimos dígitos coinciden con
`SANDBOX_FAIL_SUFFIX` (13 por defecto) se rechazan, para poder probar el
camino de fallo.

**Para conectar un proveedor real** (Wompi, Stripe, Mercado Pago):

1. Implementa `PaymentProvider` en `backend/src/services/payments/`.
2. Regístralo en el `registry` de
   [payments/index.ts](backend/src/services/payments/index.ts).
3. Cambia `PAYMENT_PROVIDER` y añade sus credenciales al `.env`.

Nada más cambia: ni la lógica de negocio, ni los controladores, ni la app.

### Publicidad: oferta y antifraude

- Valores de lanzamiento (2026-10-19, `AD_LAUNCH_OFFER`): CPC $100–$1.000, tope
  por campaña $10.000–$500.000, 1–30 días. Se cambian en *Tarifas y Precios* sin
  tocar código; los interruptores nacen apagados.
- Ubicaciones que existen de verdad: `splash` (al abrir la app) y `explore`
  (feed de descubrimiento). Resultados de búsqueda y listado de negocios **no son
  una superficie publicitaria todavía** y no se ofrecen. El lanzamiento usa `explore`.
- Un clic se cobra si: es el primero del dispositivo —y de la cuenta— en la
  ventana (1.440 min, día de Colombia), ese dispositivo vio la campaña en los
  últimos 30 min, no llegó antes de 500 ms ni con agente de automatización, el cupo
  diario de la **red** (10; reservado de forma atómica, `AdNetworkQuota`) no está
  lleno y queda presupuesto. La IP nunca es la identidad: solo limita cuántos
  clics cobrables caben desde ella. Cada clic deja en `AdClick` su veredicto,
  señales, retraso y versión de configuración; los sospechosos (`review`) no se
  cobran y se investigan en `GET /advertisements/:id/clicks`.

### Datos del cliente en el historial del comercio

Pasados `CUSTOMER_CONTACT_WINDOW_DAYS` (7) días calendario desde la entrega o
cancelación, el historial deja de mostrar la dirección y reduce el nombre
(`personalDataProtected`), y pedir contacto con el cliente es una excepción: lleva
justificación y queda detenida hasta que soporte o administración la autorice o la
niegue (`PATCH /pqrs/:id/contact-exception`). Nunca se rechaza sin salida: una
garantía puede vencer después. La base conserva todo.

### Cierre, suspensión y desactivación de un negocio (M-026)

Tres cosas distintas sobre estados que ya existían: el **cierre voluntario**
(`isActive` + `reopenAt`, del dueño), la **suspensión de ZIPP** (`isSuspended`) y la
**desactivación definitiva** (`isArchived`). La suspensión prevalece sobre el
interruptor del dueño en todos los puntos de entrada: ni el dueño, ni el personal,
ni un administrador por «abrir» la levantan; solo el procedimiento de suspensión,
con motivo, a nombre de quien lo autoriza (`adminStatusLog`). Un negocio suspendido
no recibe, anuncia ni acepta pedidos nuevos (lo ya aceptado sí lo termina) y su
cierre temporal no se reabre solo. Desactivar desde los términos comerciales es
suspender. Restaurar un archivado exige motivo y lo deja cerrado.

---

## Variables de entorno

La referencia completa y comentada está en
[backend/.env.example](backend/.env.example). Las que más importan:

| Variable | Para qué | Por defecto |
|---|---|---|
| `MONGODB_URI` | Conexión a MongoDB | `mongodb://localhost:27017/zipp` |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | Firma de tokens (**obligatorias y distintas**) | — |
| `ENCRYPTION_KEY` / `CSRF_SECRET` | Cifrado y CSRF (**obligatorias**) | — |
| `PAYMENT_PROVIDER` | Proveedor de pagos | `sandbox` |
| `GOOGLE_MAPS_API_KEY` | Geocoding (opcional) | vacío |
| `MAPBOX_ACCESS_TOKEN` | Mapas, rutas y ETA (token **público** `pk.`) | vacío |
| `TRACKING_MIN_PERSIST_MS` | Mínimo entre escrituras de posición | `5000` |
| `TRACKING_STALE_AFTER_MS` | Sin señal por más de esto = "perdido" | `90000` |
| `TRACKING_HISTORY_DAYS` | Retención del rastro de una entrega | `30` |
| `DELIVERY_BASE_FEE` / `DELIVERY_PER_KM` | Tarifa de domicilio | `4000` / `900` |
| `DELIVERY_MAX_RADIUS_KM` | Límite de cobertura | `12` |
| `PLATFORM_COMMISSION_RATE` | Comisión de la plataforma | `0.10` |
| `PLATFORM_TAX_RATE` | Impuesto añadido | `0` |
| `AUTH_RATE_LIMIT_MAX` | Intentos de autenticación por ventana | `10` |
| `RATE_LIMIT_MAX` | Peticiones por IP cada 15 min (toda la API) | `10000` |
| `RATE_LIMIT_PER_USER_MAX` | Peticiones por cuenta autenticada cada 15 min | `1000` |
| `MONGO_MAX_POOL_SIZE` | Conexiones concurrentes a MongoDB por proceso | `200` |

Sin `GOOGLE_MAPS_API_KEY` la distancia se calcula con la fórmula de
Haversine sobre las coordenadas guardadas: funciona sin conexión y es
determinista.

---

## Despliegue

```bash
cd backend
npm run build      # compila a dist/
npm start          # node dist/app.js
```

Antes de desplegar:

1. `NODE_ENV=production`.
2. Los cuatro secretos definidos, largos y únicos (el arranque falla si no).
3. `CLIENT_URL`, `ADMIN_URL` y `BUSINESS_URL` apuntando a los dominios reales
   — el CORS los usa como lista blanca.
4. MongoDB con réplica y copias de seguridad.
5. HTTPS por delante (la app confía en `X-Forwarded-For`: `trust proxy` está
   activo).

Los paneles se compilan con `npm run build` y se sirven como estáticos.

### Con Docker

```bash
cp backend/.env.example backend/.env   # y completa los secretos
docker compose up -d                   # MongoDB + API
docker compose logs -f api
```

La imagen es multi-etapa: compila con las dependencias de desarrollo y
ejecuta sin ellas, como usuario `node` (no root) y con `dumb-init` como
PID 1 — sin él, el `SIGTERM` del orquestador no llega al apagado ordenado
y el contenedor muere con peticiones a medias. El `HEALTHCHECK` usa el
mismo `/health` que ya comprueba la conexión con Mongo, así que un
contenedor que responde pero no puede leer la base no recibe tráfico.

Los tres frontends no están en el compose a propósito: son estáticos y en
desarrollo se sirven con Vite, donde meterlos en un contenedor solo añade
una capa entre el editor y el recambio en caliente.

`docker compose down -v` **borra la base de datos**; sin `-v` la conserva.

---

## Seguridad

- Contraseñas con **Argon2id**; verificación de hashes bcrypt heredados con
  migración automática.
- Tokens de acceso de 15 minutos y refresh de 7 días **con rotación** y
  detección de reutilización (si se reutiliza un refresh token, se revocan
  todas las sesiones).
- Bloqueo por fuerza bruta por IP y por cuenta.
- 2FA TOTP con códigos de recuperación.
- Roles y permisos (RBAC), auditoría y detección de fraude.
- Helmet, CORS con lista blanca, sanitización NoSQL, protección HPP y límites
  de peticiones.
- Content-Security-Policy de los paneles de administración y de comercios, en
  modo **solo-informe** (`deploy/nginx/csp-*.conf`). Las infracciones llegan a
  `POST /api/v1/csp-report` y se leen en `GET /api/v1/security/csp-violations`.
  Pasar a bloqueo exige recorrer cada panel en un navegador con el dominio real: los
  pasos están en cada archivo.

**Nunca subas `.env` al repositorio.** El [.gitignore](.gitignore) raíz lo
excluye.
