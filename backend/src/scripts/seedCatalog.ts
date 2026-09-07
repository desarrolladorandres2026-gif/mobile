import { Types } from 'mongoose';
import { User, Business, Category, Product, Coupon, Address } from '../models';
import {
  BusinessCategory,
  CouponType,
  CouponFundedBy,
  CouponScope,
} from '../types';

/**
 * El catálogo de demostración que el README lleva prometiendo desde
 * siempre.
 *
 * `seed.ts` creaba ocho usuarios y se detenía ahí, pero el README describe
 * Burger House, Rincón Paisa y Super Fresh para el primer comercio; Café
 * Aroma y Droguería Salud+ para el segundo; dos direcciones guardadas para
 * el primer cliente; y una tabla entera de cupones con sus condiciones.
 * Nada de eso existía. Quien seguía la guía entraba al panel de comercios
 * y encontraba la pantalla vacía, o probaba `BIENVENIDO` en el checkout y
 * recibía "cupón inválido" — sin forma de saber si había hecho algo mal o
 * si el sistema estaba roto.
 *
 * Los datos de aquí son exactamente los que documenta el README. Si uno de
 * los dos cambia, el otro tiene que cambiar con él: son la misma promesa
 * escrita dos veces.
 */

/** Garzón, Huila. Las mismas coordenadas que usan los fixtures de prueba. */
const GARZON = { lat: 2.1958, lng: -75.6258 };

/** Desplaza un punto unos metros, para que los comercios no se apilen. */
function nearby(index: number) {
  return {
    lat: GARZON.lat + index * 0.0035,
    lng: GARZON.lng + (index % 2 === 0 ? 0.0025 : -0.0025),
  };
}

interface ProductSeed {
  name: string;
  description: string;
  price: number;
  discountPrice?: number;
  extras?: Array<{ name: string; price: number }>;
}

interface CategorySeed {
  name: string;
  products: ProductSeed[];
}

interface BusinessSeed {
  /** Teléfono del dueño en el README: decide a quién pertenece. */
  ownerPhone: string;
  name: string;
  description: string;
  category: BusinessCategory;
  address: string;
  phone: string;
  deliveryTime: number;
  minOrder: number;
  categories: CategorySeed[];
}

