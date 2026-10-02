import mongoose from 'mongoose';
import { config } from '../config';
import { BusinessStaff } from '../models';

/**
 * Migración 025 — roles del panel de comercios v2 (propietario, administrador,
 * operador, cajero).
 *
 *   - `role: 'staff'` (el viejo "Mostrador") pasa a `operator`: ve lo mismo
 *     que antes, pedidos del día y abrir/cerrar, y además consulta el menú.
 *   - `role: 'manager'` no cambia de valor; en pantalla es "Administrador".
 *   - Las filas sin `status` (todas las anteriores) quedan `active` si
 *     `isActive` era true y `suspended` si era false: lo único que cambia es
 *     que ahora se distingue "dado de baja" de "pendiente".
 *   - Los propietarios no se tocan: siguen siendo `Business.ownerId`, así
 *     ninguna cuenta existente pierde acceso.
 *
 * Idempotente. Manual, fuera de `deploy.sh`. El código ya lee `staff` como
 * `operator` (ver `normalizeStaffRole`), así que correrla no es urgente.
 *
 *   npm run migrate:business-roles-v2 -- --dry-run
 *   npm run migrate:business-roles-v2
 */
export interface RolesV2Report {
  staffToOperator: number;
  statusBackfilled: number;
  dryRun: boolean;
}

export async function migrateBusinessRolesV2(options: { dryRun?: boolean } = {}): Promise<RolesV2Report> {
  const dryRun = options.dryRun === true;
  const coll = BusinessStaff.collection;

  const staffToOperator = await coll.countDocuments({ role: 'staff' });
  const statusBackfilled = await coll.countDocuments({ status: { $exists: false } });

  if (!dryRun) {
    await coll.updateMany({ role: 'staff' }, { $set: { role: 'operator' } });
    await coll.updateMany({ status: { $exists: false }, isActive: false }, { $set: { status: 'suspended' } });
    await coll.updateMany({ status: { $exists: false } }, { $set: { status: 'active' } });
  }
  return { staffToOperator, statusBackfilled, dryRun };
}

if (require.main === module) {
  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 025 — roles del panel de comercios v2${dryRun ? ' (dry-run)' : ''}\n`);

    try {
      const report = await migrateBusinessRolesV2({ dryRun });
      console.log(`  staff → operator: ${report.staffToOperator}`);
      console.log(`  status rellenado: ${report.statusBackfilled}`);
      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    }
  })();
}
