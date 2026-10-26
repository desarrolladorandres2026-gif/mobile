# Lulubiz

Software contable y administrativo con las prestaciones de Siigo: facturación electrónica vía proveedor autorizado por la DIAN, contabilidad, inventario, punto de venta, compras, cartera, nómina, impuestos y API pública. Multiempresa, pensado para muchas empresas y grandes volúmenes. Primer país: Colombia.

Cómo probar, correr y desplegar está en [README.md](README.md). Decisiones en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md). Operación y piloto en [docs/OPERACION.md](docs/OPERACION.md). API en [docs/API.md](docs/API.md). No lo repitas aquí.

Es un proyecto independiente: toda su documentación, agentes y automatizaciones viven dentro de `lulubiz/` y no dependen de nada fuera de esta carpeta.

---

## Pila (decidida, no se reabre)

React 19 + Vite, Node.js + Fastify, MongoDB Atlas. **JavaScript puro**: archivos `.js` y `.jsx`. **Estilos solo con Tailwind 4** (CLI oficial, `src/input.css` → `src/output.css`, ignorado por git); no se escriben hojas de estilo propias ni clases personalizadas. La paleta vive en `frontend/tailwind.config.js`. La elección de MongoDB está tomada; se vuelve a hablar solo ante un hecho nuevo.

| Carpeta | Qué es | Puerto |
|---|---|---|
| `backend/` | API, libro y módulos | 3000 |
| `frontend/` | Interfaz | 3100 |
| `e2e/` | Recorrido completo en Chrome real | — |

Tres paquetes npm independientes: `npm install` en cada uno.

## Verificación por paquete

| Paquete | Comando |
|---|---|
| `backend` | `npm test` (≈16 min la suite completa) · un archivo: `npm test -- <fichero>` · `npm run verify` · `npm run bench` |
| `frontend` | `npm test` · `npm run build` |
| `e2e` | `npm test` (compila la interfaz y corre Playwright) |

**Corre solo la suite del bloque que cambiaste.** Las suites completas se dejan para el final de todas las fases.

---

## Doctrina

Antes de proponer cualquier cambio: **¿esto realmente mejora Lulubiz?** Que Siigo u otro lo tenga no es una razón. Responde qué problema resuelve, para quién (contador, dueño de pyme, cajero), qué complejidad añade, de qué depende, qué riesgo introduce, si hace falta *ahora* y si hay algo más sencillo.

**Prioridades.** No dejes que algo llamativo desplace un P0.

- **P0** — aislamiento entre empresas · seguridad · cifras contables incorrectas · corrupción o pérdida de datos · cualquier cosa que bloquee a una empresa.
- **P1** — funcionalidad esencial · errores frecuentes · estabilidad · rendimiento.
- **P2** — mejoras de uso · automatización · analítica.
- **P3** — cosmética · experimentación.

**Regla contable.** Ninguna cifra sin su origen en asientos. Si un dato no sale del libro, se marca como derivado o incompleto.

**Regla de seguridad.** En auth, permisos, claves de API, datos de una empresa, exportación y borrado, la pregunta no es «¿funciona?» sino **«¿cómo abusa alguien de esto?»**. La amenaza número uno es que una empresa vea o toque datos de otra.

**Regla de simplicidad.** Nada de microservicios, infraestructura, dependencias ni abstracciones prematuras. Tampoco simplifiques algo que reviente al escalar.

**Regla de consistencia.** Si una propuesta contradice una decisión de `ARQUITECTURA.md`, nómbrala, explica cuál y por qué valdría cambiarla. Nunca la cambies en silencio.

**Regla de no inventar.** Distingue hecho confirmado / inferencia / recomendación / hipótesis. Si falta información: «necesito verificar X antes de recomendar Y», y verifícalo en el código. Toda cifra tributaria o normativa lleva su fuente.

**Costos.** Al cotizar, solo desembolso externo (proveedor de facturación, correo, nube); el desarrollo lo hace el equipo y no se le pone precio.

---

## Invariantes que no se negocian

