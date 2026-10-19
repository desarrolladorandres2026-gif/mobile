import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * M-025 — la política CSP del panel administrativo, comprobada en lo que se
 * puede comprobar SIN navegador.
 *
 * Esto NO prueba que el panel funcione bajo la política: eso exige recorrerlo en un
 * navegador con el dominio real y leer los reportes (pasos pendientes, en el propio
 * `deploy/nginx/csp-admin.conf`). Lo que sí fija:
 *  · la política no se afloja sin que se note (nada de `unsafe-eval`, comodines ni
 *    `unsafe-inline` en scripts);
 *  · el panel no contiene nada que esa política bloquearía por construcción
 *    (scripts en línea, eval, innerHTML);
 *  · cada origen externo que el código del panel nombra está en la política: si
 *    alguien añade un CDN al panel y no a la política, esto falla aquí y no en producción.
 */

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const conf = read('deploy', 'nginx', 'csp-admin.conf');
const headerLine = conf.split('\n').find((l) => /^add_header Content-Security-Policy(-Report-Only)? /.test(l))!;
const policy = headerLine.match(/"([^"]+)"/)![1];
const directives = new Map<string, string[]>(
  policy.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const [name, ...sources] = d.split(/\s+/);
    return [name, sources] as [string, string[]];
  })
);
const sourcesOf = (d: string) => directives.get(d) ?? [];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx?|css|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const adminSource = walk(path.join(ROOT, 'admin', 'src')).map((f) => ({ file: f, text: fs.readFileSync(f, 'utf8') }));

