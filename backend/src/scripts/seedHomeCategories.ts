import mongoose from 'mongoose';
import { config } from '../config';
import { HomeCategory } from '../models';

/**
 * Categorías de negocio del Home, en el mismo orden y con las mismas
 * claves/labels que `BUSINESS_CATEGORIES` en `mobile/constants/config.ts`.
 *
 * Si esa lista cambia en mobile, actualiza esta también — no hay una fuente
 * única compartida porque mobile no depende del backend para arrancar.
 */
const HOME_CATEGORIES = [
  { key: 'restaurant', name: 'Restaurantes' },
  { key: 'fast_food', name: 'Comidas rápidas' },
  { key: 'pharmacy', name: 'Droguerías' },
  { key: 'cafe', name: 'Cafeterías' },
  { key: 'supermarket', name: 'Mercados' },
] as const;

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
