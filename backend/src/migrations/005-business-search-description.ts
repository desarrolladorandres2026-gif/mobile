import mongoose from 'mongoose';
import { config } from '../config';
import { Business } from '../models';

/**
 * Migración 005 — la descripción del negocio entra al buscador.
 *
 * El índice de texto `business_search` solo cubría `name` y `category`.
 * Buscar "hamburguesa" no encontraba un negocio como "Carbón & Pan" porque
 * la palabra solo aparece en su descripción, y su carta usa nombres de autor
 * ("Doble Smash", "Clásica de la Casa") que nunca la dicen. `Product` ya
 * indexaba `description`; esta migración iguala `Business` al mismo criterio.
 *
 * Mongo no permite cambiar la definición de un índice de texto existente:
 * hay que borrarlo y reconstruirlo. `dropIndex` ignora el error si el índice
 * ya no está (migración repetida, o base nueva que nunca lo tuvo).
 *
 * No toca datos, solo el índice — segura de ejecutar más de una vez.
 */
export async function migrateBusinessSearchDescription(): Promise<{ rebuilt: boolean }> {
  await Business.collection.dropIndex('business_search').catch(() => {});
  await Business.createIndexes();
  return { rebuilt: true };
}

// ── Ejecutable desde la línea de comandos ──
if (require.main === module) {
  (async () => {
    await mongoose.connect(config.mongodb.uri);
    console.log('\n▸ Migración 005 — descripción del negocio en el buscador\n');

    try {
      await migrateBusinessSearchDescription();
      console.log('  Índice business_search reconstruido con `description`.');
      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    }
  })();
}
