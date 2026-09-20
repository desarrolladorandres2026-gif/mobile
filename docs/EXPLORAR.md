# Explorar — investigación, diseño y plan técnico

> **Para quién es este documento:** el equipo que va a construirlo (móvil + backend + paneles).
> Escrito el 2026-09-20. Estado del código al commit `2d37cca`.

---

## 0. Contexto: por qué este trabajo

Hoy el descubrimiento de Zipp está **invertido**.

El feed rico —las 20 colecciones automáticas de `/home-sections`— vive en **Inicio**
(`mobile/app/(client)/(tabs)/home.tsx`), que es la pantalla a la que el usuario llega
*ya sabiendo* que va a pedir. Y **Explorar** (`mobile/app/(client)/(tabs)/search.tsx`),
que es donde entra quien *no* sabe qué quiere, está casi vacía: cuando no hay búsqueda
escrita, el `ListEmptyComponent` pinta un `DiscoveryHub` (líneas 656-796) con cuatro
cosas:

1. Búsquedas recientes (tags grises, desde `AsyncStorage`)
2. "Lo más buscado" (tags dorados, desde `GET /search/popular`)
3. "Explorar por categoría" — una **lista vertical** de filas con chevron
4. Una tarjeta de Mandados

Eso es un índice, no un descubrimiento. Nadie entra a una lista de filas con chevron y
sale diciendo "no sabía que podía pedir esto".

**El objetivo:** que entrar a Explorar produzca la sensación de *"hay demasiadas cosas
para descubrir"*, sin que se convierta en un muro de tarjetas puesto para llenar hueco.

---

## 1. Investigación: Rappi y DiDi Food

### Nota honesta sobre las fuentes

Lo que sigue mezcla dos niveles de certeza, y conviene distinguirlos:

- **Verificado en fuentes públicas** (✅): el rediseño 2025 de Rappi, la descripción
  pública de DiDi Food, y dos artículos de ingeniería (Uber Eats y DoorDash) que
  explican los mecanismos reales detrás de este tipo de feed.
- **Conocimiento de producto** (◈): el inventario granular de secciones dentro de sus
  apps. No existe un teardown público con capturas fiables de la pestaña de Explorar de
  Rappi Colombia ni de DiDi Food Colombia; lo describo por conocimiento del patrón, no
  por haberlo medido hoy.

**Recomendación antes de ejecutar la Fase 2:** que alguien del equipo abra ambas apps en
Garzón/Neiva y anote los títulos literales de cada sección durante una semana, a
distintas horas. Media jornada de trabajo que convierte todo lo marcado ◈ en dato.

---

### 1.1 Rappi

