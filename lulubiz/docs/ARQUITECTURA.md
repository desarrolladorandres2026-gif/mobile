# Lulubiz: arquitectura

Pila: React 19 con JSX y Tailwind 4, Node.js con JavaScript (sin TypeScript), Fastify y MongoDB (Atlas). Primer país: Colombia. Alcance: mundial, con muchas empresas y grandes volúmenes.

Sin tipos estáticos, la validación en tiempo de ejecución es la defensa: cada importe, moneda, identificador y estructura se valida en la entrada de cada operación.

## 1. Principios

1. **El dinero es entero.** Unidades menores (centavos) más código de moneda ISO 4217. Nunca números decimales. En la interfaz, el texto se convierte con BigInt y cadenas, sin pasar por decimales.
2. **El libro solo se agrega.** No hay actualizar ni borrar asientos. Una corrección es un asiento de reversión.
3. **Toda consulta lleva `tenantId`**, garantizado en una sola capa (`TenantCollection`), no por disciplina de cada desarrollador.
4. **Un asiento es todo o nada.** Asiento, consecutivo, compuerta de período, saldos **y evento de auditoría** van en la misma transacción.
5. **Toda escritura es repetible** con una clave de idempotencia.
6. **Nada de estado en memoria del proceso** del que dependa la corrección (los límites en memoria son una optimización, ver §12).

## 2. Tenencia

- Cada documento de negocio tiene `tenantId` como primer campo de todo índice.
- `TenantCollection` es la única forma de tocar una colección de negocio: inyecta `tenantId`, rechaza filtros que traigan el suyo y no expone borrados masivos. Las colecciones de identidad global (`users`, `sessions`, `tokens`) son la excepción documentada y viven solo en el módulo de autenticación.
- Clave de fragmentación prevista: `{ tenantId: 1, createdAt: 1 }` en las colecciones grandes. Solo `tenantId` crearía una partición caliente con un cliente grande. Fragmentación y zonas por región: diseñadas, no activadas.

## 3. Libro contable

| Colección | Contenido | Se modifica |
|---|---|---|
| `journals` | Asiento: fecha, período, moneda, número, líneas (máx. 500), origen | Nunca |
| `balances` | Saldo por cuenta, período y moneda | Solo `$inc`, en la transacción del asiento |
| `counters` | Consecutivo por empresa y tipo de documento | Solo `$inc` atómico |
| `periods` | Estado del período (abierto o cerrado) y compuerta de cierre | Cierre y reapertura |
| `accounts` | Plan de cuentas | Se desactiva, nunca se borra (y se puede reactivar) |
| `audit` | Bitácora, solo de agregar | Nunca |

Reglas:
- Un asiento tiene líneas con `debit` o `credit` enteros no negativos, en una sola moneda, con débitos iguales a créditos. Solo se contabiliza en cuentas que existen, están activas y admiten asientos.
- El consecutivo no tiene huecos: se asigna dentro de la transacción y, si falla, no se consume.
- Idempotencia: índice único `(tenantId, idempotencyKey)`. Repetir devuelve el original sin tocar saldos.
- Reversión: asiento con `reversesJournalId` y líneas invertidas; índice único impide revertir dos veces. No revalida las cuentas (corregir un error no puede depender de una cuenta desactivada después) pero respeta el cierre del período.
- **Cierre de períodos.** Cada asiento incrementa el documento del período con la condición `status: 'open'`. Cerrar modifica ese mismo documento, así que un cierre y un asiento simultáneos chocan y se serializan en lugar de cruzarse.
- Escritura `majority`, lectura `snapshot`. La función de cada transacción se repite si choca, con espera aleatoria creciente entre reintentos.

## 4. Autenticación y permisos

- **Contraseñas:** scrypt (N=2^16, r=8, p=2), mínimo 12 caracteres. Los parámetros viajan con el hash para endurecerlos después. Un inicio de sesión con esos parámetros tardó ≈211 ms en una máquina de desarrollo.
- **Sesiones** en el servidor (MongoDB): el token se entrega una vez y solo queda su SHA-256. Vence a los 30 min sin actividad y a las 12 h en total, y se revoca al instante.
- Un fallo de inicio de sesión (correo, contraseña o bloqueo) responde siempre igual. Cinco fallos bloquean la cuenta 15 min.
- **Verificación de correo, recuperación de contraseña e invitaciones** con tokens de un solo uso (solo se guarda su hash), con vencimiento (24 h, 1 h y 7 días) y atómicos: dos usos simultáneos no pueden ganar los dos. Los enlaces llevan el token en el fragmento de la URL, que el navegador no envía al servidor. Recuperar la contraseña cierra todas las sesiones y avisa por correo. Solo quien confirmó su propio correo puede invitar.
- **Verificación en dos pasos (TOTP, RFC 6238)**, validada contra los vectores oficiales. El secreto se guarda cifrado con AES-256-GCM; hay 10 códigos de recuperación (solo su hash). Un código sirve una sola vez, incluso en carreras. Los fallos se acumulan entre desafíos y bloquean la cuenta: no se puede forzar pidiendo desafíos nuevos.
- Un usuario es una identidad global; la pertenencia a una empresa (`memberships`) lleva un rol. Roles: propietario, administrador, contador y lector. Lo que la matriz no lista está denegado. Un administrador no nombra, degrada ni quita propietarios, y la empresa nunca queda sin propietario.

## 5. API HTTP (Fastify)

- Esquemas estrictos en todo cuerpo, sin conversión de tipos: un importe `"100"` como texto es un error. Solo JSON.
- La autenticación ocurre antes de validar el cuerpo. Rutas de empresa bajo `/v1/tenants/:tenantId/...`, con una única comprobación de sesión, pertenencia y permiso.
- Cookie `HttpOnly`, `SameSite=Strict`, `Secure` en producción; además, un `Origin` presente debe estar en `ALLOWED_ORIGINS`. Sin CORS: el navegador entra por el mismo origen.
- `Cache-Control: no-store` en toda la API. Límite de peticiones por IP (global, inicio de sesión, registro, recuperación, dos pasos, tokens).
- Las escrituras del libro exigen `Idempotency-Key`. Un servicio saturado responde 503 con `Retry-After`. Los errores inesperados responden 500 genérico.

## 6. Observabilidad y auditoría

- Log estructurado (pino) con `requestId`, `tenantId` y `userId`; las cabeceras `cookie` y `authorization` se ocultan.
- `/healthz`, `/readyz` (ping a la base) y `/metrics` en formato Prometheus (peticiones y duración por método, ruta-patrón y estado), con `METRICS_TOKEN`.
- **Reporte de errores**: interfaz mínima `report(err, contexto)` con adaptador de log y de webhook (limitado a 30 por minuto). Solo viaja una lista fija de campos (id de petición, ruta, estado, empresa, usuario), nunca cookies, cabeceras ni cuerpos. Captura promesas rechazadas y excepciones sin atrapar. El destino real es una decisión de despliegue (`ERROR_WEBHOOK_URL`); conectar un servicio concreto es un adaptador de pocas líneas.
- **Auditoría atómica**: cada operación que escribe recibe `inTx(session, resultado)` y registra su evento con la misma sesión. Si el evento no se puede escribir, la operación tampoco se confirma (probado). Los inicios de sesión se anotan sin empresa (ocurren antes de elegirla) y los fallidos sueltos.

