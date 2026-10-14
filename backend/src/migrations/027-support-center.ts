import mongoose from 'mongoose';
import { config } from '../config';
import { Pqrs, HelpArticle, getNextSequence } from '../models';
import type { HelpCategory } from '../models/HelpArticle';

/**
 * Migración 027 — Centro de soporte del panel de comercios.
 *
 *   - Numera los casos que no tienen `ticketNumber` (SOP-000123), del más
 *     antiguo al más nuevo, con el mismo contador atómico que usa el alta.
 *   - Siembra en `HelpArticle` las cinco respuestas que el panel de comercios
 *     traía escritas en el código, para que soporte las mantenga desde el panel
 *     de administración. Solo esas: el resto de categorías queda "pendiente de
 *     configuración" hasta que soporte las redacte.
 *
 * Idempotente: no renumera lo numerado ni duplica un artículo (clave: categoría
 * + pregunta). No toca estados ni historial. Manual, fuera de `deploy.sh`.
 *
 *   npm run migrate:support-center -- --dry-run
 *   npm run migrate:support-center
 */
export interface SupportCenterReport {
  ticketsToNumber: number;
  articlesToSeed: number;
  dryRun: boolean;
}

export const SEED_ARTICLES: Array<{ category: HelpCategory; question: string; answer: string }> = [
  {
    category: 'payments',
    question: '¿Cómo se calcula lo que ZIPP me paga?',
    answer: 'Venta, menos la comisión de ZIPP, menos los descuentos que asumes tú, menos las reversiones por reembolsos o contracargos: eso es tu neto. El propietario lo ve por semana en Liquidaciones, con los pedidos que lo componen.',
  },
  {
    category: 'payments',
    question: '¿En qué liquidación se pagó un pedido?',
    answer: 'Abre la ficha del pedido (el ojo en la lista de pedidos): quien ve las finanzas del local encuentra ahí el estado de su liquidación y su neto.',
  },
  {
    category: 'orders',
    question: 'No me llegan pedidos',
    answer: 'Revisa el interruptor Abierto / Cerrado del menú lateral: con el local cerrado ZIPP no te manda pedidos nuevos. Si un documento venció, tampoco recibes pedidos hasta subirlo de nuevo en Documentos.',
  },
  {
    category: 'drivers',
    question: 'El domiciliario falló el código de recogida',
    answer: 'Tras varios intentos fallidos queda bloqueado un tiempo. No le entregues el pedido: en la ficha del pedido hay un enlace de WhatsApp a Soporte con el mensaje ya escrito.',
  },
  {
    category: 'account',
    question: '¿Quién puede cambiar la cuenta donde me pagan?',
    answer: 'Solo el propietario del local.',
  },
];

export async function migrateSupportCenter(options: { dryRun?: boolean } = {}): Promise<SupportCenterReport> {
  const dryRun = options.dryRun === true;
  const unnumbered = { $or: [{ ticketNumber: null }, { ticketNumber: { $exists: false } }] };

  const ids = (await Pqrs.find(unnumbered).sort({ createdAt: 1, _id: 1 }).select('_id').lean()).map((row) => row._id);
  if (!dryRun) {
    for (const id of ids) {
      await Pqrs.updateOne({ _id: id, ...unnumbered }, { $set: { ticketNumber: await getNextSequence('pqrs') } }, { timestamps: false });
    }
  }

  let articlesToSeed = 0;
  for (const article of SEED_ARTICLES) {
    const exists = await HelpArticle.exists({ category: article.category, question: article.question });
    if (exists) continue;
    articlesToSeed += 1;
    if (!dryRun) await HelpArticle.create({ ...article, createdBy: null });
  }

  return { ticketsToNumber: ids.length, articlesToSeed, dryRun };
}

if (require.main === module) {
  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 027 — Centro de soporte${dryRun ? ' (dry-run)' : ''}\n`);

    try {
      const report = await migrateSupportCenter({ dryRun });
      console.log(`  casos por numerar: ${report.ticketsToNumber}`);
      console.log(`  artículos de ayuda por sembrar: ${report.articlesToSeed}`);
      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    }
  })();
}
