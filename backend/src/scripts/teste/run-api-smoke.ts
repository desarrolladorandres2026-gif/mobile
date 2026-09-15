import fs from 'fs';
import path from 'path';
import { parseArgs } from './common';

/**
 * `npm run teste:api-smoke -- --base=http://localhost:3000/api/v1 [--label=antes|despues]`
 *
 * Fotografía las rutas públicas de lectura del backend **en marcha** y, si
 * ya existe una foto anterior, la compara. Solo GET y `/orders/quote` (que
 * no escribe), y menos de 40 peticiones para no chocar con el rate limit
 * de 100 cada 15 minutos.
 *
 * Se corre antes de `teste:seed` y otra vez después. La regla: todo lo que
 * no es TESTE tiene que salir idéntico (mismo estado, misma forma), y los
 * listados solo pueden haber crecido con negocios TESTE.
 */

type Shape = string | Shape[] | { [k: string]: Shape };

function shapeOf(value: unknown): Shape {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0])] : [];
  if (typeof value === 'object') {
    const out: Record<string, Shape> = {};
    for (const key of Object.keys(value as object).sort()) out[key] = shapeOf((value as Record<string, unknown>)[key]);
    return out;
  }
  return typeof value;
}

interface Snap { status: number; shape: Shape; names?: string[] }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = typeof args.base === 'string' ? args.base : 'http://localhost:3000/api/v1';
  const label = typeof args.label === 'string' ? args.label : 'antes';
  const dir = path.join(__dirname, 'smoke');
  fs.mkdirSync(dir, { recursive: true });

  const snaps: Record<string, Snap> = {};
  const take = async (name: string, url: string, names?: (body: any) => string[]) => {
    // `/health` cuelga de la raíz, no de `/api/v1`.
    const res = await fetch(url === '/health' ? base.replace(/\/api\/v\d+$/, '') + url : base + url);
    const body = await res.json().catch(() => ({}));
    snaps[name] = { status: res.status, shape: shapeOf(body), ...(names && res.ok ? { names: names(body) } : {}) };
    console.log(`${String(res.status).padEnd(4)} ${name}`);
  };

  await take('health', '/health');
  await take('businesses.list', '/businesses?limit=50', (b) => (b.data ?? []).map((x: any) => x.name).sort());
  await take('businesses.byCategory', '/businesses?category=fast_food&limit=50', (b) => (b.data ?? []).map((x: any) => x.name).sort());
  await take('businesses.search', '/businesses?search=burger', (b) => (b.data ?? []).map((x: any) => x.name).sort());
  await take('businesses.missing', '/businesses/000000000000000000000000');
  await take('products.missing', '/products/000000000000000000000000');
  await take('products.badId', '/products/no-es-un-id');
  await take('orders.unauthenticated', '/orders/my');

  // El primer negocio que no sea TESTE, para comparar su ficha y su carta.
  const list: any = await (await fetch(`${base}/businesses?limit=50`)).json().catch(() => ({ data: [] }));
  const nonTeste = (list.data ?? []).find((b: any) => !/Callejón 21|Sazón de la Tulia|Carbón & Pan|Trigo & Tinto|Punto Fresco/.test(b.name));
  if (nonTeste) {
    await take('business.byId.nonTeste', `/businesses/${nonTeste._id}`);
    await take('products.byBusiness.nonTeste', `/products/business/${nonTeste._id}`, (b) => (b.data ?? []).map((x: any) => x.name).sort());
  }

  const file = path.join(dir, `smoke.${label}.json`);
  fs.writeFileSync(file, JSON.stringify(snaps, null, 2) + '\n');
  console.log(`\n📄 ${file}`);

  const beforeFile = path.join(dir, 'smoke.antes.json');
  if (label !== 'antes' && fs.existsSync(beforeFile)) {
    const before: Record<string, Snap> = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
    const problems: string[] = [];
    for (const [name, prev] of Object.entries(before)) {
      const now = snaps[name];
      if (!now) { problems.push(`${name}: ya no se capturó`); continue; }
      if (now.status !== prev.status) problems.push(`${name}: estado ${prev.status} → ${now.status}`);
      if (JSON.stringify(now.shape) !== JSON.stringify(prev.shape) && !name.startsWith('businesses.')) problems.push(`${name}: cambió la forma`);
      if (prev.names && now.names) {
        const lost = prev.names.filter((n) => !now.names!.includes(n));
        if (lost.length) problems.push(`${name}: desaparecieron ${lost.join(', ')}`);
        const added = now.names.filter((n) => !prev.names!.includes(n));
        const foreign = added.filter((n) => !/Callejón 21|Sazón de la Tulia|Carbón & Pan|Trigo & Tinto|Punto Fresco/.test(n));
        if (foreign.length && name.startsWith('businesses.')) problems.push(`${name}: aparecieron negocios que no son TESTE: ${foreign.join(', ')}`);
      }
    }
    console.log(problems.length ? `\n❌ ${problems.length} diferencias:\n${problems.map((p) => '   ' + p).join('\n')}` : '\n✅ Sin diferencias fuera del TESTE.');
    process.exit(problems.length ? 1 : 0);
  }
}

main().catch((err) => { console.error('❌', err.message); process.exit(1); });