## 7. Permisos de la base de datos

La aplicación se conecta con un usuario de rol `lulubiz_app`, creado por `npm run db:setup` con credenciales de administración:
- `journals` y `audit`: solo `find` e `insert`. Ni el código, ni una vulnerabilidad, ni una credencial filtrada pueden editar o borrar un asiento ni un evento.
- Solo se borra lo que caduca o se retira: sesiones, tokens y membresías.
- No puede crear ni borrar colecciones ni índices (los crea `db:setup`), ni usar `$out`, ni leer otras bases, ni administrar usuarios.

Probado contra un MongoDB con autenticación real: toda la aplicación funciona de punta a punta con solo esos permisos, y cada operación prohibida se rechaza.

## 8. Rendimiento medido

Un nodo local de MongoDB en una máquina de desarrollo (`npm run bench`). **No son cifras de un clúster real**: ahí hay red, replicación a varios nodos y fragmentación.

| Escenario | Resultado |
|---|---|
| Lecturas con 200 000 asientos de una empresa (reciente, por período, por cuenta, página profunda) | p50 ≈ 1 ms; cada consulta examina exactamente las filas que devuelve (usa índice) |
| Saldo de una cuenta | p50 ≈ 0,3 ms |
| Asientos, 1 empresa, 1, 8 y 32 clientes simultáneos | ≈130/s estables; p99 ≈ 257 ms con 32 clientes |
| Asientos, 20 empresas, 32 clientes simultáneos | ≈825/s |

Antes de limitar la concurrencia por empresa, una sola empresa con 32 escritores simultáneos caía a 47/s con p99 de 3,7 s: todos los asientos pelean por los mismos documentos (consecutivo, compuerta del período, saldos) y los reintentos en cadena empeoraban todo. Hoy una escritura por empresa a la vez en cada proceso (`concurrencyPerTenant`), con cola acotada y espera máxima de 10 s (después responde 503).

**Techo conocido:** el consecutivo sin huecos obliga a serializar los asientos de una empresa por tipo de documento. El rendimiento por empresa está acotado por la latencia de una transacción (≈8 ms local; en Atlas, más). Para volúmenes muy superiores por empresa, la salida es repartir series de numeración (por caja o por terminal), no más concurrencia.

## 9. Facturación electrónica (fase 1)

Módulo `backend/src/invoicing/`. Factura y nota crédito electrónicas a través de un **proveedor tecnológico autorizado por la autoridad tributaria**; Lulubiz no firma ni transmite por su cuenta.

- **Contrato del proveedor** (`provider.js`): `issue({kind, reference, document})` es idempotente por `reference` y devuelve aceptada (`cufe`, `qr`, `validatedAt`), rechazada (con motivo) o lanza `ProviderUnavailableError`; `status(reference)` consulta. Hay un **simulador** (`sandbox`): CUFE falso con prefijo `SANDBOX-`, el cliente llamado `RECHAZAR` provoca un rechazo y `TIMEOUT` una primera falta de respuesta. Es el predeterminado fuera de producción; `INVOICING_PROVIDER=sandbox` **impide arrancar en producción**, porque sus documentos no tienen validez. En producción sin proveedor configurado la facturación responde `NOT_CONFIGURED` (501).
- **Dinero** (`tax.js`): importes en la unidad menor de la moneda, cantidades en milésimas (1500 = 1,5), descuento e IVA en puntos básicos; aritmética con `BigInt`; cada línea se redondea (mitad hacia arriba) y los totales son la suma de las líneas redondeadas. La interfaz tiene un port de la misma aritmética y una prueba de paridad contra el servidor sobre 5000 casos aleatorios.
- **Configuración por empresa** (`settings.js`): datos del emisor (NIT con dígito de verificación calculado), cuentas contables (por cobrar, ingresos, IVA por pagar, caja opcional) y **resoluciones de numeración** (`resolutions.js`): prefijo, rango, vigencia, sin solapes; el siguiente número se asigna con `$inc` atómico dentro de la transacción, sin huecos.
- **Flujo de emisión** (`invoices.js`): 1) reserva de número y documento en estado `pending_provider`, 2) llamada al proveedor **fuera** de cualquier transacción de base de datos, 3) si valida, el documento pasa a `issued` y se contabiliza (asiento `FV` o `NC`) en una transacción junto con su auditoría. Con el proveedor caído la factura queda pendiente y `sync` la reintenta con la misma `reference` (no duplica). Si el proveedor validó pero la contabilidad falla (por ejemplo, período cerrado), la factura queda `issued` con `accounting.status: 'pending'` y se contabiliza después con `account`.
- **Notas crédito**: reservan de forma optimista, con un `updateOne` condicionado, la cantidad, el neto y el IVA acreditados de la factura; al acreditar el resto se usa la diferencia exacta, de modo que dos notas parciales suman exactamente la factura. Una nota rechazada es terminal y libera la reserva. Los motivos válidos (códigos 1 a 5 de la DIAN para Colombia) vienen del país.
- **Permisos**: `invoices:read`, `invoices:issue`, `settings:manage`.
- **Interfaz**: Facturas, Notas crédito y Facturación (configuración y resoluciones). La vista previa de una factura coincide al centavo con el cálculo del servidor.

## 10. Contabilidad completa (fase 2)

### 10.1 Informes contables

Módulo `backend/src/reports/`. Solo lectura, sobre los saldos mensuales por cuenta (`balances`) que el libro actualiza dentro de la transacción de cada asiento; ningún informe suma recorriendo el libro. Rutas `GET /v1/tenants/:tenantId/reports/...` con permiso `reports:read`.

- **Balance de prueba** (`trial-balance`): saldo inicial, débitos, créditos y saldo final por cuenta, con las cuentas de grupo sumando a sus hijas en todos los niveles. `balanced` exige débitos = créditos y saldos inicial y final netos en cero.
- **Estado de resultados** (`income-statement`): ingresos, costos y gastos del rango, utilidad bruta y neta. Los grupos se muestran pero no se suman dos veces.
- **Balance general** (`balance-sheet`): activos, pasivos y patrimonio acumulados al cierre de un período, más el resultado acumulado. Las cuentas de orden quedan fuera de la ecuación y su saldo neto se informa aparte (`memoNet`), de modo que `activo − pasivo − patrimonio − resultado + memoNet = 0` siempre.
- **Libro auxiliar** (`general-ledger`): saldo inicial, asientos en orden cronológico con saldo corrido y saldo final en la última página. Pagina con cursor que lleva los acumulados de la página anterior; así cada página cuesta lo mismo sin releer el libro. Usa el índice `tenant_account_chronological`.
- Una sola moneda por informe, períodos mensuales (AAAA-MM). Una prueba con asientos al azar comprueba que el saldo final del auxiliar de cada cuenta, paginado, coincide con el del balance de prueba y que el balance general cuadra.
- **Cierre de ejercicio:** ver §10.7. Tras cerrar un año, el balance general trae su resultado en el patrimonio y el estado de resultados sigue mostrando la actividad real del año (resta el asiento de cierre); el balance de prueba sí lo incluye.

