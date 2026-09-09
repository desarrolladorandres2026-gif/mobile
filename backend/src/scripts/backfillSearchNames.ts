import mongoose, { Model } from 'mongoose';
import { connectDB } from '../config';
import { Business, Product } from '../models';
import { normalize } from '../utils/text';

/**
 * Rellena `searchName` en el catálogo que ya existía.
 *
 * Los hooks del esquema solo actúan cuando algo se guarda, así que sin esta
 * pasada todo lo sembrado antes se queda con el campo vacío y la búsqueda
 * por prefijo no encuentra nada hasta que alguien vuelva a editar cada
 * producto uno por uno.
 *
 * Se puede ejecutar tantas veces como haga falta: solo escribe donde el
 * valor calculado no coincide con el guardado, así que una segunda pasada
 * no toca un solo documento.
 *
 *   npm run backfill:search-names
 */

const BATCH = 500;

async function backfill(
  model: Model<any>,
  label: string
): Promise<void> {
  // `lean` y solo los dos campos que importan: esto recorre el catálogo
  // entero y no hay razón para instanciar un documento completo de Mongoose
  // por cada fila para leerle el nombre.
  const cursor = model
    .find({}, { name: 1, searchName: 1 })
    .lean()
    .cursor();

  let pending: mongoose.AnyBulkWriteOperation[] = [];
  let written = 0;
  let scanned = 0;

  const flush = async () => {
    if (!pending.length) return;
    await model.bulkWrite(pending);
    written += pending.length;
    pending = [];
  };

  for await (const doc of cursor) {
    scanned++;
    const expected = normalize(doc.name ?? '');
    if (doc.searchName === expected) continue;

    pending.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { searchName: expected } },
      },
    });

    if (pending.length >= BATCH) await flush();
  }

  await flush();
  console.log(`   ${label}: ${written} actualizados de ${scanned} revisados`);
}

const run = async () => {
  await connectDB();
  console.log('🔤 Rellenando nombres de búsqueda…');

  await backfill(Business, 'Negocios');
  await backfill(Product, 'Productos');

  await mongoose.disconnect();
  console.log('✅ Listo.');
};

run().catch(async (error) => {
  console.error('❌ El relleno falló:', error);
  await mongoose.disconnect();
  process.exit(1);
});
