/**
 * Configuración fija del contenedor.
 *
 * No hay `.env` en este paquete: a diferencia de `business/`, estos valores
 * se incrustan en el instalador en tiempo de build (`scripts/release.mjs`
 * los pasa como variables de entorno antes de `tsc`), porque el `.exe` no
 * tiene un servidor detrás que le sirva un `.env.production` distinto por
 * entorno. Los defaults de abajo son los de desarrollo (contra `localhost`,
 * igual que `business/.env.example`).
 */

function env(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

/**
 * Una o varias llaves públicas PEM en una sola variable de entorno, para
 * una rotación: durante la transición, `ZIPP_UPDATE_PUBLIC_KEY_PEM` lleva
 * las dos llaves, una tras otra. Se separan por el propio delimitador del
 * formato PEM, así que no hace falta inventar uno.
 */
function envPublicKeys(name: string): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return [];
  return raw
    .split(/(?<=-----END PUBLIC KEY-----)/)
    .map((pem) => pem.trim())
    .filter(Boolean);
}

export const config = {
  /** El panel que carga la ventana. Debe ser el origen exacto, sin ruta. */
  panelUrl: env('ZIPP_PANEL_URL', 'http://localhost:3002'),

  /** La API, solo para `GET /app/version` (interruptor de versión mínima). Sin credenciales. */
  apiUrl: env('ZIPP_API_URL', 'http://localhost:3000/api/v1'),

  /** Dónde vive `latest.yml` y el manifiesto firmado (ver `updater.ts`). Vacío hasta tener dominio propio. */
  updateFeedUrl: env('ZIPP_UPDATE_FEED_URL', ''),

  /**
   * Llave(s) pública(s) Ed25519 (PEM) incrustadas en el build; la privada
   * no vive en este repo. Lista, para aceptar la vieja y la nueva mientras
   * se rota (ver `shared/manifest.ts`, `verifySignedManifest`).
   */
  updatePublicKeys: envPublicKeys('ZIPP_UPDATE_PUBLIC_KEY_PEM'),

  appId: 'co.zipp.negocios',
  productName: 'Zipp Negocios',

  /** `app.getVersion()` ya lo da electron-builder desde `package.json`; se repite aquí por claridad en los imports. */
  version: process.env.npm_package_version ?? '0.0.0',
} as const;

export const isDev = process.env.NODE_ENV !== 'production';