### 10.2 Cartera: recibos de caja y antigüedad de saldos

Módulo `backend/src/receivables/`. Cierra el ciclo de la venta a crédito: factura → cobro → saldo.

- **Estado de cartera en la factura**: `collectible` (su débito fue a por cobrar; una venta de contado a caja no tiene cartera), `paidTotal` y `balance` = total − acreditado − cobrado. `balance` es un campo mantenido con `$inc` y no un cálculo, para poder indexar solo las facturas abiertas (índice parcial `tenant_invoice_open`). Una nota crédito sobre lo ya cobrado deja `balance` negativo: es saldo a favor del cliente y todavía no hay devolución de dinero.
- **Recibo de caja** (`RC`): aplica el cobro a una o varias facturas del mismo cliente y moneda. El asiento (débito a caja o bancos, crédito a la cuenta por cobrar de cada factura), la baja del saldo y el recibo se confirman en una sola transacción. La baja es una operación condicionada (`balance >= importe`): dos cobros simultáneos a la misma factura no pueden dejarla en negativo, y un recibo con una factura que falla no aplica ninguna. Idempotente por clave. El número del recibo es el consecutivo del asiento `RC`.
- **Anulación**: reversa el asiento y devuelve el saldo a cada factura en la misma transacción; anular dos veces, o a la vez, devuelve el saldo una sola vez. Respeta el cierre de períodos.
- **Asientos de documentos**: los generados por un documento (`source`) ya no se revierten a mano, y los tipos `FV`, `NC`, `RC`, `FC`, `CE`, `NP`, `MI`, `PV`, `CJ` y `CA` quedan reservados a los módulos. Un asiento manual con ellos consumiría su consecutivo y dejaría huecos, y uno revertido a mano dejaría el saldo del documento desactualizado.
- **Cartera por edades** (`receivables/aging`): por cliente, vigente y vencido a 1-30, 31-60, 61-90 y más de 90 días, desde `dueDate` (o la emisión si no la tiene). Una sola agregación sobre el índice parcial. Permisos: `receipts:create` y `receipts:void` (propietario, administrador y contador); la lectura va con `invoices:read`.
- **Prueba de coherencia**: tras facturar, cobrar, acreditar y anular, la suma de `balance` de las facturas con cartera es igual al saldo de la cuenta por cobrar en el libro.
- **Límites**: el recibo debe aplicarse por completo a facturas (el dinero que llega antes de la factura va como anticipo, §10.11); la cartera por edades usa el saldo de hoy, no a una fecha pasada; no hay devolución de saldos a favor.

### 10.3 Compras, notas de proveedor, pagos y cuentas por pagar

Módulo `backend/src/purchases/`. Es el espejo de las ventas, sin proveedor tecnológico: la factura la emitió el proveedor y aquí solo se registra.

- **Factura de compra** (`FC`): proveedor, número de su factura, fechas, líneas (cada una con su cuenta de gasto, costo o activo, y tarifa de IVA del país) y **retenciones** opcionales (nombre, cuenta por pagar de tipo pasivo, base subtotal o IVA y tarifa en puntos básicos; importe con `BigInt`, medio hacia arriba). El asiento debita gastos e IVA descontable y acredita Proveedores (total − retenciones) y cada retención. `balance` = lo que falta pagar; se mantiene con `$inc` y condiciones en el filtro. La misma factura del proveedor no se registra dos veces (índice único parcial por proveedor y número mientras no esté anulada); anulable solo sin pagos ni notas.
- **Nota de proveedor** (`NP`): devolución o descuento sobre una compra, por líneas o por todo lo que queda. Reserva de forma optimista, con un filtro de igualdad, lo ya acreditado; devuelve las retenciones en proporción y, si agota la factura, con la diferencia exacta. Las notas simultáneas se reintentan y la que no cabe falla con `OVER_CREDIT`. Anulable: reversa su asiento y libera lo reservado.
- **Pago** (`CE`, comprobante de egreso): aplica el dinero que sale a una o varias facturas del mismo proveedor y moneda, con baja condicionada del saldo (`balance >= importe`), asiento y comprobante en una sola transacción, idempotente y anulable.
- **Cuentas por pagar por edades**: igual que la cartera, sobre el índice parcial de compras abiertas.
- **Configuración**: `payable` (Proveedores) y `vatDeductible` (IVA descontable) en las cuentas de Facturación; sin ellas la compra responde `SETTINGS_INCOMPLETE` y la pantalla dice qué falta.
- **Permisos**: `purchases:read` (todos los roles), `purchases:create`, `purchases:void`, `payments:create`, `payments:void` (propietario, administrador y contador).
- **Prueba de coherencia**: tras comprar, pagar, acreditar y anular, la suma de `balance` de las compras vigentes es el saldo de la cuenta de proveedores en el libro.
- **Límites**: las retenciones las define quien registra la compra (el sistema no aplica tablas de bases mínimas ni conceptos de retención de un país); el pago debe aplicarse por completo a facturas (lo que se entrega antes de la factura va como anticipo, §10.11); una nota sobre una factura ya pagada deja saldo a favor y no hay reintegro. Los asientos de cada documento comparten el consecutivo de su tipo con sus anulaciones: tras anular `RC1` el siguiente recibo es `RC3`, porque `RC2` es el asiento de la anulación.

### 10.4 Inventario

Módulo `backend/src/inventory/`. Costo promedio ponderado, permanente: cada movimiento deja el saldo en cantidad y valor.

