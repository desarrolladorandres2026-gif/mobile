# ZIPP

Plataforma colombiana de domicilios y marketplace. Arranca en ciudades intermedias —Garzón, Huila— y de ahí a otros municipios. No es solo una app de domicilios: es el ecosistema local que conecta usuarios, comercios, repartidores y ZIPP.

Monorepo de cinco paquetes npm independientes. No hay workspaces, no hay `package.json` raíz.

| Carpeta | Qué es | Puerto |
|---|---|---|
| `backend/` | API REST + WebSockets · Express 4 · Mongoose 8 · Socket.IO | 3000 |
| `mobile/` | App de clientes **y** de domiciliarios (dos apps, un código) · Expo Router 55 | 8081 |
| `admin/` | Panel de administración · Vite · React 19 | 3001 |
| `business/` | Panel de comercios · Vite · React 19 | 3002 |
| `web/` | Sitio público · Vite · React 19 | 3003 |

El arranque local, las credenciales del seed, el cálculo del dinero, los códigos de traspaso, el tracking y el despliegue ya están en [README.md](README.md). No lo repitas aquí.

---

## Doctrina

Antes de proponer cualquier cambio: **¿esto realmente mejora ZIPP?** Que otra plataforma lo tenga no es una razón. Responde qué problema resuelve, para quién, qué impacto tiene, qué complejidad añade, de qué depende, qué riesgos introduce, si hace falta *ahora*, si hay algo más sencillo, y a qué otras partes del sistema afecta.

**Prioridades.** No dejes que una función llamativa P3 desplace un P0.

- **P0** — seguridad · pérdida de dinero · corrupción de datos · pedidos imposibles · pagos incorrectos · cualquier cosa que bloquee la operación.
- **P1** — funcionalidad esencial · errores frecuentes · experiencia de compra · estabilidad · rendimiento · operación de comercios y repartidores.
- **P2** — mejoras de UX · automatización · optimización · analítica · crecimiento.
- **P3** — cosmética · experimentación · nice-to-have.

**Regla financiera.** Ninguna simulación de rentabilidad sin **todos** los costes: comisión de ZIPP, domicilio cobrado, pago al repartidor, descuentos, promociones, cashback, **coste de procesamiento de Wompi**, coste de transferencia, impuestos, devoluciones, cancelaciones y pérdidas operativas. Omitir el coste de pasarela convierte una simulación en un deseo.

**Regla de seguridad.** Cuando toques auth, permisos, pagos, datos personales, direcciones, tokens, sesiones, códigos de pedido, promociones, puntos o roles, la pregunta no es "¿funciona?" sino **"¿cómo abusa alguien de esto?"**. Nunca sacrifiques seguridad por velocidad de entrega.

**Regla de arquitectura.** Ninguna solución aislada. Si tocas pedidos, piensa la cascada entera: usuario → carrito → checkout → pago → pedido → comercio → dispatch → repartidor → entrega → historial → puntos → notificaciones → calificación. Arreglar solo el punto visible deja inconsistencias detrás.

**Regla de simplicidad.** Presupuesto limitado. Nada de microservicios, infraestructura, dependencias ni abstracciones prematuras. Pero tampoco simplifiques algo que reviente al escalar. Si la arquitectura actual sirve, explica cómo; si ya no, explica por qué.

**Regla de consistencia.** Si una propuesta contradice una decisión ya tomada en ZIPP, nómbrala, explica cuál se contradice y por qué valdría la pena cambiarla. Nunca la cambies en silencio.

**Regla de no inventar.** Distingue siempre hecho confirmado / inferencia / recomendación / hipótesis. Si falta información: *"necesito verificar X antes de recomendar Y"*, y verifícalo en el código.

**Diseño.** Obsidiana y Champagne Gold, sensación premium y tecnológica. Evita interfaces genéricas, exceso de tarjetas y contenedores, iconografía sin personalidad y pantallas saturadas. Todo debe sentirse como un mismo producto.

---

## Verificación por paquete

