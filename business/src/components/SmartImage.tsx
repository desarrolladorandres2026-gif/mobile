import { useState } from 'react';
import { ImageOff } from 'lucide-react';

/**
 * La imagen de un producto, servida al tamaño que toca.
 *
 * Tres cosas que un `<img src>` a secas no hace:
 *
 * · **No salta la maquetación.** El contenedor es cuadrado desde el
 *   primer pintado, así que el hueco ya está reservado antes de que
 *   llegue un solo byte. Un `<img>` sin dimensiones empuja el contenido
 *   hacia abajo al cargar, y en una lista de treinta productos eso es la
 *   página entera moviéndose.
 *
 * · **No descarga de más.** `srcSet` + `sizes` dejan que el navegador
 *   elija: la miniatura de 200 px en una fila del menú, la de 800 en la
 *   ficha. Servir la de 1200 para un cuadro de 48 px es exactamente lo
 *   que hace lenta una app de catálogo con datos móviles.
 *
 * · **No enseña un hueco gris.** Mientras carga se ve la versión
 *   diminuta y borrosa que ya viene calculada, en el sitio exacto y con
 *   los colores de la foto real.
 */

export interface ProductImages {
  thumb: string;
  catalog: string;
  detail: string;
  large: string;
  /** `data:` URI incrustado, o la URL en productos anteriores al relleno. */
  placeholder: string;
  width: number;
  height: number;
  /** Si las variantes se sirven con la cadena de mejora automática. */
  enhanced: boolean;
  backgroundRemoved: boolean;
}

/**
 * Ancho real de cada variante, en px. Copia de `PRODUCT_IMAGE_VARIANTS`
 * del backend: si allí cambia un tamaño, cambia aquí.
 *
 * El `srcSet` se arma en el panel y no viaja del servidor porque solo lo
 * usa el panel: en cada respuesta pública eran cuatro URLs repetidas por
 * producto que ni el móvil ni la web leían.
 */
const VARIANT_WIDTHS = { thumb: 200, catalog: 400, detail: 800, large: 1200 } as const;

function srcSetOf(images: ProductImages): string {
  return (Object.keys(VARIANT_WIDTHS) as (keyof typeof VARIANT_WIDTHS)[])
    .map((key) => `${images[key]} ${VARIANT_WIDTHS[key]}w`)
    .join(', ');
}

interface Props {
  images?: ProductImages | null;
  /** Producto sin foto: se usa para el texto alternativo y el hueco. */
  alt: string;
  /**
   * Ancho que ocupará la imagen, en sintaxis de `sizes`. Sin esto el
   * navegador asume el ancho de la ventana y baja la variante más grande.
   */
  sizes?: string;
  /** Variante que se pide como `src` de partida. */
  base?: 'thumb' | 'catalog' | 'detail' | 'large';
  className?: string;
  /** La primera imagen visible no debe ser diferida. */
  priority?: boolean;
}

export default function SmartImage({
  images,
  alt,
  sizes = '(max-width: 640px) 25vw, 96px',
  base = 'catalog',
  className = '',
  priority = false,
}: Props) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!images || failed) {
    return (
      <div
        className={`grid place-items-center bg-[var(--color-bg-alt)] text-[var(--color-text-muted)] ${className}`}
        role="img"
        aria-label={failed ? `No se pudo cargar la foto de ${alt}` : `${alt}, sin foto`}
      >
        <ImageOff className="w-1/3 h-1/3 max-w-6 max-h-6 opacity-60" />
      </div>
    );
  }

  return (
    <div className={`relative overflow-hidden bg-[var(--color-bg-alt)] ${className}`}>
      {/*
        El desenfoque de carga va de fondo y no como otra <img>: así no
        compite por el hueco ni provoca un segundo repintado, y desaparece
        con una transición cuando la de verdad ya está decodificada.
      */}
      <div
        aria-hidden
        className={`absolute inset-0 bg-cover bg-center transition-opacity duration-300 ${
          loaded ? 'opacity-0' : 'opacity-100'
        }`}
        style={{ backgroundImage: `url("${images.placeholder}")` }}
      />

      <img
        src={images[base]}
        srcSet={srcSetOf(images)}
        sizes={sizes}
        alt={alt}
        width={images.width}
        height={images.height}
        loading={priority ? 'eager' : 'lazy'}
        // `async` deja que el navegador decodifique fuera del hilo
        // principal: con muchas filas, decodificar en línea se nota como
        // tirones al desplazar.
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={`relative w-full h-full object-cover transition-opacity duration-300 ${
          loaded ? 'opacity-100' : 'opacity-0'
        }`}
      />
    </div>
  );
}
