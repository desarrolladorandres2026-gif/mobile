import mongoose from 'mongoose';
import { config } from '../config';
import { Business, Order } from '../models';

/**
 * Migración 006 — índices para las listas que más se leen.
 *
 * - `Order {businessId, createdAt}` y `{businessId, status, createdAt}`: el
 *   panel del comercio pagina sus pedidos por fecha, con o sin filtro de
 *   estado, y las analíticas filtran por rango de fechas del negocio.
 * - `Order {driverId, createdAt}`: el historial del domiciliario.
 * - `Business {ownerId, createdAt}`: "mis negocios", la sala de socket del
 *   dueño y cada comprobación de propiedad.
 *
 * Se crean con `createIndexes()` —que solo añade lo que falta— y no con
 * `syncIndexes()`, que además borraría cualquier índice que no esté
 * declarado en el esquema (ver la nota de la migración 003).
 *
 * No toca datos: segura de ejecutar más de una vez. En Atlas M0 los índices
 * cuentan contra los 512 MB; estos son sobre campos pequeños.
 */
export async function migratePerfIndexes(): Promise<{ created: string[] }> {
  const before = new Set([
    ...(await Order.collection.indexes()).map((i) => `orders.${i.name}`),
    ...(await Business.collection.indexes()).map((i) => `businesses.${i.name}`),
  ]);

  await Order.createIndexes();
  await Business.createIndexes();

  const after = [
    ...(await Order.collection.indexes()).map((i) => `orders.${i.name}`),
    ...(await Business.collection.indexes()).map((i) => `businesses.${i.name}`),
  ];
  return { created: after.filter((name) => !before.has(name)) };
}

// ── Ejecutable desde la línea de comandos ──
if (require.main === module) {
  (async () => {
    await mongoose.connect(config.mongodb.uri);
    console.log('\n▸ Migración 006 — índices de rendimiento\n');

    try {
      const { created } = await migratePerfIndexes();
      console.log(created.length ? `  Creados: ${created.join(', ')}` : '  Ya existían todos.');
      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    }
  })();
}
