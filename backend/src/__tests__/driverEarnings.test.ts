import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Order } from '../models';
import { UserRole, OrderStatus, PaymentMethod } from '../types';
import { authHeader, makeUser, makeDriver, makeBusiness, GARZON } from './factories';
import { driverService } from '../services/driver.service';

/**
 * El historial de ganancias.
 *
 * `getDailyEarnings` contestaba "cuánto llevo hoy" y era lo único que
 * había: el endpoint aceptaba una fecha desde siempre y la app nunca se la
 * pasó. La pregunta que faltaba es la otra —"¿me compensa este trabajo?"—
 * y solo se puede contestar mirando varios días juntos.
 *
 * Lo que más se prueba aquí es el reparto por día. Agrupar en UTC parece
 * inofensivo y en Colombia (-5) manda al día siguiente todo lo entregado
 * después de las siete de la tarde, que es el tramo de cena: el mejor rato
 * de la jornada contado en la jornada equivocada, sin ningún error visible.
 */

/** Un pedido entregado, con lo que el domiciliario se llevó. */
async function delivered(
  driverId: any,
  businessId: any,
  clientId: any,
  at: Date,
  { fee = 4000, tip = 0 }: { fee?: number; tip?: number } = {}
) {
  return Order.create({
    orderNumber: `ZIPP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    clientId,
    businessId,
    driverId,
    items: [],
    status: OrderStatus.DELIVERED,
    deliveredAt: at,
    paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
    deliveryAddress: 'Calle falsa 123',
    deliveryLocation: { type: 'Point', coordinates: [GARZON.lng, GARZON.lat] },
    subtotal: 20000,
    deliveryFee: fee,
    tip,
    total: 24000 + tip,
    // Los tres campos de dinero de primer nivel son obligatorios en el
    // esquema: son los que existían antes de `finance` y siguen ahí.
    platformCommission: 2000,
    businessPayout: 18000,
    driverPayout: fee + tip,
    // Y esto es lo que de verdad lee `getEarningsRange`.
    finance: { driverDeliveryPayout: fee, tip },
  });
}

/** Una fecha local a la hora indicada, N días atrás. */
function daysAgoAt(days: number, hour: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 30, 0, 0);
  return d;
}

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('Ganancias del domiciliario por rango', () => {
  let driverUser: any;
  let driver: any;
  let business: any;
  let client: any;

  beforeEach(async () => {
    driverUser = await makeUser({ role: UserRole.DRIVER });
    driver = await makeDriver(driverUser._id);
    client = await makeUser();
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
  });

  it('separa la tarifa garantizada de la propina', async () => {
    // Se reportan aparte porque se comportan distinto: la tarifa es lo que
    // Zipp debe y no la puede bajar una promoción; la propina es dinero del
    // cliente que pasa de largo. Sumarlas escondía exactamente el hueco que
    // hay que poder ver.
    await delivered(driver._id, business._id, client._id, daysAgoAt(1, 13), { fee: 4000, tip: 2000 });

    const res = await request(app)
      .get('/api/v1/drivers/earnings/range')
      .set(await authHeader(driverUser))
      .expect(200);

    expect(res.body.data.totals).toMatchObject({
      guaranteedFees: 4000,
      tips: 2000,
      total: 6000,
      orders: 1,
    });
  });

  it('cuenta una entrega de las nueve de la noche en su propio día', async () => {
    // La prueba que justifica no usar `$group` de Mongo. A las 21:30 en
    // Colombia son las 02:30 UTC del día siguiente.
    const anoche = daysAgoAt(1, 21);
    await delivered(driver._id, business._id, client._id, anoche);

    const res = await request(app)
      .get('/api/v1/drivers/earnings/range')
      .set(await authHeader(driverUser))
      .expect(200);

    const day = res.body.data.series.find((d: any) => d.date === localDay(anoche));
    expect(day?.orders).toBe(1);
  });

  it('devuelve los días en blanco, no los omite', async () => {
    // Un hueco es información: ese día no salió a trabajar. Si la serie los
    // saltara, la gráfica uniría el lunes con el miércoles y contaría otra
    // historia.
    await delivered(driver._id, business._id, client._id, daysAgoAt(2, 12));

    const res = await request(app)
      .get('/api/v1/drivers/earnings/range')
      .set(await authHeader(driverUser))
      .expect(200);

    expect(res.body.data.series).toHaveLength(7);
    expect(res.body.data.series.filter((d: any) => d.orders === 0)).toHaveLength(6);
  });

  it('promedia sobre los días trabajados, no sobre los del calendario', async () => {
    // Un domingo libre no es un domingo malo. Dividir entre siete cuando se
    // trabajaron dos días mentiría a la baja sobre lo que rinde el trabajo.
    await delivered(driver._id, business._id, client._id, daysAgoAt(1, 12), { fee: 5000 });
    await delivered(driver._id, business._id, client._id, daysAgoAt(2, 12), { fee: 5000 });

    const res = await request(app)
      .get('/api/v1/drivers/earnings/range')
      .set(await authHeader(driverUser))
      .expect(200);

    expect(res.body.data.totals.workedDays).toBe(2);
    expect(res.body.data.totals.perDay).toBe(5000);
    expect(res.body.data.totals.perOrder).toBe(5000);
  });

  it('no cuenta las entregas de otro domiciliario', async () => {
    const otro = await makeUser({ role: UserRole.DRIVER });
    const otroDriver = await makeDriver(otro._id);
    await delivered(otroDriver._id, business._id, client._id, daysAgoAt(1, 12), { fee: 9000 });

    const res = await request(app)
      .get('/api/v1/drivers/earnings/range')
      .set(await authHeader(driverUser))
      .expect(200);

    expect(res.body.data.totals.total).toBe(0);
  });

  it('rechaza un rango absurdo en vez de traerse media colección', async () => {
    await expect(
      driverService.getEarningsRange(
        driverUser._id.toString(),
        new Date('2020-01-01'),
        new Date()
      )
    ).rejects.toThrow(/no puede pasar de/i);
  });

  it('rechaza un rango al revés', async () => {
    await expect(
      driverService.getEarningsRange(
        driverUser._id.toString(),
        new Date(),
        daysAgoAt(5, 12)
      )
    ).rejects.toThrow(/al revés/i);
  });

  it('solo lo puede consultar un domiciliario', async () => {
    const cliente = await makeUser();
    await request(app)
      .get('/api/v1/drivers/earnings/range')
      .set(await authHeader(cliente))
      .expect(403);
  });
});
