import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Business, BusinessStaff, BusinessRole, Order } from '../models';
import { UserRole } from '../types';
import { orderService } from '../services/order.service';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, authHeader, GARZON, offsetKm } from './factories';

/**
 * La lista de pedidos programados del comercio: los que esperan su hora.
 *
 * `getByBusiness` los esconde de la cocina hasta que se activan; esta lista
 * es la otra mitad, para que el comercio vea lo que viene y planifique.
 */

const DESTINATION = offsetKm(GARZON, 2);
const OPEN_ALL_DAY = { open: '00:00', close: '00:00', isOpen: true };

let owner: any;
let business: any;
let product: any;
let client: any;

const place = (extra: Record<string, unknown> = {}) =>
  orderService.create({
    clientId: client._id.toString(),
    businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }],
    paymentMethod: 'cash_on_delivery',
    deliveryAddress: 'Calle 5 # 3-21',
    deliveryLatitude: DESTINATION.lat,
    deliveryLongitude: DESTINATION.lng,
    ...extra,
  } as never);

const hoursAhead = (h: number) => new Date(Date.now() + h * 3_600_000);
const scheduled = async (user: any, id = business._id) =>
  request(app).get(`/api/v1/orders/business/${id}/scheduled`).set(await authHeader(user));

beforeEach(async () => {
  await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
  owner = await makeUser({ role: UserRole.BUSINESS });
  business = await makeBusiness(owner._id);
  await Business.updateOne(
    { _id: business._id },
    {
      schedule: Object.fromEntries(
        ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [d, OPEN_ALL_DAY])
      ),
    }
  );
  product = await makeProduct(business._id, { price: 20000 });
  client = await makeUser({ role: UserRole.CLIENT });
});

describe('Pedidos programados del comercio', () => {
  it('lista solo los que esperan su hora, del más próximo al más lejano', async () => {
    const far = await place({ scheduledFor: hoursAhead(30) });
    const near = await place({ scheduledFor: hoursAhead(5) });
    await place(); // inmediato: no es programado

    const res = await scheduled(owner);
    expect(res.status).toBe(200);
    expect(res.body.data.map((o: any) => o._id)).toEqual([near._id.toString(), far._id.toString()]);
  });

  it('un programado ya activado pasa al tablero y sale de la lista', async () => {
    const order = await place({ scheduledFor: hoursAhead(5) });
    await Order.updateOne({ _id: order._id }, { scheduledActivatedAt: new Date() });
    expect((await scheduled(owner)).body.data).toHaveLength(0);
  });

  it('no mezcla pedidos de otro negocio', async () => {
    await place({ scheduledFor: hoursAhead(5) });
    const otherOwner = await makeUser({ role: UserRole.BUSINESS });
    const other = await makeBusiness(otherOwner._id);
    expect((await scheduled(otherOwner, other._id)).body.data).toHaveLength(0);
  });

  it('el empleado la ve sin el dinero interno; un ajeno recibe 403', async () => {
    await place({ scheduledFor: hoursAhead(5) });
    const employee = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: business._id, userId: employee._id, role: BusinessRole.EMPLOYEE, isActive: true });

    const res = await scheduled(employee);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].platformCommission).toBeUndefined();
    expect(res.body.data[0].businessPayout).toBeUndefined();

    const stranger = await makeUser({ role: UserRole.BUSINESS });
    expect((await scheduled(stranger)).status).toBe(403);
  });
});
