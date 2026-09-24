import mongoose from 'mongoose';
import { config } from '../config';
import { Business, Settlement } from '../models';
import { encrypt, decrypt, hashForSearch } from '../security';
import { businessAad } from '../services/business.service';
import { PayoutBeneficiary, SettlementPaymentStatus } from '../types';

/**
 * Migración 018 — endurecimiento de la cuenta de pago y los datos fiscales
 * del comercio (revisión de seguridad del flujo fiscal).
 *
 * Cuatro cosas, todas idempotentes y sin tocar `updatedAt`:
 *
 *   1. **Cifrado atado al negocio (AAD).** `payoutAccount.accountNumberEnc`
 *      pasa de v2 a v3 con `businessId` como dato autenticado adicional
 *      (copiar el texto cifrado a otro comercio deja de servir);
 *      `payoutAccount.holderDocument` y `legal.documentNumber`, que estaban
 *      **en claro**, se cifran. El código sigue leyendo lo que no se haya
 *      migrado (v2 o claro), así que esta migración se puede correr después
 *      del deploy sin cortar nada. Se escribe con el driver nativo: no hay
 *      validación de `maxlength` ni hooks de caché de por medio.
 *
 *   2. **`accountNumberHash`.** HMAC determinista de `método:número` para
 *      detectar la misma cuenta en varios comercios (`sharedWithBusinesses`
 *      en la cola de finanzas). Requiere descifrar el número una vez.
 *
 *   3. **Índices** de `payoutAccount.verificationStatus` (cola de cuentas
 *      pendientes) y `payoutAccount.accountNumberHash`.
 *
 *   4. **Reporte (solo lectura)** de a quién bloquea el nuevo control:
 *        · comercios YA aprobados sin cuenta verificada — desde ahora no se
 *          les puede liquidar hasta que finanzas la verifique (la 017 ya
 *          cuenta estos mismos comercios);
 *        · liquidaciones PENDIENTES de pago sin foto de cuenta — no se pueden
 *          pagar hasta refrescarlas con
 *          `POST /finance/settlements/:id/payout-account/refresh`.
 *
 * Nada de lo anterior desaprueba a un comercio ni toca una liquidación.
 *
 * Manual, fuera de `deploy.sh`, como todas: `npm run migrate:payout-account-hardening`
 * (`-- --dry-run` para ver sin escribir).
 */

export interface PayoutAccountHardeningReport {
  accountNumbersResealed: number;
  holderDocumentsEncrypted: number;
  legalNumbersEncrypted: number;
  hashesBackfilled: number;
  /** Cuentas que no se pudieron descifrar: se dejan tal cual y se listan. */
  unreadableAccounts: string[];
  approvedWithoutVerifiedAccount: number;
  approvedWithoutVerifiedSample: string[];
  pendingSettlementsWithoutSnapshot: number;
  dryRun: boolean;
}

const sealed = (value: unknown) => typeof value === 'string' && /^v3:/.test(value);