| Paquete | Comando |
|---|---|
| `backend` | `npm test` · `npm run typecheck` · `npm run lint` |
| `mobile` | `npm run typecheck` · `npm test` (no tiene ESLint) |
| `admin` · `business` · `web` | `npm run lint` · **`npx tsc -b`** |

**`tsc --noEmit` en `admin`, `business` y `web` no comprueba absolutamente nada.** Sus `tsconfig.json` son `{"files": [], "references": [...]}`: cero archivos de entrada, siempre verde. El código real está en `tsconfig.app.json`. Usa `npx tsc -b`; si falla (no declaran `composite: true`), usa `npx tsc -p tsconfig.app.json --noEmit`.

---

## Invariantes que no se negocian

- **El dinero es entero en COP**, siempre vía [`backend/src/utils/money.ts`](backend/src/utils/money.ts). Nada de floats.
- **Ninguna escritura contable se salta `ledgerService`** ([`backend/src/services/ledger.service.ts`](backend/src/services/ledger.service.ts)). Su `post()` valida partida doble; un `LedgerImbalanceError` no es un bug, es el sistema avisando de que falta **nombrar al acreedor** de ese dinero.
- `LedgerEntry.orderId` y `Payout.orderId` son `required` a propósito: el libro está atado al pedido para poder reconstruir cada asiento contra algo que pasó en la calle. **Un cobro sin pedido detrás** (publicidad, membresía) va a su propio modelo — como ya hizo `AdInvoice` —, nunca al ledger. Excepción decidida el 2026-09-23: cuando una liquidación **compensa** publicidad o un reembolso tardío contra lo que se le debía al comercio por un pedido, esa compensación sí se asienta (cuentas `AD_SPEND_OFFSET` y `PAYOUT_OFFSET_CLEARING`) atada a ese pedido; la factura sigue siendo `AdInvoice`.
- La máquina de estados del pedido vive en `VALID_TRANSITIONS`, [`backend/src/services/order.service.ts:36`](backend/src/services/order.service.ts#L36). Única fuente de verdad.
- **Nunca `findById` → validar → `save()`** sobre dinero o stock. Ese patrón ya costó cinco carreras de concurrencia corregidas. La condición va dentro del filtro: `findOneAndUpdate({_id, balance: {$gte: n}}, {$inc: {balance: -n}})`.
- Mongo rechaza que `$set`/`$inc` y `$setOnInsert` toquen el mismo campo (`ConflictingUpdateOperators`). Ha mordido tres veces.
- Los **virtuals de Mongoose no corren dentro de `.aggregate()`**, y `createdAt` es inmutable en updates normales: ahí hay que bajar al driver nativo.
- **El color vive en dos archivos** que se sincronizan a mano: `variables de color/colores.css` (lo importan admin, business y web) y [`mobile/theme/tokens.ts`](mobile/theme/tokens.ts). Tocar uno solo produce deriva silenciosa.
- Iconos de **acción**: lucide, y **nunca emoji Unicode en texto**. En mobile es `lucide-react-native` y cada icono se registra en [`mobile/theme/icons.ts`](mobile/theme/icons.ts) importándolo **por archivo** (`lucide-react-native/icons/<kebab>`); importar el índice completo mata el arranque de Metro. En los paneles es `lucide-react`.
- Ilustraciones de **concepto** (categorías, colecciones, estados vacíos, KPIs): logos PNG de Twemoji 14, generados con `scripts/logos/` desde el SVG oficial. En mobile el registro es [`mobile/lib/logos.ts`](mobile/lib/logos.ts) y `components/illustrations/` los envuelve con `pngIllustration`; en los paneles es `src/components/logos.tsx`. Son CC-BY 4.0: la atribución vive en el Centro legal, el footer de web y el login de los paneles, y no se quita. Las barras laterales de admin y business ya pasaron a PNG (2026-09-22); no queda ninguna ilustración SVG en ningún panel.
- Navegación en mobile: siempre `ROUTES` de [`mobile/lib/routing.ts`](mobile/lib/routing.ts), nunca strings `/(client)/...`.
- La app va **en modo claro**. Nunca uses `ForceTheme isDark` aunque el código lo sugiera: el claro es la fuente de verdad.
- **`npm run seed` no se ejecuta para comprobar nada**, y jamás en producción. La base de dev es Atlas, no local.
- Las seis migraciones de `backend/src/migrations/` son **manuales**: están fuera de `deploy.sh` a propósito.
- `prebuild --clean` **borra el keystore** de firma, que vive gitignorado dentro de `android/`. Usa `prebuild` sin `--clean`.
- No deshabilites la acción principal de una pantalla: encadénala al paso que falta. Un botón gris es un callejón sin salida más silencioso que un error.

## Realidades operativas

No hay CI (`.github/` no existe), ni Prettier, ni husky, ni ESLint en `mobile`. No hay logs estructurados ni Sentry: el reporte de crashes va al propio backend (`mobile/lib/crashReporting.ts`). PM2 corre **una sola instancia** en modo `fork` porque Socket.IO no tiene sticky sessions — cualquier estado en memoria de proceso es un bloqueante de escala. El dominio de producción todavía es el marcador literal `REEMPLAZAR_DOMINIO`. Un 429 del rate limiter se ve en los paneles como "no tienes datos", no como un error.

---

## Enrutamiento a especialistas

La sesión principal coordina: mantiene la visión global y detecta dependencias entre áreas. Los especialistas viven en `.claude/agents/`. Un hook (`.claude/hooks/zipp-router.mjs`) avisa automáticamente cuando hace falta uno, pero el criterio manda igual cuando el hook no aplique.

| Cuando la tarea toca | Invoca |
|---|---|
| ledger, pricing, comisiones, liquidaciones, payouts, puntos, cupones, reembolsos, efectivo, Wompi | `zipp-finance` |
| auth, sesiones, RBAC, tokens, cifrado, rate limit, códigos de pedido, fraude, abuso | `zipp-security` |
| modelos nuevos, migraciones, cambios que cruzan módulos, decisiones de escala | `zipp-architect` |
| "¿esto ya existe?", código muerto, deuda, coherencia entre paneles | `zipp-auditor` |
| tests que faltan, suites rojas, cobertura de un cambio | `zipp-qa` |
| `mobile/**` | `zipp-mobile` |
| `backend/src/**` que no sea dinero ni seguridad | `zipp-backend` |
| Explorar, Inicio, búsqueda, colecciones, recomendación, retención | `zipp-discovery` |
| dispatch, incidencias, cancelaciones, SOS, soporte, despliegue | `zipp-operations` |
| panel `business/**`, onboarding de comercios, menú, liquidaciones | `zipp-merchant` |
| app del domiciliario, turno, ofertas, ganancias, fondo rotatorio | `zipp-driver` |
| promociones, referidos, campañas, publicidad, cashback | `zipp-growth` |
| "¿cómo lo hace Rappi/DiDi?" | `zipp-competitor` |

Los especialistas de solo lectura **proponen**; no editan. Los tres ejecutores (`zipp-qa`, `zipp-mobile`, `zipp-backend`) no dan nada por terminado sin el comando de verificación de su paquete en verde.

---

## Estilo de trabajo

Directo, técnico, crítico y estructurado. No elogies una idea por haber sido propuesta; si es mala, explica por qué; si es buena pero no toca todavía, dilo. Cuando encuentres un problema no lo ocultes: clasifícalo CRÍTICO / ALTO / MEDIO / BAJO y di problema, causa, impacto, riesgo, solución y prioridad.

Las reglas personales del usuario —`relleno` (concisión), `sin cajas` (nada de tarjetas ni fondos decorativos), `preciso` (preguntar antes de asumir) y la regla de oro (nunca `text-muted` en el texto)— están en `~/.claude/CLAUDE.md` y aplican aquí sin copiarse: dos copias se desincronizan.
