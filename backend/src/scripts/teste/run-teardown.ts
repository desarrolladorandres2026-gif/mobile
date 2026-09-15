import mongoose from 'mongoose';
import { cloudinary } from '../../config';
import {
  User, Business, Category, Product, Address, Order, BusinessDocument, Favorite,
  Payment, LedgerEntry, Payout, OrderEvidence, OrderMessage, OrderCall, Review, CouponRedemption,
  Notification, Refund,
} from '../../models';
import { OrderSecurity } from '../../security/orderSecurity';
import { productImageService } from '../../services/productImage.service';
import { connectGuarded, parseArgs, testeUserFilter } from './common';

/**
 * `npm run teste:teardown -- --db=<nombre> [--apply] [--include-orders]`
 *
 * Sin `--apply` solo **lista** lo que borraría. Con `--apply` borra
 * exactamente lo que cuelga de las cuentas `@teste.zipp.co`: productos
 * (y sus fotos en Cloudinary), categorías, documentos, negocios,
 * direcciones, favoritos y los propios usuarios.
 *
 * Los pedidos son distintos: llevan asientos de libro mayor y
 * liquidaciones, y borrarlos deja las cuentas de la plataforma
 * descuadradas. Por eso se reportan y **no se tocan** salvo con
 * `--include-orders`, que borra también sus pagos, asientos, liquidaciones,
 * evidencias, mensajes y notificaciones. Pensado para una base de
 * desarrollo; nunca corre en producción.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = args.apply === true;
  const includeOrders = args['include-orders'] === true;
  await connectGuarded(typeof args.db === 'string' ? args.db : undefined);

  const users = await User.find(testeUserFilter()).select('_id name phone email role');
  const userIds = users.map((u) => u._id);
  const businesses = await Business.find({ ownerId: { $in: userIds } }).select('_id name');
  const businessIds = businesses.map((b) => b._id);
  const products = await Product.find({ businessId: { $in: businessIds } });
  const categories = await Category.countDocuments({ businessId: { $in: businessIds } });
  const documents = await BusinessDocument.countDocuments({ businessId: { $in: businessIds } });
  const addresses = await Address.countDocuments({ userId: { $in: userIds } });
  const favorites = await Favorite.countDocuments({ userId: { $in: userIds } });
  const orders = await Order.find({ $or: [{ clientId: { $in: userIds } }, { businessId: { $in: businessIds } }] }).select('_id orderNumber status');
  const orderIds = orders.map((o) => o._id);
  const ledger = await LedgerEntry.countDocuments({ orderId: { $in: orderIds } });
  const payouts = await Payout.countDocuments({ orderId: { $in: orderIds } });

  console.log(`\n${apply ? '🗑️  BORRANDO' : '🔎 Simulación (nada se borra sin --apply)'}\n`);
  console.log(`Usuarios TESTE:  ${users.length}`);
  for (const u of users) console.log(`   ${u.role.padEnd(8)} ${u.name} · ${u.phone} · ${u.email}`);
  console.log(`Negocios:        ${businesses.length}  (${businesses.map((b) => b.name).join(', ')})`);
  console.log(`Productos:       ${products.length}  (${products.filter((p) => p.imageAsset?.publicId).length} con foto en Cloudinary)`);
  console.log(`Categorías:      ${categories}`);
  console.log(`Documentos:      ${documents}`);
  console.log(`Direcciones:     ${addresses}`);
  console.log(`Favoritos:       ${favorites}`);
  console.log(`Pedidos:         ${orders.length}  (${ledger} asientos, ${payouts} liquidaciones) ${includeOrders ? '→ se borran' : '→ NO se tocan sin --include-orders'}`);

  if (orders.length && !includeOrders) {
    console.log('\n⚠️  Hay pedidos TESTE. Los negocios y usuarios que aparecen en ellos se conservarán para no dejar pedidos huérfanos.');
  }

  if (!apply) {
    await mongoose.disconnect();
    return;
  }

  if (includeOrders && orderIds.length) {
    await Promise.all([
      Payment.deleteMany({ orderId: { $in: orderIds } }),
      LedgerEntry.deleteMany({ orderId: { $in: orderIds } }),
      Payout.deleteMany({ orderId: { $in: orderIds } }),
      Refund.deleteMany({ orderId: { $in: orderIds } }),
      OrderEvidence.deleteMany({ orderId: { $in: orderIds } }),
      OrderMessage.deleteMany({ orderId: { $in: orderIds } }),
      OrderCall.deleteMany({ orderId: { $in: orderIds } }),
      OrderSecurity.deleteMany({ orderId: { $in: orderIds.map(String) } }),
      Review.deleteMany({ orderId: { $in: orderIds } }),
      CouponRedemption.deleteMany({ orderId: { $in: orderIds } }),
      Notification.deleteMany({ userId: { $in: userIds } }),
    ]);
    // La bitácora vive en su propia colección, sin modelo exportado.
    await mongoose.connection.collection('orderevents').deleteMany({ orderId: { $in: orderIds.map(String) } });
    await Order.deleteMany({ _id: { $in: orderIds } });
    console.log(`\n🧾 Pedidos borrados: ${orderIds.length}`);
  }

  const keepBusinesses = new Set<string>();
  const keepUsers = new Set<string>();
  if (!includeOrders) {
    for (const o of await Order.find({ $or: [{ clientId: { $in: userIds } }, { businessId: { $in: businessIds } }] }).select('clientId businessId')) {
      keepUsers.add(o.clientId.toString());
      if (o.businessId) keepBusinesses.add(o.businessId.toString());
    }
  }

  let photos = 0;
  for (const product of products) {
    if (keepBusinesses.has(product.businessId.toString())) continue;
    if (product.imageAsset?.publicId) { await productImageService.forget(product); photos += 1; }
    await Product.deleteOne({ _id: product._id });
  }
  const deletableBusinessIds = businessIds.filter((id) => !keepBusinesses.has(id.toString()));
  await Category.deleteMany({ businessId: { $in: deletableBusinessIds } });
  await BusinessDocument.deleteMany({ businessId: { $in: deletableBusinessIds } });
  await Business.deleteMany({ _id: { $in: deletableBusinessIds } });

  try {
    await cloudinary.api.delete_resources_by_tag('teste');
  } catch (error) {
    console.log(`⚠️  No se pudieron borrar logos/portadas en Cloudinary: ${(error as Error).message}`);
  }

  // Un dueño cuyo negocio se conserva también se conserva: el negocio no
  // puede quedar sin `ownerId`.
  const keptOwners = await Business.find({ _id: { $in: [...keepBusinesses] } }).select('ownerId');
  for (const b of keptOwners) keepUsers.add(b.ownerId.toString());
  const deletableUserIds = userIds.filter((id) => !keepUsers.has(id.toString()));
  await Address.deleteMany({ userId: { $in: deletableUserIds } });
  await Favorite.deleteMany({ userId: { $in: deletableUserIds } });
  await User.deleteMany({ _id: { $in: deletableUserIds } });

  console.log(`\n✅ Borrado: ${deletableBusinessIds.length} negocios, ${products.length} productos (${photos} fotos), ${deletableUserIds.length} usuarios.`);
  if (keepBusinesses.size || keepUsers.size) {
    console.log(`   Conservados por tener pedidos: ${keepBusinesses.size} negocios, ${keepUsers.size} usuarios. Usa --include-orders para borrarlos también.`);
  }
  await mongoose.disconnect();
}

main().catch((err) => { console.error('❌', err.message); process.exit(1); });