- **Datos**: artículo (`goods` con cuenta de inventario y de costo de ventas, o `service` sin existencias), bodega (la principal se crea con el primer movimiento), existencia (una por artículo y bodega: cantidad en milésimas y valor en unidades menores; el costo promedio es valor / cantidad) y movimiento (solo se agrega, nunca se edita: se corrige con otro de signo contrario). Las cuentas de inventario y de costo de un artículo no cambian cuando ya tiene movimientos.
- **Costo**: una salida cuesta el promedio del momento y sacar todo cuesta todo el valor, así que no quedan residuos. Las entradas traen su valor (compra, ajuste, devolución); los reversos salen por el valor exacto con el que entraron.
- **Concurrencia**: una salida se planea leyendo y se aplica con una condición de igualdad sobre cantidad y valor. Si otra operación movió esa existencia entremedias falla con `STOCK_CONFLICT` y quien llama repite todo con un desfase aleatorio (`withStockRetry`). Una existencia nunca queda negativa.
- **Compras**: una línea con `itemId` entra a la bodega por su neto (con descuento y sin IVA) y su cuenta es la de inventario del artículo, no la que escriba quien registra. Anular la compra o acreditarla por una nota de proveedor saca exactamente lo que entró; si parte ya se vendió, la operación entera se rechaza (`INSUFFICIENT_STOCK`) y no cambia nada. Anular la nota vuelve a meter.
- **Ventas**: una línea de factura con `itemId` es un bien del inventario. Al crear, un aviso temprano (sin gastar un número de la resolución) comprueba que hay existencias. La salida definitiva ocurre al **contabilizar**, en la misma transacción que el asiento `FV`: la existencia sale al promedio de ese momento y el asiento suma débito a costo de ventas y crédito a inventario. El costo por línea queda en `stockCost`. Si entre la creación y la validación del proveedor se agotó, la factura (ya válida ante el proveedor) queda emitida con la contabilización pendiente y se contabiliza con «Contabilizar» al reponer. El proveedor de facturación no recibe nada del inventario.
- **Devoluciones de venta**: una nota crédito cuyo motivo devuelve bienes (`returnsGoods` en el paquete del país: devolución y anulación) regresa los bienes al inventario **al costo al que salieron**, no al promedio de hoy, y revierte ese costo en su asiento. El costo se fija al crear la nota junto con lo demás que reserva (`credited.restocked` y `credited.cost`); devolver todo en varias notas suma exactamente el costo original, y una rebaja previa sobre las mismas unidades no lo altera. Una nota rechazada por el proveedor libera lo reservado. Con la factura sin contabilizar todavía no se devuelven sus bienes (`INVALID_STATE`).
- **Cuadre con el libro**: `inventory/valuation` compara, por cuenta de inventario, el valor de las existencias con el saldo contable; la diferencia debe ser cero y la pantalla avisa si no lo es. Las pruebas lo comprueban después de cada operación de compras, ventas, devoluciones, ajustes y traspasos.
- **Ajustes y traspasos**: un ajuste (`MI`) lleva su asiento contra una cuenta contrapartida; un traspaso (`TR`) mueve mercancía entre bodegas al costo promedio de origen sin tocar el libro. Idempotentes por clave.
- **Permisos**: `inventory:read` (todos los roles), `inventory:manage` (artículos y bodegas) e `inventory:adjust` (ajustes y traspasos) para propietario, administrador y contador.
- **Límites**: sin lotes, series ni vencimientos; sin costeo FIFO ni recosteo (el costo de una venta queda fijo al contabilizarla aunque después se corrija una compra anterior); sin reservas de existencias ni pedidos; los ajustes y traspasos no se anulan, se corrigen con otro; una nota crédito de rebaja no mueve existencias.

### 10.5 Punto de venta

Módulo `backend/src/pos/`. Venta de mostrador con turnos de caja, pensada para que un cajero cobre rápido sin tocar la contabilidad.

- **Caja**: código (prefijo de su numeración: `CAJA1-000012`), cuentas de cobro por método (`cash` obligatoria; `card` y `transfer` opcionales: sin cuenta, esa caja no recibe ese método), cuentas de `shortage` (gasto) y `surplus` (ingreso) para las diferencias del cierre, y bodega opcional (la principal por defecto). Con un turno abierto no se cambian sus cuentas ni se desactiva.
- **Turno**: una caja tiene a lo sumo uno abierto (índice único parcial; dos aperturas simultáneas, una sola gana). Guarda el efectivo inicial y los totales vivos (`salesCount`, `salesTotal`, `cashTotal`, `cardTotal`, `transferTotal`, `voidedCount`, `voidedTotal`) que cada venta o anulación ajusta con `$inc` y con el turno abierto como condición: una venta no entra a un turno que se cerró.
- **Venta** (asiento `PV`): líneas como las de una factura (con `itemId` salen del inventario al costo promedio, en la misma transacción, con costo de ventas contra inventario), cliente opcional («consumidor final» si no hay), pagos mixtos (efectivo, tarjeta, transferencia; uno por método) que suman exactamente el total, y efectivo recibido solo para calcular el cambio. El consecutivo es por caja (contador `lastSale` dentro de la transacción), así que dos cajas no compiten por numeración; el asiento `PV` sigue siendo uno por empresa. Idempotente por clave. Si no hay existencias, la venta entera se rechaza y no cambia nada.
- **Anulación**: solo con el turno abierto (permiso aparte, `pos:void`, que el cajero no tiene). Reversa el asiento, regresa los bienes al costo al que salieron y descuenta la venta de los totales del turno. Con el turno cerrado ya no se anula: se corrige con un ajuste.
- **Cierre** (asiento `CJ`): efectivo esperado = efectivo inicial + cobrado en efectivo (las anuladas no cuentan). Se compara con el contado y la diferencia se asienta contra la cuenta de faltantes o sobrantes de la caja; el cajero no elige cuenta contable (indicarla a mano exige `pos:manage`). Una condición de igualdad sobre los totales del turno hace que una venta que entre mientras se cierra obligue a recalcular: el cierre siempre cuenta todo lo vendido o la venta se rechaza. El efectivo inicial no mueve la contabilidad, ya estaba en la caja.
- **Rol y permisos**: `cashier` (cajero) tiene `pos:read`, `pos:sell`, `inventory:read` y `parties:read`: vende, abre y cierra su turno, pero no ve asientos, informes ni facturas, ni anula, ni configura cajas. `pos:void` y `pos:manage` van con propietario, administrador y contador; `pos:read` lo tienen todos.
- **Prueba de coherencia**: tras vender, anular y cerrar, el efectivo del libro es lo cobrado menos lo anulado más el sobrante, y el inventario cuadra con su cuenta.
- **Límites**: no emite documento electrónico (el equivalente POS de la DIAN depende del proveedor y todavía no hay uno real: hasta entonces estas ventas no tienen validez ante la DIAN); no hay devoluciones sobre un turno cerrado ni cambios de producto; los precios de los artículos con precio no se pueden cambiar en caja, pero no hay descuentos por línea ni permisos finos por cajero; un cajero ve los turnos y ventas de todas las cajas (no solo las suyas); el techo de ventas por segundo es el del libro de la empresa.

### 10.6 API pública: claves de API

Módulo `backend/src/auth/apiKeys.js`. La API pública es la misma de la interfaz (no hay una versión aparte); lo nuevo es cómo se autentica una integración. Referencia para quien integra: [API.md](API.md).

