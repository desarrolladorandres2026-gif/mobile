import mongoose from 'mongoose';
import { config } from '../config';
import { HomeCategory } from '../models';
import { BusinessCategory, BUSINESS_CATEGORY_LABELS } from '../types/enums';

/**
 * Categorías de negocio del Home, en el mismo orden que
 * `BUSINESS_CATEGORIES` en `mobile/constants/config.ts`.
 *
 * Las etiquetas ya no se escriben aquí: salen de `BUSINESS_CATEGORY_LABELS`,
 * que es la misma lista que usa el servidor cuando tiene que nombrar una
 * categoría en una respuesta. Antes había dos copias y nada que avisara al
 * renombrar solo una.
 */
const HOME_CATEGORIES = [
  BusinessCategory.RESTAURANT,
  BusinessCategory.FAST_FOOD,
  BusinessCategory.PHARMACY,
  BusinessCategory.CAFE,
  BusinessCategory.SUPERMARKET,
].map((key) => ({ key: key as string, name: BUSINESS_CATEGORY_LABELS[key] }));

/**
 * Idempotente: upsert por `key`. Correrlo de nuevo tras editar nombres o
 * imágenes desde el panel no pisa esos cambios — solo crea lo que falte y
 * no toca `imageUrl`/`status`/`order` de lo que ya existe.
 */
const seedHomeCategories = async () => {
  await mongoose.connect(config.mongodb.uri);
  console.log(`🗄️  Conectado a MongoDB (${mongoose.connection.name})`);

  let created = 0;
  let skipped = 0;

  for (let i = 0; i < HOME_CATEGORIES.length; i++) {
    const { key, name } = HOME_CATEGORIES[i];
    const existing = await HomeCategory.findOne({ key });
    if (existing) {
      skipped++;
      continue;
    }
    await HomeCategory.create({ key, name, imageUrl: '', status: 'active', order: i });
    created++;
  }

  console.log(`✅ Categorías de inicio: ${created} creadas, ${skipped} ya existían`);
  await mongoose.disconnect();
};

seedHomeCategories()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Error al sembrar categorías de inicio:', err);
    process.exit(1);
  });
