import mongoose from 'mongoose';
import { config } from '../config';
import { Business } from '../models';

/**
 * Migración 024 — índice de "Abierto sin app conectada".
 *
 * `Business.panelSeenAt` / `panelDisconnectedNotifiedAt` (ver el modelo) son
 * campos nuevos sin backfill: `null` es exactamente "nunca se ha visto un
 * panel", que es el estado correcto de todo negocio existente. Esta
 * migración solo crea el índice `{isActive, panelDisconnectedNotifiedAt}`
 * que usa el barrido (`businessPresence.service.ts`), siguiendo el
 * precedente de la 006 y la 021: crearlo antes de desplegar para que el
 * primer arranque no lo construya sobre una colección grande mientras
 * atiende tráfico.
 *
 *   npm run migrate:business-panel-presence -- --dry-run   # solo informa
 *   npm run migrate:business-panel-presence                # crea el índice
 *
 * Manual a propósito: no forma parte de `deploy.sh`.
 */

const keyOf = (spec: Record<string, unknown>) => JSON.stringify(spec);

async function existingKeys(): Promise<Set<string>> {
  return new Set((await Business.collection.indexes()).map((i) => keyOf(i.key as Record<string, unknown>)));
}

export interface PanelPresenceIndexReport {
  missing: string[];
  created: string[];
  dryRun: boolean;
}

export async function migrateBusinessPanelPresence(options: { dryRun?: boolean } = {}): Promise<PanelPresenceIndexReport> {
  const dryRun = options.dryRun === true;
  const target = keyOf({ isActive: 1, panelDisconnectedNotifiedAt: 1 });

  const before = await existingKeys();
  const missing = before.has(target) ? [] : [`businesses.${target}`];

  if (dryRun || missing.length === 0) {
    return { missing, created: [], dryRun };
  }

  await Business.createIndexes();
  const after = await existingKeys();
  const created = after.has(target) ? [`businesses.${target}`] : [];
  return { missing, created, dryRun };
}

if (require.main === module) {
  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 024 — índice de presencia del panel${dryRun ? ' (dry-run)' : ''}\n`);

    try {
      const report = await migrateBusinessPanelPresence({ dryRun });
      if (dryRun) {
        console.log(report.missing.length ? `  Falta: ${report.missing.join(', ')}` : '  Ya existe.');
      } else {
        console.log(report.created.length ? `  Creado: ${report.created.join(', ')}` : '  Ya existía.');
      }
      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    }
  })();
}