- **Clave**: `lbk_<prefijo de 8 hex>_<secreto de 256 bits>`. El prefijo la identifica (índice único global) y el secreto la prueba. Solo se guarda el SHA-256 del secreto: con 256 bits al azar no hace falta un hash lento, y una copia de la base no permite usar ninguna clave. El token completo se muestra una única vez; la comparación es de tiempo constante.
- **Autenticación**: `Authorization: Bearer <clave>` sobre las mismas rutas de empresa; la guarda de cada ruta prueba la clave contra la empresa de la ruta y el permiso de la ruta, igual que una sesión. La clave pasa a ser `ctx { userId: null, role: 'apikey', apiKeyId }`. Las rutas de sesión (`/v1/auth/*`, `/v1/me`) no admiten claves. Con clave y cookie a la vez, manda la clave.
- **Permisos**: cada clave lleva un subconjunto de permisos, que no puede exceder los de quien la crea. Nunca se pueden dar `tenant:manage`, `users:manage`, `apikeys:manage`, `settings:manage` ni `periods:reopen`: una clave filtrada no puede crear otras claves, invitar personas, cambiar la configuración de facturación ni reabrir un período. Crear claves exige `apikeys:manage` (propietario y administrador) y una sesión.
- **Fallos de identidad indistinguibles**: clave inexistente, secreto equivocado, vencida, revocada o de otra empresa responden lo mismo (`401 INVALID_CREDENTIALS`); solo un permiso que falta es `403`. No hay forma de saber desde fuera si una clave existe.
- **Vida de una clave**: vencimiento opcional (vale hasta el final de ese día), revocación inmediata e idempotente, máximo de 20 activas por empresa. Pertenece a la empresa: sigue valiendo si quien la creó se va. `lastUsedAt` se actualiza como máximo cada 5 minutos para no escribir en cada petición.
- **CSRF**: una petición con clave no está sujeta a la defensa de `Origin` (la clave viaja en una cabecera que un sitio ajeno no puede añadir a una petición del navegador); la sesión por cookie sigue sujeta.
- **Auditoría**: lo que hace una clave queda con `apiKeyId` y sin `userId`; crear y revocar claves también se audita. La pantalla de auditoría la nombra.
- **Documentación que no se desactualiza**: `docs/API.md` lleva una tabla de rutas y permisos generada de las rutas registradas; una prueba falla si una ruta nueva no aparece, si cambia su permiso, o si un permiso que se puede dar a una clave no protege ninguna ruta.
- **Límites**: sin OpenAPI ni clientes generados, sin webhooks, sin cuota propia por clave ni restricción por IP (comparten el límite de 300 por minuto de la dirección desde la que llaman). La clave no distingue entornos (prueba y producción) porque no hay un entorno de pruebas aparte.

### 10.7 Cierre de ejercicio

Módulo `backend/src/closing/yearEnd.js`. Lleva a cero, con un solo asiento `CA` fechado el 31 de diciembre, las cuentas de ingresos, costos y gastos del año (de una moneda) y pasa la diferencia al patrimonio: utilidad al crédito de la cuenta que se indique, pérdida al débito de la cuenta de pérdida (que por defecto es la misma). El año siguiente empieza de cero.

- **Orden**: no se cierra un año si uno anterior con movimiento de resultados no tiene cierre vigente (su resultado quedaría mezclado con el de este). Tampoco se cierra un año que no ha terminado, ni uno sin movimiento.
- **Idempotencia**: cerrar un año ya cerrado devuelve el cierre existente; dos cierres simultáneos asientan uno solo (la clave del asiento incluye el número de intento, así que tras una reapertura se puede cerrar de nuevo).
- **Integridad del resultado**: si con este cierre quedan cerradas todas las monedas que tuvieron movimiento de resultados en el año, se cierran también los doce períodos (marcados con `closedByYear`). Así ningún asiento tardío descuadra un resultado que ya está en el patrimonio. Con varias monedas, los períodos se cierran al cerrar la última. Un período marcado no se reabre suelto: se reabre el ejercicio (`POST /periods/:period/reopen` responde `INVALID_STATE`).
- **Reapertura** (`periods:reopen`): reabre los períodos que cerró el cierre y reversa el asiento; solo si no hay un ejercicio posterior cerrado. Si la reversión falla, los períodos vuelven a quedar cerrados. El asiento de cierre no se revierte a mano (es un asiento de documento).
- **Informes**: el balance general no necesita ajuste (el resultado queda en el patrimonio). El estado de resultados resta el asiento de cierre y su reversión para mostrar la actividad real del año; sin esto, el de diciembre saldría en cero justo después de cerrar. El balance de prueba sí incluye el cierre.
- **Permisos**: ver y calcular la vista previa, `reports:read`; cerrar, `periods:manage` (propietario, administrador y contador); reabrir, `periods:reopen` (propietario y administrador).
- **Límites**: el asiento va en el período de diciembre, que debe estar abierto (si se cerró a mano, hay que reabrirlo); no hay asientos de ajuste de cierre propios ni «período 13»; una cuenta de resultados de un año cerrado no puede recibir asientos tardíos sin reabrir el ejercicio; el cierre no distribuye utilidades ni crea reservas (eso es un asiento manual del año siguiente).

### 10.8 Preparación del piloto: primeros pasos e importación

No son un módulo contable sino lo que un cliente nuevo necesita desde el primer día. Manual de operación: [OPERACION.md](OPERACION.md).

- **Primeros pasos** (`GET /onboarding`, `reports:read`; `backend/src/onboarding/`): una vista calculada sobre la configuración y los datos, sin guardar nada, así que nunca se desactualiza. Cada paso dice si está hecho, si es obligatorio o recomendable, qué falta exactamente y a qué pantalla ir. Obligatorios: plan de cuentas, datos del emisor y cuentas, resoluciones de numeración vigentes (facturas y notas crédito), cuentas de compras y proveedor de facturación. El proveedor en modo de pruebas deja ese paso sin hacer: sus documentos no valen ante la DIAN. Recomendables: terceros, artículos, cajas.
- **Importación** (pantalla «Importar»): terceros y artículos desde CSV, sin endpoints nuevos. El navegador lee el archivo (comillas, saltos de línea dentro de un campo, BOM de Excel, coma, punto y coma o tabulador), valida cada fila con las mismas reglas del formulario y muestra la revisión **sin guardar nada**: filas listas y filas con su problema y su línea del archivo. Al confirmar crea las filas válidas de a una por la API de siempre, sin detenerse en un error. Por eso el servidor sigue siendo quien decide (permisos, dígito del NIT, cuentas que deben existir, duplicados) y no hay una puerta de entrada nueva que proteger.
- **Repetible**: un código de artículo o un documento que ya existe se cuenta como «ya existía» y se omite; repetir la importación no duplica. Dentro del archivo, una clave repetida se rechaza en su segunda aparición.
- **Límites**: hasta 2 000 filas y 2 MB por vez; no es atómica (si falla a mitad, lo creado queda creado y el resumen lo dice); no actualiza lo que ya existe, solo crea; no importa saldos, facturas ni movimientos históricos (los saldos iniciales se cargan con asientos y ajustes de inventario); los importes llevan coma decimal, como en el resto de la interfaz.

