import mongoose from 'mongoose';
import { config } from '../config';
import { Zone, Business, Role } from '../models';
import { Permission, SUPER_ADMIN_ROLE_SLUG } from '../security/rbac';

/**
 * Migración 017 — versionado de zonas (D9) y reporte fiscal de comercios
 * (Fase 0 del plan del panel admin).
 *
 * Tres cosas, en este orden y todas idempotentes:
 *
 *   1. **Zonas sin versión.** `Zone` ahora guarda `version` (la tarifa
 *      vigente) y `versions[]` (su historial). Las zonas anteriores no
 *      tienen ninguna de las dos: se les da `version: 1` y una entrada de
 *      historial con su tarifa actual (`changeReason` "…antes del
 *      versionado…", sin autor), para que el primer cambio de tarifa no deje
 *      el historial arrancando en el vacío. Se escribe con el driver nativo y
 *      sin tocar `updatedAt`, que es la fecha que se le asigna a esa entrada.
 *
 *   2. **Permisos `zones:view` / `zones:manage` en el rol `super_admin`.** El
 *      rol legacy `admin` ya los trae por código (`rbac.ts`), pero el rol de
 *      sistema `super_admin` guarda su lista de permisos en la base desde la
 *      migración 002: sin esto, cuando la Fase 1 quite los permisos legacy, el
 *      Super Administrador se quedaría sin editar zonas. `$addToSet`: no toca
 *      ningún otro permiso.
 *
 *   3. **Reporte (solo lectura) de comercios ya aprobados sin datos legales o
 *      sin cuenta de pago verificada.** `approve()` ahora exige ambos, pero
 *      solo para aprobaciones nuevas: a los ya aprobados NO se les quita la
 *      aprobación. Este reporte dice cuántos son y cuáles, para que finanzas
 *      los complete (y para saber a quiénes bloquearía la liquidación con
 *      cuenta verificada el día que se cablee).
 *
 * Los pedidos anteriores no tienen `zoneVersion` y no se rellena: no hay forma
 * fiable de saber con qué versión de la tarifa se cotizaron. Quedan en `null`
 * = "antes del versionado".
 *
 * Manual, fuera de `deploy.sh`, como todas: `npm run migrate:zone-versions`
 * (`-- --dry-run` para ver sin escribir).
 */

export interface ZoneVersionsFiscalReport {
  zonesBackfilled: number;
  superAdminPermissionsAdded: number;
  approvedWithoutLegal: number;
  approvedWithoutVerifiedAccount: number;
  /** Los primeros ids, para ir a completarlos. */
  approvedIncompleteSample: string[];
  dryRun: boolean;
}

const ZONE_PERMISSIONS = [Permission.ZONES_VIEW, Permission.ZONES_MANAGE];

export async function migrateZoneVersionsFiscalReport(
  options: { dryRun?: boolean } = {}
): Promise<ZoneVersionsFiscalReport> {
  const dryRun = options.dryRun ?? false;

  // ── 1. Zonas sin historial ──
  const withoutHistory = { $or: [{ versions: { $exists: false } }, { versions: { $size: 0 } }] };
  const zones = await Zone.collection.find(withoutHistory).toArray();
  let zonesBackfilled = 0;

  for (const zone of zones) {
    if (!dryRun) {
      const version = typeof zone.version === 'number' ? zone.version : 1;
      const result = await Zone.collection.updateOne(
        // Otra vez el filtro: si alguien versionó la zona entre la lectura y
        // esta escritura, no se pisa su historial.
        { _id: zone._id, ...withoutHistory },
        {
          $set: {
            version,
            versions: [
              {
                version,
                baseFee: zone.baseFee ?? null,
                perKm: zone.perKm ?? null,
                surcharge: zone.surcharge ?? 0,
                minOrder: zone.minOrder ?? 0,
                changeReason: 'Tarifa vigente antes del versionado (migración 017)',
                changedBy: null,
                changedAt: zone.updatedAt ?? zone.createdAt ?? new Date(),
              },
            ],
          },
        }
      );
      zonesBackfilled += result.modifiedCount;
    } else {
      zonesBackfilled += 1;
    }
  }

  // ── 2. Permisos de zonas en el rol super_admin ──
  const superAdmin = await Role.findOne({ slug: SUPER_ADMIN_ROLE_SLUG }).select('permissions').lean();
  const missingPermissions = superAdmin
    ? ZONE_PERMISSIONS.filter((p) => !(superAdmin.permissions ?? []).includes(p))
    : [];
  if (superAdmin && missingPermissions.length > 0 && !dryRun) {
    await Role.updateOne(
      { slug: SUPER_ADMIN_ROLE_SLUG },
      { $addToSet: { permissions: { $each: missingPermissions } } }
    );
  }

  // ── 3. Reporte de comercios aprobados incompletos (solo lectura) ──
  const approved = await Business.find({ isApproved: true })
    .select('name +legal +payoutAccount')
    .lean();

  let approvedWithoutLegal = 0;
  let approvedWithoutVerifiedAccount = 0;
  const sample: string[] = [];

  for (const business of approved) {
    const legal = business.legal;
    const legalOk = !!(legal?.documentType && legal.documentNumber && legal.legalName) &&
      (legal.documentType !== 'NIT' || !!legal.dv);
    const accountOk = business.payoutAccount?.verificationStatus === 'verified';

    if (!legalOk) approvedWithoutLegal += 1;
    if (!accountOk) approvedWithoutVerifiedAccount += 1;
    if ((!legalOk || !accountOk) && sample.length < 50) sample.push(String(business._id));
  }

  return {
    zonesBackfilled,
    superAdminPermissionsAdded: missingPermissions.length,
    approvedWithoutLegal,
    approvedWithoutVerifiedAccount,
    approvedIncompleteSample: sample,
    dryRun,
  };
}

if (require.main === module) {
  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 017 — Zonas versionadas y reporte fiscal${dryRun ? ' (ejecución en seco)' : ''}\n`);

    try {
      const report = await migrateZoneVersionsFiscalReport({ dryRun });
      console.log(`  Zonas con historial creado            ${report.zonesBackfilled}`);
      console.log(`  Permisos de zonas añadidos a super_admin ${report.superAdminPermissionsAdded}`);
      console.log(`  Comercios aprobados sin datos legales  ${report.approvedWithoutLegal}`);
      console.log(`  Comercios aprobados sin cuenta verificada ${report.approvedWithoutVerifiedAccount}`);
      if (report.approvedIncompleteSample.length) {
        console.log(`  Ejemplos (ids):                        ${report.approvedIncompleteSample.join(', ')}`);
      }
      console.log('\n✔ Migración completada. Ningún comercio aprobado fue desaprobado.\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    } finally {
      await mongoose.disconnect();
    }
  })();
}
