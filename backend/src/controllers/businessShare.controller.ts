import { Request, Response, NextFunction } from 'express';
import { businessService } from '../services';
import { config } from '../config';
import { AppError } from '../middlewares';

/**
 * La vista previa que WhatsApp/Facebook/Telegram pintan al pegar el enlace
 * que comparte la app.
 *
 * El problema que resuelve: `web/` es una SPA de React, y el rastreador de
 * WhatsApp **no ejecuta JavaScript** — solo descarga el HTML y lee las
 * etiquetas `<meta property="og:...">` del `<head>`. Contra la página real
 * (`web/src/pages/BusinessShare.tsx`), ese HTML inicial no lleva nada del
 * negocio: lo pinta React después, con una petición que el rastreador nunca
 * dispara. Por eso el enlace que de verdad se comparte no apunta a `web/`
 * sino aquí: esta ruta vive en el backend, que ya tiene el negocio en la
 * base de datos y puede escribir las etiquetas directo en el HTML, sin
 * esperar a ningún cliente.
 *
 * Un humano que toca el enlace no se queda aquí: en cuanto el HTML llega,
 * un script lo manda a la página real de `web/`, que es la que tiene el
 * botón "Abrir en la app" y el resto de la ficha. El rastreador, que no
 * corre ese script, ya se fue con lo que necesitaba antes de que importara.
 */

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] as string));

function notFoundPage(): string {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>Negocio no encontrado — Zipp</title>
<meta name="robots" content="noindex">
</head><body style="font-family:sans-serif;text-align:center;padding:4rem 1rem;color:#333">
<h1>No encontramos este negocio</h1>
<p>El enlace puede estar mal escrito o el negocio ya no está disponible.</p>
</body></html>`;
}

function previewPage(params: {
  name: string;
  description: string;
  image: string | null;
  /** La página real en `web/`: destino del rebote y `og:url` a la vez. */
  pageUrl: string;
}): string {
  const { name, description, image, pageUrl } = params;
  const title = escapeHtml(`${name} — Zipp`);
  const desc = escapeHtml(description);
  const url = escapeHtml(pageUrl);

  // `og:image` es opcional en el estándar, pero sin ella la mayoría de
  // rastreadores no pinta ninguna vista previa visual — exactamente lo que
  // se está resolviendo aquí. Cuando el negocio no tiene logo ni portada,
  // mejor ninguna etiqueta que una rota apuntando a un archivo que no existe.
  const imageTags = image
    ? `<meta property="og:image" content="${escapeHtml(image)}">
<meta name="twitter:image" content="${escapeHtml(image)}">
<meta name="twitter:card" content="summary_large_image">`
    : `<meta name="twitter:card" content="summary">`;

  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">

<meta property="og:type" content="website">
<meta property="og:site_name" content="Zipp">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${url}">
${imageTags}

<link rel="canonical" href="${url}">
<meta http-equiv="refresh" content="0; url=${url}">
<script>location.replace(${JSON.stringify(pageUrl)});</script>
</head><body style="font-family:sans-serif;text-align:center;padding:4rem 1rem;color:#333">
<p>Abriendo <a href="${url}">${title}</a> en Zipp…</p>
</body></html>`;
}

export class BusinessShareController {
  async preview(req: Request, res: Response, next: NextFunction) {
    let business;
    try {
      business = await businessService.getPublicBySlug(String(req.params.slug ?? ''));
    } catch (error) {
      // Solo "no encontrado" se convierte en la página amable: un fallo de
      // verdad (base de datos caída, etc.) sigue su camino normal hacia
      // `errorHandler` en vez de disfrazarse de negocio inexistente, que
      // borraría cualquier rastro del error real en los registros.
      if (error instanceof AppError && error.statusCode === 404) {
        res.status(404).type('html').send(notFoundPage());
        return;
      }
      next(error);
      return;
    }

    try {
      res.set('Cache-Control', 'public, max-age=300');

      const pageUrl = `${config.webUrl}/negocio/${business.slug}`;
      const description =
        business.description?.trim() ||
        `Pide en ${business.name} por Zipp. Calificación ${business.rating.toFixed(1)} · ${business.deliveryTime} min.`;

      res.type('html').send(
        previewPage({
          name: business.name,
          description,
          image: business.coverImage || business.logo || null,
          pageUrl,
        })
      );
    } catch (error) { next(error); }
  }
}

export const businessShareController = new BusinessShareController();
