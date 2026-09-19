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
 * - `none`: autenticado o con datos que no se enseñan al público.
 */
export function cacheHeaders(res: Response, policy: 'shared' | 'revalidate' | 'none'): void {
  switch (policy) {
    case 'shared':
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
      break;
    case 'revalidate':
      res.setHeader('Cache-Control', 'public, no-cache');
      break;
    default:
      res.setHeader('Cache-Control', 'private, no-store');
  }
}
