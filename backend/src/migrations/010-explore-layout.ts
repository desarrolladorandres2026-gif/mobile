import mongoose from 'mongoose';
import { config } from '../config';
import { ExploreLayoutState, ExploreLayoutVersion, EXPLORE_GLOBAL_SCOPE } from '../models';
import { DEFAULT_EXPLORE_LAYOUT } from '../constants/exploreLayoutDefault';
import { EXPLORE_SCHEMA_VERSION } from '../validators/exploreLayout.validator';
import { invalidatePrefixes, CachePrefix } from '../cache';

/**
 * Migración 010 — el layout de Explorar como configuración publicada.
 *
 * Deja escrita en Atlas la versión 1 con el Explorar de siempre
 * (`DEFAULT_EXPLORE_LAYOUT`) y un borrador igual, para que el constructor
 * del panel arranque desde lo que la gente ya ve.
 *
 * **No es un requisito para desplegar**: sin estos documentos el backend
 * sirve el mismo layout desde el código. Tampoco toca roles: los permisos
 * `explore:*` salen de la tabla estática de `security/rbac.ts`.
 *
 * Idempotente: si el estado ya existe no hace nada. `--down` borra lo que
 * esta migración (y el constructor después de ella) escribió en Atlas —
 * el borrador y todas las versiones— y Explorar vuelve al layout del código.
 */
export async function migrateExploreLayout(): Promise<{ created: boolean }> {
  const existing = await ExploreLayoutState.findOne({ scope: EXPLORE_GLOBAL_SCOPE });
  if (existing) return { created: false };

  await ExploreLayoutVersion.create({
    scope: EXPLORE_GLOBAL_SCOPE,
    version: 1,
    sections: DEFAULT_EXPLORE_LAYOUT,
    schemaVersion: EXPLORE_SCHEMA_VERSION,
    publishedBy: null,
    publishedAt: new Date(),
    note: 'Explorar de siempre (migración 010)',
  });
  await ExploreLayoutState.create({
    scope: EXPLORE_GLOBAL_SCOPE,
    draft: DEFAULT_EXPLORE_LAYOUT,
    schemaVersion: EXPLORE_SCHEMA_VERSION,
    revision: 1,
    currentVersion: 1,
  });
  await invalidatePrefixes([CachePrefix.EXPLORE_LAYOUT]);
  return { created: true };
}

export async function rollbackExploreLayout(): Promise<{ versions: number; states: number }> {
  const [versions, states] = await Promise.all([
    ExploreLayoutVersion.deleteMany({ scope: EXPLORE_GLOBAL_SCOPE }),
    ExploreLayoutState.deleteMany({ scope: EXPLORE_GLOBAL_SCOPE }),
  ]);
  await invalidatePrefixes([CachePrefix.EXPLORE_LAYOUT]);
  return { versions: versions.deletedCount ?? 0, states: states.deletedCount ?? 0 };
}

// ── Ejecutable desde la línea de comandos ──
if (require.main === module) {
  const down = process.argv.includes('--down');
  (async () => {
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 010 — layout de Explorar${down ? ' (--down)' : ''}\n`);

    try {
      if (down) {
        const { versions, states } = await rollbackExploreLayout();
        console.log(`  Borradas: ${versions} versión(es), ${states} borrador(es). Explorar vuelve al layout del código.`);
      } else {
        const { created } = await migrateExploreLayout();
        console.log(created ? '  Versión 1 y borrador creados.' : '  Ya existía: no se tocó nada.');
      }
      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    }
  })();
}
