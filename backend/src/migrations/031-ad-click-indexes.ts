import mongoose from 'mongoose';
import { config } from '../config';
import { AdClick, AdNetworkQuota } from '../models';

/**
 * Migración 031 — índices de `AdClick`, la evidencia de los clics cobrables.
 *
 * Dos de ellos SON el control de dinero, no un acelerador:
 * - `{campaignId, clickId}` único: el mismo toque no se cobra dos veces.
 * - `{dedupeKey}` único parcial: un clic cobrable por dispositivo y ventana,
 *   aunque lleguen dos a la vez.
 * - `{userDedupeKey}` único parcial: lo mismo por cuenta, para que cambiar de
 *   dispositivo no abra otro clic cobrable (2026-10-19).
 * - `AdNetworkQuota.{key}` único: el cupo diario por red se reserva de forma atómica;
 *   sin este índice dos clics simultáneos podrían pasar los dos con un solo cupo.
 *   Su TTL limpia solo los cupos viejos.
 *
 * Mongoose los crea al arrancar (`autoIndex`) y el servicio espera a
 * `AdClick.init()` antes del primer clic cobrable; esto los deja creados antes
 * de encender `adBillingEnabled`, siguiendo el precedente de la 006. Con
 * `createIndexes()` (solo añade lo que falta), nunca `syncIndexes()`.
 *
 * No toca datos: segura de ejecutar más de una vez. Manual, fuera de deploy.sh.
 */
export async function migrateAdClickIndexes(): Promise<{ created: string[] }> {
  const names = async () => {
    try {
      const [clicks, quotas] = await Promise.all([
        AdClick.collection.indexes().catch(() => []),
        AdNetworkQuota.collection.indexes().catch(() => []),
      ]);
      return [...clicks.map((i) => `adclicks.${i.name}`), ...quotas.map((i) => `adnetworkquotas.${i.name}`)];
    } catch {
      return [] as string[]; // la colección aún no existe
    }
  };
  const before = new Set(await names());
  await AdClick.createIndexes();
  await AdNetworkQuota.createIndexes();
  return { created: (await names()).filter((name) => !before.has(name)) };
}

// ── Ejecutable desde la línea de comandos ──
if (require.main === module) {
  (async () => {
    await mongoose.connect(config.mongodb.uri);
    console.log('\n▸ Migración 031 — índices de AdClick\n');

    try {
      const { created } = await migrateAdClickIndexes();
      console.log(created.length ? `  Creados: ${created.join(', ')}` : '  Ya existían todos.');
      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    }
  })();
}
