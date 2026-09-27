import mongoose from 'mongoose';
import { config } from '../config';
import { SecurityEvent } from '../models';

/**
 * Migración 022 — índices del historial de seguridad de comercios.
 *
 * `SecurityEvent` es una colección nueva: cuatro índices de consulta y el TTL
 * de `createdAt` (12 meses) que hace de política de retención. No hay datos
 * que migrar: las sesiones abiertas antes del despliegue siguen funcionando y
 * aparecen en el centro de seguridad como "dispositivo no identificado"
 * (`Session.identified` es falso por defecto) hasta que la persona vuelva a
 * entrar desde un panel que ya manda `X-Device-ID`.
 *
 * Mongoose ya crea estos índices al arrancar (`autoIndex`), pero, como en la
 * 006 y la 021, conviene crearlos antes del despliegue. Solo `createIndexes()`
 * (añade lo que falta), nunca `syncIndexes()` (ver la nota de la 003).
 *
 *   npm run migrate:security-events -- --dry-run   # solo informa
 *   npm run migrate:security-events                # crea lo que falte
 *
 * Manual a propósito: no forma parte de `deploy.sh`.
 */
const keyOf = (spec: Record<string, unknown>) => JSON.stringify(spec);

async function existingKeys(): Promise<Set<string>> {
  try {
    return new Set((await SecurityEvent.collection.indexes()).map((i) => keyOf(i.key as Record<string, unknown>)));
  } catch {
    // La colección aún no existe (NamespaceNotFound): no hay ningún índice.
    return new Set();
  }
}

export interface SecurityEventsIndexesReport {
  missing: string[];
  created: string[];
  dryRun: boolean;
}

export async function migrateSecurityEventIndexes(options: { dryRun?: boolean } = {}): Promise<SecurityEventsIndexesReport> {
  const dryRun = options.dryRun === true;
  const before = await existingKeys();
  const declared = SecurityEvent.schema.indexes().map(([fields]) => keyOf(fields as Record<string, unknown>));
  const missing = declared.filter((k) => !before.has(k)).map((k) => `securityevents.${k}`);
  const created: string[] = [];

  if (!dryRun) {
    await SecurityEvent.createIndexes();
    const after = await existingKeys();
    created.push(...[...after].filter((k) => !before.has(k)).map((k) => `securityevents.${k}`));
  }
  return { missing, created, dryRun };
}

// ── Ejecutable desde la línea de comandos ──
if (require.main === module) {
  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 022 — historial de seguridad de comercios${dryRun ? ' (dry-run)' : ''}\n`);

    try {
      const report = await migrateSecurityEventIndexes({ dryRun });
      if (dryRun) {
        console.log(report.missing.length ? `  Faltan: ${report.missing.join(', ')}` : '  No falta ninguno.');
      } else {
        console.log(report.created.length ? `  Creados: ${report.created.join(', ')}` : '  Ya existían todos.');
      }
      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    }
  })();
}
