import mongoose from 'mongoose';
import { connectDB } from '../config';
import { Product } from '../models';
import { initCache, closeCache, invalidateBusiness } from '../cache';
import { fetchInlinePlaceholder } from '../services/productImage.service';

/**
 * Incrusta la miniatura borrosa en las fotos de producto que ya existían.
 *
 * Desde el 2026-09-21 cada foto nueva guarda su miniatura como `data:` URI
 * al subirse (`imageAsset.placeholderDataUri`), y la respuesta la manda
 * dentro del JSON en vez de como una URL más que pedir. Las fotos
 * anteriores siguen sirviendo la URL, que funciona igual pero cuesta un
 * viaje a la red por producto: esta pasada las pone al día.
 *
 *   npm run backfill:image-placeholders -- --dry-run   cuenta, sin descargar ni escribir
 *   npm run backfill:image-placeholders                rellena solo lo que falta
 *   npm run backfill:image-placeholders -- --force     recalcula también lo ya relleno
 *
 * Cada escritura exige que la foto siga siendo la misma (`publicId` **y**
 * `checksum`): si el comercio cambió la foto mientras corría el script, la
 * miniatura calculada ya no le corresponde y no se guarda.
 *
 * `bulkWrite` no pasa por el plugin de invalidación, así que al final se
 * vacía a mano la caché del catálogo. Eso llega al servidor cuando la caché
 * es Redis (producción); con la de memoria (desarrollo) cada proceso tiene
 * la suya, y el servidor verá el cambio cuando caduquen sus entradas.
 */

/** Descargas a la vez: amable con Cloudinary y rápido de sobra. */
const CONCURRENCY = 8;

interface Options {
  dryRun: boolean;
  force: boolean;
}

interface Pending {
  productId: mongoose.Types.ObjectId;
  publicId: string;
  checksum: string;
  /** `true` si es de la galería y no la principal. */
  gallery: boolean;
}

function readOptions(argv: string[]): Options {
  return {
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
  };
}

function needsPlaceholder(image: { placeholderDataUri?: string | null } | null | undefined, force: boolean) {
  return Boolean(image) && (force || !image?.placeholderDataUri);
}

function writeFor(item: Pending, uri: string): mongoose.AnyBulkWriteOperation {
  if (!item.gallery) {
    return {
      updateOne: {
        filter: {
          _id: item.productId,
          'imageAsset.publicId': item.publicId,
          'imageAsset.checksum': item.checksum,
        },
        update: { $set: { 'imageAsset.placeholderDataUri': uri } },
      },
    };
  }
  return {
    updateOne: {
      filter: { _id: item.productId },
      update: { $set: { 'gallery.$[photo].placeholderDataUri': uri } },
      arrayFilters: [{ 'photo.publicId': item.publicId, 'photo.checksum': item.checksum }],
    },
  };
}

async function run(): Promise<void> {
  const options = readOptions(process.argv.slice(2));
  await connectDB();

  const mode = options.dryRun ? 'ensayo (no escribe)' : options.force ? 'forzado' : 'normal';
  console.log(`🖼️  Incrustando miniaturas borrosas — modo ${mode}`);

  const cursor = Product.find(
    { $or: [{ imageAsset: { $ne: null } }, { 'gallery.0': { $exists: true } }] },
    { imageAsset: 1, gallery: 1 }
  )
    .lean()
    .cursor();

  const queue: Pending[] = [];
  for await (const doc of cursor) {
    if (doc.imageAsset?.publicId && needsPlaceholder(doc.imageAsset, options.force)) {
      queue.push({
        productId: doc._id,
        publicId: doc.imageAsset.publicId,
        checksum: doc.imageAsset.checksum,
        gallery: false,
      });
    }
    for (const photo of doc.gallery ?? []) {
      if (photo.publicId && needsPlaceholder(photo, options.force)) {
        queue.push({ productId: doc._id, publicId: photo.publicId, checksum: photo.checksum, gallery: true });
      }
    }
  }

  console.log(`   Fotos por rellenar ... ${queue.length}`);

  let written = 0;
  let failed = 0;

  if (!options.dryRun) {
    for (let i = 0; i < queue.length; i += CONCURRENCY) {
      const batch = queue.slice(i, i + CONCURRENCY);
      const uris = await Promise.all(batch.map((item) => fetchInlinePlaceholder(item.publicId)));

      const ops: mongoose.AnyBulkWriteOperation[] = [];
      batch.forEach((item, index) => {
        const uri = uris[index];
        if (uri) ops.push(writeFor(item, uri));
        else failed++;
      });

      if (ops.length) {
        const result = await Product.bulkWrite(ops);
        written += result.modifiedCount;
      }
    }

    if (written) {
      initCache();
      await invalidateBusiness();
      await closeCache();
    }
  }

  console.log(`   ${options.dryRun ? 'Se descargarían' : 'Actualizadas'} ..... ${options.dryRun ? queue.length : written}`);
  if (!options.dryRun) {
    // Una que falla sigue sirviendo la URL: no es un error, es lo de antes.
    console.log(`   Sin respuesta útil ... ${failed}  (siguen con la URL)`);
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
