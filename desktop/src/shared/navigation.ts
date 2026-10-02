/**
 * Qué puede navegar la ventana principal y qué se manda al navegador del
 * sistema.
 *
 * Sin electron: lo prueba `vitest` sin levantar una ventana. La ventana
 * (`main/window.ts`) solo llama a estas funciones, nunca decide por su
 * cuenta — así la regla vive en un solo sitio, igual que
 * `resolveOrderAccess` en el backend.
 */

/** Esquemas que SÍ se pueden abrir en el navegador del sistema. */
const EXTERNAL_SCHEMES = new Set(['https:', 'tel:', 'mailto:']);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * ¿Esta navegación se queda DENTRO de la ventana?
 *
 * Solo el origen exacto del panel (protocolo + host + puerto). Un
 * subdominio distinto, `http:` en vez de `https:`, o cualquier otro origen
 * —incluida una página de phishing con el mismo aspecto— se abre fuera.
 */
export function isSameOrigin(url: string, panelOrigin: string): boolean {
  const target = parse(url);
  const origin = parse(panelOrigin);
  if (!target || !origin) return false;
  return target.protocol === origin.protocol && target.host === origin.host;
}

/**
 * ¿Esta URL se puede abrir en el navegador del sistema?
 *
 * Cubre los enlaces reales del panel: WhatsApp (wa.me), la atribución de
 * Twemoji, los `tel:` de contacto y las URLs firmadas de documentos
 * (Cloudinary, siempre https). Cualquier otro esquema —`file:`, `javascript:`,
 * uno inventado— no sale, porque no hay ningún enlace legítimo que lo use y
 * sí hay ataques que sí.
 */
export function isExternalLinkAllowed(url: string): boolean {
  const target = parse(url);
  if (!target) return false;
  return EXTERNAL_SCHEMES.has(target.protocol);
}

export type NavigationDecision =
  | { action: 'allow' }
  | { action: 'open-external' }
  | { action: 'deny' };

/**
 * La decisión única para cualquier intento de navegar o abrir una ventana
 * nueva, dentro de la ventana principal.
 *
 * - Mismo origen del panel → se queda.
 * - Otro origen pero esquema de la lista blanca → se abre afuera.
 * - Cualquier otra cosa (otro origen sin lista blanca, `file:`, un esquema
 *   inventado) → se bloquea. Un `<webview>` o `window.open` a algo que no
 *   sea el panel nunca debe ejecutar JavaScript dentro de este proceso.
 */
export function decideNavigation(url: string, panelOrigin: string): NavigationDecision {
  if (isSameOrigin(url, panelOrigin)) return { action: 'allow' };
  if (isExternalLinkAllowed(url)) return { action: 'open-external' };
  return { action: 'deny' };
}
