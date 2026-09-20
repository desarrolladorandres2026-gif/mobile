import fs from 'fs';
import path from 'path';
import { TESTE_BUSINESSES, TESTE_CLIENTS, TESTE_PASSWORD, TesteProduct } from './data/businesses';
import { TESTE_IMAGES } from './data/images';
import {
  PHASE6_DATE, PHASE6_SUITES, PHASE6_DEFECTS, PHASE6_CHECKS, PHASE6_PENDING, PHASE6_VERDICT,
} from './data/phase6';

/**
 * `npm run teste:report` — escribe `TESTE.md` desde los datos.
 *
 * El documento se genera, no se escribe a mano: así el catálogo, los
 * precios, los modificadores y las licencias que se leen en el informe son
 * exactamente los que se siembran. Si alguien cambia un precio en
 * `data/businesses.ts`, el informe cambia con él.
 */

const money = (n: number) => `$${n.toLocaleString('es-CO')}`;

const DAYS: Array<[keyof typeof TESTE_BUSINESSES[0]['schedule'], string]> = [
  ['monday', 'Lun'], ['tuesday', 'Mar'], ['wednesday', 'Mié'], ['thursday', 'Jue'],
  ['friday', 'Vie'], ['saturday', 'Sáb'], ['sunday', 'Dom'],
];

function scheduleLine(schedule: typeof TESTE_BUSINESSES[0]['schedule']): string {
  return DAYS.map(([key, label]) => {
    const day = schedule[key];
    return day.isOpen ? `${label} ${day.open}–${day.close}` : `${label} cerrado`;
  }).join(' · ');
}

function groupsOf(product: TesteProduct): string {
  if (!product.groups?.length) return '—';
  return product.groups
    .map((g) => {
      const rule = g.minSelect === 0
        ? `opcional, hasta ${g.maxSelect}`
        : g.minSelect === g.maxSelect
          ? `obligatorio, elige ${g.minSelect}`
          : `obligatorio, ${g.minSelect}–${g.maxSelect}`;
      const agotadas = g.options.filter((o) => o.isAvailable === false).length;
      return `**${g.name}** (${rule}${agotadas ? `, ${agotadas} agotada` : ''}): ` +
        g.options.map((o) => `${o.name}${o.price ? ` +${money(o.price)}` : ''}${o.isAvailable === false ? ' ⛔' : ''}`).join(', ');
    })
    .join('<br>');
}

function flags(product: TesteProduct): string {
  const list: string[] = [];
  if (product.isFeatured) list.push('destacado');
  if (product.isAvailable === false) list.push('no disponible');
  if (product.discountPrice) list.push(`descuento ${money(product.discountPrice)}`);
  if (product.stock !== undefined) list.push(`stock ${product.stock}${product.lowStockThreshold ? ` (aviso ${product.lowStockThreshold})` : ''}`);
  if (product.requiresAgeVerification) list.push('mayor de edad');
  if (product.extras?.length) list.push(`${product.extras.length} extras planos`);
  return list.join(', ') || '—';
}

const totals = {
  products: TESTE_BUSINESSES.reduce((n, b) => n + b.products.length, 0),
  categories: TESTE_BUSINESSES.reduce((n, b) => n + b.categories.length, 0),
  groups: TESTE_BUSINESSES.reduce((n, b) => n + b.products.reduce((m, p) => m + (p.groups?.length ?? 0), 0), 0),
  options: TESTE_BUSINESSES.reduce((n, b) => n + b.products.reduce((m, p) => m + (p.groups ?? []).reduce((k, g) => k + g.options.length, 0), 0), 0),
  soldOutOptions: TESTE_BUSINESSES.reduce((n, b) => n + b.products.reduce((m, p) => m + (p.groups ?? []).reduce((k, g) => k + g.options.filter((o) => o.isAvailable === false).length, 0), 0), 0),
};

const lines: string[] = [];
const w = (s = '') => lines.push(s);

