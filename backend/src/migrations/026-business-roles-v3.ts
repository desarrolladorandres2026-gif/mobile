import mongoose from 'mongoose';
import { config } from '../config';
import { BusinessStaff, LEGACY_COUNTER_ROLES } from '../models';

/**
 * Migración 026 — roles del panel de comercios v3 (propietario,
 * administrador, empleado).
 *
 *   - `staff`, `operator` y `cashier` pasan a `employee` (decisión
 *     2026-10-09: el mostrador es un solo papel).
 *   - `manager` no cambia. Los propietarios tampoco: siguen siendo
 *     `Business.ownerId`.
 *   - No toca `status` ni `isActive`: nadie se reactiva ni se suspende.
 *
 * Quien era cajero deja de ver las ventas del turno y gana agotar productos
 * y abrir/cerrar el local; por eso el informe cuenta cuántos cajeros hay, para
 * que el propietario lo sepa. El código ya los lee como `employee` (ver
 * `normalizeStaffRole`), así que correrla no es urgente, pero sí debe correr
 * DESPUÉS de desplegar ese código y no antes.
 *
 * Idempotente. Manual, fuera de `deploy.sh`.
 *
 *   npm run migrate:business-roles-v3 -- --dry-run
 *   npm run migrate:business-roles-v3
 */
export interface RolesV3Report {
  toEmployee: number;
  formerCashiers: number;
  dryRun: boolean;
}

export async function migrateBusinessRolesV3(options: { dryRun?: boolean } = {}): Promise<RolesV3Report> {
  const dryRun = options.dryRun === true;
  const coll = BusinessStaff.collection;
  const legacy = { role: { $in: [...LEGACY_COUNTER_ROLES] } };

  const toEmployee = await coll.countDocuments(legacy);
  const formerCashiers = await coll.countDocuments({ role: 'cashier' });

  if (!dryRun) await coll.updateMany(legacy, { $set: { role: 'employee' } });
  return { toEmployee, formerCashiers, dryRun };
}

if (require.main === module) {
  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 026 — roles del panel de comercios v3${dryRun ? ' (dry-run)' : ''}\n`);

    try {
      const report = await migrateBusinessRolesV3({ dryRun });
      console.log(`  staff/operator/cashier → employee: ${report.toEmployee}`);
      console.log(`  de ellos, antes cajeros (ganan agotar y abrir/cerrar): ${report.formerCashiers}`);
      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    }
  })();
}