- **Dinero entero en unidad menor, con moneda**, vía `backend/src/core/money.js`. Nada de floats. `-net` produce `-0`: usa `0 - net`.
- **Todo asiento pasa por [`ledger.js`](backend/src/ledger/ledger.js)**, en transacción (`writeConcern: majority`, `readConcern: snapshot`). Un `LedgerImbalanceError` no es un bug: es el sistema avisando de que falta nombrar una contrapartida.
- **Libro solo de agregar**: se corrige con reversión, nunca editando ni borrando. Los tipos de asiento de `MODULE_DOC_TYPES` los crean los módulos, no se aceptan a mano.
- **Consecutivo sin huecos** por empresa y tipo; anular un documento consume su número.
- **Todo acceso a datos por la capa de empresa** ([`tenantCollection.js`](backend/src/data/tenantCollection.js)), que inyecta `tenantId`. Los índices empiezan por `tenantId`.
- **Nunca leer → validar → guardar** sobre saldos, existencias o consecutivos. La condición va dentro del filtro de la escritura atómica.
- Mongo rechaza `$set`/`$inc` y `$setOnInsert` sobre el mismo campo; los virtuals no corren en `.aggregate()`.
- **Idempotencia** con índice único; `Idempotency-Key` donde se escribe dinero.
- Un **permiso nuevo** exige su etiqueta en español en `frontend/src/lib/apiKeys.js`; una **ruta nueva** exige regenerar la tabla de `docs/API.md` (`UPDATE_API_DOCS=1 npx vitest run src/http/apiDocs.test.js`); un **módulo que asienta** exige una comprobación en `scripts/verifyIntegrity.js`.
- Lo que depende de un país va en `backend/src/countries/<código>/`, no en el núcleo.
- `INVOICING_PROVIDER=sandbox` no arranca en producción. No hay adaptador real del proveedor: hasta entonces los documentos no tienen validez ante la DIAN.
- **No se corren `db:setup`, `seed:demo` ni `tenant:delete` contra Atlas para comprobar nada.**

## Reglamento de diseño

Software empresarial maduro, sin plantilla de IA. Funcionalidad, luego claridad, luego estética.

- **Azul** para interacción; **verde y rojo** solo funcionales. Sin dorado, morado, naranja ni decorativos.
- **Segoe UI Variable** con pila de respaldo. Inter prohibida. Sin fuentes monoespaciadas. Una sola familia.
- Sin `text-muted`, sin grises deslavados ni opacidades bajas.
- **Sin iconos, emojis ni ilustraciones**: todo por etiquetas de texto.
- **Sin tarjetas**, ni bordes, sombras o esquinas redondeadas generalizados, ni degradados, cristal, brillos o animaciones sin función.
- Tablas como elemento central, importes alineados; formularios convencionales con etiquetas visibles; botones principal / secundario / destructivo sin acciones ocultas al pasar el cursor.
- No deshabilites la acción principal: encadénala al paso que falta.
- Radios nativos no (son redondos): select o casilla cuadrada.

El verificador del reglamento corre sobre las pantallas reales en e2e.

## Realidades operativas

El consecutivo sin huecos serializa por empresa y tipo de documento; la salida futura es repartir series. El límite por IP y por empresa vive en memoria de cada proceso: con varias instancias hay que subirlo al borde. Pendientes que no dependen del código: SMTP real, proveedor de facturación real, plan de cuentas validado por un contador, despliegue y restauración probados en Atlas.

En bash de esta máquina, plantillas con backticks o regex con `\s` se corrompen y los atajos de Python se cuelgan: escribe archivos con las herramientas de archivo y usa node. `/tmp` de bash no lo ve node en Windows.

---

## Enrutamiento a especialistas

La sesión principal coordina. Los especialistas viven en `.claude/agents/`. Un hook (`.claude/hooks/lulubiz-router.mjs`) avisa cuando hace falta uno; el criterio manda igual cuando no aplique. **Abre la sesión con `lulubiz/` como carpeta de trabajo** para que se carguen.

| Cuando la tarea toca | Invoca |
|---|---|
| código del libro y de los módulos que asientan: períodos, cierre, saldos, cartera, compras, inventario valorizado, POS, bancos, activos, nómina contabilizada, informes | `lulubiz-contabilidad` |
| revisar registros, balances de prueba, estados financieros, conciliaciones, NIIF, tratamiento contable de una operación, razones financieras | `lulubiz-contador` |
| preparar borradores de asientos y comprobantes, clasificar documentos y movimientos, partidas de conciliación, resumen de cartera y pagos, cómo hacer una operación en Lulubiz | `lulubiz-auxiliar` |
| auth, sesiones, permisos, claves de API, aislamiento entre empresas, exportación, borrado | `lulubiz-security` |
| colecciones nuevas, esquemas, índices, migraciones, transacciones, escala | `lulubiz-architect` |
| DIAN, facturación electrónica, IVA, retenciones, ICA, exógena, nómina y su norma | `lulubiz-impuestos` |
| «¿esto ya existe?», código muerto, deuda, documentación desactualizada | `lulubiz-auditor` |
| pruebas que faltan, suites rojas | `lulubiz-qa` |
| `backend/src/**` | `lulubiz-backend` |
| `frontend/**` | `lulubiz-frontend` |
| «¿cómo lo hace Siigo?» | `lulubiz-competitor` |

Los especialistas de solo lectura **proponen**; no editan. Los tres ejecutores (`lulubiz-qa`, `lulubiz-backend`, `lulubiz-frontend`) no dan nada por terminado sin el comando de verificación de su paquete en verde.

## Estilo de trabajo

Directo, técnico, crítico y estructurado. No elogies una idea por haber sido propuesta; si es mala, explica por qué. Cuando encuentres un problema, clasifícalo CRÍTICO / ALTO / MEDIO / BAJO y di problema, causa, impacto, riesgo, solución y prioridad.