w('# TESTE — entorno de prueba de ZIPP');
w();
w('> Generado por `npm run teste:report` desde `src/scripts/teste/data/`. No editar a mano: lo que aquí se lee es exactamente lo que siembra `npm run teste:seed`.');
w();
w(`**${TESTE_BUSINESSES.length} comercios · ${totals.products} productos · ${totals.categories} categorías · ${totals.groups} grupos de modificadores · ${totals.options} opciones (${totals.soldOutOptions} agotadas a propósito) · ${TESTE_IMAGES.length} fotografías.**`);
w();
w('Los comercios son ficticios pero están construidos como comercios reales. Se distinguen por las cuentas de sus dueños (`@teste.zipp.co`, teléfonos `300999xxxx`), nunca por el nombre: en la app se ven como cualquier otro negocio. `npm run teste:teardown` los borra sin tocar nada más.');
w();

// ── Cuentas ──
w('## Cuentas');
w();
w(`Contraseña de todas: \`${TESTE_PASSWORD}\``);
w();
w('| Rol | Nombre | Teléfono | Correo | Para |');
w('|---|---|---|---|---|');
for (const b of TESTE_BUSINESSES) w(`| Comercio | ${b.owner.name} | ${b.owner.phone} | ${b.owner.email} | Panel de ${b.name} |`);
for (const c of TESTE_CLIENTS) w(`| Cliente | ${c.name} | ${c.phone} | ${c.email} | App móvil (${c.address.label}) |`);
w();
w('Los domiciliarios son los de demostración que ya existen (`npm run seed:demo-drivers`): Pedro `3111234567` y Luis `3121234567`.');
w();

// ── Comercios ──
w('## Los cinco comercios');
w();
w('| Comercio | Categoría | Horario | Prep. | Pedido mín. | Envío gratis desde | Dirección |');
w('|---|---|---|---|---|---|---|');
for (const b of TESTE_BUSINESSES) {
  w(`| **${b.name}** | \`${b.category}\` | ${scheduleLine(b.schedule)} | ${b.deliveryTime} min | ${b.minOrder ? money(b.minOrder) : '—'} | ${b.freeDeliveryThreshold ? money(b.freeDeliveryThreshold) : '—'} | ${b.address} · tel. ${b.phone} |`);
}
w();

for (const b of TESTE_BUSINESSES) {
  w(`### ${b.name}`);
  w();
  w(b.description);
  w();
  w(`Secciones del menú: ${b.categories.map((c) => `**${c}**`).join(' · ')}`);
  w();
  w('| Producto | Sección | Precio | Modificadores | Otros |');
  w('|---|---|---|---|---|');
  for (const p of b.products) {
    w(`| **${p.name}** | ${p.category} | ${money(p.price)} | ${groupsOf(p)} | ${flags(p)} |`);
  }
  w();
}

// ── Imágenes ──
w('## Fotografías, fuentes y licencias');
w();
w('Las 60 son de **Unsplash**, bajo la [Unsplash License](https://unsplash.com/license): uso comercial y no comercial, sin atribución obligatoria (se registra igual el autor). Se excluyeron las de Unsplash+ (de pago) y las patrocinadas, se exigió lado corto ≥ 1200 px y cada una se revisó a ojo: que corresponda al producto, sin marcas, sin marcas de agua y sin personas reconocibles. Ninguna foto se repite.');
w();
w('| Clave | Uso | Autor | Foto | Tamaño |');
w('|---|---|---|---|---|');
for (const image of TESTE_IMAGES) {
  const [businessKey, rest] = image.key.split('.');
  const business = TESTE_BUSINESSES.find((b) => b.key === businessKey);
  const use = rest === 'logo' ? 'Logo' : rest === 'cover' ? 'Portada' : business?.products.find((p) => p.imageKey === rest)?.name ?? rest;
  w(`| \`${image.key}\` | ${business?.name ?? ''} — ${use} | [${image.author}](${image.authorUrl}) | [${image.photoId}](${image.pageUrl}) | ${image.width}×${image.height} |`);
}
w();

// ── Cómo se usa ──
w('## Cómo se usa');
w();
w('```bash');
w('cd backend');
w('npm run teste:api-smoke -- --label=antes      # con el backend corriendo');
w('npm run teste:seed     -- --db=<nombre>       # idempotente, no borra nada');
w('npm run teste:api-smoke -- --label=despues    # compara con la de antes');
w('npm run teste:validate -- --db=<nombre>       # solo lectura; PASS/FAIL');
w('npm run teste:teardown -- --db=<nombre>       # simulación; añade --apply para borrar');
w('```');
w();
w('Todos se niegan a correr con `NODE_ENV=production` y exigen `--db=<nombre>` igual al de la conexión. `teste:seed` deja `teste.manifest.json` con los ids sembrados.');
w();

