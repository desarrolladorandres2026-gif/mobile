import mongoose from 'mongoose';
import { connectDB } from '../config';
import { Business } from '../models';

/**
 * Rellena `rating`/`totalReviews` de los 6 negocios de prueba de este
 * entorno — los cinco del TESTE (`scripts/teste/data/businesses.ts`) más
 * "Carnes Sofia" de `seedTestBusiness.ts` — que se sembraron antes de que
 * `seedTestBusiness.ts` trajera una calificación (el TESTE nunca la puso:
 * `businessService.create()` no acepta `rating`, y con razón — es dato que
 * se gana con reseñas reales, no algo que un negocio declara al crearse).
 *
 * Sin esto, esos negocios se quedan en `rating: 0` (el default del
 * esquema), y las tarjetas de producto del inicio esconden la estrella
 * porque `businessRating > 0` no se cumple.
 *
 *   npm run backfill:demo-ratings
 */

const RATINGS: Record<string, { rating: number; totalReviews: number }> = {
  'Callejón 21': { rating: 4.6, totalReviews: 89 },
  'Sazón de la Tulia': { rating: 4.8, totalReviews: 134 },
  'Carbón & Pan': { rating: 4.7, totalReviews: 102 },
  'Trigo & Tinto': { rating: 4.5, totalReviews: 58 },
  'Autoservicio Punto Fresco': { rating: 4.3, totalReviews: 41 },
  'Carnes Sofia': { rating: 4.5, totalReviews: 23 },
};

const run = async () => {
  await connectDB();
  console.log('⭐ Rellenando calificación de los negocios de demostración…');

  let updated = 0;
  for (const [name, stats] of Object.entries(RATINGS)) {
    const result = await Business.updateOne(
      { name, rating: 0 },
      { $set: { rating: stats.rating, totalReviews: stats.totalReviews } }
    );
    if (result.modifiedCount > 0) {
      updated += 1;
      console.log(`   ${name}: ${stats.rating}★ (${stats.totalReviews} reseñas)`);
    }
  }

  console.log(`✅ Listo. ${updated} negocios actualizados.`);
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error('❌ El relleno falló:', error);
  await mongoose.disconnect();
  process.exit(1);
});