const BUSINESSES: BusinessSeed[] = [
  {
    ownerPhone: '3151234567',
    name: 'Burger House',
    description: 'Hamburguesas a la parrilla, papas de corte grueso y malteadas.',
    category: BusinessCategory.FAST_FOOD,
    address: 'Cra 10 # 8-45',
    phone: '3151110001',
    deliveryTime: 25,
    minOrder: 15000,
    categories: [
      {
        name: 'Hamburguesas',
        products: [
          {
            name: 'Hamburguesa Clásica',
            description: 'Carne de res 150 g, queso, lechuga, tomate y salsa de la casa.',
            price: 18000,
            extras: [
              { name: 'Queso extra', price: 2500 },
              { name: 'Tocineta', price: 3500 },
              { name: 'Carne adicional', price: 7000 },
            ],
          },
          {
            name: 'Hamburguesa Doble Tocineta',
            description: 'Doble carne, doble queso y tocineta crocante.',
            price: 27000,
            discountPrice: 23500,
            extras: [
              { name: 'Huevo frito', price: 2000 },
              { name: 'Aros de cebolla', price: 4000 },
            ],
          },
          {
            name: 'Hamburguesa de Pollo Crispy',
            description: 'Pechuga apanada, coleslaw y salsa picante suave.',
            price: 20000,
            extras: [{ name: 'Extra picante', price: 0 }],
          },
        ],
      },
      {
        name: 'Acompañamientos',
        products: [
          { name: 'Papas a la Francesa', description: 'Corte grueso, con sal marina.', price: 8000 },
          { name: 'Aros de Cebolla', description: 'Apanados y crocantes, con salsa ranch.', price: 9500 },
        ],
      },
      {
        name: 'Bebidas',
        products: [
          { name: 'Malteada de Vainilla', description: 'Helado artesanal, 16 oz.', price: 11000 },
          { name: 'Gaseosa 400 ml', description: 'Surtida.', price: 4500 },
        ],
      },
    ],
  },
  {
    ownerPhone: '3151234567',
    name: 'Rincón Paisa',
    description: 'Comida típica antioqueña: bandeja, sancocho y fritanga.',
    category: BusinessCategory.RESTAURANT,
    address: 'Calle 7 # 12-30',
    phone: '3151110002',
    deliveryTime: 35,
    minOrder: 18000,
    categories: [
      {
        name: 'Platos fuertes',
        products: [
          {
            name: 'Bandeja Paisa',
            description: 'Frijoles, arroz, chicharrón, chorizo, huevo, aguacate y arepa.',
            price: 32000,
            extras: [
              { name: 'Chicharrón extra', price: 6000 },
              { name: 'Aguacate extra', price: 3000 },
            ],
          },
          { name: 'Sancocho de Gallina', description: 'Con yuca, plátano y mazorca.', price: 26000 },
          { name: 'Mojarra Frita', description: 'Con patacón, arroz y ensalada.', price: 30000 },
        ],
      },
      {
        name: 'Para picar',
        products: [
          { name: 'Picada Personal', description: 'Chorizo, morcilla, chicharrón y papa criolla.', price: 22000 },
          { name: 'Arepa de Choclo con Queso', description: 'Recién hecha en la plancha.', price: 9000 },
        ],
      },
    ],
  },
  {
    ownerPhone: '3151234567',
    name: 'Super Fresh',
    description: 'Mercado de barrio: frutas, verduras y básicos de la despensa.',
    category: BusinessCategory.SUPERMARKET,
    address: 'Cra 12 # 4-18',
    phone: '3151110003',
    deliveryTime: 40,
    minOrder: 20000,
    categories: [
      {
        name: 'Frutas y verduras',
        products: [
          { name: 'Tomate Chonto (libra)', description: 'Fresco del día.', price: 3500 },
          { name: 'Banano (kilo)', description: 'De la región.', price: 4000 },
          { name: 'Cebolla Larga (manojo)', description: 'Recién cosechada.', price: 3000 },
        ],
      },
      {
        name: 'Despensa',
        products: [
          { name: 'Arroz 1 kg', description: 'Grano largo.', price: 5500 },
          { name: 'Aceite Girasol 1 L', description: 'Para cocina diaria.', price: 12000 },
          { name: 'Huevos AA (cubeta x30)', description: 'Frescos.', price: 21000 },
        ],
      },
    ],
  },
  {
    ownerPhone: '3161234567',
    name: 'Café Aroma',
    description: 'Café de origen, repostería del día y desayunos.',
    category: BusinessCategory.CAFE,
    address: 'Calle 9 # 10-12',
    phone: '3161110001',
    deliveryTime: 20,
    minOrder: 10000,
    categories: [
      {
        name: 'Café',
        products: [
          {
            name: 'Capuchino',
            description: 'Doble shot, leche texturizada.',
            price: 8500,
            extras: [
              { name: 'Leche deslactosada', price: 1500 },
              { name: 'Shot extra', price: 2500 },
            ],
          },
          { name: 'Americano', description: 'Filtrado, 12 oz.', price: 6000 },
          { name: 'Latte Vainilla', description: 'Con jarabe de vainilla natural.', price: 9500 },
        ],
      },
      {
        name: 'Repostería',
        products: [
          { name: 'Croissant de Mantequilla', description: 'Horneado en la mañana.', price: 6500 },
          { name: 'Torta de Zanahoria (porción)', description: 'Con frosting de queso crema.', price: 9000 },
        ],
      },
    ],
  },
  {
    ownerPhone: '3161234567',
    name: 'Droguería Salud+',
    description: 'Medicamentos de venta libre, cuidado personal y primeros auxilios.',
    category: BusinessCategory.PHARMACY,
    address: 'Cra 9 # 6-55',
    phone: '3161110002',
    deliveryTime: 30,
    minOrder: 8000,
    categories: [
      {
        name: 'Venta libre',
        products: [
          { name: 'Acetaminofén 500 mg (x20)', description: 'Analgésico y antipirético.', price: 7000 },
          { name: 'Ibuprofeno 400 mg (x10)', description: 'Antiinflamatorio.', price: 8500 },
          { name: 'Suero Oral (500 ml)', description: 'Rehidratación.', price: 5000 },
        ],
      },
      {
        name: 'Cuidado personal',
        products: [
          { name: 'Alcohol Antiséptico 700 ml', description: 'Uso externo.', price: 9000 },
          { name: 'Curas Adhesivas (x30)', description: 'Surtidas.', price: 6500 },
        ],
      },
    ],
  },
];