### 10.9 Verificador de integridad

`backend/src/scripts/verifyIntegrity.js` y `npm run verify`. Solo lee. Recalcula desde los asientos (que no se pueden editar) lo que el sistema mantiene aparte, y avisa de cualquier diferencia: saldos por cuenta y período, asientos cuadrados, numeración consecutiva sin saltos, existencias contra kardex y contra el libro, documentos contabilizados con su asiento, totales de turno contra sus ventas, ejercicios cerrados en cero, saldos de anticipos, saldos por centro de costo y por tercero, y conciliaciones bancarias. Está pensado para comprobar una base restaurada de una copia de seguridad (la restauración real en Atlas sigue sin probarse), para antes y después de un despliegue y como vigilancia diaria. Las pruebas alteran cada cosa por fuera del sistema y comprueban que la comprobación correspondiente falla y las demás no. No cubre cartera ni cuentas por pagar contra su cuenta del libro porque un asiento manual sobre ellas es legítimo. Ver [OPERACION.md](OPERACION.md) §6.

### 10.10 Libros y estados de cuenta (fase 4, bloque 4a)

Módulo `backend/src/reports/books.js`. Listados de lo emitido y registrado en un rango de fechas, calculados desde los **documentos** (facturas, notas, compras, recibos, pagos), no desde el libro contable: sirven para revisar con el contador o mostrar a un tercero. Solo leen. Permiso `reports:read`.

- **Libro de ventas** (`reports/sales-book`): facturas emitidas (suman) y notas crédito emitidas (restan), con base e IVA por cada tarifa del rango y totales. **Libro de compras** (`reports/purchases-book`): compras vigentes (suman) y notas de proveedor vigentes (restan), con retenciones y lo que se paga. Una factura rechazada o una compra anulada no aparecen.
- **Estado de cuenta de un cliente** (`reports/customer-statement`): facturas a crédito, notas crédito sobre ellas y recibos de caja, con saldo inicial (lo anterior al rango), saldo corrido y saldo final. Una factura de contado a caja no tiene cartera y no aparece; una nota solo cuenta si su factura era a crédito; un recibo anulado deja de contar. **De un proveedor** (`reports/supplier-statement`): compras (lo que se le debe, ya sin retenciones), notas de proveedor y pagos. El saldo final coincide con el `balance` que lleva la propia factura o compra (las pruebas lo comprueban).
- **Ventas netas** (`reports/sales-summary?by=customer|month`): facturas menos notas crédito, por cliente (ordenado por lo vendido) o por mes de emisión.
- **Límite de tamaño**: un rango con más de 2 000 documentos se rechaza con `RANGE_TOO_LARGE` y se pide uno más corto (el mes es lo habitual). Hay índices por empresa, moneda y fecha en facturas, compras y notas.
- **Límites**: el libro de ventas no incluye las ventas de mostrador (todavía no tienen documento electrónico); los formatos no son los oficiales de la DIAN ni los ha validado un contador; no hay exportación a archivo (la interfaz solo muestra); el estado de cuenta es por documentos, no por asientos, así que un asiento manual sobre la cuenta de clientes no aparece en él.

### 10.11 Anticipos de clientes y a proveedores (fase 4, bloque 4b)

Módulo `backend/src/advances/`. Dinero que se recibe de un cliente, o se entrega a un proveedor, antes de que exista la factura.

- **Anticipo de cliente**: recibo de caja (serie `RC`) que debita caja o bancos y acredita una cuenta de **pasivo** (anticipos recibidos). **Anticipo a proveedor**: comprobante de egreso (serie `CE`) que debita una cuenta de **activo** (anticipos entregados) y acredita caja o bancos. Las dos cuentas se configuran en Facturación (`customerAdvance`, `supplierAdvance`); sin ellas el anticipo responde `SETTINGS_INCOMPLETE`, y una cuenta de tipo equivocado también. Idempotente por clave.
- **Aplicar** un anticipo a facturas a crédito (o a compras) mueve el saldo de la cuenta de anticipos a la cuenta por cobrar (o por pagar) y baja el saldo de cada documento, como un cobro o un pago, **sin que entre ni salga dinero**. Asiento `AA` (tipo reservado). Se puede aplicar en varias veces y a varios documentos hasta agotarlo; la fecha no puede ser anterior al anticipo ni al documento.
- **Concurrencia**: la baja del saldo del anticipo y la de cada documento son operaciones condicionadas (`balance >= importe`) en la misma transacción del asiento. Dos aplicaciones simultáneas del mismo dinero: pasa una y la otra responde `OVER_PAYMENT` (hay una prueba). Una aplicación es idempotente por clave.
- **Anulaciones**: una aplicación se anula (reversa su asiento y devuelve los saldos al anticipo y a cada documento); un anticipo solo se anula si no tiene aplicaciones vigentes. Un anticipo anulado no se aplica.
- **Estados de cuenta**: el anticipo cuenta desde que se entrega (saldo a favor del cliente, o dinero ya entregado al proveedor). Aplicarlo no es un movimiento nuevo, así que no se cuenta dos veces: el saldo final del estado de cuenta es lo que debe la factura menos lo que queda sin aplicar del anticipo.
- **Integridad**: el verificador (§10.9) comprueba que el saldo de cada anticipo sea su importe menos sus aplicaciones vigentes.
- **Permisos**: se reutilizan los del cobro y el pago: crear y aplicar con `receipts:create` (cliente) o `payments:create` (proveedor); anular con `receipts:void` o `payments:void`; leer con `invoices:read` o `purchases:read`.
- **Límites**: no hay devolución de un anticipo sobrante al cliente ni cobro de uno al proveedor (se corrige con un asiento manual); un anticipo es de una sola moneda. **Las notas débito quedan fuera de este bloque**: la de venta exige ampliar el contrato con el proveedor de facturación electrónica (documento `debit_note`), que aún no tiene un adaptador real; la de proveedor se hará con el resto de documentos de compras. Las numeraciones comparten serie con sus anulaciones (tras anular `AA1`, la siguiente aplicación es `AA3`).

### 10.12 Centros de costo y tercero en las líneas del asiento (fase 4, bloque 4c)

Módulos `backend/src/costCenters/`, `core/dims.js`, `reports/dimensions.js` y la extensión de `ledger/ledger.js`. Dos dimensiones opcionales por **línea** de asiento, ambas validadas y sumadas dentro de la misma transacción que el asiento.

