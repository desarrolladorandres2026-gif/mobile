import mongoose from 'mongoose';
import { config } from '../config';
import { HomeCategory } from '../models';

/**
 * Imágenes de portada para las categorías del home (carrusel LED y ahora
 * también portada de los carruseles de productos por categoría).
 *
 * Las cinco vienen de Unsplash, bajo la Unsplash License, verificadas con un
 * HEAD 200 el día que se buscaron — mismo criterio que las 60 fotos del
 * TESTE (`src/scripts/teste/data/images.ts`).
 */
const IMAGES: Record<string, string> = {
  restaurant: 'https://images.unsplash.com/photo-1695753568605-d8653d5319e6',
  fast_food: 'https://images.unsplash.com/photo-1561758033-d89a9ad46330',
  pharmacy: 'https://images.unsplash.com/photo-1696861286643-341a8d7a79e9',
  cafe: 'https://images.unsplash.com/photo-1553962311-62f2471b159d',
  supermarket: 'https://images.unsplash.com/photo-1604719312566-8912e9227c6a',
};

const setHomeCategoryImages = async () => {
  await mongoose.connect(config.mongodb.uri);
  console.log(`🗄️  Conectado a MongoDB (${mongoose.connection.name})`);

  let updated = 0;
  for (const [key, imageUrl] of Object.entries(IMAGES)) {
    const res = await HomeCategory.updateOne({ key }, { $set: { imageUrl } });
    if (res.matchedCount) updated++;
    else console.log(`⚠️  No existe HomeCategory con key="${key}" — corre antes el seed de categorías`);
  }

  console.log(`✅ Imágenes asignadas: ${updated}/${Object.keys(IMAGES).length}`);
  await mongoose.disconnect();
};

setHomeCategoryImages()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Error al asignar imágenes de categorías:', err);
    process.exit(1);
  });
