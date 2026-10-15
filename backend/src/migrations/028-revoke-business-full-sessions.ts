import mongoose from 'mongoose';
import { config } from '../config';
import { User } from '../models';
import { Session, sessionManager } from '../security/sessions';

/**
 * Migración 028 — revoca las sesiones COMPLETAS de las cuentas de comercio.
 *
 * C1 (2026-10-14): `POST /auth/login` solo abría sesión de mostrador si el
 * cliente mandaba `surface`; sin él, quien tuviera la contraseña del local
 * obtenía una sesión `full` de 7 días. Desde este cambio el servidor decide el
 * alcance y toda sesión de comercio que no sea una elevación nace como
 * mostrador, pero las sesiones `full` que ya existían siguen vivas hasta que
 * caducan. Esta migración es el punto de corte manual: las cuentas de comercio
 * vuelven a iniciar sesión (y nacen como mostrador).
 *
 * Solo toca sesiones `scope: 'full'` y `elevatedFrom: null`. Las elevadas
 * (entrada con PIN o contraseña desde el mostrador) cuelgan de una sesión de
 * mostrador y no se tocan; las de mostrador tampoco.
 *
 * Manual y fuera de `deploy.sh` a propósito — expulsa al dueño de todo panel
 * abierto en el momento en que se corra.
 *
 * Idempotente: una sesión ya revocada no vuelve a contarse.
 */

export interface RevokeBusinessFullSessionsReport {
  businessUsers: number;
  sessionsRevoked: number;
  dryRun: boolean;
}

export async function migrateRevokeBusinessFullSessions(
  options: { dryRun?: boolean } = {}
): Promise<RevokeBusinessFullSessionsReport> {
  const dryRun = options.dryRun ?? false;

  const users = await User.find({ role: 'business' }).select('_id').lean();
  const userIds = users.map((u) => u._id.toString());

  const sessions = await Session.find({
    userId: { $in: userIds },
    isActive: true,
    scope: 'full',
    elevatedFrom: null,
  }).select('_id userId').lean();

  let sessionsRevoked = 0;
  if (!dryRun) {
    for (const session of sessions) {
      if (await sessionManager.revokeSession(session._id.toString(), String(session.userId), 'migration')) {
        sessionsRevoked += 1;
      }
    }
  }

  return { businessUsers: users.length, sessionsRevoked: dryRun ? sessions.length : sessionsRevoked, dryRun };
}

if (require.main === module) {
  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 028 — Revocar sesiones completas de comercio${dryRun ? ' (ejecución en seco)' : ''}\n`);

    try {
      const report = await migrateRevokeBusinessFullSessions({ dryRun });
      console.log(`  Usuarios de comercio                ${report.businessUsers}`);
      console.log(`  Sesiones ${dryRun ? 'a revocar' : 'revocadas'}                  ${report.sessionsRevoked}`);
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
