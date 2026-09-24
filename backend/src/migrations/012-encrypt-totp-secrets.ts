import mongoose from 'mongoose';
import { config } from '../config';
import { User } from '../models';
import { sealTotpSecret } from '../security/totp';

/**
 * Migración 012 — cifra los secretos TOTP que quedaron en claro.
 *
 * La migración 004 nunca tocó `twoFactorSecret`: cifra desde entonces todo
 * secreto nuevo (`sealTotpSecret`, formato `v2:...`), pero una cuenta que
 * activó 2FA antes de ese cambio sigue con el secreto Base32 en texto plano
 * en la base. Con una copia de la base bastaba para generar los códigos de
 * cualquiera de esas cuentas — ver `security/totp.ts`.
 *
 * Detecta "en claro" por el formato: un valor cifrado con `encrypt()`
 * siempre empieza por `v2:` seguido de cuatro segmentos en base64. Cualquier
 * otra cosa (el Base32 de `speakeasy`, que solo usa A-Z2-7) se cifra.
 *
 * Idempotente: correrla dos veces no vuelve a cifrar lo que ya está cifrado.
 */

const ALREADY_ENCRYPTED = /^v2:[^:]+:[^:]+:[^:]+:[^:]+$/;

export interface EncryptTotpSecretsReport {
  usersWithPlaintextSecretEncrypted: number;
  dryRun: boolean;
}

export async function migrateEncryptTotpSecrets(
  options: { dryRun?: boolean } = {}
): Promise<EncryptTotpSecretsReport> {
  const dryRun = options.dryRun ?? false;

  const candidates = await User.find({
    twoFactorSecret: { $exists: true, $ne: null },
  })
    .select('_id twoFactorSecret')
    .lean();

  const plaintext = candidates.filter(
    (u) => typeof u.twoFactorSecret === 'string' && u.twoFactorSecret && !ALREADY_ENCRYPTED.test(u.twoFactorSecret)
  );

  if (!dryRun) {
    for (const user of plaintext) {
      // BAJO: condicionado al valor leído — si algo más escribió (o cifró)
      // el secreto entre la lectura y esta escritura, el `updateOne` no
      // encuentra el documento y no lo sobrescribe con un cifrado hecho a
      // partir de un valor que ya no es el vigente.
      await User.updateOne(
        { _id: user._id, twoFactorSecret: user.twoFactorSecret },
        { $set: { twoFactorSecret: sealTotpSecret(user.twoFactorSecret as string) } }
      );
    }
  }

  return { usersWithPlaintextSecretEncrypted: plaintext.length, dryRun };
}

if (require.main === module) {
  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 012 — Cifrado de secretos TOTP heredados${dryRun ? ' (ejecución en seco)' : ''}\n`);

    try {
      const report = await migrateEncryptTotpSecrets({ dryRun });
      console.log(`  Secretos TOTP cifrados ahora        ${report.usersWithPlaintextSecretEncrypted}`);
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
