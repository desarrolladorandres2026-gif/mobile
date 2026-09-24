import mongoose from 'mongoose';
import { config } from '../config';
import { User } from '../models';
import { sessionManager } from '../security/sessions';

/**
 * Migración 014 — revoca las sesiones activas de todos los usuarios admin.
 *
 * M1: antes de este cambio, una sesión de admin no llevaba `isStaff: true`
 * (nació con el TTL largo de cliente) y un ascenso a admin no revocaba las
 * sesiones anteriores (`updateUserRole` ya lo hace ahora). Esta migración es
 * el punto de corte manual: todo admin existente vuelve a iniciar sesión y
 * nace de nuevo como staff, con el TTL corto (8h / 30min de inactividad).
 *
 * Manual y fuera de `deploy.sh` a propósito — expulsa a todo admin
 * conectado en el momento en que se corra.
 *
 * Idempotente: revocar una sesión ya revocada no hace nada.
 */

export interface RevokeAdminSessionsReport {
  adminUsers: number;
  sessionsRevoked: number;
  dryRun: boolean;
}

export async function migrateRevokeAdminSessions(
  options: { dryRun?: boolean } = {}
): Promise<RevokeAdminSessionsReport> {
  const dryRun = options.dryRun ?? false;

  const admins = await User.find({ role: 'admin' }).select('_id').lean();

  let sessionsRevoked = 0;
  if (!dryRun) {
    for (const admin of admins) {
      sessionsRevoked += await sessionManager.revokeAllSessions(admin._id.toString(), {
        reason: 'admin',
      });
    }
  }

  return { adminUsers: admins.length, sessionsRevoked, dryRun };
}

if (require.main === module) {
  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 014 — Revocar sesiones de admin${dryRun ? ' (ejecución en seco)' : ''}\n`);

    try {
      const report = await migrateRevokeAdminSessions({ dryRun });
      console.log(`  Usuarios admin                      ${report.adminUsers}`);
      console.log(`  Sesiones revocadas                  ${report.sessionsRevoked}`);
      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    } finally {
      await mongoose.disconnect();
    }
  })();
}
