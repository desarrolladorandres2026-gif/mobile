import mongoose from 'mongoose';
import { config } from '../config';
import { cloudinary } from '../config';
import { DriverDocument } from '../models';
import { DriverVerification } from '../security/driverSecurity';

/**
 * Migración 015 — pasa documentos y selfies de domiciliarios a entrega
 * privada de Cloudinary (S16).
 *
 * Antes de este cambio, la cédula, el SOAT, la licencia y las selfies de
 * verificación de un domiciliario se subían con entrega `upload` (pública):
 * cualquiera con la URL —filtrada, adivinada por el patrón previsible de
 * Cloudinary, o encontrada en un volcado de la base— podía verlas sin pasar
 * por el backend ni por ningún control de acceso.
 *
 * Por cada documento/verificación con `imageUrl` público y sin `imageKey`:
 *  1. Extrae el `public_id` de la URL de Cloudinary.
 *  2. `uploader.rename(id, id, { type: 'upload', to_type: 'authenticated', invalidate: true })`
 *     — mismo recurso, mismo `public_id`, pero ya no servible sin firmar.
 *  3. `updateOne({ _id, imageUrl: <original> }, { $set: { imageKey, isPrivate: true }, $unset: { imageUrl: 1 } })`
 *     — condicionado al valor leído, para no pisar un documento que cambió
 *     entre la lectura y la escritura.
 *
 * En lotes, idempotente (una fila ya con `imageKey`/`isPrivate` no se toca
 * de nuevo; una sin `imageUrl` reconocible se deja intacta y se cuenta como
 * "omitida" para revisión manual) y con `--dry-run`.
 */

const BATCH_SIZE = 25;

export interface DriverDocsPrivateReport {
  documentsMigrated: number;
  documentsSkipped: number;
  verificationsMigrated: number;
  verificationsSkipped: number;
  dryRun: boolean;
}

/** El `public_id` de Cloudinary a partir de su URL de entrega pública. */
function publicIdFromCloudinaryUrl(url: string): string | null {
  // .../upload/v123456/zipp/driver-documents/abc123.jpg → zipp/driver-documents/abc123
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-zA-Z0-9]+)?$/);
  return match ? match[1] : null;
}

async function migrateCollection(
  model: typeof DriverDocument | typeof DriverVerification,
  dryRun: boolean
): Promise<{ migrated: number; skipped: number }> {
  let migrated = 0;
  let skipped = 0;

  // Se pagina con `_id` en vez de skip/limit: entre lotes se van
  // reasignando documentos (isPrivate:true los saca del filtro), así que
  // un cursor por posición se saltaría filas.
  for (;;) {
    const batch = await (model as typeof DriverDocument)
      .find({ imageUrl: { $exists: true, $ne: null }, isPrivate: { $ne: true } })
      .limit(BATCH_SIZE)
      .select('_id imageUrl')
      .lean();

    if (batch.length === 0) break;

    for (const doc of batch) {
      const originalUrl = doc.imageUrl as string;
      const publicId = publicIdFromCloudinaryUrl(originalUrl);

      if (!publicId) {
        // No se puede seguir sin trabarse en un bucle: al no escribir nada,
        // esta fila volvería a salir en la siguiente vuelta del `while`.
        // Se cuenta como omitida — para revisión manual — y se corta el
        // lote aquí; lo que ya se migró en corridas anteriores no se toca.
        skipped += 1;
        return { migrated, skipped };
      }

      if (!dryRun) {
        await cloudinary.uploader.rename(publicId, publicId, {
          type: 'upload',
          to_type: 'authenticated',
          resource_type: 'image',
          invalidate: true,
        });

        await (model as typeof DriverDocument).updateOne(
          { _id: doc._id, imageUrl: originalUrl },
          { $set: { imageKey: publicId, isPrivate: true }, $unset: { imageUrl: 1 } }
        );
      }
      migrated += 1;
    }

    if (dryRun) break; // en seco no cambia nada, así que el `while` no avanzaría nunca
  }

  return { migrated, skipped };
}

export async function migrateDriverDocsPrivate(
  options: { dryRun?: boolean } = {}
): Promise<DriverDocsPrivateReport> {
  const dryRun = options.dryRun ?? false;

  const documents = await migrateCollection(DriverDocument, dryRun);
  const verifications = await migrateCollection(DriverVerification as any, dryRun);

  return {
    documentsMigrated: documents.migrated,
    documentsSkipped: documents.skipped,
    verificationsMigrated: verifications.migrated,
    verificationsSkipped: verifications.skipped,
    dryRun,
  };
}

if (require.main === module) {
  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 015 — Documentos y selfies de domiciliarios a privado${dryRun ? ' (ejecución en seco)' : ''}\n`);

    try {
      const report = await migrateDriverDocsPrivate({ dryRun });
      console.log(`  Documentos migrados                 ${report.documentsMigrated}`);
      console.log(`  Documentos omitidos (revisar a mano) ${report.documentsSkipped}`);
      console.log(`  Verificaciones migradas              ${report.verificationsMigrated}`);
      console.log(`  Verificaciones omitidas               ${report.verificationsSkipped}`);
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
