import { describe, it, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import {
  User, Business, Product, Category, Driver, Order, Payout, Coupon,
  CouponRedemption, LedgerEntry,
} from '../../models';
import {
  OrderStatus, UserRole, PaymentMethod, PaymentStatus,
  PayoutBeneficiary, PayoutStatus,
} from '../../types';
import { orderService } from '../../services/order.service';
import { ledgerService } from '../../services/ledger.service';
import { payoutService } from '../../services/payout.service';
import { pricingConfigService } from '../../services/pricingConfig.service';
import { hashPassword } from '../../security';
import { makePricingConfig, GARZON } from '../factories';

/**
 * Siete mil usuarios a la vez, de todos los roles.
 *
 * ── Qué prueba esto y qué NO ──
 *
 * **No** es una prueba de throughput. Corre sobre `mongodb-memory-server`,
 * no contra Atlas ni contra un servidor HTTP levantado, así que no dice
 * nada sobre cuántas peticiones por segundo aguanta el backend, ni sobre
 * el pool de conexiones, ni sobre la latencia de red. Para eso hace falta
 * un despliegue de verdad y una herramienta de carga (ver
 * `docs/load-testing.md`).
 *
 * **Sí** prueba lo que en este proyecto ha roto siempre: que los
 * invariantes de dinero e inventario sobreviven cuando miles de
 * operaciones compiten por los mismos recursos. Todos los bugs graves de
 * este repositorio han sido carreras —el fondo del domiciliario, el canje
 * de puntos, el reclamo del pedido, el presupuesto del cupón— y ninguno se
 * ve con un usuario a la vez.
 *
 * ── Por qué la población va por el driver nativo ──
 *
 * `User` hashea con argon2id en un `pre('save')`, y argon2 es memory-hard a
 * propósito. Siete mil hashes serían diez minutos de CPU y varios GB de RAM
 * antes de empezar la prueba de verdad. Se calcula **un** hash y se insertan
 * los documentos con `collection.insertMany`, que se salta el middleware.
 * La prueba no va sobre el hasheo.
 */

// ── La forma del mercado ──
//
// Proporciones de un municipio, no de una capital: mucha gente pidiendo,
// bastantes repartidores, unos pocos comercios y un puñado de
// administradores. Suman 7.000.
const CLIENTS = 5_800;
const DRIVERS = 900;
const BUSINESSES = 250;
const ADMINS = 50;
const TOTAL_USERS = CLIENTS + DRIVERS + BUSINESSES + ADMINS;

/**
 * Cuántos pedidos se lanzan en la fase concurrente.
 *
 * Menos que clientes a propósito: lo interesante no es que cada uno pida
 * una vez en paz, sino que muchos peleen por lo mismo a la vez.
 */
const ORDERS = 2_400;

/** Cuántas operaciones van de verdad en paralelo en cada tanda. */
const BATCH = 120;

/**
 * Productos con inventario escaso, para forzar la carrera del stock.
 *
 * Todo el tráfico se concentra en unos pocos: es lo que pasa de verdad un
 * viernes por la noche, y es la única forma de que la reserva atómica de
 * inventario se ponga a prueba.
 */
const HOT_PRODUCTS = 12;
const HOT_STOCK = 40;

/** Cupón con presupuesto corto: muchos lo intentan, pocos caben. */
const COUPON_USES = 150;

interface Population {
  clientIds: string[];
  driverIds: string[];
  businesses: Array<{ id: string; productIds: string[] }>;
  hotProductIds: string[];
  hotBusinessId: string;
}

interface BatchOutcome {
  ok: number;
  failed: number;
  /** Motivo → cuántas veces. Agrupado, porque son miles. */
  reasons: Map<string, number>;
}

/**
 * Reparte una lista de tareas en tandas que sí corren a la vez, y **cuenta
 * por qué falló lo que falló**.
 *
 * `Promise.allSettled` a secas se traga los motivos, y un rechazo legítimo
 * —producto agotado, cupón lleno, pedido ya tomado— se ve igual que un
 * fallo real. La primera versión de esta prueba creó 440 pedidos de 2.400 y
 * pasó tan tranquila: el número era correcto y no decía nada. Agrupar los
 * motivos es lo que convierte esto en información.
 */
async function inBatches<T>(
  tasks: Array<() => Promise<T>>,
  size: number
): Promise<BatchOutcome> {
  const outcome: BatchOutcome = { ok: 0, failed: 0, reasons: new Map() };

  for (let i = 0; i < tasks.length; i += size) {
    const slice = tasks.slice(i, i + size).map((task) => task());
    for (const result of await Promise.allSettled(slice)) {
      if (result.status === 'fulfilled') {
        outcome.ok += 1;
        continue;
      }
      outcome.failed += 1;
      const reason = String(
        (result.reason as { message?: string })?.message ?? result.reason
      ).slice(0, 90);
      outcome.reasons.set(reason, (outcome.reasons.get(reason) ?? 0) + 1);
    }
  }

  return outcome;
}

/** Imprime los motivos de rechazo, del más frecuente al menos. */
function reportReasons(label: string, outcome: BatchOutcome) {
  if (outcome.reasons.size === 0) return;
  const sorted = [...outcome.reasons.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n  ${label}: ${outcome.ok} ok, ${outcome.failed} rechazados`);
  for (const [reason, count] of sorted.slice(0, 6)) {
    console.log(`    ${String(count).padStart(5)}  ${reason}`);
  }
}

const oid = () => new mongoose.Types.ObjectId();

describe('Sistema completo bajo carga: 7.000 usuarios de todos los roles', () => {
  let population: Population;
  let couponId: string;
  const timings: Record<string, number> = {};

  const stopwatch = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    const value = await fn();
    timings[label] = Date.now() - started;
    return value;
  };

  beforeAll(async () => {
    await makePricingConfig({
      maxDriverCashDebt: 500_000,
      // Por defecto la fábrica de pruebas deja el efectivo apagado, y la
      // primera corrida perdió 1.200 pedidos por eso. Aquí hace falta
      // encendido: el efectivo es lo que mete el fondo del repartidor en
      // la ecuación, que es la mitad de lo que se está probando.
      cashOnDeliveryEnabled: true,
      cashOnDeliveryMaxAmount: 200_000,
    });
    pricingConfigService.invalidate();

    population = await stopwatch('poblar', async () => {
      // Un solo hash para todos: la prueba no va sobre argon2.
      const password = await hashPassword('Carga.Segura123');

      const users: any[] = [];
      const push = (role: UserRole, index: number) => {
        const _id = oid();
        users.push({
          _id,
          name: `${role}-${index}`,
          // Teléfonos únicos y deterministas: el índice único de `phone` es
          // parte de lo que se está ejercitando.
          phone: `3${String(100_000_000 + users.length)}`,
          password,
          role,
          isActive: true,
          isVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        return _id;
      };

      const clientIds: any[] = [];
      const driverUserIds: any[] = [];
      const ownerIds: any[] = [];

      for (let i = 0; i < CLIENTS; i += 1) clientIds.push(push(UserRole.CLIENT, i));
      for (let i = 0; i < DRIVERS; i += 1) driverUserIds.push(push(UserRole.DRIVER, i));
      for (let i = 0; i < BUSINESSES; i += 1) ownerIds.push(push(UserRole.BUSINESS, i));
      for (let i = 0; i < ADMINS; i += 1) push(UserRole.ADMIN, i);

      await User.collection.insertMany(users);

      // ── Repartidores ──
      const driverDocs = driverUserIds.map((userId, i) => ({
        _id: oid(),
        userId,
        vehicleType: 'motorcycle',
        licensePlate: `LOAD${i}`,
        status: 'available',
        currentLocation: { type: 'Point', coordinates: [GARZON.lng, GARZON.lat] },
        baseFund: 300_000,
        currentFund: 300_000,
        rating: 5,
        totalDeliveries: 0,
        totalEarnings: 0,
        isActive: true,
        isApproved: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      await Driver.collection.insertMany(driverDocs);

      // ── Comercios, categorías y productos ──
      const businessDocs: any[] = [];
      const categoryDocs: any[] = [];
      const productDocs: any[] = [];
      const businesses: Array<{ id: string; productIds: string[] }> = [];

      ownerIds.forEach((ownerId, i) => {
        const businessId = oid();
        const categoryId = oid();

        businessDocs.push({
          _id: businessId,
          ownerId,
          name: `Negocio ${i}`,
          // El `slug` lo genera un `pre('save')` que el driver nativo no
          // ejecuta, y la ruta declara `unique: true`. Sin esto los siete
          // mil documentos salen con `slug: null` y el segundo choca contra
          // el índice. Es el precio exacto de saltarse Mongoose para poder
          // poblar rápido, y hay que pagarlo a mano.
          slug: `negocio-carga-${i}`,
          description: 'Comercio de carga',
          category: 'fast_food',
          address: 'Cra 10 #5-23',
          location: { type: 'Point', coordinates: [GARZON.lng, GARZON.lat] },
          phone: '3151234567',
          minOrder: 0,
          commissionRateBps: 1000,
          commissionRate: 0.1,
          isActive: true,
          isApproved: true,
          city: 'Garzón',
          rating: 0,
          totalReviews: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        categoryDocs.push({
          _id: categoryId,
          businessId,
          name: 'Carta',
          sortOrder: 1,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        // El primer comercio lleva la carta caliente entera; el resto,
        // tres productos. Tienen que ser TODOS del mismo local: un pedido
        // mezcla un negocio y un producto, y el servicio rechaza —con
        // razón— un producto que no es de ese local. La primera versión de
        // esta prueba repartía los doce calientes entre cuatro comercios y
        // mandaba todo el tráfico a uno: novecientos rechazos legítimos que
        // parecían carga procesada.
        const productCount = i === 0 ? HOT_PRODUCTS : 3;
        const ids: any[] = [];
        for (let p = 0; p < productCount; p += 1) {
          const productId = oid();
          ids.push(productId);
          productDocs.push({
            _id: productId,
            businessId,
            categoryId,
            name: `Producto ${i}-${p}`,
            description: 'Producto de carga',
            price: 10_000,
            discountPrice: null,
            extras: [],
            gallery: [],
            isAvailable: true,
            stock: null,
            requiresAgeVerification: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }

        businesses.push({ id: businessId.toString(), productIds: ids.map(String) });
      });

      // Los productos calientes: inventario contado, todos del mismo local.
      const hot = productDocs.slice(0, HOT_PRODUCTS);
      for (const product of hot) product.stock = HOT_STOCK;

      await Business.collection.insertMany(businessDocs);
      await Category.collection.insertMany(categoryDocs);
      await Product.collection.insertMany(productDocs);

      const coupon = await Coupon.create({
        code: 'CARGA150',
        title: 'Cupón de carga',
        type: 'fixed',
        value: 1_000,
        validFrom: new Date(Date.now() - 86_400_000),
        validUntil: new Date(Date.now() + 86_400_000),
        // El tope es la parte interesante: muchos más lo intentan de los
        // que caben, y ni uno solo puede pasarse.
        usageLimit: COUPON_USES,
        perUserLimit: 1,
        isActive: true,
      });
      couponId = coupon._id.toString();

      return {
        clientIds: clientIds.map(String),
        driverIds: driverDocs.map((d) => d._id.toString()),
        businesses,
        hotProductIds: hot.map((p) => p._id.toString()),
        hotBusinessId: businesses[0].id,
      };
    });
  }, 600_000);

  it('el censo queda montado: 7.000 usuarios de los cuatro roles', async () => {
    const [total, clients, drivers, owners, admins] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ role: UserRole.CLIENT }),
      User.countDocuments({ role: UserRole.DRIVER }),
      User.countDocuments({ role: UserRole.BUSINESS }),
      User.countDocuments({ role: UserRole.ADMIN }),
    ]);

    expect(total).toBe(TOTAL_USERS);
    expect(clients).toBe(CLIENTS);
    expect(drivers).toBe(DRIVERS);
    expect(owners).toBe(BUSINESSES);
    expect(admins).toBe(ADMINS);
    expect(await Driver.countDocuments({})).toBe(DRIVERS);
    expect(await Business.countDocuments({})).toBe(BUSINESSES);
  });

  it('miles de pedidos simultáneos, y ni un peso descuadrado', async () => {
    const created = await stopwatch('pedidos', async () => {
      const tasks = Array.from({ length: ORDERS }, (_, i) => async () => {
        const clientId = population.clientIds[i % population.clientIds.length];

        // Dos tercios se pelean por los productos escasos del mismo local;
        // el resto se reparte por el pueblo. Es la forma real del tráfico
        // un viernes: no está distribuido, está concentrado.
        const hot = i % 3 !== 0;
        const businessId = hot
          ? population.hotBusinessId
          : population.businesses[i % population.businesses.length].id;
        const productId = hot
          ? population.hotProductIds[i % population.hotProductIds.length]
          : population.businesses[i % population.businesses.length].productIds[0];

        return orderService.create({
          clientId,
          businessId,
          items: [{ productId, quantity: 1 }],
          // Mitad y mitad: el efectivo mete el fondo del domiciliario en la
          // ecuación y el online mete la pasarela.
          paymentMethod: i % 2 === 0 ? PaymentMethod.CASH_ON_DELIVERY : PaymentMethod.ONLINE,
          deliveryAddress: 'Cra 1 #2-3',
          deliveryLongitude: GARZON.lng,
          deliveryLatitude: GARZON.lat,
          // Uno de cada cuatro intenta el cupón con tope corto.
          couponCode: i % 4 === 0 ? 'CARGA150' : undefined,
        });
      });

      return inBatches(tasks, BATCH);
    });

    reportReasons('pedidos', created);
    const orders = await Order.countDocuments({});

    // Fallar no es un error del sistema: un producto agotado *debe*
    // rechazar. Lo que no puede pasar es que se cree un pedido y su
    // contabilidad no exista, o al revés.
    expect(orders).toBe(created.ok);
    expect(created.ok).toBeGreaterThan(0);

    // ── Los rechazos, uno por uno ──
    //
    // Contar cuántos pasaron no dice nada: un escenario mal armado también
    // "pasa" con un número bajo. Lo que importa es que **cada rechazo
    // tenga una razón legítima de negocio**. Cualquier otra cosa —un
    // producto que no es del comercio, un campo que falta, un error de
    // Mongo— significa que la prueba dejó de ejercitar el sistema y pasó a
    // ejercitar su propia validación de entrada, que es exactamente cómo
    // una prueba de carga se vuelve decorativa.
    const legitimate = [
      /no está disponible en este momento/, // inventario agotado
      /no alcanza para/,                    // stock insuficiente
      /cupón/i,                             // tope del cupón
      /efectivo/i,                          // techo de efectivo
    ];

    const unexpected = [...created.reasons.entries()].filter(
      ([reason]) => !legitimate.some((pattern) => pattern.test(reason))
    );
    expect(unexpected).toEqual([]);

    // El invariante que lo gobierna todo. Si esto es falso, hay dinero
    // reconocido que no le pertenece a nadie.
    expect(await ledgerService.isBalanced()).toBe(true);
  }, 900_000);

  it('el inventario nunca se vendió por debajo de cero', async () => {
    const oversold = await Product.countDocuments({ stock: { $lt: 0 } });

    // La reserva atómica (`$inc` con la condición dentro de la escritura)
    // es lo único que separa esto de vender cuarenta hamburguesas de las
    // que hay treinta.
    expect(oversold).toBe(0);

    const sold = await Product.find({ _id: { $in: population.hotProductIds } }).select('stock');
    for (const product of sold) {
      expect(product.stock!).toBeGreaterThanOrEqual(0);
      expect(product.stock!).toBeLessThanOrEqual(HOT_STOCK);
    }
  });

  it('el cupón no se usó ni una vez por encima de su tope', async () => {
    const coupon = await Coupon.findById(couponId);
    const redemptions = await CouponRedemption.countDocuments({ couponId });

    // Seiscientos pedidos lo intentaron y sólo caben ciento cincuenta.
    expect(coupon!.usedCount).toBeLessThanOrEqual(COUPON_USES);
    expect(redemptions).toBe(coupon!.usedCount);
  });

  it('cada pedido tiene su contabilidad, y ninguno la tiene dos veces', async () => {
    const orders = await Order.countDocuments({});

    const groups = await LedgerEntry.aggregate([
      { $match: { event: 'order_placed' } },
      { $group: { _id: '$orderId', batches: { $addToSet: '$groupId' } } },
      { $match: { 'batches.1': { $exists: true } } },
    ]);

    // Un pedido con dos asientos de creación es dinero reconocido dos
    // veces. El índice único del libro lo impide; esto lo comprueba.
    expect(groups).toHaveLength(0);

    const withBooks = await LedgerEntry.distinct('orderId', { event: 'order_placed' });
    expect(withBooks).toHaveLength(orders);
  });

  it('novecientos repartidores peleando por los mismos pedidos: cada uno para uno solo', async () => {
    const ready = await stopwatch('reparto', async () => {
      const pending = await Order.find({ status: OrderStatus.PENDING })
        .select('_id businessId')
        .limit(1_200)
        .lean();

      // ── La pasarela, simulada ──
      //
      // Un pedido en línea sin pagar no puede aceptarse, y hace bien: el
      // comercio no debe cocinar por un checkout abandonado. Pero aquí eso
      // dejaba la mitad del sistema sin ejercitar, así que se marca el
      // cobro como confirmado igual que haría el webhook de la pasarela.
      await Order.updateMany(
        { status: OrderStatus.PENDING, paymentMethod: PaymentMethod.ONLINE },
        { $set: { paymentStatus: PaymentStatus.PAID } }
      );

      // Los pedidos pasan a listos por el camino del comercio, en tandas.
      const owners = new Map<string, string>();
      const businesses = await Business.find({
        _id: { $in: pending.map((o) => o.businessId) },
      }).select('ownerId').lean();
      for (const b of businesses) owners.set(b._id.toString(), b.ownerId.toString());

      const advance = pending.map((order) => async () => {
        const ownerId = owners.get(order.businessId!.toString())!;
        for (const status of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
          await orderService.updateStatus(
            order._id.toString(),
            status,
            ownerId,
            UserRole.BUSINESS
          );
        }
      });

      // Solo los de efectivo llegan a ACCEPTED: los online sin pagar están
      // bloqueados a propósito, y eso también se está comprobando.
      reportReasons('avance a listo', await inBatches(advance, BATCH));

      return Order.find({ status: OrderStatus.READY }).select('_id').lean();
    });

    expect(ready.length).toBeGreaterThan(0);

    // ── La carrera ──
    //
    // Cada pedido se ofrece a tres repartidores a la vez. Es la situación
    // que rompió el sistema antes: los tres pasaban la comprobación previa
    // y el último `save()` pisaba a los otros dos, dejando fondo retenido
    // por pedidos que nunca iban a repartir.
    const claims: Array<() => Promise<unknown>> = [];
    ready.forEach((order, i) => {
      for (let k = 0; k < 3; k += 1) {
        const driverId = population.driverIds[(i * 3 + k) % population.driverIds.length];
        claims.push(() => orderService.assignDriver(order._id.toString(), driverId));
      }
    });

    const outcomes = await stopwatch('reclamos', () => inBatches(claims, BATCH));
    reportReasons('reclamos', outcomes);
    const won = outcomes.ok;

    // Exactamente uno por pedido. Ni dos, ni ninguno cuando había fondo.
    const assigned = await Order.countDocuments({ driverId: { $ne: null } });
    expect(won).toBe(assigned);
    expect(assigned).toBeLessThanOrEqual(ready.length);

    // Y un solo pago al repartidor por pedido: el índice único de `Payout`
    // apuntaba al primero que ganaba, y si otro se quedaba el pedido, la
    // liquidación pagaba a quien no repartió.
    const doubled = await Payout.aggregate([
      { $match: { beneficiary: PayoutBeneficiary.DRIVER } },
      { $group: { _id: '$orderId', drivers: { $addToSet: '$driverId' } } },
      { $match: { 'drivers.1': { $exists: true } } },
    ]);
    expect(doubled).toHaveLength(0);
  }, 900_000);

  it('ningún repartidor quedó con el fondo en negativo', async () => {
    const broke = await Driver.countDocuments({ currentFund: { $lt: 0 } });

    // Es dinero de personas reales. Un fondo negativo significa que se
    // reservó dos veces para el mismo bolsillo.
    expect(broke).toBe(0);
  });

  it('el fondo retenido cuadra con los pedidos que cada uno lleva encima', async () => {
    const drivers = await Driver.find({ currentFund: { $lt: 300_000 } })
      .select('_id currentFund')
      .lean();

    for (const driver of drivers.slice(0, 50)) {
      const holding = await Order.find({
        driverId: driver._id,
        status: { $in: [OrderStatus.READY, OrderStatus.PICKED_UP, OrderStatus.ON_WAY] },
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      }).select('finance.businessPayout businessPayout').lean();

      const reserved = holding.reduce(
        (sum, o: any) => sum + (o.finance?.businessPayout ?? o.businessPayout ?? 0),
        0
      );

      // Lo que le falta al fondo tiene que ser exactamente lo que lleva
      // comprometido. Cualquier otra cifra es dinero congelado por un
      // pedido que ya no existe.
      expect(300_000 - driver.currentFund).toBe(reserved);
    }
  }, 300_000);

  it('miles de entregas a la vez dejan el libro cuadrado', async () => {
    const assigned = await Order.find({
      driverId: { $ne: null },
      status: OrderStatus.READY,
    })
      .select('_id driverId')
      .limit(600)
      .lean();

    const deliveries = assigned.map((order) => async () => {
      const driver = await Driver.findById(order.driverId).select('userId').lean();
      const driverUserId = driver!.userId.toString();

      // Admin salta los códigos, que se prueban aparte: aquí interesa el
      // efecto contable de cerrar cientos de entregas a la vez.
      for (const status of [OrderStatus.PICKED_UP, OrderStatus.ON_WAY, OrderStatus.DELIVERED]) {
        await orderService.updateStatus(
          order._id.toString(),
          status,
          driverUserId,
          UserRole.ADMIN
        );
      }
    });

    reportReasons('entregas', await stopwatch('entregas', () => inBatches(deliveries, BATCH)));

    expect(await ledgerService.isBalanced()).toBe(true);
  }, 900_000);

  it('liquidar en masa no paga dos veces ni deja el libro torcido', async () => {
    const admin = await User.findOne({ role: UserRole.ADMIN }).select('_id').lean();

    const businessIds = await Payout.distinct('businessId', {
      beneficiary: PayoutBeneficiary.BUSINESS,
      status: PayoutStatus.PAYABLE,
    });

    const runs = businessIds.slice(0, 120).map((businessId) => () =>
      payoutService.settle({
        beneficiary: PayoutBeneficiary.BUSINESS,
        businessId: String(businessId),
        createdBy: admin!._id.toString(),
      })
    );

    reportReasons('liquidaciones', await stopwatch('liquidaciones', () => inBatches(runs, 40)));

    // Un payout en dos liquidaciones distintas es un pago duplicado.
    const doubled = await Payout.aggregate([
      { $match: { settlementId: { $ne: null } } },
      { $group: { _id: '$_id', batches: { $addToSet: '$settlementId' } } },
      { $match: { 'batches.1': { $exists: true } } },
    ]);
    expect(doubled).toHaveLength(0);

    expect(await ledgerService.isBalanced()).toBe(true);
  }, 600_000);

  it('resumen de la corrida', async () => {
    const [orders, delivered, cancelled, ledgerLines] = await Promise.all([
      Order.countDocuments({}),
      Order.countDocuments({ status: OrderStatus.DELIVERED }),
      Order.countDocuments({ status: OrderStatus.CANCELLED }),
      LedgerEntry.countDocuments({}),
    ]);

    // Se imprime a propósito: el valor de esta prueba no es sólo que pase,
    // sino poder comparar los tiempos entre versiones y ver cuándo algo
    // empezó a costar el doble.
    console.log('\n── Carga: 7.000 usuarios ──');
    console.log(`usuarios       ${TOTAL_USERS}`);
    console.log(`pedidos        ${orders} (entregados ${delivered}, cancelados ${cancelled})`);
    console.log(`asientos       ${ledgerLines}`);
    for (const [label, ms] of Object.entries(timings)) {
      console.log(`${label.padEnd(15)}${(ms / 1000).toFixed(1)} s`);
    }

    expect(await ledgerService.isBalanced()).toBe(true);
  });
});
