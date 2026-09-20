import mongoose from 'mongoose';
import { connectDB } from '../config';
import { DiscoveryCollection } from '../models';
import { ALL_SEEDS, seedToDocument } from '../constants/discoverySeeds';

/**
 * Siembra las veinte colecciones que hasta ahora vivían en el array
 * `sectionDefs` de `homeSections.service.ts`.
 *
 * Es la migración de "definidas en código" a "definidas en la base". Cada
 * entrada de aquí reproduce la regla que ya tenía esa colección, traducida
 * al lenguaje cerrado del modelo, y le añade las dos cosas que antes no
 * podía expresar: a qué feed va y en qué franja horaria tiene sentido.
 *
 *   npm run seed:discovery-collections            crea solo las que faltan
 *   npm run seed:discovery-collections -- --force reescribe también las existentes
 *
 * Por defecto **no pisa** una colección que ya existe: en cuanto alguien
 * edite un título desde el panel, este script no puede deshacerlo. `--force`
 * es para volver al punto de partida, y es una decisión consciente.
 */

async function run(): Promise<void> {
  const force = process.argv.includes('--force');
  await connectDB();

  console.log(`🧭 Sembrando colecciones de descubrimiento${force ? ' (forzado)' : ''}…`);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const seed of ALL_SEEDS) {
    const doc = seedToDocument(seed);

    const existing = await DiscoveryCollection.findOne({ key: seed.key });

    if (!existing) {
      await DiscoveryCollection.create(doc);
      created++;
    } else if (force) {
      Object.assign(existing, doc);
      await existing.save();
      updated++;
    } else {
      skipped++;
    }
  }

  const home = await DiscoveryCollection.countDocuments({ isActive: true, feed: { $in: ['home', 'both'] } });
  const explore = await DiscoveryCollection.countDocuments({ isActive: true, feed: { $in: ['explore', 'both'] } });

  console.log('');
  console.log(`   Creadas ......... ${created}`);
  console.log(`   Reescritas ...... ${updated}`);
  console.log(`   Ya existían ..... ${skipped}`);
  console.log('');
  console.log(`   Activas en Inicio ..... ${home}`);
  console.log(`   Activas en Explorar ... ${explore}`);

  await mongoose.disconnect();
  console.log('');
  console.log('✅ Listo.');
}

run().catch(async (error) => {
  console.error('❌ La siembra falló:', error);
  await mongoose.disconnect();
  process.exit(1);
});