describe('La política del panel administrativo', () => {
  it('existe, arranca en solo-informe (o ya bloquea) y reporta al backend', () => {
    expect(headerLine).toBeTruthy();
    expect(headerLine).toMatch(/Content-Security-Policy(-Report-Only)? /);
    expect(sourcesOf('report-uri')).toEqual(['https://api.REEMPLAZAR_DOMINIO/api/v1/csp-report']);
    expect(conf).toMatch(/Reporting-Endpoints/);
  });

  it('lo que no se nombra no se permite', () => {
    expect(sourcesOf('default-src')).toEqual(["'none'"]);
    expect(sourcesOf('object-src')).toEqual(["'none'"]);
    expect(sourcesOf('frame-ancestors')).toEqual(["'none'"]);
    expect(sourcesOf('base-uri')).toEqual(["'self'"]);
    expect(sourcesOf('form-action')).toEqual(["'self'"]);
  });

  it('los scripts solo salen del propio origen: sin unsafe-inline, sin unsafe-eval', () => {
    expect(sourcesOf('script-src')).toEqual(["'self'"]);
    expect(policy).not.toContain('unsafe-eval');
  });

  it("'unsafe-inline' existe SOLO en estilos (excepción documentada), nunca en scripts ni en conexiones", () => {
    const withInline = [...directives.entries()].filter(([, s]) => s.includes("'unsafe-inline'")).map(([d]) => d);
    expect(withInline).toEqual(['style-src']);
    expect(conf).toMatch(/EXCEPCIÓN DOCUMENTADA/);
  });

  it('ninguna directiva abre la puerta a cualquier origen', () => {
    for (const [name, sources] of directives) {
      if (name === 'report-uri' || name === 'report-to') continue;
      for (const source of sources) {
        expect(source, `${name} ${source}`).not.toBe('*');
        expect(source, `${name} ${source}`).not.toBe('https:');
        expect(source, `${name} ${source}`).not.toBe('http:');
        // Un comodín solo puede ser un subdominio de un dominio concreto, nunca el host entero ni un TLD.
        expect(source, `${name} ${source}`).not.toMatch(/^(https?|wss?):\/\/\*(\.[a-z]+)?$/);
      }
    }
    // Ni scripts ni conexiones ni marcos admiten esquemas enteros (data:, blob:) salvo los workers de Mapbox.
    for (const d of ['script-src', 'connect-src', 'frame-src']) {
      expect(sourcesOf(d).filter((s) => /^(data|blob):$/.test(s))).toEqual([]);
    }
  });

  it('los orígenes propios apuntan a los dominios de ZIPP, con TLS', () => {
    for (const [name, sources] of directives) {
      if (name === 'report-to') continue;
      for (const source of sources.filter((s) => /^(https?|wss?):\/\//.test(s))) {
        expect(source, `${name} ${source}`).toMatch(/^(https|wss):\/\//);
      }
    }
    expect(sourcesOf('connect-src')).toContain('https://api.REEMPLAZAR_DOMINIO');
    expect(sourcesOf('connect-src')).toContain('wss://api.REEMPLAZAR_DOMINIO');
  });

  it('documenta lo que falta verificar en un navegador real', () => {
    expect(conf).toMatch(/Lo que NO está verificado/);
    expect(conf).toMatch(/recorrer, con la consola abierta/);
    expect(conf).toMatch(/blob:/);
  });
});

describe('Lo que el panel contiene frente a esa política', () => {
  it('index.html no tiene scripts en línea y el del tema salió a un archivo', () => {
    const html = read('admin', 'index.html');
    const inline = [...html.matchAll(/<script\b([^>]*)>/gi)].filter((m) => !/\bsrc\s*=/.test(m[1]));
    expect(inline).toEqual([]);
    expect(html).toContain('/theme-init.js');
    expect(fs.existsSync(path.join(ROOT, 'admin', 'public', 'theme-init.js'))).toBe(true);
    // Lo que hace el script no cambió: mismo tema guardado, misma clase, mismo color-scheme.
    const script = read('admin', 'public', 'theme-init.js');
    expect(script).toContain("localStorage.getItem('zipp_theme')");
    expect(script).toContain("classList.add('dark')");
    expect(script).toContain('colorScheme');
  });

  it('ningún archivo del panel evalúa texto como código ni escribe HTML sin escapar', () => {
    const forbidden = /\beval\s*\(|new\s+Function\s*\(|dangerouslySetInnerHTML|\.innerHTML\s*=|document\.write\s*\(|\.insertAdjacentHTML\s*\(/;
    const offenders = adminSource.filter((f) => forbidden.test(f.text)).map((f) => path.relative(ROOT, f.file));
    expect(offenders).toEqual([]);
  });

  it('cada origen externo que el código nombra está en la política (o es un enlace saliente)', () => {
    // Enlaces a los que se navega (no recursos que la página carga): no los gobierna la CSP.
    const OUTBOUND = new Set(['www.google.com', 'github.com', 'localhost']);
    const hosts = new Set<string>();
    for (const { text } of adminSource) {
      // `{s}.tile.openstreetmap.org` es el patrón de subdominios de Leaflet: se cuenta como `a.tile…`.
      for (const m of text.matchAll(/https?:\/\/((?:\{[a-z]\}\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}|localhost)/gi)) {
        const host = m[1].toLowerCase().replace(/^\{[a-z]\}\./, 'a.');
        if (/^(www\.)?w3\.org$/.test(host) || host.endsWith('.example') || host === 'example.com') continue;
        if (!OUTBOUND.has(host)) hosts.add(host);
      }
    }
    // Cloudinary se nombra como texto (`res.cloudinary.com`) en el ayudante de imágenes.
    if (adminSource.some((f) => f.text.includes('res.cloudinary.com'))) hosts.add('res.cloudinary.com');

    const allSources = [...directives.values()].flat();
    const covered = (host: string) =>
      allSources.some((s) => {
        const h = s.replace(/^[a-z]+:\/\//, '');
        return h === host || (h.startsWith('*.') && host.endsWith(h.slice(1)));
      });
    const missing = [...hosts].filter((h) => !covered(h));
    expect(missing).toEqual([]);
    // Y la comprobación no es vacía: al menos estos tres se encontraron de verdad.
    expect([...hosts].sort()).toEqual(expect.arrayContaining(['res.cloudinary.com', 'a.tile.openstreetmap.org']));
  });

  it('el mapa de flota carga Mapbox con el token que da el servidor, no uno escrito en el código', () => {
    const fleet = adminSource.find((f) => f.file.endsWith('FleetMap.tsx'))!;
    expect(fleet.text).toContain('config.accessToken');
    expect(fleet.text).not.toMatch(/pk\.[A-Za-z0-9_-]{20,}/);
  });
});
