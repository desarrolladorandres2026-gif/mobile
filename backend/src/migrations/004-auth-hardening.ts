import mongoose from 'mongoose';
import { config } from '../config';
import { User } from '../models';

/**
 * Migración 004 — endurecimiento de autenticación (auditoría 2026-09-14/15).
 *
 * Tres cambios de esquema, ninguno destructivo por sí solo, pero que dejan
 * datos existentes en un estado que conviene poner al día explícitamente:
 *
 * 1. `User.refreshToken` desapareció: la fuente de verdad ahora es
 *    `Session.tokenHash` (ver `security/sessions.ts`). El campo viejo, si
 *    queda en un documento, ya no se lee en ningún lugar — pero seguir
 *    guardando un refresh token en claro en la base no tiene sentido una vez
 *    que nada lo usa. Se retira con `$unset`.
 *
 * 2. `phoneVerified`: antes del A4 de la auditoría, el registro de tres
 *    pasos confirmaba el celular por OTP pero nunca marcaba `phoneVerified`,
 *    así que cuentas creadas por ese camino podían editar su teléfono sin
 *    un segundo OTP. Se marca `phoneVerified: true` para toda cuenta
 *    `client` que:
 *      - ya esté verificada (`isVerified: true`) — nadie llega ahí sin
 *        haber pasado por OTP de registro o de login, y
 *      - NO haya entrado nunca por Google/Apple (sin `googleId`/`appleId`),
 *        porque esas cuentas piden el celular aparte y sí pueden estar
 *        legítimamente sin verificar todavía.
 *    Cuentas `business`/`driver`/`admin` no se tocan: se crean por otros
 *    caminos (alta de personal, panel) donde `phoneVerified` nunca aplicó
 *    de la misma manera, y decidir su caso es una llamada de producto, no
 *    de esta migración.
 *
 * 3. Códigos de recuperación de 2FA con el hash SHA-256 sin clave (formato
 *    anterior a este endurecimiento): siguen aceptándose sin cambios —
 *    `verifyRecoveryCode` valida ambos formatos — así que esta migración NO
 *    los toca. Se listan aquí solo para que quede constancia de que existen
 *    y que su reemplazo requiere que el usuario regenere sus códigos desde
 *    el panel (acción que no se puede automatizar: son de un solo uso y el
 *    valor en claro no se guarda en ningún sitio).
 *
 * Segura de ejecutar más de una vez: cada cambio es idempotente.
 */

export interface AuthHardeningReport {
  usersWithLegacyRefreshTokenCleared: number;
  usersMarkedPhoneVerified: number;
  usersWithLegacyRecoveryCodes: number;
  dryRun: boolean;
}

export async function migrateAuthHardening(options: { dryRun?: boolean } = {}): Promise<AuthHardeningReport> {
  const dryRun = options.dryRun ?? false;

  // `refreshToken` ya no está en el esquema: `updateMany` de Mongoose, en
  // modo `strict` (el default), descarta en silencio cualquier operación
  // sobre un campo que el esquema no declara — ni siquiera un `$unset`
  // llegaría a la base. Se usa el driver crudo (`User.collection`) a
  // propósito, precisamente porque el objetivo es tocar un campo que el
  // modelo actual ya no conoce.
  const legacyRefreshTokenCount = await User.collection.countDocuments({ refreshToken: { $exists: true } });
  if (!dryRun && legacyRefreshTokenCount > 0) {
    await User.collection.updateMany({ refreshToken: { $exists: true } }, { $unset: { refreshToken: 1 } });
  }

  const phoneVerifiedFilter = {
    role: 'client',
    isVerified: true,
    phoneVerified: { $ne: true },
    phone: { $exists: true, $ne: null },
    googleId: { $exists: false },
    appleId: { $exists: false },
  };
  const usersMarkedPhoneVerified = await User.countDocuments(phoneVerifiedFilter);
  if (!dryRun && usersMarkedPhoneVerified > 0) {
    await User.updateMany(phoneVerifiedFilter, { $set: { phoneVerified: true } });
  }

  // Solo diagnóstico: cuenta cuántos recovery codes con el formato viejo
  // siguen vivos, para que quien opere sepa cuántas cuentas conviene avisar.
  const usersWithLegacyRecoveryCodes = await User.countDocuments({
    twoFactorEnabled: true,
    recoveryCodes: { $exists: true, $not: { $size: 0 } },
  });

  return {
    usersWithLegacyRefreshTokenCleared: legacyRefreshTokenCount,
    usersMarkedPhoneVerified,
    usersWithLegacyRecoveryCodes,
    dryRun,
  };
}

// ── Ejecutable desde la línea de comandos ──
if (require.main === module) {
  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 004 — Endurecimiento de autenticación${dryRun ? ' (ejecución en seco)' : ''}\n`);

    try {
      const report = await migrateAuthHardening({ dryRun });

      console.log(`  refreshToken legado retirado         ${report.usersWithLegacyRefreshTokenCleared}`);
      console.log(`  Cuentas marcadas phoneVerified        ${report.usersMarkedPhoneVerified}`);
      console.log(`  Cuentas con recovery codes en formato anterior (solo informativo, no se tocan): ${report.usersWithLegacyRecoveryCodes}`);

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
