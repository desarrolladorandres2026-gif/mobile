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
- **Límites**: el recibo debe aplicarse por completo a facturas (no hay anticipos de clientes); la cartera por edades usa el saldo de hoy, no a una fecha pasada; no hay devolución de saldos a favor.

### 10.3 Compras, notas de proveedor, pagos y cuentas por pagar

Módulo `backend/src/purchases/`. Es el espejo de las ventas, sin proveedor tecnológico: la factura la emitió el proveedor y aquí solo se registra.

- **Factura de compra** (`FC`): proveedor, número de su factura, fechas, líneas (cada una con su cuenta de gasto, costo o activo, y tarifa de IVA del país) y **retenciones** opcionales (nombre, cuenta por pagar de tipo pasivo, base subtotal o IVA y tarifa en puntos básicos; importe con `BigInt`, medio hacia arriba). El asiento debita gastos e IVA descontable y acredita Proveedores (total − retenciones) y cada retención. `balance` = lo que falta pagar; se mantiene con `$inc` y condiciones en el filtro. La misma factura del proveedor no se registra dos veces (índice único parcial por proveedor y número mientras no esté anulada); anulable solo sin pagos ni notas.
- **Nota de proveedor** (`NP`): devolución o descuento sobre una compra, por líneas o por todo lo que queda. Reserva de forma optimista, con un filtro de igualdad, lo ya acreditado; devuelve las retenciones en proporción y, si agota la factura, con la diferencia exacta. Las notas simultáneas se reintentan y la que no cabe falla con `OVER_CREDIT`. Anulable: reversa su asiento y libera lo reservado.
- **Pago** (`CE`, comprobante de egreso): aplica el dinero que sale a una o varias facturas del mismo proveedor y moneda, con baja condicionada del saldo (`balance >= importe`), asiento y comprobante en una sola transacción, idempotente y anulable.
- **Cuentas por pagar por edades**: igual que la cartera, sobre el índice parcial de compras abiertas.
- **Configuración**: `payable` (Proveedores) y `vatDeductible` (IVA descontable) en las cuentas de Facturación; sin ellas la compra responde `SETTINGS_INCOMPLETE` y la pantalla dice qué falta.
- **Permisos**: `purchases:read` (todos los roles), `purchases:create`, `purchases:void`, `payments:create`, `payments:void` (propietario, administrador y contador).
- **Prueba de coherencia**: tras comprar, pagar, acreditar y anular, la suma de `balance` de las compras vigentes es el saldo de la cuenta de proveedores en el libro.
- **Límites**: las retenciones las define quien registra la compra (el sistema no aplica tablas de bases mínimas ni conceptos de retención de un país); el pago debe aplicarse por completo a facturas (no hay anticipos a proveedores); una nota sobre una factura ya pagada deja saldo a favor y no hay reintegro. Los asientos de cada documento comparten el consecutivo de su tipo con sus anulaciones: tras anular `RC1` el siguiente recibo es `RC3`, porque `RC2` es el asiento de la anulación.

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