// ── Estrategia y matriz ──
w('## Estrategia de pruebas');
w();
w('Tres capas, de más barata a más cara:');
w();
w('1. **Automática en memoria** (`npm test`): `testeCatalog.test.ts` siembra el TESTE completo en una Mongo efímera y recorre por HTTP las filas marcadas ✅ abajo. Es lo que corre en cada cambio.');
w('2. **Validación contra la base sembrada** (`teste:validate`): relaciones, precios, límites de los grupos, fotos vivas y coherencia de los pedidos ya creados. Solo lectura.');
w('3. **Manual en los tres frontends**: las filas ✋, que necesitan ojo humano (que la hoja se vea bien, que el ticket de cocina se lea, que el horario se pinte).');
w();
w('Lo que se cubre en cada una está en la columna *Dónde*.');
w();
w('## Matriz de escenarios');
w();
w('| ID | Escenario | Datos del TESTE | Esperado | Dónde |');
w('|---|---|---|---|---|');
const matrix: Array<[string, string, string, string, string]> = [
  ['M-01', 'Combinación máxima', '2× Clásica de la Casa: Angus, cheddar, tocineta doble, chipotle, papas rústicas, limonada', '(22.900+7.000+2.500+6.000+1.000+6.500+5.500)×2 = **$102.800**', '✅ auto'],
  ['M-02', 'Grupo obligatorio omitido', 'Clásica de la Casa sin "Tipo de carne"', '400 `MODIFIER_REQUIRED`; en la app, la hoja baja al grupo y lo resalta', '✅ auto + ✋'],
  ['M-03', 'Mínimo = máximo = 2', 'Mojarra Frita con un solo acompañante', '400 `MODIFIER_REQUIRED`', '✅ auto'],
  ['M-04', 'Exceso sobre el máximo', 'Nuggets con 3 salsas (máx. 2)', '400 `MODIFIER_TOO_MANY`', '✅ auto'],
  ['M-05', 'Opción agotada', 'Bandeja Paisa + "Chicharrón extra"', '400 `MODIFIER_UNAVAILABLE`; en la app sale inactiva con "Agotado"', '✅ auto + ✋'],
  ['M-06', 'Precio manipulado', 'Capuchino con `price: -99999` en una opción', 'Se ignora; cobra el precio de la base de datos', '✅ auto'],
  ['M-07', 'Seis grupos a la vez', 'Pizza Mitad y Mitad: familiar, delgada, 2 sabores, borde de queso', '$59.900', '✅ auto'],
  ['M-08', 'Todo opcional a cero', 'Perro Americano solo con salsas ($0)', 'Cobra $12.900 exactos', '✋'],
  ['C-01', 'Mismo producto, distinta selección', '2 capuchinos, uno con leche de almendras', 'Dos líneas separadas en el carrito', '✅ auto (store)'],
  ['C-02', 'Sugerencia con obligatorios', '"Para acompañar" ofrece el Capuchino', 'Abre su hoja en vez de agregarlo a ciegas', '✋'],
  ['C-03', 'Carrito de dos negocios', 'Agregar de Callejón 21 y luego de Carbón & Pan', 'El carrito se reemplaza, avisando', '✋'],
  ['S-01', 'Última unidad', 'Croissant de Almendras con stock 1, dos clientes a la vez', 'Uno 201, otro 409 `OUT_OF_STOCK`; stock 0', '✅ auto'],
  ['S-02', 'Producto agotado', 'Torta de Zanahoria (stock 0)', 'No aparece en la carta; por API, 400', '✅ auto'],
  ['S-03', 'Aviso de poco inventario', 'Croissant (stock 6, aviso en 3)', 'El panel avisa al bajar de 3', '✋'],
  ['H-01', 'Día cerrado', 'Sazón de la Tulia un lunes', 'La app dice "Cerrado hoy" y no deja agregar. **La API sí acepta** (limitación L-3)', '✋'],
  ['H-02', 'Cierre pasada la medianoche', 'Callejón 21 a las 00:30 (abre 16:00–01:00)', 'Debería estar abierto; **la app lo muestra cerrado** (limitación L-4)', '✋'],
  ['H-03', 'Horario reducido', 'Trigo & Tinto un domingo a las 15:00 (cierra 14:00)', 'Cerrado, con "Abre a las 7:00 a. m."', '✋'],
  ['B-01', 'Interruptor de cerrado', 'Desactivar Trigo & Tinto desde el panel', 'Desaparece del listado; la API responde 404', '✅ auto'],
  ['O-01', 'Ciclo completo', 'Pedido → aceptar → preparar → listo → asignar → recoger → entregar', 'Estado `delivered` y línea de tiempo con sus hitos', '✅ auto'],
  ['O-02', 'Cancelación del cliente', 'Pedido pendiente de Huevos AA x30 (2 unidades)', 'Cancelado y stock devuelto (10 → 12)', '✅ auto'],
  ['O-03', 'Rechazo del comercio', 'Motivo `business_out_of_stock`', 'Queda registrado el código, no solo el texto', '✅ auto'],
  ['O-04', 'Doble envío', 'Misma `idempotencyKey` dos veces', 'Un solo pedido y un solo aviso a la cocina', '✅ auto'],
  ['O-05', 'Reintento por timeout', 'Cuatro peticiones simultáneas con la misma clave', 'Un pedido; el stock baja una sola vez', '✅ auto'],
  ['A-01', 'Mayor de edad', 'Cerveza Nacional six pack', 'El pedido nace con `requiresAgeVerification` (el cliente necesita fecha de nacimiento de adulto; los dos de TESTE la traen)', '✅ auto'],
  ['P-01', 'Pedido mínimo', 'Punto Fresco con $5.000 en agua', 'Rechazado por no llegar a $15.000', '✅ auto'],
  ['P-02', 'Envío gratis', 'Callejón 21 con más de $45.000', 'El envío queda en cero', '✋'],
  ['R-01', '"Lo de siempre"', 'Repetir el capuchino con leche de almendras', 'Mismo carrito, mismos `optionId`, mismo total', '✅ auto'],
  ['R-02', 'Producto sin modificadores', 'Gaseosa 1,5 L', 'La hoja no muestra ninguna sección de grupos', '✋'],
  ['SEC-01', 'Opción de otro producto', '`optionId` de la Bandeja en la Clásica', '400 `MODIFIER_UNKNOWN`', '✅ auto'],
  ['SEC-06', 'Editar la carta ajena', 'El dueño de Carbón & Pan edita un producto de Punto Fresco', '403, sin cambios', '✅ auto'],
];
for (const row of matrix) w(`| ${row[0]} | ${row[1]} | ${row[2]} | ${row[3]} | ${row[4]} |`);
w();

