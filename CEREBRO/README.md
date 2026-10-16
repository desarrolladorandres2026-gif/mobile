# CEREBRO

Mapa técnico **vivo** de ZIPP: lee el código real, lo conecta (pantalla → botón → petición → ruta → controlador → servicio → base de datos), lo audita y se actualiza solo cuando el código cambia.

No es documentación: no hay un texto que se desactualice. Todo lo que muestra sale del código (o de una referencia manual con un ancla que se vuelve a comprobar en cada actualización).

## Uso rápido

Desde la raíz del repositorio:

```bash
node CEREBRO/scripts/cerebro.mjs construir   # primera vez: análisis completo (~45 s)
node CEREBRO/scripts/cerebro.mjs iniciar     # vigilante + interfaz en segundo plano
# abre http://127.0.0.1:3900
node CEREBRO/scripts/cerebro.mjs estado      # ¿está corriendo? ¿cuándo se actualizó?
node CEREBRO/scripts/cerebro.mjs detener
```

| Comando | Qué hace |
|---|---|
| `construir` | Reconstrucción **completa** desde cero. Úsala si sospechas deriva o tras cambiar los analizadores. |
| `actualizar` | Actualización **incremental** una sola vez (solo lo que cambió). |
| `iniciar` / `detener` / `estado` | Vigilante en segundo plano (PID y registro en `data/runtime/`). |
| `vigilar` | Vigilante en primer plano (Ctrl+C para salir). |
| `servir` | Solo la interfaz, sin vigilar. |
| `verificar [rapido\|pruebas\|todo\|<suite>]` | Ejecuta tipos y pruebas y guarda la evidencia por archivo de prueba. |
| `revisar <archivo> [desde-hasta\|todo] [nota]` | Registra que alguien leyó esas líneas (ver *Cobertura*). |
| `comprobar` | Valida que lo generado es coherente y que las referencias al código son correctas. |

**Qué debe seguir ejecutándose para que el mapa se actualice solo:** el proceso del vigilante (`iniciar`). Si se detiene, la interfaz lo muestra («Vigilante detenido» y «N archivos cambiaron y no están analizados»). Reinícialo con `iniciar`; al arrancar se pone al día con lo que cambió mientras no estaba.

## Qué verás

| Vista | Para qué sirve |
|---|---|
| **Resumen** | Alcance real del análisis, cobertura, estado de los controles, hallazgos, últimos cambios. |
| **Mapa** | Módulos y dependencias reales (zoom: aplicaciones → módulos → archivos). Desde cualquier símbolo, «Ver conexiones» abre su vecindad: quién lo usa (izquierda) y de qué depende (derecha). |
| **Botones y acciones** | Cada botón, enlace, formulario o interruptor con su estado y evidencia; clic → **recorrido completo** hasta la base de datos. |
| **Endpoints** | Ruta, guardas (autenticación, roles, permisos, validación, límites), qué escribe, quién lo consume, qué pruebas lo ejercitan. |
| **Modelos de datos** | Campos, índices, quién lee y quién escribe, relaciones. |
| **Eventos e integraciones** | Eventos Socket.IO (emisor ↔ oyente), procesos periódicos, librerías y servicios externos, variables de entorno. |
| **Finanzas** | Flujos de dinero con fórmulas, quién paga a quién y evidencia viva; constantes; hallazgos financieros. |
| **Pedidos y estados** | Máquinas de estado leídas del AST, quién escribe cada estado, procesos de negocio. |
| **Roles y permisos** | Guardas reales por ruta, matrices rol→permiso, compuertas de interfaz. |
| **Hallazgos** | Errores confirmados, riesgos probables e hipótesis, con evidencia, gravedad, probabilidad, impacto y alcance. |
| **Cobertura** | Inventario completo, líneas indexadas, líneas auditadas, rangos pendientes y exclusiones justificadas. |
| **Cambios** | Historial de lo que el vigilante detectó y su impacto. |
| **Sistema** | Estado del vigilante, de la instantánea y de la verificación por ejecución. |

Búsqueda global: `Ctrl K` (símbolos, endpoints, botones por su texto, modelos, archivos). Cada ubicación es un enlace `vscode://file/…` que abre el archivo en la línea exacta.

## Cómo distingue lo que sabe de lo que supone

**Conexiones** (colores del mapa):

| Tipo | Significado |
|---|---|
| Sólida dorada — *estática* | Resuelta por el verificador de tipos de TypeScript. Prueba que el código la contiene, no que se ejecute. |
| Discontinua azul — *inferida* | Deducida por convención (props que pasan manejadores, `mutate` de react-query, stores de Zustand, interfaces). No demostrada por tipos. |
| Verde — *desde una prueba* | La referencia nace en un archivo de prueba. |
| Punteada gris — *sin confirmar* | No se pudo comprobar. |

**Estado de un botón o acción** (siempre con la razón y la evidencia que lo sostiene):

