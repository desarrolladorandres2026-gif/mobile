import mongoose from 'mongoose';
import { config } from '../config';
import { User, Business, Category, Product } from '../models';
import { BusinessCategory, UserRole } from '../types';

/**
 * Siembra un comercio de prueba completo — dueño, negocio aprobado,
 * categorías y catálogo con precios — para poder recorrer un pedido de
 * principio a fin sin depender de datos reales de Atlas.
 *
 * Idempotente igual que `demoDrivers.ts`: usa `findOneAndUpdate` con
 * `upsert` para no duplicar nada si se corre dos veces, y no borra ni toca
 * ningún otro documento de la base.
 */

const DEMO_PASSWORD = 'Zipp.2026';
const OWNER_PHONE = '3171234567';
const BUSINESS_PHONE = '3181234567';

/** No hay categoría "carnicería" en `BusinessCategory`; supermercado es la más cercana. */
const CATEGORY = BusinessCategory.SUPERMARKET;

// Mismas coordenadas que usan los fixtures de prueba (`GARZON` en factories.ts),
// para que el negocio caiga dentro del radio de búsqueda de un cliente de prueba.
const LOCATION = { lat: 2.1958, lng: -75.6258 };

interface ProductSeed {
  name: string;
  description: string;
  price: number;
}

interface CategorySeed {
  name: string;
  sortOrder: number;
  products: ProductSeed[];
}

const CATALOG: CategorySeed[] = [
  {
    name: 'Res',
    sortOrder: 0,
    products: [
      { name: 'Lomo de Res (libra)', description: 'Corte tierno para la parrilla o el sartén.', price: 28000 },
      { name: 'Carne para Asar (libra)', description: 'Corte clásico para asado de fin de semana.', price: 16000 },
      { name: 'Carne Molida de Res (libra)', description: 'Ideal para albóndigas, carne al gusto o pasta.', price: 15000 },
      { name: 'Costilla de Res (libra)', description: 'Perfecta para sudado o caldo.', price: 14000 },
    ],
  },
  {
    name: 'Cerdo',
    sortOrder: 1,
    products: [
      { name: 'Chuleta de Cerdo (libra)', description: 'Corte fresco, listo para la plancha.', price: 13000 },
      { name: 'Costilla de Cerdo BBQ (libra)', description: 'Para asar con salsa BBQ.', price: 15000 },
      { name: 'Lomo de Cerdo (libra)', description: 'Corte magro, ideal al horno.', price: 17000 },
    ],
  },
  {
    name: 'Pollo',
    sortOrder: 2,
    products: [
      { name: 'Pechuga de Pollo (libra)', description: 'Sin piel, sin hueso.', price: 9000 },
      { name: 'Pierna Pernil de Pollo (libra)', description: 'Con piel y hueso, jugosa al horno.', price: 7000 },
      { name: 'Alitas de Pollo (libra)', description: 'Para freír o al horno.', price: 8500 },
    ],
  },
  {
    name: 'Embutidos y Fríos',
    sortOrder: 3,
    products: [
      { name: 'Chorizo Santarrosano (paquete x6)', description: 'Receta tradicional, listo para asar.', price: 12000 },
      { name: 'Salchicha Ranchera (libra)', description: 'Para perro caliente o asado.', price: 11000 },
      { name: 'Morcilla (unidad)', description: 'Receta casera.', price: 4000 },
    ],
  },
];

async function main(): Promise<void> {
  if (config.nodeEnv === 'production') {
    console.error('\n❌ Este script no corre en producción — es un comercio de prueba con precios de ejemplo.\n');
    process.exit(1);
  }

  await mongoose.connect(config.mongodb.uri);
  console.log(`🗄️  Conectado a MongoDB (${mongoose.connection.name})`);

  // `findOneAndUpdate` no dispara `pre('save')`, así que un upsert directo
  // dejaría la contraseña sin hashear. `User.create()` sí lo dispara.
  let owner = await User.findOne({ phone: OWNER_PHONE });
  if (!owner) {
    owner = await User.create({
      name: 'Sofía Ramírez',
      phone: OWNER_PHONE,
      password: DEMO_PASSWORD,
      role: UserRole.BUSINESS,
      isActive: true,
      isVerified: true,
    });
    console.log(`👤 Dueño creado: ${owner.name} (${owner.phone})`);
  } else {
    console.log(`👤 Dueño ya existía: ${owner.name} (${owner.phone})`);
  }

  const admin = await User.findOne({ email: 'admin@zipp.co' }).select('_id');

  let business = await Business.findOne({ ownerId: owner._id });
  if (!business) {
    business = await Business.create({
      ownerId: owner._id,
      name: 'Carnes Sofia',
      description: 'Carnicería de barrio: cortes frescos de res, cerdo y pollo, y embutidos.',
      category: CATEGORY,
      address: 'Calle 10 # 5-23',
      location: { type: 'Point', coordinates: [LOCATION.lng, LOCATION.lat] },
      phone: BUSINESS_PHONE,
      deliveryTime: 25,
      minOrder: 10000,
      isActive: true,
      isApproved: true,
      approvedAt: new Date(),
      approvedBy: admin?._id ?? null,
    });
    console.log(`🏪 Negocio creado: ${business.name} (${business.slug})`);
  } else {
    business.isActive = true;
    business.isApproved = true;
    business.approvedAt = business.approvedAt ?? new Date();
    await business.save();
    console.log(`🏪 Negocio ya existía: ${business.name} (${business.slug}) — verificado activo y aprobado`);
  }

  let categoriesCreated = 0;
  let productsCreated = 0;

  for (const cat of CATALOG) {
    let category = await Category.findOne({ businessId: business._id, name: cat.name });
    if (!category) {
      category = await Category.create({
        businessId: business._id,
        name: cat.name,
        sortOrder: cat.sortOrder,
        isActive: true,
      });
      categoriesCreated += 1;
    }

    for (const p of cat.products) {
      const exists = await Product.findOne({ businessId: business._id, categoryId: category._id, name: p.name });
      if (exists) continue;

      await Product.create({
        businessId: business._id,
        categoryId: category._id,
        name: p.name,
        description: p.description,
        price: p.price,
        isAvailable: true,
      });
      productsCreated += 1;
    }
  }

  console.log(`📂 Categorías: ${CATALOG.length} (${categoriesCreated} nuevas)`);
  console.log(`📦 Productos: ${CATALOG.reduce((n, c) => n + c.products.length, 0)} (${productsCreated} nuevos)`);
  console.log(`\n✅ Listo para probar una compra.`);
  console.log(`   Comercio: Carnes Sofia (${business.isApproved ? 'aprobado' : 'pendiente'}, ${business.isActive ? 'activo' : 'inactivo'})`);
  console.log(`   Dueño:    ${OWNER_PHONE} / ${DEMO_PASSWORD}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Error sembrando el comercio de prueba:', err);
  process.exit(1);
});
