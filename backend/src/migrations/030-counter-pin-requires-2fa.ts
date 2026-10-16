import mongoose from 'mongoose';
import { config } from '../config';
import { User, Business, BusinessStaff } from '../models';
import { Session, sessionManager } from '../security/sessions';
import { unlockPin } from '../services/counterPin.service';
import { maskEmail, maskPhone } from '../utils/mask';

/**
 * Migración 030 — quita el PIN de mostrador a toda cuenta sin 2FA activo.
 *
 * Invariante nueva (2026-10-15): un PIN de mostrador implica 2FA. Hasta ahora
 * `setOwnPin` solo lo exigía al propietario: un administrador sin 2FA podía
 * crear PIN, y con eso `counterPeople(businessId)` dejaba de estar vacío y
 * `assertPasswordDoorOpen` cerraba la puerta de la contraseña
 * (`COUNTER_PASSWORD_DISABLED`). Un dueño sin 2FA ni clave del mostrador se
 * quedaba sin ninguna forma de entrar. Además, restablecer o quitar el 2FA no
 * borraba el PIN: quedaba un PIN sin 2FA y, tras 20 fallos, un bloqueo de 30
 * días sin salida.
 *
 * Qué hace, por cada cuenta con PIN (`counterPinHash` o `counterPinSetAt`) y
 * sin `twoFactorEnabled`:
 *
 *   1. Borra `counterPinHash` y pone `counterPinSetAt` en null.
 *   2. Borra sus filas de `CounterPinAttempt` (intentos y bloqueos).
 *   3. Revoca sus sesiones elevadas activas (entradas con PIN o contraseña
 *      desde el mostrador). Las sesiones completas y de mostrador no se tocan.
 *
 * Y lista las cuentas afectadas (id, correo y celular enmascarados, negocios
 * que es dueño o administra) para AVISARLES: la próxima vez que quieran PIN
 * tendrán que activar la verificación en dos pasos.
 *
 * **Orden de despliegue.** Antes del código nuevo o inmediatamente después.
 * Con el código nuevo ya en marcha nadie sin 2FA puede crear un PIN, así que
 * no hay carrera; mientras la migración no corra, esas cuentas siguen con el
 * puerta de la contraseña cerrada.
 *
 * Manual y fuera de `deploy.sh` a propósito. **Por defecto es una ejecución en
 * seco**: no escribe nada hasta que se pasa `--apply`.
 *
 *   npm run migrate:counter-pin-2fa            # en seco
 *   npm run migrate:counter-pin-2fa -- --apply # escribe
 *
 * Idempotente: una segunda pasada ya no encuentra cuentas con PIN y sin 2FA.
 */

export interface AffectedCounterPinAccount {
  userId: string;
  email: string;
  phone: string;
  businesses: string[];
}

export interface CounterPinTwoFactorReport {
  dryRun: boolean;
  /** Cuentas con PIN y sin 2FA (las que se limpian, o se limpiarían). */
  accounts: number;
  sessionsRevoked: number;
  affected: AffectedCounterPinAccount[];
}

export async function migrateCounterPinRequiresTwoFactor(
  options: { dryRun?: boolean } = {}
): Promise<CounterPinTwoFactorReport> {
  const dryRun = options.dryRun ?? true;

  const users = await User.find({
    twoFactorEnabled: { $ne: true },
    $or: [{ counterPinHash: { $exists: true, $nin: [null, ''] } }, { counterPinSetAt: { $ne: null } }],
  })
    .select('_id email phone')
    .lean();

  const affected: AffectedCounterPinAccount[] = [];
  let sessionsRevoked = 0;

  for (const user of users) {
    const userId = String(user._id);

    const owned = await Business.find({ ownerId: user._id }).select('name').lean();
    const staffRows = await BusinessStaff.find({ userId: user._id, isActive: true }).select('businessId').lean();
    const managed = staffRows.length
      ? await Business.find({ _id: { $in: staffRows.map((r) => r.businessId) } }).select('name').lean()
      : [];
    const businesses = [...new Set([...owned, ...managed].map((b) => `${b.name} (${String(b._id)})`))];

    affected.push({ userId, email: maskEmail(user.email), phone: maskPhone(user.phone), businesses });

    const elevated = await Session.find({ userId, isActive: true, elevatedFrom: { $ne: null } }).select('_id').lean();
    if (dryRun) {
      sessionsRevoked += elevated.length;
      continue;
    }

    // Filtro con la misma condición de arriba: si entre el listado y la
    // escritura la cuenta activó el 2FA, su PIN es legítimo y no se toca.
    const cleared = await User.updateOne(
      { _id: user._id, twoFactorEnabled: { $ne: true } },
      { $unset: { counterPinHash: 1 }, $set: { counterPinSetAt: null } }
    );
    if (cleared.modifiedCount !== 1) {
      affected.pop();
      continue;
    }
    await unlockPin(userId);
    for (const session of elevated) {
      if (await sessionManager.revokeSession(String(session._id), userId, 'migration')) sessionsRevoked += 1;
    }
  }

  return { dryRun, accounts: affected.length, sessionsRevoked, affected };
}

if (require.main === module) {
  (async () => {
    const apply = process.argv.includes('--apply');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 030 — PIN de mostrador exige 2FA${apply ? '' : ' (ejecución en seco)'}\n`);

    try {
      const report = await migrateCounterPinRequiresTwoFactor({ dryRun: !apply });
      console.log(`  Cuentas con PIN y sin 2FA              ${report.accounts}`);
      console.log(`  Sesiones elevadas ${apply ? 'revocadas' : 'a revocar'}            ${report.sessionsRevoked}`);
      if (report.affected.length) {
        console.log(`\n  Avisar a estas cuentas (deben activar el 2FA para volver a crear su PIN):`);
        for (const a of report.affected) {
          console.log(`   • ${a.userId}  ${a.email}  ${a.phone}  ${a.businesses.join(', ') || '(sin negocios)'}`);
        }
      }
      console.log(apply ? '\n✔ Migración completada\n' : '\n✔ Ejecución en seco completada (nada se escribió; usa --apply para escribir)\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    } finally {
      await mongoose.disconnect();
    }
  })();
}
