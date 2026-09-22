import mongoose from 'mongoose';
import { config } from '../config';
import { ImageProcessingEvent, Product } from '../models';

/**
 * Migración 008 — recorte de fondo de fotos de producto.
 *
 * **No rellena datos.** Los campos nuevos de `imageAsset` (`cutout`,
 * `backgroundRemoval`, `useOriginal`) son opcionales, y todo lo que los
 * lee trata su ausencia como "sin recorte": los productos de antes se ven
 * exactamente igual sin tocarlos.
 *
 * Hace dos cosas:
 *
 * 1. **Índices.** La TTL y el índice por comercio de
 *    `ImageProcessingEvent`, y el índice parcial que usa el barrido
 *    (`background_removal_due`). Con `createIndexes()`, que solo añade lo
 *    que falta — nunca `syncIndexes()` (ver la nota de la migración 003).
 *
 * 2. **Repara el daño del fallo de la galería.** Hasta esta versión, cada
 *    foto de galería se subía con el mismo `public_id` que la portada:
 *    Cloudinary la sobrescribía y la entrada de galería quedaba apuntando
 *    al mismo archivo que la portada. Aquí se quitan esas entradas **sin
 *    borrar ningún archivo** —el archivo es la portada—, y se listan los
 *    productos afectados: su portada puede estar mostrando en realidad la
 *    última foto de galería que se subió, y eso solo lo puede confirmar el
 *    comercio mirándola.
 *
 * Por defecto solo informa. `--apply` escribe. Segura de repetir.
 */
export async function migrateProductImageCutout(options: { apply: boolean }): Promise<{
  indexesCreated: string[];
  affected: Array<{ productId: string; businessId: string; name: string; entries: number }>;
}> {
  const indexesBefore = new Set([
    ...(await Product.collection.indexes()).map((i) => `products.${i.name}`),
    ...(await ImageProcessingEvent.collection.indexes().catch(() => [])).map(
      (i) => `imageprocessingevents.${i.name}`
    ),
  ]);

  if (options.apply) {
    await Product.createIndexes();
    await ImageProcessingEvent.createIndexes();
  }

  const indexesAfter = options.apply
    ? [
        ...(await Product.collection.indexes()).map((i) => `products.${i.name}`),
        ...(await ImageProcessingEvent.collection.indexes()).map(
          (i) => `imageprocessingevents.${i.name}`
        ),
      ]
    : [];

  // Directo a la colección: no hace falta hidratar documentos para esto, y
  // así no pasa por los virtuales ni por los valores por defecto.
  const damaged = await Product.collection
    .find(
      {
        'imageAsset.publicId': { $type: 'string' },
        $expr: {
          $in: ['$imageAsset.publicId', { $ifNull: ['$gallery.publicId', []] }],
        },
      },
      { projection: { _id: 1, businessId: 1, name: 1, 'imageAsset.publicId': 1, gallery: 1 } }
    )
    .toArray();

  const affected = damaged.map((doc) => ({
    productId: String(doc._id),
    businessId: String(doc.businessId),
    name: String(doc.name ?? ''),
    entries: (doc.gallery as Array<{ publicId: string }>).filter(
      (image) => image.publicId === doc.imageAsset.publicId
    ).length,
  }));

  if (options.apply) {
    // Por Mongoose y no por el driver: así la escritura invalida la caché
    // de lecturas de cada carta que toca.
    for (const doc of damaged) {
      await Product.updateOne(
        // La misma condición otra vez: si el comercio cambió la portada
        // entre la lectura y esta escritura, no se toca nada.
        { _id: doc._id, 'imageAsset.publicId': doc.imageAsset.publicId },
        { $pull: { gallery: { publicId: doc.imageAsset.publicId } } }
      );
    }
  }

  return {
    indexesCreated: indexesAfter.filter((name) => !indexesBefore.has(name)),
    affected,
  };
}

// ── Ejecutable desde la línea de comandos ──
if (require.main === module) {
  (async () => {
    const apply = process.argv.includes('--apply');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 008 — recorte de fondo de fotos de producto ${apply ? '' : '(solo informe; usa --apply para escribir)'}\n`);

    try {
      const { indexesCreated, affected } = await migrateProductImageCutout({ apply });
      if (apply) {
        console.log(indexesCreated.length ? `  Índices creados: ${indexesCreated.join(', ')}` : '  Índices: ya existían todos.');
      }
      if (!affected.length) {
        console.log('  Galerías: ningún producto afectado por el fallo de la portada.');
      } else {
        console.log(`  Galerías: ${affected.length} producto(s) con entradas que apuntan a la portada${apply ? ' — reparadas' : ''}.`);
        console.log('  Avisa a cada comercio: su portada puede ser la última foto de galería que subió.\n');
        for (const row of affected) {
          console.log(`   • ${row.name} (producto ${row.productId}, comercio ${row.businessId}): ${row.entries} entrada(s)`);
        }
      }
      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    }
  })();
}