| Estado | Criterio |
|---|---|
| Funcional y verificada | Cadena completa hasta un endpoint existente **y** ese endpoint lo ejercita una prueba HTTP que se ejecutó y pasó (`verificar`). |
| Pendiente de verificación | La cadena existe de punta a punta en el código, pero ninguna ejecución la ha demostrado. **Es el estado honesto por defecto.** |
| Parcialmente funcional | Un eslabón es débil (p. ej. un manejador por prop que ningún uso del componente proporciona, o una escritura que no se ve escribir). |
| Desconectada | No tiene manejador ni destino, o se pasa `null`/`undefined`. |
| Sin implementar | Cuerpo vacío, solo `console.*` o marcador `TODO`/«próximamente». |
| Con errores | La petición va a una ruta que no existe, con método equivocado, o a un endpoint cuyos roles excluyen a esa app. |

**Hallazgos:** *confirmado* (demostrado por el código o por una ejecución — las sondas están en `manual/sondas/`), *probable* (el patrón apunta al problema y falta un dato), *hipótesis* (hay que verificarlo antes de actuar).

**Cambios** (en `Cambios`): *detectado* → *analizado* → *probado* → *verificado en ejecución* son niveles distintos; un cambio solo sube de nivel con su propia evidencia.

## Cobertura: qué significa «100 %»

Tres niveles que **nunca se mezclan**:

1. **Inventariado** — el archivo existe con su hash y número de líneas. Cubre todos los archivos del repo (excepto `CEREBRO/`, `node_modules`, `dist`, etc.; cada exclusión está justificada en `cerebro.config.json` y se muestra en la vista Cobertura).
2. **Indexado** — un analizador automático lo procesó: AST de TypeScript con verificador de tipos para `.ts/.tsx/.js/.mjs/.cjs`; escaneo de texto (secretos, variables, marcadores) para configuración, shell, CSS, HTML y similares. **No implica comprensión.**
3. **Auditado** — una persona o agente leyó esos rangos. Se registra en `manual/revisiones.json` atado al **hash del archivo**: si el archivo cambia, la lectura queda obsoleta y el rango vuelve a figurar como pendiente.

CEREBRO **no declara completo** el análisis mientras haya líneas sin auditar. La cifra de auditoría de hoy es la que muestra el Resumen; el resto es indexado automático. Archivos binarios, recursos, lockfiles, Markdown y el proyecto nativo `mobile/android/` (generado por `expo prebuild`) se inventarían con su motivo pero no se analizan como código.

## Cómo funciona

```
git ls-files ──► inventario (hash, líneas, clase)
                    │
   por paquete ─► programa TypeScript (tsconfig propio) ─► extractores por archivo:
                    símbolos · llamadas · imports · rutas Express · modelos Mongoose ·
                    llamadas axios/fetch · elementos JSX interactivos · eventos socket ·
                    tablas de estado/permisos · pruebas
                    │
                    ▼
              enlace (grafo): resuelve props, react-query, stores, interfaces;
              casa llamadas de frontend con endpoints; recorre cada manejador hasta
              su efecto; deriva modelos, eventos, procesos, integraciones, roles,
              estados, hallazgos automáticos y cobertura
                    │
                    ▼   + manual/*.json (referencias al código con ancla verificada)
        data/snapshots/<id>/*.json   ──►  data/actual.json (puntero atómico)
                                              │
                           servidor local ◄───┘ ── interfaz (SSE avisa de cada instantánea)
```

**Actualización incremental.** El vigilante (`fs.watch` recursivo) marca archivos tocados; pasado un breve *debounce* compara hashes, re-analiza solo los archivos cambiados **más sus importadores directos** (atravesando barriles `index.ts`) y vuelve a enlazar todo el grafo (rápido). Cada ciclo escribe una instantánea **completa** en un directorio nuevo y solo entonces mueve `actual.json`: nadie ve un mapa a medias, y si el ciclo falla la anterior sigue vigente con el error visible en *Sistema*. Cada 30 minutos hace una **reconstrucción completa**; si su resultado difiere del acumulado de actualizaciones incrementales, lo registra como *deriva* en el historial.

**Sin bucles.** El vigilante ignora `CEREBRO/` salvo `CEREBRO/manual/*.json` y `CEREBRO/data/verificacion.json` (que sí disparan un re-enlace, porque son entradas: las escriben personas o el comando `verificar`, nunca el propio build). Lo demás que CEREBRO escribe (`data/snapshots`, `actual.json`, `historial.jsonl`…) nunca lo vuelve a despertar.

**Si editas los scripts de CEREBRO** mientras el vigilante corre, este lo detecta y se relanza solo (un vigilante con código viejo en memoria escribiría instantáneas con analizadores obsoletos).

**Pruebas del propio mecanismo.** Crear `web/src/lib/__cerebro_probe.ts` produjo una entrada de historial con el archivo *nuevo* y sus símbolos añadidos; borrarlo, el archivo *eliminado* y los símbolos retirados.

## Datos y archivos

