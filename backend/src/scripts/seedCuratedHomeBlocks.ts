import mongoose from 'mongoose';
import { config } from '../config';
import { Business, Product, CuratedHomeBlock } from '../models';
import { VISIBLE_BUSINESS } from '../utils/catalogQuery';

/**
 * Puebla los bloques curados del inicio con contenido real del catálogo (no
 * inventado): elige por criterios objetivos —descuento, calificación,
 * recientes— en vez de ids fijos, porque el catálogo cambia entre entornos.
 *
 * Un banner cada 3 colecciones automáticas: las 20 colecciones ocupan el
 * espacio de `order` 10, 20, 30…200 (`homeSections.service.ts`), así que un
 * banner "cada 3" cae en 35, 65, 95, 125, 155, 185 — justo entre la 3ª/4ª,
 * 6ª/7ª colección, etc. Alterna `productBanner`/`businessBanner` para que no
 * se repita siempre el mismo tipo de carrusel.
 *
 * Idempotente por `order`: correrlo de nuevo tras editar algo desde el admin
 * no debería resucitar contenido que un admin borró a propósito, así que
 * solo toca los `order` que este script mismo define.
 */

const BANNER_ORDERS = [35, 65, 95, 125, 155, 185] as const;
const BUSINESS_COLLECTION_ORDER = 15;

async function upsertBlock(params: {
  kind: 'productBanner' | 'businessBanner' | 'businessCollection';
  title: string;
  subtitle?: string;
  items: mongoose.Types.ObjectId[];
  order: number;
}) {
  const { kind, title, subtitle, items, order } = params;
  const existing = await CuratedHomeBlock.findOne({ order });
  if (existing) {
    existing.kind = kind;
    existing.title = title;
    existing.subtitle = subtitle;
    existing.items = items;
    existing.isActive = true;
    await existing.save();
    console.log(`↻ Actualizado "${title}" (order ${order}, ${items.length} items)`);
    return;
  }
  await CuratedHomeBlock.create({ kind, title, subtitle, items, order, isActive: true });
  console.log(`✅ Creado "${title}" (order ${order}, ${items.length} items)`);
}

/** Trío consecutivo de un arreglo, dando la vuelta si hace falta. No sirve
 * con arreglos de menos de 3 — en ese caso el bloque simplemente no se crea. */
function tripletAt<T>(pool: T[], startIndex: number): T[] {
  if (pool.length < 3) return [];
  const out: T[] = [];
  for (let i = 0; i < 3; i++) out.push(pool[(startIndex + i) % pool.length]);
  return out;
}

const PRODUCT_BANNER_TITLES = [
  { title: 'El trío del hambre', subtitle: 'Los descuentos más fuertes de hoy' },
  { title: 'Para darte un gusto', subtitle: 'Selección curada del equipo ZIPP' },
  { title: 'Recién llegados', subtitle: 'Lo nuevo del catálogo' },
];

const BUSINESS_BANNER_TITLES = [
  { title: 'Los favoritos de siempre', subtitle: 'Los negocios mejor calificados de ZIPP' },
  { title: 'Aliados que no te puedes perder', subtitle: 'Recomendados por el equipo' },
  { title: 'Los más queridos', subtitle: 'La gente vuelve por ellos' },
];

const seed = async () => {
  await mongoose.connect(config.mongodb.uri);
  console.log(`🗄️  Conectado a MongoDB (${mongoose.connection.name})`);

  // Limpia los `order` de una versión anterior de este script (25/45/47) que
  // ya no forman parte del patrón "cada 3 colecciones" — si quedaran, se
  // verían como bloques sueltos sin relación con el resto de la secuencia.
  const staleOrders = [25, 45, 47].filter((o) => !BANNER_ORDERS.includes(o as any) && o !== BUSINESS_COLLECTION_ORDER);
  if (staleOrders.length) {
    const { deletedCount } = await CuratedHomeBlock.deleteMany({ order: { $in: staleOrders } });
    if (deletedCount) console.log(`🧹 Bloques antiguos eliminados: ${deletedCount}`);
  }

  // ── Pool de productos: mayor descuento primero, luego destacados/recientes ──
  const productPool = await Product.aggregate([
    { $match: { isAvailable: true, $or: [{ stock: null }, { stock: { $gt: 0 } }] } },
    { $lookup: { from: 'businesses', localField: 'businessId', foreignField: '_id', as: 'business' } },
    { $unwind: '$business' },
    { $match: Object.fromEntries(Object.entries(VISIBLE_BUSINESS).map(([k, v]) => [`business.${k}`, v])) },
    {
      $addFields: {
        discountPercent: {
          $cond: [
            { $and: [{ $gt: ['$discountPrice', 0] }, { $lt: ['$discountPrice', '$price'] }, { $gt: ['$price', 0] }] },
            { $floor: { $multiply: [{ $divide: [{ $subtract: ['$price', '$discountPrice'] }, '$price'] }, 100] } },
            0,
          ],
        },
      },
    },
    { $sort: { discountPercent: -1, isFeatured: -1, createdAt: -1 } },
    { $limit: 30 },
    { $project: { _id: 1 } },
  ]);
  const productIds = productPool.map((p) => p._id as mongoose.Types.ObjectId);

  // ── Pool de negocios: mejor calificados primero ──
  const businessDocs = await Business.find(VISIBLE_BUSINESS)
    .sort({ rating: -1, totalReviews: -1 })
    .select('_id');
  const businessIds = businessDocs.map((b) => b._id as mongoose.Types.ObjectId);

  let productBannerN = 0;
  let businessBannerN = 0;

  for (let i = 0; i < BANNER_ORDERS.length; i++) {
    const order = BANNER_ORDERS[i];
    const isProduct = i % 2 === 0;

    if (isProduct) {
      const items = tripletAt(productIds, productBannerN * 3);
      const copy = PRODUCT_BANNER_TITLES[productBannerN % PRODUCT_BANNER_TITLES.length];
      productBannerN++;
      if (items.length === 3) {
        await upsertBlock({ kind: 'productBanner', items, order, ...copy });
      } else {
        console.log(`⚠️  No hay suficientes productos para el banner de order ${order}. Se omite.`);
      }
    } else {
      const items = tripletAt(businessIds, businessBannerN * 3);
      const copy = BUSINESS_BANNER_TITLES[businessBannerN % BUSINESS_BANNER_TITLES.length];
      businessBannerN++;
      if (items.length === 3) {
        await upsertBlock({ kind: 'businessBanner', items, order, ...copy });
      } else {
        console.log(`⚠️  No hay suficientes negocios para el banner de order ${order}. Se omite.`);
      }
    }
  }

  // ── Colección de negocios: fila horizontal, no carrusel — una sola vez ──
  if (businessIds.length >= 4) {
    await upsertBlock({
      kind: 'businessCollection',
      title: 'Los mejores de la ciudad',
      subtitle: 'Negocios con la calificación más alta',
      items: businessIds.slice(0, 10),
      order: BUSINESS_COLLECTION_ORDER,
    });
  } else {
    console.log(`⚠️  Solo hay ${businessIds.length} negocios visibles — se necesitan al menos 4. Se omite la colección.`);
  }

  await mongoose.disconnect();
};

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Error al sembrar bloques curados del inicio:', err);
    process.exit(1);
  });
