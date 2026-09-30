import { Business, BusinessDocument, Driver, DriverDocument } from '../models';
import { pushService } from './push.service';

/**
 * Avisos de vencimiento de documentos a comercios y domiciliarios.
 *
 * Un papel vencido corta la operación: el comercio deja de recibir pedidos
 * (`order.service.create`) y el domiciliario no puede conectarse
 * (`assertDocumentsCurrent`). Hasta ahora solo el panel admin se enteraba;
 * la persona afectada lo descubría cuando ya no le entraba trabajo.
 *
 * Etapas: 30, 7 y 1 día antes, y una el día que vence. Solo se manda la etapa
 * en la que está el papel ahora: si al desplegar faltan 5 días, llega el de
 * 7 y no los de 30 y 7 de golpe.
 *
 * La marca `<expiresAt>:<etapa>` se escribe con la condición dentro del
 * filtro antes de enviar, así que dos barridos a la vez no avisan dos veces.
 * Lleva la fecha dentro para que un papel renovado (otra `expiresAt`) vuelva
 * a empezar el ciclo sin tener que limpiar nada al subirlo.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const EXPIRY_REMINDER_DAYS = [30, 7, 1] as const;
/** Pasado esto, un papel vencido ya no genera el aviso de "venció": no se avisa de lo viejo al desplegar. */
const EXPIRED_GRACE_MS = 2 * DAY_MS;

const BUSINESS_LABEL: Record<string, string> = {
  rut: 'RUT',
  chamber_of_commerce: 'certificado de Cámara de Comercio',
  legal_rep_id: 'cédula del representante legal',
  bank_certificate: 'certificación bancaria',
  health_permit: 'concepto sanitario',
};

const DRIVER_LABEL: Record<string, string> = {
  identity: 'documento de identidad',
  identity_back: 'reverso del documento de identidad',
  criminal_record: 'certificado de antecedentes judiciales',
  license: 'licencia de conducción',
  soat: 'SOAT',
  technical_review: 'revisión técnico-mecánica',
  vehicle_registration: 'tarjeta de propiedad',
};

/** La etapa que toca hoy, o `null` si no toca ninguna. 0 = venció. */
export function reminderStage(expiresAt: Date, now: Date): number | null {
  const msLeft = expiresAt.getTime() - now.getTime();
  if (msLeft <= 0) return -msLeft <= EXPIRED_GRACE_MS ? 0 : null;
  const daysLeft = Math.ceil(msLeft / DAY_MS);
  const stage = [...EXPIRY_REMINDER_DAYS].reverse().find((d) => daysLeft <= d);
  return stage ?? null;
}

const bogotaDay = (d: Date) => d.toLocaleDateString('es-CO', { day: 'numeric', month: 'long', timeZone: 'America/Bogota' });

function whenPhrase(stage: number): string {
  if (stage === 1) return 'vence mañana';
  return `vence en ${stage} días`;
}

function businessMessage(label: string, businessName: string, stage: number, expiresAt: Date) {
  if (stage === 0) {
    return {
      title: `Tu ${label} venció`,
      body: `${businessName} no recibe pedidos hasta que subas el nuevo en Documentos del panel.`,
    };
  }
  return {
    title: `Tu ${label} ${whenPhrase(stage)}`,
    body: `Sube el nuevo en Documentos del panel antes del ${bogotaDay(expiresAt)} para que ${businessName} siga recibiendo pedidos.`,
  };
}

function driverMessage(label: string, stage: number, expiresAt: Date) {
  if (stage === 0) {
    return {
      title: `Tu ${label} venció`,
      body: 'No puedes conectarte hasta que subas el nuevo en Documentos.',
    };
  }
  return {
    title: `Tu ${label} ${whenPhrase(stage)}`,
    body: `Súbelo renovado en Documentos antes del ${bogotaDay(expiresAt)} para seguir recibiendo pedidos.`,
  };
}

/** Reclama el aviso (idempotente). `true` si este proceso es quien debe enviarlo. */
async function claim(model: typeof BusinessDocument | typeof DriverDocument, id: unknown, key: string): Promise<boolean> {
  const res = await (model as typeof BusinessDocument).updateOne(
    { _id: id, expiryRemindersSent: { $ne: key } },
    { $push: { expiryRemindersSent: { $each: [key], $slice: -12 } } }
  );
  return res.modifiedCount === 1;
}

export async function sendExpiryReminders(now = new Date()): Promise<{ business: number; driver: number }> {
  const window = {
    status: { $in: ['approved', 'expired'] },
    expiresAt: { $gte: new Date(now.getTime() - EXPIRED_GRACE_MS), $lte: new Date(now.getTime() + 30 * DAY_MS) },
  };

  const [businessDocs, driverDocs] = await Promise.all([
    BusinessDocument.find(window).select('businessId type expiresAt +expiryRemindersSent').limit(2000).lean(),
    DriverDocument.find(window).select('driverId type expiresAt +expiryRemindersSent').limit(2000).lean(),
  ]);

  const [businesses, drivers] = await Promise.all([
    Business.find({ _id: { $in: businessDocs.map((d) => d.businessId) } }).select('ownerId name').lean(),
    Driver.find({ _id: { $in: driverDocs.map((d) => d.driverId) } }).select('userId').lean(),
  ]);
  const businessById = new Map(businesses.map((b) => [String(b._id), b]));
  const driverById = new Map(drivers.map((d) => [String(d._id), d]));

  let business = 0;
  for (const doc of businessDocs) {
    const stage = reminderStage(doc.expiresAt!, now);
    const owner = businessById.get(String(doc.businessId));
    if (stage === null || !owner?.ownerId) continue;
    const key = `${doc.expiresAt!.toISOString()}:${stage}`;
    if (doc.expiryRemindersSent?.includes(key)) continue;
    if (!(await claim(BusinessDocument, doc._id, key))) continue;
    const label = BUSINESS_LABEL[doc.type] ?? doc.type;
    await pushService.sendToUser(String(owner.ownerId), {
      ...businessMessage(label, owner.name, stage, doc.expiresAt!),
      data: { type: 'document_expiring', scope: 'business', businessId: String(doc.businessId), documentType: doc.type },
    });
    business++;
  }

  let driver = 0;
  for (const doc of driverDocs) {
    const stage = reminderStage(doc.expiresAt!, now);
    const d = driverById.get(String(doc.driverId));
    if (stage === null || !d?.userId) continue;
    const key = `${doc.expiresAt!.toISOString()}:${stage}`;
    if (doc.expiryRemindersSent?.includes(key)) continue;
    if (!(await claim(DriverDocument, doc._id, key))) continue;
    const label = DRIVER_LABEL[doc.type] ?? doc.type;
    await pushService.sendToUser(String(d.userId), {
      ...driverMessage(label, stage, doc.expiresAt!),
      data: { type: 'document_expiring', scope: 'driver', documentType: doc.type },
    });
    driver++;
  }

  return { business, driver };
}

// ── Barrido ──────────────────────────────────────────────────────────
// Cada hora basta: la etapa más fina es "falta un día". Mismo patrón de
// `setInterval` de proceso que los demás barridos (PM2 en una instancia).
let timer: ReturnType<typeof setInterval> | null = null;

export function startDocumentExpirySweeper(intervalMs = 60 * 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    sendExpiryReminders().catch((error) => console.error('[document-expiry-sweep]', error));
  }, intervalMs);
  timer.unref?.();
}

export function stopDocumentExpirySweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
