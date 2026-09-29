# Barra lateral y barra superior del panel de comercios

Origen: `business/src/components/Layout.tsx` y `business/src/index.css`.
Destino: React + Tailwind **v4** + lucide-react (las clases `w-30`, `bg-black/4`, `ring-3` y `backdrop-blur-xs` solo existen en v4; en v3 hay que usar valores arbitrarios).

## Estructura

Contenedor raíz: `flex h-screen overflow-hidden`, fondo `--color-bg` (#F6F8FA), texto `--color-text-main` (#0B0F19).
Dos hijos: `<aside>` (barra lateral) y `<main>` (columna con barra superior fija y contenido con scroll).

## Barra lateral (compacta, solo iconos con etiqueta debajo)

**Contenedor**
- Ancho `w-30` (7.5rem = 120px). Fondo `#f1f1f1`. Borde derecho 1px `#d7d7d7`. Sombra `1px 0 3px rgba(0,0,0,.08)`.
- Columna: `flex flex-col`.
- Escritorio (`lg`): estática en el flujo (`lg:static lg:translate-x-0`).
- Móvil: `fixed inset-y-0 left-0 z-50`, desplazada `-translate-x-full`; al abrir `translate-x-0`. Transición `transform 300ms ease-out`.
- Overlay móvil: `fixed inset-0 z-40 bg-black/60 backdrop-blur-xs lg:hidden`, cierra al pulsar.

**Cabecera de marca**
- Alto `h-14`, sin encogerse, borde inferior 1px `#d7d7d7`.
- Logo 25px + texto "ZIPP" a 15px, semibold, `tracking-tight`, color `#4b4b4b`, centrados con gap de 8px.
- Botón de cerrar (solo móvil): `X` de 16px, absoluto arriba a la derecha, `#555` que pasa a `#111` al pasar el ratón.

**Selector de negocio** (opcional, solo si hay varios)
- Padding lateral 8px, arriba 8px. `select` nativo con `appearance-none`, alto 28px, fondo blanco, borde `#d7d7d7`, `rounded-sm`, texto 9px semibold `#444`, truncado.
- Chevron de 12px, absoluto a la derecha, `#666`, sin eventos de puntero.
- Foco: borde `--color-success`.

**Estado y sonido** (opcional)
- Fila centrada, gap 8px. Estado: punto de 8px (verde con `animate-pulse` si abierto, rojo si cerrado) + texto 9px bold en mayúsculas con `tracking-wide`. Sonido: icono de 14px, verde activo, `#777` silenciado.

**Lista de navegación**
- `nav` con `flex-1 overflow-y-auto pt-1`, en columna sin gap ni separadores.
- Cada ítem: columna centrada, `gap-1`, `py-2.5 px-1`, texto 11px `font-medium tracking-wide`, transición de color 150ms.
  - Icono 25px arriba, etiqueta debajo truncada y centrada con `leading-tight`.
  - Inactivo: texto `#555`. Hover: texto `#161616` y fondo `black/4`.
  - Activo: texto `#141414` semibold, icono `#292929`.
- **Indicador activo**: barra vertical pegada al borde izquierdo del ítem. `absolute left-0 top-1/2 -translate-y-1/2`, alto 48px, ancho 4px, esquinas derechas redondeadas, color champagne `#D69E26`.
- Activo se calcula por prefijo de ruta (`startsWith`), salvo la raíz `/`, que exige coincidencia exacta.
- Iconos: la referencia usa `@fluentui/react-icons` (variante Regular). Con lucide funciona igual; mantén 25px y trazo fino.

**Scrollbar de la lista**: ancho 10px, pulgar `#c5c5c5` (hover `#a8a8a8`), totalmente redondeado.

**Pie**: `px-2 py-2`, borde superior 1px `#d7d7d7`. Botón "Salir": icono `LogOut` de 20px con trazo 1.8 y texto 10px debajo, `#555`, hover rojo.

## Barra superior (dentro de `<main>`)

- `sticky top-0 z-30`, alto `h-20` (80px), fondo `#f1f1f1`, borde inferior 1px `#d7d7d7`, sombra `0 1px 3px rgba(0,0,0,.08)`. Padding horizontal 16px (24px desde `sm`). Fila con gap 12–16px.
- **Grupo izquierdo** (gap 8–12px):
  - Hamburguesa (solo `<lg`): botón circular con padding 8px, `#444`, hover fondo `#dedede`.
  - Atrás y adelante (solo `≥sm`): 36x36 circulares, flechas de 20px con trazo 2.4; atrás `#777`, adelante `#999`, hover `#222` y fondo `#dedede`.
  - Inicio: círculo de 48x48 fondo `#303030`, icono `Home` blanco de 24px relleno. Hover: escala 1.05 y fondo `#D69E26`.
- **Buscador** (solo `≥md`): `flex-1 max-w-2xl`, alto 48px, píldora blanca, borde `#d7d7d7`, padding horizontal 20px, icono de lupa de 24px `#666` y input transparente de 16px medium con placeholder `#777`. Foco (`focus-within`): borde `#D69E26` y anillo de 2px `#D69E26` al 20%.
- **Grupo derecho** (`ml-auto`, gap 8–12px):
  - Campana: 36x36 circular, `#666`, oculta bajo `sm`.
  - Perfil: píldora blanca con borde `#d7d7d7`, padding 4px (12px a la derecha), hover borde `#D69E26`. Dentro, avatar circular de 40px fondo `#D69E26`, inicial blanca bold, anillo blanco de 3px. Desde `xl` muestra a su lado nombre (12px bold `#333`, truncado a 144px) y subtítulo (10px `#777`).

## Contenido

`p-6 lg:p-8`, dentro un `page-container` con `space-y-6`. El fallback de carga es un spinner de 24px con borde `--color-primary` y parte superior transparente.

## Tokens que hay que llevar

| Token | Valor |
|---|---|
| `--color-bg` | #F6F8FA |
| `--color-text-main` | #0B0F19 |
| `--color-primary` | #D69E26 |
| `--color-success` | #10B981 |
| `--color-danger` | el del proyecto destino |
| Gris de barras | #f1f1f1 |
| Línea | #d7d7d7 |

Los grises de las barras están **escritos directamente** en el componente, no como tokens. Al portar conviene convertirlos en variables para no arrastrar la deriva de color que este repo ya sufre.

## Advertencias

- Este diseño usa fondo gris y sombra en ambas barras, lo que va en contra de la regla "sin cajas" si el proyecto destino la comparte. Son barras de navegación, no tarjetas, pero confírmalo.
- Fuente: `font-sans` del proyecto, sin tipografía especial.
- El modo oscuro **no** está resuelto en esta barra (colores fijos hex). Si el destino lo necesita, hay que tokenizar antes.
