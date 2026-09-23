import mongoose from 'mongoose';
import { config } from '../config';
import { Advertisement, AdPlacement } from '../models';

/**
 * Migración 009 — superficie de la campaña (`placement`).
 *
 * Nueva campo en `Advertisement` para poder mostrar publicidad también en
 * Explorar, no solo en el flyer de arranque. El código ya tolera documentos
 * sin el campo (`getActiveForApp` trata la ausencia como `'splash'`), así
 * que esta migración no es un requisito para desplegar — es limpieza: deja
 * el dato explícito en Atlas para que un `find({placement:'splash'})` normal
 * (el panel admin, un reporte, otra consulta futura) no tenga que repetir
 * ese respaldo.
 *
 * `updateMany` con filtro `{placement: {$exists: false}}`: solo toca lo que
 * nunca se escribió, así que repetirla no hace nada la segunda vez.
 */
export async function migrateAdPlacement(): Promise<{ updated: number }> {
  const result = await Advertisement.updateMany(
    { placement: { $exists: false } },
    { $set: { placement: AdPlacement.SPLASH } }
  );
  await Advertisement.createIndexes();
  return { updated: result.modifiedCount };
}

// ── Ejecutable desde la línea de comandos ──
if (require.main === module) {
  (async () => {
    await mongoose.connect(config.mongodb.uri);
    console.log('\n▸ Migración 009 — superficie de campañas de publicidad\n');

    try {
      const { updated } = await migrateAdPlacement();
      console.log(`  Campañas actualizadas a 'splash': ${updated}`);
      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    }
  })();
}