// ── Fase 6 ──
w('## FASE 6 — REGRESIÓN Y SEGURIDAD');
w();
w(`Cierre del ${PHASE6_DATE}. Demuestra que los grupos de modificadores y el TESTE no rompen lo que ya existía, y deja por escrito lo que se encontró de camino.`);
w();
w('### Pruebas ejecutadas');
w();
w('| Suite | Comando | Antes | Después |');
w('|---|---|---|---|');
for (const s of PHASE6_SUITES) w(`| ${s.suite} | \`${s.command}\` | ${s.before} | ${s.after} |`);
w();
w('### Errores encontrados y corregidos');
w();
w('Los cinco se encontraron **leyendo el código**, se reprodujeron con una prueba que falla, y esa misma prueba pasa con la corrección.');
w();
for (const d of PHASE6_DEFECTS) {
  w(`#### ${d.id} · ${d.title} _(${d.severity})_`);
  w();
  w(`- **Dónde:** ${d.where}`);
  w(`- **Qué pasaba:** ${d.evidence}`);
  w(`- **Corrección:** ${d.fix} — *${d.status}*`);
  w();
}
w('### Comprobaciones');
w();
w('| ID | Qué se comprueba | Resultado |');
w('|---|---|---|');
for (const c of PHASE6_CHECKS) w(`| ${c.id} | ${c.what} | ${c.result} |`);
w();
w('### Limitaciones pendientes');
w();
for (const p of PHASE6_PENDING) w(`- ${p}`);
w();
w(`### Veredicto: **${PHASE6_VERDICT.status}**`);
w();
w(PHASE6_VERDICT.reason);
w();

const out = path.join(__dirname, 'TESTE.md');
fs.writeFileSync(out, lines.join('\n'));
console.log(`📄 ${out} (${lines.length} líneas)`);
