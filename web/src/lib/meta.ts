/**
 * Título, descripción y canonical por página.
 *
 * Sin librería de head: son pocas etiquetas y la SPA las actualiza al montar
 * cada ruta. Los rastreadores que ejecutan JavaScript las leen; WhatsApp y
 * Facebook no, y para ellos está `GET /negocio/:slug` en el backend.
 */
export interface PageMeta {
  title: string;
  description?: string;
  /** Ruta canónica ("/comercios"). Se resuelve contra el origen actual. */
  path?: string;
}

function ensure(selector: string, tag: 'meta' | 'link', attrs: Record<string, string>): HTMLElement {
  let el = document.head.querySelector<HTMLElement>(selector);
  if (!el) {
    el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.head.appendChild(el);
  }
  return el;
}

function setMeta(key: 'name' | 'property', name: string, content: string): void {
  ensure(`meta[${key}="${name}"]`, 'meta', { [key]: name }).setAttribute('content', content);
}

export function setPageMeta({ title, description, path }: PageMeta): void {
  document.title = title;
  setMeta('property', 'og:title', title);
  if (description) {
    setMeta('name', 'description', description);
    setMeta('property', 'og:description', description);
  }
  if (path !== undefined) {
    const url = `${window.location.origin}${path}`;
    ensure('link[rel="canonical"]', 'link', { rel: 'canonical' }).setAttribute('href', url);
    setMeta('property', 'og:url', url);
  }
}