- **Centro de costo** (`costCenter`): código de hasta 10 caracteres (`A-Z`, `0-9`, `-`, `_`; se guarda en mayúsculas), propio de cada empresa y único dentro de ella. Se crea y edita con `accounts:manage` y se lee con `accounts:read`. Un centro **desactivado** conserva su historia pero el libro rechaza líneas nuevas con él; uno que no existe se rechaza igual.
- **Tercero** (`partyId`): cliente, proveedor u otro tercero de la empresa. El libro comprueba que pertenezca a la empresa (un tercero de otra se rechaza). Los documentos lo ponen solos en la línea de la **cuenta por cobrar** (factura, nota crédito, recibo, anticipo y su aplicación) y de la **cuenta por pagar** (compra, nota de proveedor, pago, anticipo); un asiento manual lo lleva solo si se elige en la línea.
- **Saldos por dimensión** (`dimBalances`): por empresa, dimensión (`costCenter` o `party`), clave, cuenta, período y moneda, con débitos y créditos acumulados por `$inc` dentro de la transacción del asiento. Reversar un asiento copia las dimensiones, así que sus saldos también se reversan. Los reportes leen estos saldos y no recorren asientos.
- **Propagación**: las líneas de factura, compra y nota llevan `costCenter`; los ingresos, gastos y el costo de ventas se agrupan por cuenta **y** centro. Una caja del punto de venta puede tener un centro y lo pone en los ingresos y el costo de todas sus ventas. Las existencias (cuenta de inventario) no llevan centro: lo lleva el costo de la venta.
- **Resultado por centro de costo** (`reports/cost-center-result?from=AAAA-MM&to=AAAA-MM&currency=`): ingresos, costos y gastos de cada centro y una fila «Sin centro de costo» con la diferencia entre el total de cada cuenta y lo asignado; la suma de todas las filas es igual al estado de resultados del mismo rango. El asiento de cierre de ejercicio se descuenta (no lleva centros), igual que en el estado de resultados.
- **Auxiliar de un tercero** (`reports/party-ledger?partyId=&from=AAAA-MM&to=AAAA-MM&currency=`): por cuenta, saldo inicial, débitos, créditos y saldo final del tercero, en la naturaleza de la cuenta, y el detalle de movimientos (tope de 2 000 asientos; más, responde `RANGE_TOO_LARGE`). El saldo de un cliente en la cuenta por cobrar es la suma de lo que le falta pagar a sus facturas.
- **Integridad**: el verificador (§10.9) recalcula los saldos por centro y por tercero desde los asientos y avisa de cualquier diferencia (décima comprobación).
- **Interfaz**: pantalla «Centros de costo» (Contabilidad); columna «Centro de costo» en asientos manuales, facturas y compras, y campo en cajas, **solo cuando la empresa tiene centros activos**; los dos informes están en «Libros y estados de cuenta».
- **Límites**: un centro no se renombra de código ni se borra (se desactiva); no hay presupuesto por centro (bloque 4g); un asiento ya registrado no se reetiqueta, se reversa y se registra de nuevo; las notas crédito heredan el centro de la línea de la factura que corrigen; los reportes son por mes completo; las líneas de impuestos (IVA, retenciones) no llevan centro.

### 10.13 Conciliación bancaria (fase 4, bloque 4d)

Módulo `backend/src/bank/bank.js`. Compara el extracto del banco con lo que dice el libro de una cuenta de activo (bancos o caja), sin tocar el libro: los asientos no se editan, la conciliación vive aparte y se puede deshacer.

- **Extracto** (`bankLines`): fecha, detalle, referencia opcional e importe con signo (positivo entra dinero, o sea débito en el libro). Se carga en la interfaz desde un CSV (fecha, detalle y valor con signo, o dos columnas de entra y sale; fechas AAAA-MM-DD o DD/MM/AAAA; importes con coma o punto decimal). Cada línea tiene una huella (fecha, importe, detalle, referencia y orden entre iguales), así que **volver a cargar el mismo extracto, o uno que se traslapa, no duplica**. Hasta 500 líneas por petición; la interfaz parte los archivos grandes. No es atómica: el resultado dice cuántas se crearon y cuántas se saltaron.
- **Conciliación** (`bankMatches`): une una línea del extracto con una línea de asiento de la misma cuenta, moneda e importe. Dos índices únicos parciales (por línea del libro y por línea del extracto, solo entre las vigentes) garantizan que ninguna se concilie dos veces, ni con peticiones simultáneas: el perdedor recibe `ALREADY_MATCHED`. Deshacer marca la conciliación como no vigente (queda el rastro). Candidatas: el mismo importe a ±10 días (ajustable). **Automática**: solo une lo inequívoco (una sola candidata, que no lo es de otra línea); lo ambiguo se deja a quien concilia.
- **Contabilizar desde el extracto**: una comisión, un impuesto o unos intereses que el libro no tiene se contabilizan desde su línea. Crea el asiento `CB` (serie reservada) contra la cuenta elegida, en la fecha del extracto, y lo concilia en la misma transacción. Idempotente por línea.
- **Saldo inicial**: una línea del libro anterior al extracto se marca como conciliada **sin línea de extracto**, con una razón obligatoria.
- **Resumen a una fecha**: saldo del libro, saldo del extracto (lo escribe quien concilia), partidas del libro sin conciliar (cheques y consignaciones en tránsito) y partidas del banco sin conciliar. «(extracto + pendiente del libro) − (libro + pendiente del banco)» es la **diferencia** y debe ser cero. Una conciliación cuenta a una fecha solo si las dos fechas, la del banco y la del libro, son de esa fecha o anteriores: el cheque que el banco pagó después queda «en tránsito» en el cierre anterior.
- **Cierre**: exige diferencia cero y guarda una fotografía (saldos y conteos). Lo cerrado no se altera: no se cargan líneas, ni se quitan, contabilizan, concilian o deshacen conciliaciones de esa fecha o anteriores (`RECONCILED`). Solo se reabre la última. Cada acción (carga, conciliación, contabilización, cierre, reapertura) deja su evento de auditoría.
- **Permisos**: `bank:read` (contador, lector, administración) y `bank:manage` (contador, administración). El cajero no ve la conciliación.
- **Integridad**: el verificador (§10.9) comprueba que cada conciliación vigente una importes iguales de la misma cuenta y que su línea del libro y la del extracto existan (undécima comprobación).
- **Rendimiento**: las pendientes se calculan con una agregación sobre los asientos de la cuenta y una búsqueda por índice de las conciliaciones; se muestran hasta 1 000 (el total cuenta todas). Pensado para cuentas de bancos de una pyme; con cientos de miles de movimientos sin conciliar habría que cerrar tramos más a menudo.
- **Límites**: una conciliación es de uno a uno (no hay una consignación que cubra varios cheques ni al revés: se contabiliza la diferencia como línea aparte); no lee formatos bancarios propios (OFX, MT940) ni se conecta a los bancos; el saldo del extracto lo escribe una persona; las diferencias de cambio en moneda extranjera no se tratan.