export async function migratePayoutAccountHardening(
  options: { dryRun?: boolean } = {}
): Promise<PayoutAccountHardeningReport> {
  const dryRun = options.dryRun ?? false;

  let accountNumbersResealed = 0;
  let holderDocumentsEncrypted = 0;
  let legalNumbersEncrypted = 0;
  let hashesBackfilled = 0;
  const unreadableAccounts: string[] = [];

  // ── 1 y 2. Cifrado con AAD y hash de la cuenta ──
  const cursor = Business.collection.find(
    { $or: [{ payoutAccount: { $exists: true } }, { legal: { $exists: true } }] },
    { projection: { payoutAccount: 1, legal: 1 } }
  );

  for await (const business of cursor) {
    const aad = businessAad(business._id);
    const $set: Record<string, unknown> = {};
    const account = business.payoutAccount as
      | { accountNumberEnc?: string; holderDocument?: string; accountNumberHash?: string; method?: string }
      | undefined;
    const legal = business.legal as { documentNumber?: string } | undefined;

    if (account?.accountNumberEnc) {
      const plain = decrypt(account.accountNumberEnc, aad);
      if (plain === account.accountNumberEnc) {
        // No se pudo descifrar (clave distinta o dato corrupto): no se toca.
        unreadableAccounts.push(String(business._id));
      } else {
        if (!sealed(account.accountNumberEnc)) {
          $set['payoutAccount.accountNumberEnc'] = encrypt(plain, aad);
          accountNumbersResealed += 1;
        }
        if (!account.accountNumberHash && account.method) {
          $set['payoutAccount.accountNumberHash'] = hashForSearch(`${account.method}:${plain}`);
          hashesBackfilled += 1;
        }
      }
    }
    if (account?.holderDocument && !sealed(account.holderDocument)) {
      // Puede estar en claro o cifrado v2: se abre y se vuelve a cifrar con AAD.
      const plain = decrypt(account.holderDocument, aad);
      if (!/^v2:/.test(plain)) {
        $set['payoutAccount.holderDocument'] = encrypt(plain, aad);
        holderDocumentsEncrypted += 1;
      }
    }
    if (legal?.documentNumber && !sealed(legal.documentNumber)) {
      const plain = decrypt(legal.documentNumber, aad);
      if (!/^v2:/.test(plain)) {
        $set['legal.documentNumber'] = encrypt(plain, aad);
        legalNumbersEncrypted += 1;
      }
    }

    if (Object.keys($set).length && !dryRun) {
      await Business.collection.updateOne({ _id: business._id }, { $set });
    }
  }

  // ── 3. Índices ──
  if (!dryRun) {
    await Business.collection.createIndex({ 'payoutAccount.verificationStatus': 1 }, { sparse: true });
    await Business.collection.createIndex({ 'payoutAccount.accountNumberHash': 1 }, { sparse: true });
  }

  // ── 4. Reporte ──
  const approved = await Business.find({ isApproved: true }).select('name +payoutAccount').lean();
  const notVerified = approved.filter((b) => b.payoutAccount?.verificationStatus !== 'verified');

  const pendingSettlementsWithoutSnapshot = await Settlement.countDocuments({
    beneficiary: PayoutBeneficiary.BUSINESS,
    paymentStatus: SettlementPaymentStatus.PENDING,
    payoutAccount: { $exists: false },
  });

  return {
    accountNumbersResealed,
    holderDocumentsEncrypted,
    legalNumbersEncrypted,
    hashesBackfilled,
    unreadableAccounts,
    approvedWithoutVerifiedAccount: notVerified.length,
    approvedWithoutVerifiedSample: notVerified.slice(0, 50).map((b) => String(b._id)),
    pendingSettlementsWithoutSnapshot,
    dryRun,
  };
}

if (require.main === module) {
  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 018 — Cuenta de pago y datos fiscales endurecidos${dryRun ? ' (ejecución en seco)' : ''}\n`);

    try {
      const report = await migratePayoutAccountHardening({ dryRun });
      console.log(`  Números de cuenta re-cifrados con AAD        ${report.accountNumbersResealed}`);
      console.log(`  Documentos de titular cifrados               ${report.holderDocumentsEncrypted}`);
      console.log(`  Números de documento legal cifrados          ${report.legalNumbersEncrypted}`);
      console.log(`  accountNumberHash calculados                 ${report.hashesBackfilled}`);
      if (report.unreadableAccounts.length) {
        console.log(`  ⚠ Cuentas que no se pudieron descifrar       ${report.unreadableAccounts.join(', ')}`);
      }
      console.log(`  Comercios aprobados SIN cuenta verificada    ${report.approvedWithoutVerifiedAccount}  (no se les podrá liquidar hasta verificarla; mismo conteo que la 017)`);
      if (report.approvedWithoutVerifiedSample.length) {
        console.log(`  Ejemplos (ids):                              ${report.approvedWithoutVerifiedSample.join(', ')}`);
      }
      console.log(`  Liquidaciones pendientes sin foto de cuenta  ${report.pendingSettlementsWithoutSnapshot}  (refrescar antes de pagar)`);
      console.log('\n✔ Migración completada. Ningún comercio fue desaprobado ni se tocó ninguna liquidación.\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    } finally {
      await mongoose.disconnect();
    }
  })();
}
