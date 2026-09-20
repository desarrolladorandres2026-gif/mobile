import mongoose from 'mongoose';
import { connectDB } from '../config';
import { Business, Product } from '../models';
import { normalize } from '../utils/text';
import {
  deriveTags,
  PRODUCT_TAGS,
  PRODUCT_TAG_LABELS,
  type ProductTag,
} from '../constants/productTags';

/**
 * Rellena `tags` en el catálogo que ya existía.
 *
 * Las colecciones de descubrimiento consultan `tags`, pero el campo nació
 * vacío: sin esta pasada, un catálogo entero de productos anteriores queda
 * fuera de todas las colecciones por etiqueta, y la pantalla se ve rota sin
 * que nadie haya roto nada.
 *
 * Deduce cada etiqueta del nombre y la descripción, con el diccionario de
 * `constants/productTags`. La máquina propone; el comercio corrige después
 * desde su panel.
 *
 *   npm run backfill:product-tags -- --dry-run   informe, sin escribir nada
 *   npm run backfill:product-tags                rellena solo lo que está vacío
 *   npm run backfill:product-tags -- --force     reescribe también lo ya etiquetado
 *
 * Por defecto **no toca** un producto que ya tiene etiquetas: quien las puso
 * a mano sabía más que este script, y una segunda pasada no puede deshacer
 * ese trabajo. `--force` existe para cuando el diccionario cambia de verdad,
 * y es una decisión consciente.
 */

const BATCH = 500;

interface Options {
  dryRun: boolean;
  force: boolean;
}

function readOptions(argv: string[]): Options {
  return {
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
  };
}

/**
 * La categoría de cada negocio, en memoria.
 *
 * Son decenas de filas, no miles: cargarlas de una vez evita un `$lookup`
 * por producto solo para leer un enum de cinco valores. Es la red de
 * seguridad de `deriveTags` cuando el nombre no dice nada ("Caja x12").
 */
async function businessCategories(): Promise<Map<string, string>> {
  const rows = await Business.find({}, { category: 1 }).lean();
  return new Map(rows.map((b) => [String(b._id), String(b.category)]));
}

async function run(): Promise<void> {
  const options = readOptions(process.argv.slice(2));
  await connectDB();

  const mode = options.dryRun ? 'ensayo (no escribe)' : options.force ? 'forzado' : 'normal';
  console.log(`🏷️  Rellenando etiquetas de producto — modo ${mode}`);

  const categories = await businessCategories();

  const filter = options.force ? {} : { $or: [{ tags: { $size: 0 } }, { tags: { $exists: false } }] };

  const cursor = Product.find(filter, {
    name: 1,
    description: 1,
    businessId: 1,
    tags: 1,
  })
    .lean()
    .cursor();

  let pending: mongoose.AnyBulkWriteOperation[] = [];
  let scanned = 0;
  let written = 0;
  let empty = 0;
  const coverage = new Map<ProductTag, number>();

  const flush = async () => {
    if (!pending.length || options.dryRun) {
      pending = [];
      return;
    }
    await Product.bulkWrite(pending);
    pending = [];
  };

  for await (const doc of cursor) {
    scanned++;

    // Nombre y descripción juntos: "Combo 2" no dice nada, pero su
    // descripción ("hamburguesa doble con papas") lo dice todo. El nombre va
    // primero porque `deriveTags` recorta por especificidad, no por posición,
    // pero mantener el orden ayuda a leer los casos raros en el informe.
    const haystack = normalize(`${doc.name ?? ''} ${doc.description ?? ''}`);
    const category = categories.get(String(doc.businessId));
    const tags = deriveTags(haystack, category);

    if (tags.length === 0) {
      empty++;
      continue;
    }

    for (const tag of tags) coverage.set(tag, (coverage.get(tag) ?? 0) + 1);

    const current = (doc.tags ?? []) as string[];
    const unchanged =
      current.length === tags.length && tags.every((t, i) => current[i] === t);
    if (unchanged) continue;

    written++;
    pending.push({
      updateOne: { filter: { _id: doc._id }, update: { $set: { tags } } },
    });

    if (pending.length >= BATCH) await flush();
  }

  await flush();

  console.log('');
  console.log(`   Revisados ....... ${scanned}`);
  console.log(`   ${options.dryRun ? 'Se escribirían' : 'Actualizados'} ... ${written}`);
  console.log(`   Sin etiqueta .... ${empty}`);

  const covered = scanned - empty;
  const pct = scanned ? Math.round((covered / scanned) * 100) : 0;
  console.log(`   Cobertura ....... ${pct}%`);

  console.log('');
  console.log('   Reparto por etiqueta:');
  const used = PRODUCT_TAGS.filter((t) => coverage.has(t));
  for (const tag of used.sort((a, b) => (coverage.get(b) ?? 0) - (coverage.get(a) ?? 0))) {
    console.log(`     ${String(coverage.get(tag)).padStart(5)}  ${PRODUCT_TAG_LABELS[tag]}`);
  }

  // Las etiquetas que nadie usa son la señal más útil del informe: o el
  // diccionario les falta una palabra, o el catálogo de verdad no vende eso.
  // Lo primero se arregla aquí; lo segundo significa que la colección que
  // dependa de esa etiqueta va a salir vacía y no debería publicarse.
  const unused = PRODUCT_TAGS.filter((t) => !coverage.has(t));
  if (unused.length) {
    console.log('');
    console.log(`   Sin un solo producto (${unused.length}):`);
    console.log(`     ${unused.map((t) => PRODUCT_TAG_LABELS[t]).join(', ')}`);
  }

  await mongoose.disconnect();
  console.log('');
  console.log(options.dryRun ? '✅ Ensayo terminado, nada se escribió.' : '✅ Listo.');
}

run().catch(async (error) => {
  console.error('❌ El relleno falló:', error);
  await mongoose.disconnect();
  process.exit(1);
});
