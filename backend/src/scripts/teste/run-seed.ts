import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { User } from '../../models';
import { UserRole } from '../../types';
import { connectGuarded, parseArgs } from './common';
import { applyTeste } from './applyTeste';
import { TESTE_PASSWORD, TESTE_BUSINESSES, TESTE_CLIENTS } from './data/businesses';

/**
 * `npm run teste:seed -- --db=<nombre> [--skip-images]`
 *
 * Idempotente: se puede correr las veces que haga falta. Deja el
 * manifiesto con los ids en `teste.manifest.json`, junto a este archivo,
 * para que `teste:teardown` y el informe sepan exactamente qué se sembró.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  await connectGuarded(typeof args.db === 'string' ? args.db : undefined);

  const admin = await User.findOne({ role: UserRole.ADMIN }).sort({ createdAt: 1 }).select('_id name');
  if (!admin) {
    throw new Error('No hay ningún administrador: la aprobación de los comercios necesita uno. Corre "npm run bootstrap:admin" primero.');
  }
  console.log(`🛡️  Aprobará: ${admin.name}`);

  const report = await applyTeste({
    adminId: admin._id.toString(),
    images: args['skip-images'] !== true,
    log: (line) => console.log(line),
  });

  const manifest = {
    seededAt: new Date().toISOString(),
    db: mongoose.connection.name,
    businesses: report.businesses.ids,
    products: report.products.ids,
    accounts: {
      password: TESTE_PASSWORD,
      owners: TESTE_BUSINESSES.map((b) => ({ business: b.name, phone: b.owner.phone, email: b.owner.email })),
      clients: TESTE_CLIENTS.map((c) => ({ name: c.name, phone: c.phone, email: c.email })),
    },
  };
  const manifestPath = path.join(__dirname, 'teste.manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  console.log('\n──────── Resumen ────────');
  console.log(`Usuarios:   ${report.users.created} nuevos, ${report.users.existing} ya estaban`);
  console.log(`Negocios:   ${report.businesses.created} nuevos, ${report.businesses.existing} ya estaban`);
  console.log(`Categorías: ${report.categories.created} nuevas, ${report.categories.existing} ya estaban`);
  console.log(`Productos:  ${report.products.created} nuevos, ${report.products.updated} actualizados`);
  console.log(`Fotos:      ${report.images.uploaded} subidas, ${report.images.skipped} ya estaban, ${report.images.failed.length} fallidas`);
  for (const f of report.images.failed) console.log(`   ⚠️  ${f}`);
  console.log(`Direcciones: ${report.addresses.created} nuevas, ${report.addresses.existing} ya estaban`);
  console.log(`\nManifiesto: ${manifestPath}`);
  console.log(`Contraseña de todas las cuentas TESTE: ${TESTE_PASSWORD}`);

  await mongoose.disconnect();
  process.exit(report.images.failed.length ? 2 : 0);
}

main().catch((err) => { console.error('❌', err.message); process.exit(1); });
