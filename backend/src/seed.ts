import mongoose from 'mongoose';
import { config } from './config';
import {
  User, Business, Category, Product, Driver, Order,
  Coupon, CouponRedemption, Zone, Address, Commission, DriverDebt,
  PlatformPricingConfig, PricingConfigAudit, LedgerEntry, Payout, Settlement,
  CashReconciliation, Refund, ProcessedWebhook, Payment,
  LegalDocument, LegalAcceptance, DataRequest, Pqrs, DriverDocument,
  Position, Role,
} from './models';
import { pricingConfigService } from './services/pricingConfig.service';
import { migrateRbac } from './migrations/002-rbac';
import { ensureDemoDriversOperational } from './scripts/demoDrivers';
import { seedCatalog } from './scripts/seedCatalog';

/**
 * Demo password for every seeded account.
 *
 * Passed in plain text on purpose: the User model's pre-save hook hashes it
 * with Argon2id. Pre-hashing here (as this script used to do with bcrypt)
 * produced a double hash — argon2(bcrypt(pwd)) — so none of the demo
 * accounts could actually log in.
 *
 * It also satisfies the platform's complexity policy, so business and admin
 * accounts can change it to something similar without being rejected.
 */
const DEMO_PASSWORD = 'Zipp.2026';

const seed = async () => {
  await mongoose.connect(config.mongodb.uri);
  console.log(`🗄️  Conectado a MongoDB (${mongoose.connection.name})`);

  await Promise.all([
    User.deleteMany({}), Business.deleteMany({}), Category.deleteMany({}),
    Product.deleteMany({}), Driver.deleteMany({}), Order.deleteMany({}),
    Coupon.deleteMany({}), CouponRedemption.deleteMany({}), Zone.deleteMany({}),
    Address.deleteMany({}), Commission.deleteMany({}), DriverDebt.deleteMany({}),
    PlatformPricingConfig.deleteMany({}), PricingConfigAudit.deleteMany({}),
    LedgerEntry.collection.deleteMany({}), Payout.deleteMany({}), Settlement.deleteMany({}),
    CashReconciliation.deleteMany({}), Refund.deleteMany({}),
    ProcessedWebhook.deleteMany({}), Payment.deleteMany({}),
    LegalDocument.deleteMany({}), LegalAcceptance.deleteMany({}),
    DataRequest.deleteMany({}), Pqrs.deleteMany({}), DriverDocument.deleteMany({}),
    Position.deleteMany({}), Role.deleteMany({}),
  ]);
  console.log('🧹 Datos anteriores eliminados');

  // ── Pricing configuration ──
  // Version 1 is derived from the environment, so a fresh install starts on
  // exactly the economics the .env describes. Everything below is editable
  // from the admin panel and every change is versioned and audited.
  pricingConfigService.invalidate();
  const pricing = await pricingConfigService.getCurrent();
  console.log(`💰 Configuración de precios v${pricing.version} publicada`);

  // ── Users ──
  await User.create({
    name: 'Admin ZIPP', phone: '3001234567', email: 'admin@zipp.co',
    password: DEMO_PASSWORD, role: 'admin', isActive: true, isVerified: true,
    // Grants access to pricing, cash verification and settlements. Narrower
    // than `role: admin` on purpose — see requireFinanceAdmin.
    isFinanceAdmin: true,
  });

  await User.create({
    name: 'Operador ZIPP', phone: '3002345678', email: 'operacion@zipp.co',
    password: DEMO_PASSWORD, role: 'admin', isActive: true, isVerified: true,
    // Deliberately not a finance admin: useful for checking that the money
    // endpoints really are closed to ordinary admins.
    isFinanceAdmin: false,
  });

  await User.create({
    name: 'Carlos Pérez', phone: '3101234567',
    password: DEMO_PASSWORD, role: 'client', isActive: true, isVerified: true,
  });

  await User.create({
    name: 'María López', phone: '3201234567',
    password: DEMO_PASSWORD, role: 'client', isActive: true, isVerified: true,
  });

  await User.create({
    name: 'Juan Restaurantes', phone: '3151234567',
    password: DEMO_PASSWORD, role: 'business', isActive: true, isVerified: true,
  });

  await User.create({
    name: 'Ana Cafeterías', phone: '3161234567',
    password: DEMO_PASSWORD, role: 'business', isActive: true, isVerified: true,
  });

  await User.create({
    name: 'Pedro Domicilios', phone: '3111234567',
    password: DEMO_PASSWORD, role: 'driver', isActive: true, isVerified: true,
  });

  await User.create({
    name: 'Luis Entregas', phone: '3121234567',
    password: DEMO_PASSWORD, role: 'driver', isActive: true, isVerified: true,
  });

  console.log('👥 Usuarios creados');

  // Los domiciliarios necesitan más que una cuenta para poder trabajar.
  //
  // El seed creaba el usuario y ahí se detenía: sin perfil `Driver` la app
  // del domiciliario ni siquiera cargaba, y sin documentos aprobados
  // `updateStatus` se negaba a ponerlos "Disponible". Las credenciales del
  // README existían pero no servían para recorrer el flujo que el README
  // describe.
  const demoDrivers = await ensureDemoDriversOperational();
  console.log(`🛵 Domiciliarios listos para operar (${demoDrivers.length})`);

  // El catálogo que el README describe: cinco comercios con sus
  // categorías y productos, los cinco cupones de la tabla y las dos
  // direcciones del primer cliente. Sin esto, seguir la guía llevaba a un
  // panel de comercios vacío y a un `BIENVENIDO` que no existía.
  const catalog = await seedCatalog();
  console.log(
    `🏪 Catálogo sembrado — ${catalog.businesses} comercios, ` +
      `${catalog.categories} categorías, ${catalog.products} productos, ` +
      `${catalog.coupons} cupones, ${catalog.addresses} direcciones`
  );

  // ── Seguridad y Acceso: Cargos, Roles y Super Administrador ──
  const rbacReport = await migrateRbac();
  console.log(`🔐 RBAC sembrado — Super Admin asignado a: ${rbacReport.superAdminAssignedTo}`);

  console.log('\n✅ Seed completado exitosamente!');
  console.log(`\n📋 Credenciales de prueba (contraseña para todos: ${DEMO_PASSWORD})`);
  console.log('   Admin:          3001234567  (admin@zipp.co)');
  console.log('   Operador:       3002345678  (operacion@zipp.co)');
  console.log('   Cliente 1:      3101234567');
  console.log('   Cliente 2:      3201234567');
  console.log('   Negocio 1:      3151234567');
  console.log('   Negocio 2:      3161234567');
  console.log('   Domiciliario 1: 3111234567');
  console.log('   Domiciliario 2: 3121234567');
  console.log('\n🎟️  Cupones: BIENVENIDO · ENVIOGRATIS · AHORRA5 · BURGER15 · EXPIRADO');

  await mongoose.disconnect();
  process.exit(0);
};

seed().catch((err) => {
  console.error('❌ Error en seed:', err);
  process.exit(1);
});