### 10.14 Documentos comerciales y nota débito del proveedor (fase 4, bloque 4e)

Módulo `backend/src/commercial/commercial.js` y la extensión de `purchases/purchases.js`. Cotizaciones, órdenes de compra y facturas recurrentes **no asientan nada por sí mismas**: lo hacen la factura o la compra en que se convierten, con todos sus controles (período abierto, proveedor de facturación, resolución, existencias, centros de costo).

- **Cotización** (`quotes`, `COT-n`): oferta a un cliente con vigencia. Se acepta, se rechaza (y se puede aceptar después), se anula o se **convierte en factura** con la forma de pago y las fechas que se elijan. Una vencida no se acepta ni se factura. No reserva existencias ni congela el precio.
- **Orden de compra** (`purchaseOrders`, `OC-n`): pedido a un proveedor, con cuenta de gasto, costo o activo (o artículo) en cada línea. Se anula o se **recibe**, y recibirla registra la factura de compra con el número de la factura del proveedor. Se recibe completa; no hay recepciones parciales.
- **Conversión**: la factura o la compra se emiten con una clave de idempotencia derivada del documento (`quote-<id>`, `po-<id>`), y el documento pasa por un estado intermedio mientras tanto. Dos conversiones simultáneas producen una sola factura o compra; si la emisión falla (cliente inactivo, número de proveedor repetido, período cerrado), el documento vuelve a su estado y se puede reintentar.
- **Factura recurrente** (`recurringInvoices`): plantilla con cliente, líneas, frecuencia (semanal, mensual, trimestral o anual), primera fecha, fecha final opcional, forma de pago y plazo. Mensual, trimestral y anual conservan el día de inicio (una plantilla del 31 sigue el 30 de abril, el 28 o 29 de febrero y vuelve al 31). **Generar** emite las facturas vencidas hasta hoy (hasta 12 períodos por plantilla por vez, 200 plantillas): cada período lleva la clave `recurring-<plantilla>-<fecha>`, así que repetir la generación o hacerla desde dos lugares no emite dos veces el mismo período. Una factura que falla (o que el proveedor rechaza) **detiene esa plantilla en ese período** con su error visible; se corrige o se salta el período. Las demás plantillas siguen.
- **Quién la ejecuta**: la interfaz («Generar las vencidas», «Generar ahora») o una tarea programada del servidor: `npm run recurring` (una vez al día basta; `TENANT_ID` limita a una empresa). El proceso no queda en memoria: no es un planificador interno, así que no depende de una sola instancia (§12).
- **Nota débito del proveedor** (serie `NDP`, reservada): un cargo adicional posterior a la factura (intereses de mora, ajuste de precio, flete). Es un documento de compra de tipo `debit_note` con su propio número, IVA descontable y retenciones, asiento (débito al gasto, crédito a proveedores con el tercero) y **saldo propio**: se paga con un pago normal, solo o junto con otras facturas, y se anula como una compra (no si tiene pagos). Debe corresponder a una factura vigente del mismo proveedor y no ser anterior a ella; no mueve existencias; no se acredita con notas de proveedor; la factura original no se anula mientras tenga notas débito vigentes. Las notas débito entran en el libro de compras y en el estado de cuenta del proveedor como cualquier compra. Para soportar las dos series, el índice único de compras pasó del número a `fullNumber` (`FC1`, `NDP1`); `ensureIndexes` crea el nuevo y borra el anterior.
- **Permisos**: se reutilizan los de facturas (`invoices:read`, `invoices:issue`) y compras (`purchases:read`, `purchases:create`, `purchases:void`). Las acciones dejan evento de auditoría (salvo la generación por línea de comandos, que no tiene usuario ni sesión).
- **Límites**: no hay remisiones (ver abajo), recepciones parciales ni edición de una cotización u orden (se anula y se crea otra); una cotización no pasa a pedido ni a orden de venta; el catch-up de una plantilla emite con la fecha de cada período (si ese período está cerrado, la factura falla y la plantilla se detiene hasta que se salte o se reabra); la nota débito de **venta** sigue pendiente del contrato con el proveedor de facturación (`debit_note`).
- **Remisiones (decisión)**: no se implementaron. Una remisión separa la salida de la mercancía de la factura, y eso obliga a decidir cuándo se reconoce el costo y qué pasa con el inventario entre la entrega y la factura. Hoy la factura y el punto de venta descuentan existencias y reconocen el costo al vender. Se retoma si un cliente piloto lo necesita, con el criterio contable validado por el contador.

## 11. Interfaz y pruebas

- Reglamento de diseño propio (azul, verde y rojo con función, sin iconos ni tarjetas, Segoe UI Variable, tablas como elemento central), verificado automáticamente sobre las pantallas reales: sin imágenes ni iconos, sombras, degradados, esquinas redondeadas ni opacidades; solo colores de la paleta (texto, fondos y bordes); tipografía correcta y contraste mínimo 4,5:1. El propio verificador tiene pruebas que demuestran que detecta cada infracción.
- Pruebas: backend (527, con réplica de MongoDB en memoria y transacciones reales, incluida una con autenticación), frontend (169) y de extremo a extremo (91, en Chrome real contra el servidor y la base reales).
- CI (`.github/workflows/lulubiz.yml`): auditoría de dependencias de producción, las tres suites y la compilación. Es el único archivo de Lulubiz fuera de su carpeta, porque GitHub solo lee flujos desde la raíz.

## 12. Límites conocidos

- **Varias instancias del servidor:** el límite de peticiones por IP y el límite de escrituras por empresa viven en memoria de cada proceso. Con N instancias el efecto es N veces mayor. La corrección no depende de ellos (la base serializa y los reintentos se desfasan), pero el límite por IP debe aplicarse también en el borde (balanceador o CDN) al escalar.
- **Correo:** la composición y el envío están probados con un transporte de prueba y con un buzón en memoria; la entrega real por SMTP no se ha probado sin credenciales.
- **Facturación electrónica sin proveedor real:** solo existe el simulador; sus documentos **no tienen validez ante la DIAN**. Falta elegir proveedor, obtener credenciales de su entorno de pruebas y escribir su adaptador (el contrato ya está definido y probado). El CUFE, la habilitación, el certificado y la resolución real los entrega el proveedor y la DIAN, no Lulubiz.
- **Facturas rechazadas conservan su número**: política de huecos en la numeración pendiente de validar con un contador.
- **Sin recibos de pago, anulación de factura ni documento soporte** todavía; las correcciones se hacen con nota crédito.
- **Plan de cuentas de Colombia:** es un borrador de clases y grupos, pendiente de validación por un contador.
- **Fragmentación y varias regiones:** diseñadas, no montadas hasta tener carga real.
- **Datos de ejemplo de rendimiento:** de un solo nodo local; hay que repetir la medición en el clúster real.
