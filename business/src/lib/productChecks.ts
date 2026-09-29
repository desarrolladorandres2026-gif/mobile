import { rawDiscountPercent, type ProductFormState } from './productForm';

/**
 * Las "recomendaciones" del formulario del producto.
 *
 * Todas salen de datos ciertos: las medidas reales de la foto, lo que la
 * app hace de verdad con cada campo y las reglas del servidor. Nada de
 * opiniones sobre la iluminación: no hay nada detrás que la mire, y un
 * consejo inventado enseña al comercio a no leer ninguno.
 *
 * Los cortes de nitidez son los de la app: la lista pide la variante de
 * 400 px, la ficha la de 800 y el visor a pantalla completa la de 1200
 * (`recommendedDimension`). Por debajo de `minDimension` la ficha ya se
 * ve borrosa.
 */

export type CheckTone = 'ok' | 'info' | 'warning';

export interface ProductCheck {
  id: string;
  tone: CheckTone;
  text: string;
}

export type PhotoState =
  | { kind: 'none' }
  /** Recortada en este navegador y aún sin subir. */
  | { kind: 'pending'; sourcePixels: number; removeBackground: boolean }
  | { kind: 'saved'; width: number; height: number; backgroundRemoved: boolean };

export interface CheckLimits {
  minDimension: number;
  recommendedDimension: number;
  canRemoveBackground: boolean;
}

export function productChecks(
  form: ProductFormState,
  photo: PhotoState,
  limits: CheckLimits
): ProductCheck[] {
  const checks: ProductCheck[] = [];

  // ── Foto ──
  if (photo.kind === 'none') {
    checks.push({
      id: 'photo',
      tone: 'warning',
      text: 'Sin foto: en la carta aparece una ilustración genérica de tu tipo de negocio.',
    });
  } else {
    const pending = photo.kind === 'pending';
    const pixels = pending ? photo.sourcePixels : Math.min(photo.width, photo.height);
    const subject = pending
      ? `El recorte toma ${pixels} px de tu foto original`
      : `La foto mide ${photo.width} × ${photo.height} px`;

    if (pixels < limits.minDimension) {
      checks.push({
        id: 'resolution',
        tone: 'warning',
        text: `${subject}: se verá borrosa en la ficha del producto. ${
          pending ? 'Aleja el zoom en Recortar o usa una foto más grande.' : 'Cámbiala por una más grande.'
        }`,
      });
    } else if (pixels < limits.recommendedDimension) {
      checks.push({
        id: 'resolution',
        tone: 'info',
        text: `${subject}: nítida en la lista; en la ficha y a pantalla completa pierde algo de detalle (ideal desde ${limits.recommendedDimension} px).`,
      });
    } else {
      checks.push({
        id: 'resolution',
        tone: 'ok',
        text: `${subject}: nitidez completa, también a pantalla completa.`,
      });
    }

    if (limits.canRemoveBackground) {
      if (photo.kind === 'pending') {
        checks.push(
          photo.removeBackground
            ? { id: 'background', tone: 'ok', text: 'Al guardar quitamos el fondo; tu foto original se conserva.' }
            : { id: 'background', tone: 'info', text: 'Se subirá con su fondo. Para quitarlo, abre Recortar y marca la casilla.' }
        );
      } else if (photo.backgroundRemoved) {
        checks.push({
          id: 'background',
          tone: 'ok',
          text: 'Fondo quitado: el producto va centrado sobre el fondo de ZIPP.',
        });
      }
    }
  }

  // ── Texto ──
  if (!form.description.trim()) {
    checks.push({
      id: 'description',
      tone: 'info',
      text: 'Sin descripción: el cliente solo verá el nombre y el precio.',
    });
  }

  // ── Oferta ──
  const price = Number(form.price);
  const discount = Number(form.discountPrice);
  if (form.price.trim() && form.discountPrice.trim() && price > 0 && discount > 0) {
    if (discount >= price) {
      checks.push({
        id: 'discount',
        tone: 'warning',
        text: 'La oferta tiene que ser menor que el precio regular; así no se puede guardar.',
      });
    } else {
      const percent = rawDiscountPercent(price, discount) ?? 0;
      checks.push(
        percent < 5
          ? {
              id: 'discount',
              tone: 'info',
              text: 'Con menos del 5 % de descuento la app no muestra la etiqueta de −%, solo el precio tachado.',
            }
          : { id: 'discount', tone: 'ok', text: `La app mostrará la etiqueta −${percent}% sobre la foto.` }
      );
    }
  }

  // ── Venta restringida ──
  if (form.requiresAgeVerification) {
    checks.push({
      id: 'age',
      tone: 'info',
      text: 'Solo mayores de 18: la app exige fecha de nacimiento de adulto y el domiciliario pide la cédula al entregar.',
    });
  }

  return checks;
}
