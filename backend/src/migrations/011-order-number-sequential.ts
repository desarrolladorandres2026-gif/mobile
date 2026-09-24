import mongoose from 'mongoose';
import { config } from '../config';
import { Order } from '../models';

/**
 * Migración 011 — números de pedido consecutivos (000001, 000002…).
 *
 * El formato anterior era `ZP2609-00042`. Ahora es solo el contador con
 * ceros a la izquierda. Esta migración renumera los pedidos existentes por
 * orden de creación y deja el contador en el último asignado, para que el
 * siguiente pedido nuevo continúe la serie.
 *
 * SOLO PARA DEV / BASES SIN PEDIDOS REALES: cambia números que un cliente o
 * un comercio pudo haber recibido. No se ejecuta en `deploy.sh`.
 *
 * Los números viejos empiezan por "ZP" y los nuevos son solo dígitos, así
 * que el índice único nunca choca a mitad de camino. Repetirla es inocua:
 * renumera en el mismo orden y termina en el mismo contador.
 */
export async function migrateOrderNumbers(): Promise<{ renumbered: number }> {
  const orders = await Order.find({}, { _id: 1 }).sort({ createdAt: 1, _id: 1 }).lean();

  const ops = orders.map((o, i) => ({
    updateOne: {
      filter: { _id: o._id },
      update: { $set: { orderNumber: String(i + 1).padStart(6, '0') } },
    },
  }));
  if (ops.length) await Order.bulkWrite(ops, { ordered: true });

  await mongoose.connection
    .collection('counters')
    .updateOne({ _id: 'orderNumber' as never }, { $set: { seq: orders.length } }, { upsert: true });

  return { renumbered: orders.length };
}

// ── Ejecutable desde la línea de comandos ──
if (require.main === module) {
  (async () => {
    await mongoose.connect(config.mongodb.uri);
    console.log('\n▸ Migración 011 — números de pedido consecutivos\n');

    try {
      const { renumbered } = await migrateOrderNumbers();
      console.log(`  Pedidos renumerados: ${renumbered}`);
      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    }
  })();
}