/**
 * Los cupones de la tabla del README, uno por uno.
 *
 * Todos los financia la plataforma salvo `BURGER15`: un descuento atado a
 * un solo comercio lo natural es que lo pague ese comercio, y además sirve
 * para que el seed cubra las dos ramas de `fundedBy` — el modelo tiene
 * reglas distintas para cada una y conviene poder probarlas.
 */
interface CouponSeed {
  code: string;
  title: string;
  description: string;
  type: CouponType;
  value: number;
  maxDiscountAmount?: number;
  minOrderAmount?: number;
  usageLimit?: number;
  perUserLimit?: number;
  firstOrderOnly?: boolean;
  scope?: CouponScope;
  fundedBy?: CouponFundedBy;
  /** Nombre del comercio al que se ata, si aplica. */
  businessName?: string;
  /** Vencido a propósito. */
  expired?: boolean;
}

const COUPONS: CouponSeed[] = [
  {
    code: 'BIENVENIDO',
    title: 'Bienvenido a Zipp',
    description: '20 % de descuento en tu primer pedido, hasta $10.000.',
    type: CouponType.PERCENTAGE,
    value: 20,
    maxDiscountAmount: 10000,
    minOrderAmount: 15000,
    firstOrderOnly: true,
  },
  {
    code: 'ENVIOGRATIS',
    title: 'Envío gratis',
    description: 'No pagas el domicilio en pedidos desde $25.000.',
    type: CouponType.FREE_DELIVERY,
    value: 0,
    minOrderAmount: 25000,
    perUserLimit: 3,
    scope: CouponScope.DELIVERY,
  },
  {
    code: 'AHORRA5',
    title: 'Ahorra $5.000',
    description: '$5.000 de descuento en pedidos desde $30.000.',
    type: CouponType.FIXED,
    value: 5000,
    minOrderAmount: 30000,
    usageLimit: 100,
  },
  {
    code: 'BURGER15',
    title: '15 % en Burger House',
    description: '15 % de descuento, hasta $8.000, solo en Burger House.',
    type: CouponType.PERCENTAGE,
    value: 15,
    maxDiscountAmount: 8000,
    businessName: 'Burger House',
    fundedBy: CouponFundedBy.BUSINESS,
    scope: CouponScope.PRODUCT,
  },
  {
    code: 'EXPIRADO',
    title: 'Promoción vencida',
    description: 'Vencido a propósito: sirve para comprobar que el checkout lo rechaza.',
    type: CouponType.FIXED,
    value: 5000,
    expired: true,
  },
];

/** Las dos direcciones guardadas del primer cliente, según el README. */
const CLIENT_ADDRESSES = [
  {
    label: 'Casa',
    address: 'Calle 5 # 14-22, Barrio Centro',
    details: 'Casa esquinera, portón blanco',
    isDefault: true,
    offset: 1,
  },
  {
    label: 'Trabajo',
    address: 'Cra 11 # 7-40, Oficina 302',
    details: 'Edificio Almendros, tercer piso',
    isDefault: false,
    offset: 2,
  },
];

export interface CatalogReport {
  businesses: number;
  categories: number;
  products: number;
  coupons: number;
  addresses: number;
}

/**
 * Siembra el catálogo. Asume una base recién limpiada por `seed.ts`, así
 * que crea sin comprobar duplicados — el `deleteMany` de arriba ya dejó el
 * terreno vacío y una comprobación aquí solo escondería un fallo en él.
 */
