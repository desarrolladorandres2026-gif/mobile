import { Response } from 'express';

/**
 * Cabeceras de caché HTTP para las lecturas públicas.
 *
 * Solo le sirven al navegador (paneles y web): el cliente HTTP de la app
 * móvil no las respeta, y para eso está la caché del servidor y la que la
 * propia app guarda.
 *
 * Tres grados, del más al menos agresivo:
 *
 * - `shared`: igual para todos y tolera un minuto de retraso (inicio,
 *   categorías, banners, ofertas, zonas). El navegador lo reutiliza sin
 *   preguntar y, pasado el minuto, sigue mostrándolo mientras revalida.
 * - `revalidate`: público, pero el panel del comercio lo vuelve a leer
 *   justo después de editarlo (ficha, carta): se pregunta siempre, y con
 *   el ETag de Express la respuesta es un 304 vacío si no cambió.
 * - `private`: público de leer, pero **distinto para cada persona** (el feed
 *   de Explorar lleva secciones derivadas de los pedidos de quien mira). Un
 *   proxy intermedio no puede guardarlo y servírselo a otro; el navegador de
 *   quien lo pidió, sí.
 * - `none`: autenticado o con datos que no se enseñan al público.
 */
export function cacheHeaders(
  res: Response,
  policy: 'shared' | 'revalidate' | 'private' | 'none'
): void {
  switch (policy) {
    case 'shared':
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
      break;
    case 'revalidate':
      res.setHeader('Cache-Control', 'public, no-cache');
      break;
    case 'private':
      // `private` aunque no haya sesión: depender de una rama condicional
      // para decidir la cabecera es cómo se filtra el feed de una persona a
      // otra el día que alguien añade una sección personal más.
      res.setHeader('Cache-Control', 'private, max-age=30');
      break;
    default:
      res.setHeader('Cache-Control', 'private, no-store');
  }
}