**✅ El rediseño de 2025** ([PRODU](https://www.produ.com/mercadeo/noticias/rappi-revoluciona-el-delivery-con-su-nueva-version/))
apunta entero hacia el descubrimiento social:

- **Capa social:** seguir a chefs, influencers y celebridades, con páginas propias donde
  comparten recomendaciones de platos y restaurantes.
- **Amigos:** seguir hasta 10 amigos para ver sus platos favoritos y pedidos recientes;
  guardar un favorito con un toque.
- **Búsqueda con IA** que devuelve recomendaciones personalizadas.
- **Pestaña de Favoritos** dedicada.
- **Pestaña de Ofertas** con descuentos personalizados.

La lectura estratégica: Rappi ya no compite por catálogo, compite por **razón para abrir
la app sin hambre**. El contenido social es una excusa para entrar.

**✅ La web de Rappi Colombia** ([rappi.com.co/restaurantes](https://www.rappi.com.co/restaurantes))
organiza el catálogo por dos ejes que conviven:

- **"Top Marcas y Cadenas de Restaurantes"** — colección por marca (Domino's, KFC,
  Starbucks…). Es descubrimiento por *confianza*.
- **"Pide tu comida favorita cerca de ti"** — colección por *antojo*: hamburguesas,
  pollo, pizza, café, sushi, mexicana, postres, saludables, italiana.

Ese segundo eje **no son categorías de negocio, son tipos de comida**. Zipp hoy solo
tiene el eje de negocio (5 valores en `backend/src/types/enums.ts`: `restaurant`,
`fast_food`, `pharmacy`, `cafe`, `supermarket`). Es el hueco más grande del benchmark.

**◈ Dentro de la app**, el patrón de Rappi es una pila de carruseles heterogéneos:
tiendas destacadas, cerca de ti, marcas, promociones, secciones por momento del día, y
un listado largo al final. Filtros en chips pegados arriba (envío gratis, calificación,
tiempo de entrega).

---

### 1.2 DiDi Food

**✅ Descripción pública** ([App Store MX](https://apps.apple.com/mx/app/didi-food-entrega-de-comida/id1434256853)):

- Organizar restaurantes **por tiempo de entrega**.
- Descuentos de hasta 50% y cupones exclusivos.
- Categorías por tipo de comida: hamburguesas, pizza, sushi, alitas.
- Filtros para "encontrar lo que quieres rápido y fácil".

**✅ Categoría "Del Barrio"** — una sección dedicada exclusivamente a establecimientos
del vecindario del usuario. Es la idea más directamente aprovechable para Zipp: en un
municipio como Garzón, "del barrio" **es** la propuesta de valor, no un adorno.

**◈ Dentro de la app**, DiDi es más agresivo comercialmente y más pobre editorialmente
que Rappi: el precio manda. Bandas de súper descuentos, entrega gratis y porcentajes muy
arriba, con el descuento pintado grande sobre la foto.

---

### 1.3 Los dos mecanismos que sí están documentados

Estos dos artículos valen más que cualquier captura, porque explican **cómo** se
construye la variedad:

**✅ Uber Eats — diversificación personalizada**
([Uber Engineering](https://www.uber.com/us/en/blog/uber-eats-recommending-marketplace/)):

> El backend decide **cuántos** carruseles mostrar, **de qué tipo**, y cómo ordenar la
> lista larga. El problema que resuelven: un usuario que solo pidió ramen vería
> únicamente ramen. La solución es un **algoritmo greedy** que representa los gustos del
> usuario y el perfil de cocina del restaurante como **vectores**, y elige cada
> siguiente elemento optimizando una función combinada de **relevancia + diversidad**.

**✅ DoorDash — carruseles generados**
([DoorDash Engineering](https://careersatdoordash.com/blog/doordash-offline-llms-online-personalization-generating-carousels/)):

> Un LLM lee los bloques de memoria de cada consumidor **offline** y genera títulos de
> carrusel y palabras clave de búsqueda personalizadas. **Online**, esas palabras
> alimentan la recuperación de candidatos, que luego rankean los modelos existentes.

La lección aplicable a Zipp sin ML ni LLM: **el título de la colección y su regla de
contenido son datos, no código.** Ambas empresas llegaron ahí por caminos distintos.
Zipp hoy los tiene hardcodeados en `sectionDefs` (`homeSections.service.ts:759-798`).

---

## 2. Benchmark

| # | Elemento | Rappi | DiDi Food | Zipp hoy | ¿Implementar? |
|---|---|---|---|---|---|
| 1 | Pestaña de descubrimiento propia | ✅ | ✅ | ⚠️ el tab existe, el contenido no | **Sí — es el trabajo** |
| 2 | Categorías por **tipo de comida** | ✅ | ✅ | ❌ solo 5 categorías de negocio | **Sí — prioridad 1** |
| 3 | Colecciones temáticas automáticas | ✅ | ~ | ✅ 20, pero en Inicio | **Sí — mover y ampliar** |
| 4 | Colecciones curadas por un humano | ✅ | ✅ | ✅ `CuratedHomeBlock` | Ya está |
| 5 | Colecciones **configurables sin deploy** | ✅ | ✅ | ❌ constantes en código | **Sí — prioridad 1** |
| 6 | Chips de filtro rápido sobre el feed | ✅ | ✅ | ⚠️ solo dentro de un sheet | **Sí** |
| 7 | Ordenar por tiempo / rating / distancia | ✅ | ✅ | ✅ `SearchFiltersSheet` | Ya está |
| 8 | Filtro "envío gratis" / "con descuento" | ✅ | ✅ | ❌ | **Sí — el dato ya existe** |
| 9 | Sección cerca de ti / del barrio | ✅ | ✅ | ✅ `cercaDeTi` (en Inicio) | **Sí — subir de rango** |
| 10 | Negocios nuevos destacados | ✅ | ✅ | ⚠️ `recienLlegados` es de *productos* | **Sí — versión de negocios** |
| 11 | Tendencias reales (crecimiento) | ✅ | ~ | ✅ `estaEnTendencia` | Ya está, y está bien hecho |
| 12 | Personalización por historial | ✅ | ✅ | ❌ el feed es anónimo | **Sí — prioridad 1** |
| 13 | "Vuelve a pedir" | ✅ | ✅ | ⚠️ `useUsual`, calculado en el cliente | **Sí — mover al servidor** |
| 14 | Descubrimiento **fuera** del perfil | ✅ (greedy) | ❌ | ❌ | **Sí — el diferenciador** |
| 15 | Rotación por hora y día | ✅ | ~ | ❌ orden fijo siempre | **Sí — barato y muy visible** |
| 16 | Banners promocionales | ✅ | ✅ | ✅ `PromotionBanner` | Falta `placement: 'explore'` |
| 17 | Capa social (amigos / influencers) | ✅ | ❌ | ❌ | **No — ver §2.1** |
| 18 | Búsqueda con corrección y sugerencias | ✅ | ✅ | ✅ cascada text→prefix→corrected | Ya está, y está bien |
| 19 | Búsquedas recientes y populares | ✅ | ✅ | ✅ | Ya está |
| 20 | Tarjetas de **producto**, no solo de negocio | ✅ | ✅ | ✅ 6 variantes | Ya está, infrautilizado |
| 21 | Foto grande como protagonista | ✅ | ✅ | ⚠️ dominan las tarjetas pequeñas | **Sí — ajuste visual** |
| 22 | Mandados / lo que no está en carta | ❌ | ❌ | ✅ | **Ventaja propia — destacarla** |

### 2.1 Qué NO copiar, y por qué

**La capa social de Rappi.** Necesita densidad de usuarios para no verse desierta. Un
carrusel de "tus amigos pidieron" vacío en Garzón es peor que no tenerlo: comunica que
nadie usa la app. Es una idea correcta para 2027, con volumen.

**El muro de descuentos de DiDi.** Poner el precio tachado en todo colapsa la marca
hacia "la app barata". La decisión ya tomada en el rediseño de Descuentos apunta en la
dirección contraria, y Zipp ya tiene una pestaña entera para eso: Explorar no debe
competir con ella.

**Las reseñas de influencers.** Mismo problema de densidad, más un coste de moderación
que el proyecto no puede absorber hoy.

---

## 3. Por qué sí a cada cosa que vamos a construir

La tabla dice *qué*. Esto dice *por qué*, que es lo que permite discutirlo.

### Categorías por tipo de comida (tags)
- **Problema:** hoy "¿qué se te antoja?" solo se puede responder escribiendo. Las 5
  categorías de negocio no son antojos: nadie quiere `fast_food`, quiere *una
  hamburguesa*.
- **Por qué ayuda al descubrimiento:** convierte un antojo difuso en un toque. Es el
  puente entre "tengo hambre" y "quiero esto".
- **Adaptación a Zipp:** `tags: string[]` sobre `Product`, vocabulario cerrado, backfill
  automático desde los diccionarios de keywords que ya existen.
- **¿Vale la pena?** Es el cuello de botella de todo lo demás. Sin tags, cada colección
  nueva es una regex nueva en el código.

### Colecciones configurables desde el panel
- **Problema:** las 20 colecciones son `const` en `homeSections.service.ts`. Cambiar un
  título es un deploy. Probar "Almuerzo bajo $12.000" un martes, imposible.
- **Por qué ayuda:** el descubrimiento se siente vivo cuando alguien lo cuida. Un feed
  que nunca cambia deja de mirarse en dos semanas.
- **Adaptación:** modelo `DiscoveryCollection` con un **DSL cerrado** de reglas (§7.2).
  El admin nunca escribe Mongo.
- **¿Vale la pena?** Sí, y el propio código ya lo anticipa: el comentario en
  `homeSections.service.ts:472-477` dice que `displayVariant` vive en el backend "para
  que a futuro administración pueda reasignarlo sin tocar código".

### Personalización con señales existentes
- **Problema:** `/home-sections` es público y anónimo. Un cliente con 30 pedidos ve
  exactamente lo mismo que uno recién registrado.
- **Por qué ayuda:** "Para ti" es la sección con más interacción en todas las apps del
  rubro, y Zipp ya tiene el dato guardado sin usarlo.
- **Adaptación:** `identifyIfPossible` (ya existe, se usa en `/search/log`) + perfil de
  gustos derivado de `Order` → `items.productId` → `tags`.
- **¿Vale la pena?** Sí, y sin tracking nuevo: no hace falta registrar vistas.

### Descubrimiento fuera del perfil
- **Problema:** el riesgo de toda personalización es la burbuja. Si pediste pizza tres
  veces, ver pizza para siempre.
- **Por qué ayuda:** es literalmente el objetivo pedido — *cosas que ni sabía que podía
  pedir*.
- **Adaptación:** el greedy de Uber Eats, pero sin ML: cuota fija de slots reservada a
  tags ausentes del perfil, y penalización de diversidad al elegir (§6.3).
- **¿Vale la pena?** Es el diferenciador. Rappi lo tiene; DiDi no.

### Rotación por hora y día
- **Problema:** el orden de las secciones es el orden de declaración, siempre. "Para
  empezar el día" ☕ sale a las once de la noche.
- **Por qué ayuda:** hace que abrir la app dos veces el mismo día se sienta distinto. Es
  la mejora con mejor relación esfuerzo/percepción de todo el documento.
- **Adaptación:** campos `dayparts` y `rotation` en la colección + semilla determinista.
- **¿Vale la pena?** Sí. Es media jornada de backend.

### Chips de intención sobre el feed
- **Problema:** los filtros están escondidos dentro de un sheet. Nadie abre un sheet
  mientras explora; se abre cuando ya se está buscando algo concreto.
- **Por qué ayuda:** convierte el feed pasivo en herramienta. "Envío gratis" y "Menos de
  $15.000" son las dos intenciones más comunes y hoy no son alcanzables desde el feed.
- **Adaptación:** fila de chips bajo el buscador. `freeDeliveryThreshold` y
  `effectivePrice` ya existen como datos.

---

## 4. Así debería ser Explorar de Zipp

Tres bandas, con una lógica detrás del orden:

- **Arriba — control.** Quien ya sabe lo que quiere sale de aquí en dos segundos.
- **En medio — descubrimiento.** Quien no sabe, se queda. Es el 80% de la pantalla.
- **Abajo — catálogo.** Quien quiere verlo todo, lo ve.

Esa es la razón de que el buscador no baje nunca y de que el listado completo no suba:
las tres bandas sirven a tres personas distintas y las tres tienen que ganar.

### De arriba hacia abajo

```
┌──────────────────────────────────────────────┐
│  Explorar                                    │  ← título, se encoge al bajar
│  ┌────────────────────────────────┐ ┌──────┐ │
│  │ 🔍 ¿Qué se te antoja hoy?      │ │ ⚙︎ 2 │ │  1. Buscador + filtros (sticky)
│  └────────────────────────────────┘ └──────┘ │
│  ( Abierto ahora )( Envío gratis )( -20% )…  │  2. Chips de intención
├──────────────────────────────────────────────┤
│  🍔  🍕  🍗  ☕  ← 4 columnas                 │  3. Antojos (grid, 8 + "Ver todo")
│  🍦  💊  🛒  ➕                               │
├──────────────────────────────────────────────┤
│  Buenos días, Andrés · 7:40 a.m.             │  4. Banda "Ahora" (por franja)
│  ░░░░░░░ carrusel grande de desayunos ░░░░░  │
├──────────────────────────────────────────────┤
│  ✦ Descubre algo nuevo                       │  5. Spotlight editorial
│      ▓▓▓▓▓▓▓▓▓  (3 tarjetas, 3D)            │
├──────────────────────────────────────────────┤
│  Nuevos en Zipp                    Ver todo →│  6. Negocios < 30 días
│  ▭▭▭▭  ▭▭▭▭  ▭▭▭▭  ← negocios               │
├──────────────────────────────────────────────┤
│  Está en tendencia                           │  7. Crecimiento real
│  ▭▭ ▭▭ ▭▭ ▭▭                                 │
├──────────────────────────────────────────────┤
│  [ banner promocional ]                      │  8. placement: 'explore'
├──────────────────────────────────────────────┤
│  Nunca has probado esto            (para ti) │  9. Anti-burbuja
│  ▭▭ ▭▭ ▭▭ ▭▭                                 │
├──────────────────────────────────────────────┤
│  Cerca de ti                                 │ 10. Del barrio
│  ▭▭ ▭▭ ▭▭ ▭▭                                 │
├──────────────────────────────────────────────┤
│  … 3-5 colecciones rotativas del pool …      │ 11. Rotan cada día
├──────────────────────────────────────────────┤
│  ¿No está en ninguna carta?            →     │ 12. Mandados
├──────────────────────────────────────────────┤
│  Todos los negocios                          │ 13. Lista infinita
│  ▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭  ← BusinessRow      │
│  ▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭                     │
└──────────────────────────────────────────────┘
```

### Sección por sección, y por qué está ahí

**1. Buscador real + filtros — fijo, no se va nunca**
Hoy el buscador de Explorar ya es real (a diferencia del de Inicio, que es un
`Pressable`). Se mantiene, pegado arriba con sombra al hacer scroll. El botón de embudo
sigue abriendo `SearchFiltersSheet` con su contador.
*Por qué arriba:* es la salida rápida. Quien sabe, escribe.

**2. Chips de intención — carrusel horizontal**
`Abierto ahora` · `Envío gratis` · `Con descuento` · `Menos de $15.000` ·
`Llega en 20 min` · `Mejor calificados`.
No son categorías: son **estados de ánimo con presupuesto**. Al tocar uno, el feed
entero se re-filtra en el sitio (no navega a otra pantalla) y el chip queda activo en
dorado. Los tres primeros se mapean a `SearchFilters` que ya existen; los otros tres son
nuevos pero el dato ya está en el catálogo.
*Por qué aquí:* es el filtro que la gente sí usa, porque se ve.

**3. Antojos — grid de 4×2 + "Ver todo"**
Aquí muere la lista vertical con chevrons. Grid de 8 baldosas con la mini-ilustración de
`CategoryTile`, y una novena que abre la rejilla completa.
Mezcla dos cosas a propósito: las categorías de negocio que ya existen (Droguería,
Supermercado) y los **tags de comida** nuevos (Hamburguesas, Pizza, Pollo, Café, Dulce).
Para el usuario son lo mismo; para el backend son dos consultas distintas.
*Por qué aquí:* es el índice visual. Rappi y DiDi lo ponen en el mismo sitio, y por la
misma razón: resuelve el 60% de las visitas con antojo definido.

**4. Banda "Ahora" — contextual por franja horaria**
Una sola colección grande, con encabezado que nombra el momento:

| Franja | Título | Contenido |
|---|---|---|
| 5-11 h | "Para empezar el día" | tags `desayuno`, `cafe`, `pan`, `arepa` |
| 11-15 h | "Hora de almorzar" | tags `almuerzo`, `corrientazo`, `bandeja`, `sopa` |
| 15-18 h | "Algo para la tarde" | tags `cafe`, `dulce`, `postre`, `bebida` |
| 18-23 h | "Para la noche" | tags `hamburguesa`, `pizza`, `perro`, `para_compartir` |
| 23-5 h | "A esta hora" | negocios abiertos ahora, sin filtro de tag |

*Por qué aquí, y no abajo:* es lo primero que cambia cuando vuelves a abrir la app. Es
el ancla de que "esto está vivo". Hoy "Para empezar el día" existe pero se muestra a las
tres de la mañana igual que a las ocho, lo cual es exactamente lo contrario.

**5. "Descubre algo nuevo" — spotlight editorial**
Tres tarjetas en el `SpotlightCarousel` que ya existe (pila 3D, avance automático). El
contenido sale de una colección con `rotation: 'daily'`: **platos buenos de negocios que
este usuario nunca ha pedido**. Si no hay perfil (usuario nuevo o anónimo), cae a
productos bien calificados de negocios con pocos pedidos.
*Por qué aquí:* es la promesa del documento hecha pixel. Arriba del todo del bloque de
descubrimiento, donde no se puede ignorar.

**6. "Nuevos en Zipp" — carrusel de negocios**
Negocios con `createdAt` de los últimos 30 días. Tarjeta grande con portada, no baldosa.
Resucita `BusinessFeatured` (`BusinessCard.tsx:411`), que hoy está exportado y sin usar.
*Por qué aquí:* es contenido que Zipp necesita empujar por razones de negocio (un
comercio nuevo sin pedidos se va), y que al usuario le interesa de verdad. Coinciden los
dos intereses, cosa poco común.

**7. "Está en tendencia"**
La colección `estaEnTendencia` que ya existe y que está bien construida: exige
`recent >= 3` pedidos y crecimiento `> 1.3x` comparando 7 días contra los 7 anteriores.
No es "lo más vendido" disfrazado: es crecimiento real.
*Por qué aquí:* prueba social. Y porque en un municipio pequeño, saber qué se está
pidiendo esta semana **es** información.

**8. Banner promocional**
`PromotionBanner` con `placement: 'explore'` (valor nuevo del enum). Uno solo, aquí, a
media pantalla. Respira porque está rodeado de contenido distinto.
*Por qué aquí y no arriba:* arriba compite con el buscador y con los antojos, que son
más útiles. A media pantalla se ve sin robar.

**9. "Nunca has probado esto" — el anti-burbuja**
Productos con tags **ausentes** del perfil del usuario, filtrados por calidad (rating
del negocio ≥ 4). Si el perfil dice hamburguesa-pizza-perro, aquí salen sopas, postres y
café.
Para usuarios sin historial, el título cambia a **"Algo diferente"** y el contenido es
una muestra diversificada del catálogo.
*Por qué aquí:* justo después de tendencias, que es puro consenso. El contraste es
deliberado: "esto es lo que piden todos / esto es lo que tú no has probado".

**10. "Cerca de ti"**
La colección `cercaDeTi` que ya existe, con distancia real. Sube desde el puesto 16 de
Inicio a un lugar visible.
*Por qué aquí:* es la idea "Del Barrio" de DiDi. En Garzón, tres cuadras contra quince
es la diferencia entre pedir y no pedir.

**11. Bloque rotativo — 3 a 5 colecciones del pool**
De aquí abajo, lo que aparece cambia cada día. El pool son las colecciones restantes
(`Para compartir`, `Algo dulce`, `Bueno y barato`, `Por menos de $10.000`, `Combos que
valen la pena`, `Date un gusto`, `Refresca el día`, `Los favoritos de la ciudad`,
`Descuentos locos`, `Listo para pedir`…) más las que el admin cree desde el panel.
La semilla del día decide cuáles entran y en qué orden (§6.2).
*Por qué aquí:* es el motor de "siempre hay algo diferente". Y está abajo a propósito:
las secciones de arriba son estables para que la pantalla no se sienta caótica.

**12. Mandados**
La tarjeta que ya existe, en el mismo sitio conceptual que hoy: el cierre del
descubrimiento por catálogo. "Si nada de esto era, pide un mandado".
*Por qué aquí:* es la ventaja propia de Zipp que ni Rappi ni DiDi tienen. Merece el
cierre, no una fila perdida arriba.

**13. "Todos los negocios" — la lista infinita**
El `FlatList` de `BusinessRow` con paginación que ya funciona. Es la última banda.
*Por qué al final:* quien llega hasta aquí quiere el catálogo, no un feed curado. Y
tenerlo abajo hace que el scroll tenga fondo — la sensación de "esto se acaba" importa.

### Qué es carrusel, qué es grid, qué es lista

| Forma | Cuándo | Secciones |
|---|---|---|
| **Grid** | Taxonomía: el usuario escanea y elige | 3 (Antojos) |
| **Carrusel horizontal** | Colección: muestra variedad sin gastar altura | 4, 6, 7, 9, 10, 11 |
| **Spotlight 3D** | Una sola cosa que queremos que se mire | 5 |
| **Banda completa** | Contenido comercial de una sola pieza | 8 |
| **Lista vertical infinita** | Catálogo exhaustivo | 13 |

Regla dura: **nunca dos carruseles del mismo aspecto seguidos.** Entre dos carruseles
compactos tiene que haber un grid, una banda, un spotlight o un cambio de tamaño de
tarjeta. Las seis variantes de `ProductCollectionRow` existen precisamente para esto y
hoy se usan sin criterio de alternancia.

### Qué es personalizado y qué no

| Sección | Personalizado | Con qué señal |
|---|---|---|
| 1, 2, 3 | No | — |
| 4 "Ahora" | Solo por hora y zona | reloj + coordenadas |
| 5 "Descubre algo nuevo" | **Sí** | negocios que nunca pidió (`Order`) |
| 6 "Nuevos en Zipp" | No | `createdAt` |
| 7 "Tendencia" | No | agregado global |
| 8 Banner | No (segmentación futura) | — |
| 9 "Nunca has probado" | **Sí** | tags ausentes del perfil |
| 10 "Cerca de ti" | Solo por zona | coordenadas |
| 11 Rotativo | Semilla por usuario + día | hash determinista |
| 13 Listado | Solo por zona | coordenadas |

**Tres de trece secciones son personales.** Es a propósito: el feed tiene que funcionar
igual de bien para un usuario anónimo, y una pantalla que solo existe si hay historial
se ve rota el primer día.

---

## 5. Experiencia visual

### Jerarquía: tres pesos, no más

Todo lo que hay en Explorar cae en uno de tres pesos, y el ritmo de la pantalla es la
alternancia entre ellos:

| Peso | Altura | Tarjeta | Dónde |
|---|---|---|---|
| **Protagonista** | 200-240 pt | foto que ocupa toda la tarjeta, texto encima o debajo | 4, 5, 6 |
| **Secundario** | 130-160 pt | foto + nombre + precio | 7, 9, 10, 11 |
| **Índice** | 76-90 pt | ilustración + etiqueta | 2, 3 |

Si dos secciones seguidas tienen el mismo peso, una de las dos está mal colocada.

### Imágenes

- **Producto en protagonista:** 1:1, 168 pt de lado, radio 20. La foto **es** la
  tarjeta; el texto va debajo sobre fondo, no encima con velo. El sistema de variantes
  por URL ya existe (`mobile/lib/productImage.ts`, `productImageUri`).
- **Producto en secundario:** 1:1, 120 pt, radio 16.
- **Negocio:** portada 16:9, 260×146 pt, con el logo en un anillo solapando la esquina
  inferior izquierda — que es exactamente lo que `BusinessRow` ya hace y funciona.
- **Categoría/tag:** la mini-ilustración SVG local, 44 pt, sin foto. Es la decisión que
  ya está tomada en el proyecto (icono = acción, ilustración = categoría) y hay que
  respetarla.
- **Siempre `expo-image` con `placeholder`.** Una tarjeta que aparece en blanco y luego
  salta destruye la sensación de calidad más que cualquier otro detalle.

### Espaciado

```
Entre secciones .................. Spacing.xl   (32)
Encabezado → primera tarjeta ..... Spacing.md   (16)
Entre tarjetas de un carrusel .... Spacing.md   (16)
Margen lateral de la pantalla .... Spacing.lg   (20)
```

El carrusel **sangra hacia fuera**: `contentContainerStyle` con `paddingHorizontal:
Spacing.lg` y el `FlatList` a ancho completo. Así la tarjeta se corta en el borde de la
pantalla y se ve que hay más. Un carrusel que termina justo en el margen parece una
lista terminada.

### Cuánto contenido se ve de una vez

- Máximo **2 secciones y media** visibles en un iPhone estándar. Tres secciones
  completas en pantalla es un catálogo; dos y media es un feed.
- Cada carrusel muestra **2.2 tarjetas** de ancho. El 0.2 es lo que dice "desliza".
- Cada colección trae **8-10 productos**, no más. Nadie desliza doce.
- El feed entero: **10-14 entradas**. Por encima de eso la pantalla pesa y el `$facet`
  también.

### Animación: solo tres, y las tres tienen trabajo

1. **Entrada escalonada de secciones** — `FadeInDown` con `delay = index * 40 ms`, tope
   en 240 ms. Comunica que el contenido llegó, no que la app es lenta.
2. **Spotlight** — el `SpotlightCarousel` que ya existe. Su movimiento es el que dice
   "mira esto".
3. **Presión de tarjeta** — `scale: 0.97` en 120 ms. Es la única microinteracción que se
   siente en el dedo.

Todas respetan "Reducir movimiento", como ya hace `CategoryMarquee`.

**Lo que NO va:** parallax al hacer scroll, brillos en las tarjetas nuevas, contadores
animados, skeletons que pulsan más rápido de 1.2 s. Todo eso es ruido que se lee como
plantilla.

### Cómo se destacan novedad y promoción

| Qué | Cómo | Dónde |
|---|---|---|
| Negocio nuevo | pastilla dorada "Nuevo" sobre la portada, esquina superior izquierda | tarjeta de negocio |
| Producto nuevo | sin distintivo — la sección ya lo dice | — |
| Descuento | pastilla con el porcentaje, dorado sobre negro, esquina inferior derecha | tarjeta de producto |
| Envío gratis | línea de texto en el `MetaRow`, no pastilla | tarjeta de negocio |
| Cerrado | velo + "CERRADO" (ya existe en `BusinessRow`) | tarjeta de negocio |

**Un distintivo por tarjeta, máximo.** Si un producto es nuevo *y* tiene descuento, gana
el descuento. Dos pastillas en una tarjeta de 120 pt es donde empieza a verse hecho por
una máquina.

---

## 6. Sistema de descubrimiento y rotación

### 6.1 Por qué hoy todo se siente igual

Tres causas concretas, todas en `homeSections.service.ts`:

1. **El orden es el orden de declaración.** `order = (i + 1) * 10` sobre el array
   `sectionDefs` (líneas 806-809). No hay elección: las 20 se calculan siempre y se
   pintan siempre en el mismo sitio.
2. **El dedupe es solo por producto.** `pickForSection` (líneas 500-516) lleva un
   `Map<productId, count>` con tope 2. **Nada limita al negocio:** un comercio con carta
   grande puede copar una sección entera. Los propios tests lo dejan por escrito — usan
   `category: 'pharmacy'` a propósito porque `fast_food` "consume el cupo de repetición
   antes de tiempo".
3. **Cero conciencia del reloj.** La única regla temporal es `filterOpenNow`. "Para
   empezar el día" y "Para la noche" conviven a las tres de la mañana.

### 6.2 Semilla determinista: el motor de la variedad

```ts
type Daypart = 'madrugada' | 'manana' | 'tarde' | 'noche';

/** Identidad estable para rotar: sesión > dispositivo > zona. */
function rotationIdentity(userId?: string, deviceId?: string, zone?: string): string {
  return userId ?? deviceId ?? zone ?? 'anon';
}

function dailySeed(identity: string, daypart: Daypart): number {
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Bogota' });
  return hash32(`${identity}:${day}:${daypart}`);   // 2026-09-20:manana
}
```

La semilla se usa en tres sitios:

| Uso | Efecto visible |
|---|---|
| Elegir **k colecciones** del pool rotativo | cada día aparecen secciones distintas |
| **Barajar** el orden dentro de la banda rotativa | la misma sección no siempre en el mismo sitio |
| **Desplazar la ventana** de candidatos: `offset = seed % max(1, candidatos - objetivo)` | la misma sección muestra productos distintos |

**Determinista a propósito.** El mismo usuario, el mismo día, la misma franja, ve lo
mismo. Eso permite cachear, y —más importante— evita que el contenido salte bajo el dedo
al hacer *pull-to-refresh*. Un feed que cambia cada vez que se recarga es desorientador,
no variado. La zona horaria se fija a `America/Bogota` porque ese error ya se cometió
antes en este proyecto con los horarios de los programas de puntos.

### 6.3 Diversificación greedy (Uber Eats, sin el machine learning)

El artículo de Uber describe vectores de gustos y perfiles de cocina. La versión
aplicable aquí, con tags en vez de embeddings:

```ts
const ALPHA = 0.7;   // 70% relevancia, 30% variedad

function diversify(candidates: Candidate[], target: number, profile?: TasteProfile) {
  const chosen: Candidate[] = [];
  const pool = [...candidates];

  while (chosen.length < target && pool.length) {
    let best = 0, bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const rel = relevance(pool[i], profile);            // 0..1
      const pen = maxSimilarity(pool[i], chosen);         // 0..1
      const score = ALPHA * rel - (1 - ALPHA) * pen;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    chosen.push(pool.splice(best, 1)[0]);
  }
  return chosen;
}

/** Sin embeddings: Jaccard sobre tags, y el mismo negocio penaliza fuerte. */
function similarity(a: Candidate, b: Candidate): number {
  const sameBusiness = a.businessId === b.businessId ? 0.6 : 0;
  const inter = a.tags.filter(t => b.tags.includes(t)).length;
  const union = new Set([...a.tags, ...b.tags]).size || 1;
  return Math.min(1, sameBusiness + 0.4 * (inter / union));
}
```

Coste: O(objetivo × candidatos) = 10 × 30 = 300 comparaciones por sección, en memoria,
sobre datos que ya están cargados. Irrelevante frente a la agregación.

### 6.4 Presupuesto de exposición

Tres topes en vez de uno. Los dos últimos son nuevos y resuelven el problema del
comercio que copa la sección:

```ts
const MAX_APPEARANCES_PER_PRODUCT  = 2;   // ya existe
const MAX_APPEARANCES_PER_BUSINESS = 3;   // NUEVO — en todo el feed
const MAX_PER_BUSINESS_IN_SECTION  = 2;   // NUEVO — dentro de una colección
```

Efecto secundario deseable: en un catálogo pequeño, obliga a que los comercios con poca
carta también aparezcan. Eso no es caridad, es retención del lado de la oferta.

**Excepción necesaria:** los bloques curados por admin (`CuratedHomeBlock`) hoy no pasan
por `usageCount`. Se mantiene así —si un humano decidió poner algo, va— pero **sí** se
registran en el contador para que las colecciones automáticas posteriores no lo repitan.

### 6.5 Cómo se reparte entre Inicio y Explorar sin duplicar

Cada colección declara su destino:

```ts
feed: 'home' | 'explore' | 'both'
```

| Feed | Qué lleva | Cuántas entradas |
|---|---|---|
| **Inicio** | Lo de siempre, banners, categorías, Los más pedidos, Pide y repite, Descuentos locos | 5-6 |
| **Explorar** | todo lo demás + las nuevas + las personales | 10-14 |
| **Ambos** | reservado para campañas puntuales; por defecto, ninguna | 0 |

`/home-sections` filtra `feed ∈ {home, both}` y `/explore` filtra `feed ∈ {explore,
both}`. **Inicio no cambia de código**: simplemente recibe menos entradas del servidor.
Eso mantiene intacto `useProgressiveLimit` y el contrato de la API.

---

## 7. Personalización

### 7.1 Con qué contamos (y con qué no)

Decisión tomada: **cero tracking nuevo.** Nada de registrar vistas de producto o de
negocio. Se trabaja con lo que ya está guardado:

| Señal | Modelo | Índice | Calidad |
|---|---|---|---|
| Historial de pedidos | `Order.clientId` | `{clientId:1, createdAt:-1}` ✅ | **Alta** — es intención pagada |
| Favoritos | `Favorite` | `{userId, kind, targetId}` único ✅ | Alta, pero escasa |
| Búsquedas | `SearchLog.userId` | `{term:1, createdAt:-1}` | Media, TTL 90 días |
| Carrito activo | `CartActivity` | `userId` único | Alta y muy fresca, pero efímera |
| Pulgares por plato | `Review.productFeedback` | — | Alta, muy escasa |

Un pedido entregado vale más que cien vistas. Esa es la razón real de que descartar el
tracking de vistas no duela: en delivery, la señal fuerte ya se está guardando.

### 7.2 El perfil de gustos

```ts
interface TasteProfile {
  tags: Record<string, number>;      // 'hamburguesa' → 0.42, normalizado a 0..1
  businessIds: string[];             // negocios de los que ya pidió
  categories: Record<string, number>;
  orderCount: number;
  lastOrderAt: Date | null;
}
```

Una sola agregación sobre `Order`, ventana de 90 días:

```
$match { clientId, status: 'delivered', createdAt: { $gte: hace90d } }
$unwind items
$group  { _id: '$items.productId', qty: { $sum: '$items.quantity' } }
$lookup products → tags
$unwind tags
$group  { _id: '$tags', weight: { $sum: '$qty' } }
```

Caché `taste:{userId}`, TTL **3600 s**, invalidada explícitamente cuando un pedido pasa
a `delivered` (en `order.service.ts`, junto al volcado que ya ocurre ahí). Nuevo prefijo
`CachePrefix.TASTE = 'taste:'` — **no** se cuelga del plugin de invalidación de
Mongoose, porque `Order` no lo tiene y añadírselo invalidaría el catálogo entero en cada
cambio de estado de cada pedido.

### 7.3 Las secciones personales y su consulta

| Sección | Regla | Fuente |
|---|---|---|
| **Vuelve a pedir** | negocios con ≥2 pedidos entregados, últimos 90 d | `Order` |
| **Porque pediste \<X\>** | mismos tags que el último pedido, **otros** negocios | `Order` + `tags` |
| **Descubre algo nuevo** | negocios bien calificados de los que **nunca** pidió | `Order` (exclusión) |
| **Nunca has probado esto** | tags del catálogo **ausentes** del perfil, rating ≥ 4 | `tags` (exclusión) |
| **De tus favoritos** | productos nuevos en negocios marcados como favoritos | `Favorite` + `createdAt` |

Las dos de exclusión son el corazón del anti-burbuja. Son también las más baratas: un
`$nin` sobre una lista corta.

### 7.4 Arquitectura de caché: base compartida + capa personal

Este es el punto donde una implementación ingenua se rompe. Cachear el feed entero por
usuario multiplica las claves por el número de usuarios activos y tira la caché.

```
GET /explore
 ├─ base     = cache.wrap(`explore:{city}:{lat}:{lng}:{dist}:{daypart}`, 60s,  buildBaseFeed)
 ├─ personal = cache.wrap(`explore:u:{userId}:{lat}:{lng}:{daypart}`,   300s, buildPersonal)
 └─ assemble(base, personal, seed)      ← en memoria, cero consultas
```

- Lo **caro** (el `$facet` de 25-30 ramas sobre `Product`) se calcula **una vez por
  zona**, como hoy.
- Lo **personal** son 2 agregaciones pequeñas, cada 5 minutos por usuario.
- El **ensamblado** —intercalar, barajar con la semilla, aplicar presupuestos de
  exposición— es memoria pura.

Usuario anónimo: se salta la rama personal y las secciones de exclusión caen a su
variante genérica ("Algo diferente" en vez de "Nunca has probado esto").

### 7.5 El equilibrio: cuántos slots a cada cosa

Sobre un feed de ~12 entradas:

| Tipo | Entradas | Papel |
|---|---|---|
| Neutral (tendencias, nuevos, cerca de ti, rotativas) | 7-8 | la base, igual para todos |
| Personal **afín** (vuelve a pedir, porque pediste X) | 2 | confort y conversión |
| Personal **exploratoria** (descubre algo nuevo, nunca has probado) | 2 | el diferenciador |
| Comercial (banner) | 1 | |

Y **dentro** de una sección afín, una cuota de exploración:

```ts
const EXPLORATION_RATE = 0.3;   // 3 de cada 10 slots salen fuera del perfil
```

Es *epsilon-greedy* de manual: el 30% de lo que ves en "Porque pediste hamburguesa" no
es hamburguesa. Suficiente para romper la burbuja, poco para no romper la promesa del
título.

---

## 8. Plan técnico

### 🔴 Prioridad alta — sin esto no hay Explorar nueva

| # | Qué | Capa | Compl. | Depende de |
|---|---|---|---|---|
| **A1** | **`tags` en `Product`** — vocabulario cerrado en `backend/src/constants/productTags.ts`, campo `tags: [String]` con `enum`, índice `{ tags: 1, isAvailable: 1 }` | BD + backend | **M** | — |
| **A2** | **Script de backfill** `backend/src/scripts/backfillProductTags.ts` — deriva tags de `searchName` reutilizando los 6 diccionarios de `homeSections.service.ts:55-60`, ampliados. Idempotente (`--force` para reescribir), por `bulkWrite` en lotes de 500 | backend | **S** | A1 |
| **A3** | **Modelo `DiscoveryCollection`** + DSL cerrado de reglas + validación Zod | BD + backend | **L** | A1 |
| **A4** | **Seed de las 20 actuales** `backend/src/scripts/seedDiscoveryCollections.ts`, con su `feed` asignado | backend | **S** | A3 |
| **A5** | **Motor v2** `backend/src/services/discovery.service.ts` — lee las definiciones de BD, compila el DSL a `$facet` dinámico, aplica presupuestos de exposición y diversificación | backend | **L** | A1, A3 |
| **A6** | **`GET /api/v1/explore`** con `identifyIfPossible`, caché base+personal | backend | **M** | A5 |
| **A7** | **`/home-sections` filtra por feed** — mismo contrato, menos entradas | backend | **S** | A5 |
| **A8** | **Pantalla Explorar nueva** — `ExploreFeed.tsx` + `SearchResults.tsx`, `search.tsx` queda como orquestador de ~150 líneas | mobile | **L** | A6 |
| **A9** | **Chips de intención** + `freeDelivery` y `maxPrice` en `SearchFilters` | mobile + backend | **M** | A8 |
| **A10** | **Banda "Ahora"** — `dayparts` en la colección + resolución de franja en `America/Bogota` | backend | **S** | A3 |
| **A11** | **Presupuesto por negocio** — los dos topes nuevos en `pickForSection` | backend | **S** | A5 |

### 🟡 Prioridad media — lo que la vuelve buena

| # | Qué | Capa | Compl. | Depende de |
|---|---|---|---|---|
| **B1** | **Perfil de gustos** `tasteProfile.service.ts` + caché `taste:` + invalidación al entregar | backend | **M** | A1 |
| **B2** | **Secciones personales** (las 5 de §7.3) | backend | **M** | B1 |
| **B3** | **Diversificación greedy** — `diversify()` con Jaccard sobre tags | backend | **M** | A1, A5 |
| **B4** | **Rotación por semilla** — `dailySeed` + pool rotativo + ventana desplazada | backend | **M** | A5 |
| **B5** | **Panel de colecciones** `admin/src/pages/DiscoveryCollections.tsx` + ruta + entrada de menú + **previsualización** | admin + backend | **L** | A3 |
| **B6** | **Tags en el panel de negocio** — control de chips en el modal de producto de `business/src/pages/Menu.tsx` | business + backend | **M** | A1 |
| **B7** | **Grid de antojos** + pantalla "todas las categorías" | mobile | **M** | A1, A8 |
| **B8** | **`placement: 'explore'`** en `PromotionBanner` | backend + admin | **S** | — |
| **B9** | **"Nuevos en Zipp"** — resucitar `BusinessFeatured`, colección de negocios | backend + mobile | **M** | A3 |
| **B10** | **`useUsual` al servidor** — hoy se calcula en el cliente desde `/orders/my` | backend + mobile | **S** | B1 |
| **B11** | **Tests** de `discovery.service` y del compilador de DSL | backend | **M** | A5 |

### 🟢 Futuro — cuando haya volumen

| # | Qué | Por qué esperar |
|---|---|---|
| **C1** | Colecciones por **barrio**, no por radio | necesita zonas definidas y densidad |
| **C2** | Banners **segmentados** por perfil de gustos | necesita B1 estable y suficientes banners |
| **C3** | **Métricas por colección** (impresión y toque, agregados, sin identificar al usuario) | es el dato que permite apagar lo que no funciona |
| **C4** | Colecciones **programadas** (festivos, lluvia, partidos) | el modelo ya tiene `startDate`/`endDate`; falta el disparador |
| **C5** | **Capa social** | densidad de usuarios |
| **C6** | **Búsqueda semántica** (embeddings) | el diccionario actual resuelve bien el 90% |

### 8.1 Detalle de los ítems que más se pueden torcer

#### A1 — Vocabulario de tags

Cerrado, en `backend/src/constants/productTags.ts`, validado por `enum` en el esquema.
Propuesta para el contexto colombiano:

```ts
export const PRODUCT_TAGS = [
  // Plato
  'hamburguesa','perro','pizza','pollo','asado','carne','arroz','sopa','bandeja',
  'corrientazo','empanada','salchipapa','sandwich','taco','pasta','mariscos','ensalada',
  // Panadería y desayuno
  'desayuno','arepa','pan','huevo','tamal','changua',
  // Dulce
  'postre','helado','torta','brownie','waffle',
  // Bebida
  'cafe','jugo','gaseosa','limonada','malteada','granizado','cerveza','agua',
  // Atributo
  'picante','vegetariano','saludable','para_compartir','personal','combo','familiar',
  // No comida
  'medicamento','aseo','mercado','mascota',
] as const;
```

~45 términos. Suficiente para cubrir el catálogo real sin convertirse en un formulario
que ningún comercio va a llenar. **Máximo 5 tags por producto**, validado en el esquema:
un producto con doce tags no aporta información, la diluye.

**Compatibilidad:** mientras el backfill no corra, `tags` es `[]`. Las reglas con
`source: 'tags'` no devolverían nada, así que el compilador aplica un **fallback
automático a la regex de keywords** cuando la colección declara `fallbackKeywords: true`.
Se retira ese camino cuando el backfill haya corrido en producción y se verifique
cobertura > 80%.

#### A3 — El DSL de reglas (y por qué es cerrado)

Un admin **nunca** debe poder escribir un pipeline de Mongo desde un formulario. Eso es
inyección con pasos extra. El DSL:

```ts
type Rule =
  | { source: 'tags';             any: string[] }
  | { source: 'discount';         minPercent: number }
  | { source: 'price';            min?: number; max?: number }
  | { source: 'prepTime';         maxMinutes: number }
  | { source: 'new';              withinDays: number; of: 'product' | 'business' }
  | { source: 'featured' }
  | { source: 'sales';            window: 'mostOrdered' | 'repeat' | 'trending' }
  | { source: 'businessRating';   min: number; minReviews?: number }
  | { source: 'businessCategory'; any: BusinessCategory[] }
  | { source: 'nearby' }
  | { source: 'personal';         kind: 'reorder'|'becauseYouOrdered'|'neverTried'|'fromFavorites' };

interface RuleDSL {
  all: Rule[];            // AND de condiciones, máximo 4
  sortBy: 'relevance'|'discount'|'price_asc'|'price_desc'|'newest'|'rating'|'distance'|'prep'|'sales';
}
```

`compileRule(rule): Record<string, unknown>` traduce cada variante a un fragmento de
`$match` **construido en código**, nunca interpolando valores del admin en operadores.
Validación con Zod a la entrada del controlador, antes de tocar la BD.

Esquema del modelo, en `backend/src/models/DiscoveryCollection.ts`:

```ts
{
  key: String,            // unique, kebab-case, max 40
  title: String,          // max 60
  subtitle: String,       // max 120, opcional
  illustration: String,   // nombre de la mini-ilustración, opcional
  feed: 'home'|'explore'|'both',
  displayVariant: 'compact'|'large'|'horizontal'|'featured'|'price_focus'|'banner'|'business_row'|'spotlight',
  rule: RuleDSL,
  order: Number,          // 0-999, mismo espacio numérico que CuratedHomeBlock y PromotionBanner.homeOrder
  dayparts: [String],     // vacío = siempre
  weekdays: [Number],     // vacío = siempre
  minSize: Number,        // default 4
  targetSize: Number,     // default 10
  rotation: 'none'|'daily'|'daypart',
  fallbackKeywords: Boolean,
  isActive: Boolean,
  startDate: Date, endDate: Date,
}
```

Índice `{ isActive: 1, feed: 1, order: 1 }`. Plugin de invalidación con prefijos
`['home:', 'explore:']`.

#### A5 — El `$facet` dinámico y su límite real

Hoy el `$facet` tiene 19-20 ramas fijas. Con colecciones en BD pasa a ser dinámico, lo
que abre dos preguntas:

1. **¿Cabe?** El resultado de un `$facet` es **un solo documento**, sujeto al límite de
   16 MB de BSON. Con 30 colecciones × 30 candidatos × ~1 KB por producto proyectado ≈
   **900 KB**. Va muy sobrado.
2. **¿Y si el admin crea 80 colecciones?** Tope duro validado en el controlador:
   **`MAX_ACTIVE_COLLECTIONS = 40` por feed**. Por encima, el `POST`/`PATCH` responde
   422 explicando que hay que desactivar alguna. Es un límite de producto además de
   técnico: un feed de 80 secciones no lo mira nadie.

Además, solo entran al `$facet` las colecciones **elegibles ahora**: activas, dentro de
su ventana de fechas, y cuya franja horaria coincide. En la práctica eso baja de 30 a
~18 ramas por petición.

#### A8 — Reestructuración del móvil

`search.tsx` tiene 906 líneas y hace tres trabajos. Se parte en tres:

```
mobile/app/(client)/(tabs)/search.tsx      ~150 líneas — orquesta estado y decide el modo
mobile/components/domain/ExploreFeed.tsx   ~300 líneas — el feed de descubrimiento
mobile/components/domain/SearchResults.tsx ~350 líneas — resultados, sugerencias, vacíos
```

**Sin `FlashList`.** Añadir esa dependencia obliga a recompilar el dev client, y el
proyecto ya tiene historial de dolor con eso (`prebuild --clean` y el keystore). Un
`FlatList` de secciones con `renderItem` por `kind` —el mismo patrón que `home.tsx` ya
usa— rinde de sobra con 12 entradas, porque cada entrada es a su vez un `FlatList`
horizontal con su propia virtualización.

Rendimiento:
- `useProgressiveLimit(4)` para montar 4 secciones y el resto tras
  `InteractionManager.runAfterInteractions` — el patrón ya existe en `home.tsx:27,30,52`.
- `removeClippedSubviews`, `windowSize={5}`, `initialNumToRender={4}`.
- `getItemLayout` **no**: las alturas son heterogéneas y estimarlas mal es peor que no
  darlo.

Componentes que se reutilizan tal cual: `ProductCollectionRow`, `CollectionHeader`,
`SpotlightCarousel`, `BusinessCollectionRow`, `PromoCarousel`, `CategoryTile`,
`BusinessRow`, `SearchFiltersSheet`.

Componentes huérfanos que se resucitan: **`BusinessFeatured`** (`BusinessCard.tsx:411`)
para "Nuevos en Zipp", y **`CategoryProductCarousel`** para la pantalla de "todas las
categorías" (B7), que es para lo que estaba pensado.

#### B5 — Panel de admin

`admin/src/pages/DiscoveryCollections.tsx`, siguiendo el patrón de
`admin/src/pages/CuratedHomeBlocks.tsx` (613 líneas) y `HomeCategories.tsx`:

- Ruta `<Route path="discovery-collections" element={<DiscoveryCollections />} />` en
  `admin/src/App.tsx`, junto a las de `home-banners` y `home-categories` (líneas 99-101).
- Entrada de menú en `admin/src/components/Layout.tsx`, junto a las líneas 58-61.
- **Constructor de regla con selectores**, no texto libre: un desplegable de `source` y,
  según lo elegido, los campos que esa variante admite.
- **Previsualización obligatoria**: `GET /discovery-collections/:id/preview?lat&lng`
  devuelve los productos que saldrían ahora mismo. Sin esto, el admin publica a ciegas y
  el feed se llena de secciones vacías.
- Reordenar con `PATCH /discovery-collections/reorder`, igual que el reorder de banners
  que ya existe.

#### B6 — Tags en el panel de negocio

En `business/src/pages/Menu.tsx`, dentro del modal de producto, después del campo
"Tiempo de preparación (opcional)" (línea ~837):

```tsx
<Field label="Etiquetas (máximo 5)" htmlFor="product-tags">
  {/* chips seleccionables del vocabulario, agrupados por familia */}
</Field>
```

Tres puntos de cambio: el estado inicial de `productForm` (línea ~37), la hidratación al
editar (línea ~209) y el payload del guardado (línea ~290). El backfill deja tags
sugeridos ya puestos, así que el comercio **corrige**, no rellena desde cero — que es la
diferencia entre que lo usen y que no.

### 8.2 La API nueva

```ts
// GET /api/v1/explore?lat&lng&maxDistance&city&intent
// auth: identifyIfPossible  (funciona anónimo; con sesión, personaliza)
// Cache-Control: private, max-age=30   ← private: puede llevar datos del usuario

interface ExploreResponse {
  entries: ExploreEntry[];
  daypart: 'madrugada' | 'manana' | 'tarde' | 'noche';
  personalized: boolean;      // el cliente puede decidir si pinta "Para ti"
}

type ExploreEntry =
  | { kind: 'collection';         order: number; key: string; title: string;
      subtitle?: string; illustration?: string; displayVariant: DisplayVariant;
      personal?: boolean; products: HomeSectionProduct[] }
  | { kind: 'businessCollection'; order: number; key: string; title: string;
      subtitle?: string; businesses: CuratedHomeBusiness[] }
  | { kind: 'productBanner';      order: number; /* … igual que hoy … */ }
  | { kind: 'businessBanner';     order: number; /* … igual que hoy … */ }
  | { kind: 'promo';              order: number; banners: PromoBanner[] };
```

**Nota sobre la cabecera:** `/home-sections` usa hoy `cacheHeaders(res, 'shared')` →
`public, max-age=60`. `/explore` **no puede** ser `public` cuando lleva secciones
personales: un proxy intermedio serviría el feed de un usuario a otro. Hay que añadir un
modo `'private'` a `backend/src/middlewares/cacheControl.ts`.

Endpoints de administración (todos bajo `authenticate + authorize(ADMIN)`, siguiendo
exactamente el patrón de `curatedHomeBlock.routes.ts`):

```
GET    /api/v1/discovery-collections/options     → vocabulario de tags, variantes, fuentes del DSL
GET    /api/v1/discovery-collections             → listado paginado, filtro por feed
POST   /api/v1/discovery-collections
GET    /api/v1/discovery-collections/:id
PATCH  /api/v1/discovery-collections/:id
PATCH  /api/v1/discovery-collections/:id/toggle
PATCH  /api/v1/discovery-collections/reorder
GET    /api/v1/discovery-collections/:id/preview?lat&lng    ← lo que saldría ahora
DELETE /api/v1/discovery-collections/:id
```

**Contrato:** `apiContract.test.ts` compara contra
`backend/src/__tests__/__contracts__/api-contract.baseline.json`. Añadir rutas es
aditivo y solo exige regenerar el baseline. **La forma de `/home-sections` no cambia** —
sigue devolviendo `HomeFeedEntry[]`, solo que menos entradas. Eso mantiene funcionando
las versiones de la app ya instaladas mientras se despliega la nueva.

---

## 9. Roadmap de implementación

| Fase | Qué entra | Resultado visible | Ítems |
|---|---|---|---|
| **1 — Cimientos** | Tags, backfill, modelo de colección, DSL, seed de las 20 | Nada cambia para el usuario. Todo lo demás se apoya aquí. | A1-A4 |
| **2 — Motor** | `discovery.service.ts`, `/explore`, reparto por feed, presupuesto por negocio, franjas | La API ya sirve el feed nuevo. Inicio se aligera. | A5-A7, A10, A11 |
| **3 — La pantalla** | Explorar nueva, chips de intención, grid de antojos | **Aquí se ve el trabajo.** | A8, A9, B7 |
| **4 — Personal** | Perfil de gustos, 5 secciones personales, diversificación, rotación | El feed deja de ser igual para todos y deja de ser igual cada día. | B1-B4, B10 |
| **5 — Control** | Panel de colecciones, tags en el panel de negocio, banners de Explorar, Nuevos en Zipp | Producto puede operar sin pedir deploys. | B5, B6, B8, B9, B11 |

**Orden no negociable:** 1 → 2 → 3. Las fases 4 y 5 pueden ir en paralelo, y la 5 puede
adelantarse si hace falta empezar a curar contenido antes de tener la personalización.

Un corte útil si hay que entregar valor antes: **al final de la fase 3 ya se puede
publicar.** Explorar sería mejor que hoy aunque el feed siga siendo igual para todos.

---

## 10. Las 10 mejoras más importantes

En orden de ejecución, que no es exactamente el orden de impacto: algunas están arriba
porque desbloquean a las demás.

| # | Mejora | Impacto | Esfuerzo | Por qué está aquí |
|---|---|---|---|---|
| **1** | **Tags en productos + backfill** | 🔥🔥🔥 | M | Es el techo de calidad de todo lo demás. Hoy la semántica sale de regex sin ancla sobre `searchName`. Sin esto, cada colección nueva es código nuevo. |
| **2** | **Mover el grueso del feed de Inicio a Explorar** | 🔥🔥🔥 | M | El arreglo más grande por menos trabajo: el contenido ya existe y está bien hecho, solo está en la pantalla equivocada. |
| **3** | **Colecciones configurables desde el panel** | 🔥🔥🔥 | L | Convierte el descubrimiento de algo que se despliega en algo que se opera. El código ya lo anticipaba. |
| **4** | **Pantalla nueva: grid de antojos + jerarquía de tres pesos** | 🔥🔥🔥 | L | Es donde se materializa el "wow". Mata la lista vertical con chevrons. |
| **5** | **Banda "Ahora" por franja horaria** | 🔥🔥 | S | La mejor relación esfuerzo/percepción del documento. Media jornada. Hoy "Para empezar el día" sale a las 3 a.m. |
| **6** | **Chips de intención sobre el feed** | 🔥🔥 | M | Saca los filtros del sheet, donde nadie los abre mientras explora. "Envío gratis" y "Menos de $15.000" ya son datos. |
| **7** | **"Nunca has probado esto" / "Descubre algo nuevo"** | 🔥🔥🔥 | M | Es literalmente lo que se pidió. Y es lo que Rappi tiene y DiDi no. |
| **8** | **Presupuesto de exposición por negocio** | 🔥🔥 | S | Arregla un defecto real y documentado: hoy un comercio puede copar una sección entera. Los propios tests lo esquivan. |
| **9** | **Rotación diaria con semilla determinista** | 🔥🔥 | M | Es el mecanismo de "siempre hay algo diferente", sin que el feed salte bajo el dedo al recargar. |
| **10** | **Perfil de gustos con las señales que ya existen** | 🔥🔥 | M | Desbloquea las cinco secciones personales sin una sola línea de tracking nuevo. |

---

## 11. Riesgos concretos

Cosas que este plan puede romper, y qué hacer al respecto. No son hipotéticas: cinco de
las siete son repeticiones de problemas que este proyecto ya tuvo.

| # | Riesgo | Por qué es real aquí | Mitigación |
|---|---|---|---|
| **R1** | **La caché comparte el prefijo `home:`** — `home:sections:*`, `home:curated` y `home:promo` cuelgan todos de ahí, así que **cualquier** escritura de producto o negocio borra el feed de todas las zonas | Ya pasa hoy. Añadir `explore:` sin cuidado duplica el problema | Nuevo `CachePrefix.EXPLORE`. Añadirlo a `prefixesFor` de `Product`, `Business` y `DiscoveryCollection`. Evaluar separar `home:sections:` de `home:curated`, que se invalidan por razones distintas |
| **R2** | **El rate limit vacía la pantalla** — el proyecto ya vivió esto: un 429 se ve exactamente igual que "no tienes datos" | Un feed con 12 secciones invita a pedir 12 endpoints | **Una sola petición.** `/explore` trae todo, igual que `/home-sections` hoy. Ni un `useQuery` por sección. Y un estado de error explícito, distinto del estado vacío |
| **R3** | **`sales:home` solo caduca por TTL** — `Order` no tiene el plugin de invalidación, así que "Los más pedidos" va 10 minutos por detrás | Ya pasa. Con más colecciones dependientes de ventas, se nota más | Se acepta: 600 s es correcto para un ranking. **No** añadir el plugin a `Order`: invalidaría el catálogo entero en cada cambio de estado de cada pedido |
| **R4** | **Los tests de `homeSections` asumen las 20 secciones en código** — los 9 casos de `homeSections.test.ts` fallan en bloque el día que las definiciones se mudan a BD | Certeza, no riesgo | El `beforeEach` siembra las colecciones desde el mismo seed de producción (A4). Reutilizar `openAllDay`/`closeAllDay` y `deliver()`, que ya existen |
| **R5** | **El `$facet` crece sin techo** si el admin crea colecciones sin límite | El límite de 16 MB por documento de BSON es real, aunque con 30 colecciones estemos en ~900 KB | Tope duro `MAX_ACTIVE_COLLECTIONS = 40` por feed, validado en el controlador con un 422 que explica qué hacer. Solo entran al `$facet` las elegibles por franja y fecha |
| **R6** | **Contenido vacío en zona con poco catálogo** — Garzón no es Bogotá. Con `MIN_SECTION_SIZE = 4` y presupuestos de exposición más estrictos, media pantalla puede desaparecer | Muy probable en producción | El ensamblado garantiza un **mínimo de 6 entradas**. Si no se llega, se relajan en orden: primero `MAX_PER_BUSINESS_IN_SECTION`, luego el radio, luego `minSize`. Nunca se sirve un feed de 2 secciones |
| **R7** | **`Cache-Control: public` con contenido personal** | `/home-sections` hoy es `public, max-age=60`. Copiar esa cabecera en `/explore` filtraría el feed de un usuario a otro a través de cualquier proxy | Modo `'private'` en `middlewares/cacheControl.ts`, y usarlo en `/explore` siempre —también en anónimo, para no depender de una rama condicional |

**Riesgo no técnico, y el más probable de todos:** el catálogo real de Garzón puede no
tener suficiente variedad para llenar 12 secciones distintas. Merece comprobarse
**antes** de la fase 3, con una consulta directa sobre producción: cuántos productos
disponibles hay, cuántos negocios activos, y cuántos tags distintos saldrían del
backfill. Si el resultado son 200 productos en 15 negocios, este plan se recorta a 7
secciones y se invierte el esfuerzo en conseguir catálogo, no en pintarlo.

---

## 12. Cómo se verifica

| Qué | Cómo |
|---|---|
| Backfill de tags | `npx tsx backend/src/scripts/backfillProductTags.ts --dry-run` → informe de cobertura por tag antes de escribir nada |
| Compilador del DSL | Tests unitarios: cada variante de `Rule` produce el `$match` esperado; una regla malformada es rechazada por Zod, no por Mongo |
| Motor de descubrimiento | `backend/src/__tests__/discovery.test.ts`, heredando los 9 casos de `homeSections.test.ts` + los nuevos: tope por negocio, franja horaria, reparto por feed, mínimo de entradas |
| Que no se rompa nada | `npm test` en `backend/` — los 903 tests actuales deben seguir verdes |
| Contrato | `apiContract.test.ts` con el baseline regenerado; verificar a mano que `/home-sections` conserva su forma |
| Rendimiento | Medir `/explore` con caché fría contra el catálogo de `scripts/teste`. Objetivo: por debajo de 400 ms |
| La pantalla | `npm run start:client` y recorrer Explorar en las cuatro franjas horarias (se puede forzar el `daypart` con un query param en desarrollo) |
| Variedad real | Abrir Explorar tres días seguidos a la misma hora y comprobar que el bloque rotativo cambió |

---

## 13. Estado de la implementación

Actualizado el 2026-09-20. Backend: **1335/1335 tests en verde**.

### ✅ Fase 1 — Cimientos

| Ítem | Dónde |
|---|---|
| Vocabulario cerrado de 45 etiquetas + `deriveTags()` | `backend/src/constants/productTags.ts` |
| `tags: string[]` en `Product`, validado por `enum`, máximo 5 | `backend/src/models/Product.ts` |
| Índice multiclave `{ tags: 1, isAvailable: 1 }` | `backend/src/models/Product.ts` |
| Script de relleno, idempotente, con `--dry-run` e informe de cobertura | `backend/src/scripts/backfillProductTags.ts` |
| Modelo `DiscoveryCollection` + DSL cerrado de 11 fuentes | `backend/src/models/DiscoveryCollection.ts` |
| Las 20 heredadas + 6 nuevas, como datos | `backend/src/constants/discoverySeeds.ts` |
| Script de siembra | `backend/src/scripts/seedDiscoveryCollections.ts` |
| Prefijos de caché `explore:` y `taste:`, propagados a los 7 modelos que invalidan `home:` | `backend/src/cache/invalidation.ts` |

### ✅ Fase 2 — Motor

| Ítem | Dónde |
|---|---|
| `compileRule()` / `compileDSL()` — el admin nunca escribe Mongo | `backend/src/services/discovery.service.ts` |
| `$facet` dinámico, una rama por colección elegible | `backend/src/services/discovery.service.ts` |
| Topes de exposición **por negocio** (3 en el feed, 2 por sección) | `pickForSection()` |
| Diversificación greedy con Jaccard sobre etiquetas (α = 0.7) | `similarity()` / `pickForSection()` |
| Segunda pasada relajada para catálogos pequeños | `assemble()` |
| Franjas horarias en `America/Bogota` | `daypartAt()` / `isEligibleNow()` |
| Semilla determinista de rotación (FNV-1a) | `dailySeed()` / `rotateWindow()` |
| `GET /api/v1/explore`, una sola petición, `Cache-Control: private` | `explore.{service,controller,routes}.ts` |
| `/home-sections` delegando y filtrando por feed — **misma forma de respuesta** | `homeSections.service.ts` (836 → 324 líneas) |
| `identifyIfPossible` promovido a middleware compartido | `backend/src/middlewares/identify.ts` |
| 23 tests nuevos: compilador, elegibilidad, rotación, reparto, topes | `backend/src/__tests__/discovery.test.ts` |
| `tags` autorizado por escrito en el contrato de API | `apiContract.test.ts` |

### ✅ Fase 3 — Pantalla (parcial)

| Ítem | Dónde |
|---|---|
| Tipos y cliente de `/explore` | `mobile/services/endpoints.ts` |
| `useExplore()` — `staleTime` 2 min por la rotación horaria | `mobile/hooks/useApi.ts` |
| Las colecciones en Explorar | `mobile/components/domain/ExploreCollections.tsx` |
| Chips de intención con retirada al volver a tocarlos | `search.tsx` (`INTENTS`, `applyIntent`) |
| La ilustración del servidor manda sobre el mapa local | `ProductCollectionRow.tsx` |

### Pendiente

| # | Qué | Fase |
|---|---|---|
| A9 | Filtros `freeDelivery` y `maxPrice` en el servidor, y sus dos chips | 3 |
| B7 | Pantalla "todas las categorías" (`/(client)/categories`) | 3 |
| B1-B2 | Perfil de gustos y las 5 secciones personales (`source: 'personal'` ya compila a `null` y se salta) | 4 |
| B5 | Panel de colecciones en `admin/` | 5 |
| B6 | Editor de etiquetas en `business/src/pages/Menu.tsx` | 5 |
| B10 | `useUsual` al servidor | 5 |

### Dos pasos manuales antes de producción

```bash
npm run backfill:product-tags -- --dry-run   # informe de cobertura primero
npm run backfill:product-tags
npm run seed:discovery-collections           # sin esto los dos feeds salen vacíos
```

El segundo **no es opcional**: desde que las colecciones viven en la base, un
despliegue sin sembrar deja Inicio y Explorar en blanco.

---

## 14. Resumen en una frase

Explorar deja de ser un buscador con un índice debajo y pasa a ser **un feed de trece
bandas** —control arriba, descubrimiento en medio, catálogo abajo— alimentado por
**colecciones que viven en la base de datos y no en el código**, con contenido que
**rota cada día y cada franja horaria**, personalizado con **las señales que Zipp ya
guarda pero no usa**, y con una cuota fija reservada a **lo que el usuario nunca habría
buscado**.