```
CEREBRO/
  cerebro.config.json   paquetes, exclusiones justificadas, puerto, vigilante
  scripts/              cerebro.mjs (CLI) y lib/ (extractores, enlace, servidor, vigilante)
  ui/                   interfaz estática (HTML + JS sin dependencias)
  manual/               conocimiento curado, VERSIONADO:
    revisiones.json       qué rangos se leyeron (con hash)
    hallazgos.json        hallazgos de la auditoría, con ancla de evidencia
    flujos-dinero.json    flujos económicos con fórmulas y referencias vivas
    flujos-negocio.json   ciclo de vida del pedido
    integraciones.json    estado de cada integración (identificada → confirmada)
    roles.json            notas de roles y permisos
    sondas/               pruebas de ejecución usadas como evidencia (no son tests de ZIPP)
  data/                 generado:
    snapshots/<id>/*.json   mapa (regenerable, ignorado por git)
    actual.json             puntero a la instantánea vigente
    historial.jsonl         cambios detectados (versionado)
    verificacion.json       evidencia de ejecución de pruebas (versionado)
    cache/, runtime/        caché de hechos y estado del vigilante (ignorados)
```

Fuente única: los conjuntos de `data/snapshots/` alimentan **todas** las vistas; no hay informes redundantes que puedan contradecirse. Las referencias manuales llevan un `ancla` (texto exacto de una línea): si el código cambia y el ancla ya no está en su sitio, el flujo o hallazgo pasa a *pendiente de revisión* en lugar de seguir presentándose como vigente.

## Impacto en ZIPP

- **No modifica ningún archivo de ZIPP** ni añade dependencias: todo vive en `CEREBRO/` y usa el `typescript` ya instalado en `backend/node_modules` (y el de cada paquete cuando existe).
- El servidor escucha solo en `127.0.0.1`, rechaza cabeceras `Host` no locales, aplica CSP estricta y solo sirve archivos que están en el inventario (nunca `.env`).
- Los secretos **no se reproducen**: el escaneo guarda archivo, línea, tipo de patrón y longitud enmascarada. `verificar` aísla las variables sensibles con valores inertes y las suites usan MongoDB en memoria; no toca Atlas, Wompi ni producción.
- Si usas `tsc -b` o Vite en los paneles, ten en cuenta que CEREBRO también crea programas TypeScript en memoria (no escribe `tsbuildinfo`).
- Requiere Node 20+ (probado en 25) y que cada paquete a analizar tenga `node_modules` si quieres tipos de terceros resueltos. `web/` y `desktop/` no los tienen: se resuelven sus símbolos propios, no los de librerías.

## Limitaciones que debes conocer

- Es **análisis estático**: no ve acceso dinámico (propiedades por cadena, registro en tiempo de ejecución, imports computados). Las llamadas de cliente a rutas armadas dinámicamente quedan marcadas como no verificables.
- Un componente elegido desde un mapa de variantes (`const Card = MAP[variant]`) no se rastrea hasta sus props; esos casos aparecen como *pendientes*, no como rotos.
- Los permisos comprobados *dentro* de un controlador se detectan de forma aproximada (columna «dentro» en Roles). El cruce automático «compuerta de interfaz ↔ guarda de la ruta que esa pantalla llama» **no está implementado**.
- Nada se ha podido confirmar contra servicios reales (Wompi, Cloudinary, Mapbox, correo, WhatsApp) ni contra la base de datos de producción; cada caso está marcado con lo que faltaría.
- La auditoría manual cubrió el núcleo financiero y de pedidos, la autorización y los OTP (ver *Cobertura*). **Pendiente de auditar** a mano: despacho (`dispatch.service`), cupones (`coupon.service`), `auth.service` completo, publicidad, Zipp Pro, soporte/PQRS, app del domiciliario, sockets, migraciones y el resto de paneles. Aparecen como indexados, no como auditados.

## Ampliar a nuevos módulos

Añade el paquete a `paquetes` en `cerebro.config.json` (`id`, `ruta`, `tsconfig` si lo tiene, `tipo`) y ejecuta `construir`. Un paquete sin `tsconfig` se analiza igualmente con opciones por defecto. Para otro repositorio, sitúalo dentro del árbol analizado o añade su ruta como paquete; mientras no esté disponible se registra como **dependencia externa pendiente de analizar**, nunca como inexistente.

## Problemas frecuentes

| Síntoma | Causa / solución |
|---|---|
| La interfaz dice «Vigilante detenido» | `node CEREBRO/scripts/cerebro.mjs iniciar`. |
| «Ya hay un vigilante» y no responde | Borra `CEREBRO/data/runtime/vigilante.lock` si el PID ya no existe. |
| Mapa vacío tras clonar | `data/snapshots` no se versiona: ejecuta `construir`. |
| Cambié un analizador y los datos se ven raros | Sube `EXTRACTOR_VERSION` en `scripts/lib/analyzer.mjs` (invalida la caché) y ejecuta `construir`. |
| Mucha memoria en el primer análisis | Es normal (varios programas TypeScript, uno por paquete, secuencial); usa `--max-old-space-size=6144`. |