export async function seedCatalog(): Promise<CatalogReport> {
  const report: CatalogReport = {
    businesses: 0,
    categories: 0,
    products: 0,
    coupons: 0,
    addresses: 0,
  };

  const admin = await User.findOne({ email: 'admin@zipp.co' }).select('_id');
  const byName = new Map<string, Types.ObjectId>();

  for (const [index, spec] of BUSINESSES.entries()) {
    const owner = await User.findOne({ phone: spec.ownerPhone }).select('_id');
    if (!owner) {
      // No se inventa un dueño: si falta, es que `seed.ts` cambió y el
      // README ya no describe lo que hay. Mejor decirlo que sembrar un
      // comercio huérfano que nadie puede administrar.
      console.warn(
        `⚠️  No existe el dueño ${spec.ownerPhone}; se omite "${spec.name}".`
      );
      continue;
    }

    const point = nearby(index);
    const business = await Business.create({
      ownerId: owner._id,
      name: spec.name,
      description: spec.description,
      category: spec.category,
      address: spec.address,
      location: { type: 'Point', coordinates: [point.lng, point.lat] },
      phone: spec.phone,
      deliveryTime: spec.deliveryTime,
      minOrder: spec.minOrder,
      isActive: true,
      isApproved: true,
      approvedAt: new Date(),
      approvedBy: admin?._id ?? null,
    });
    byName.set(spec.name, business._id as Types.ObjectId);
    report.businesses += 1;

    for (const [order, cat] of spec.categories.entries()) {
      const category = await Category.create({
        businessId: business._id,
        name: cat.name,
        sortOrder: order,
        isActive: true,
      });
      report.categories += 1;

      for (const p of cat.products) {
        await Product.create({
          businessId: business._id,
          categoryId: category._id,
          name: p.name,
          description: p.description,
          price: p.price,
          discountPrice: p.discountPrice ?? null,
          extras: p.extras ?? [],
          isAvailable: true,
        });
        report.products += 1;
      }
    }
  }

  const now = Date.now();
  for (const spec of COUPONS) {
    const businessId = spec.businessName ? byName.get(spec.businessName) ?? null : null;
    if (spec.businessName && !businessId) {
      console.warn(`⚠️  "${spec.businessName}" no se sembró; se omite el cupón ${spec.code}.`);
      continue;
    }

    await Coupon.create({
      code: spec.code,
      title: spec.title,
      description: spec.description,
      type: spec.type,
      value: spec.value,
      maxDiscountAmount: spec.maxDiscountAmount ?? 0,
      minOrderAmount: spec.minOrderAmount ?? 0,
      // El vencido arranca y termina en el pasado; el resto vale un mes.
      validFrom: new Date(now - (spec.expired ? 60 : 1) * 24 * 3600_000),
      validUntil: new Date(now + (spec.expired ? -1 : 30) * 24 * 3600_000),
      usageLimit: spec.usageLimit ?? 0,
      perUserLimit: spec.perUserLimit ?? 0,
      firstOrderOnly: spec.firstOrderOnly ?? false,
      businessId,
      fundedBy: spec.fundedBy ?? CouponFundedBy.PLATFORM,
      scope: spec.scope ?? CouponScope.PRODUCT,
      // Público salvo el vencido: no tiene sentido enseñarlo en el carrusel
      // de promociones de la app.
      isPublic: !spec.expired,
      isActive: true,
      campaignApproved: true,
    });
    report.coupons += 1;
  }

  const client = await User.findOne({ phone: '3101234567' }).select('_id');
  if (client) {
    for (const spec of CLIENT_ADDRESSES) {
      const point = nearby(spec.offset);
      await Address.create({
        userId: client._id,
        label: spec.label,
        address: spec.address,
        details: spec.details,
        location: { type: 'Point', coordinates: [point.lng, point.lat] },
        isDefault: spec.isDefault,
      });
      report.addresses += 1;
    }
  }

  return report;
}
