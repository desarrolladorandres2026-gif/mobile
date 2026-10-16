import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as emitter from '../sockets/emitter';
import { orderService } from '../services/order.service';
import { businessService } from '../services/business.service';
import { Product } from '../models';
import { PaymentMethod, UserRole } from '../types';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON, offsetKm } from './factories';

const DESTINATION = offsetKm(GARZON, 1);
const CLOSED_ALL_WEEK = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [
    d,
    { open: '08:00', close: '22:00', isOpen: false },
  ])
);

/**
 * El horario del negocio se aplica en el servidor a los pedidos inmediatos,
 * no solo en la app: una versión vieja o una llamada directa a la API no
 * puede pedirle a un local que ya cerró.
 */
describe('Horario del negocio en pedidos inmediatos', () => {
  let client: any;
  let owner: any;
  let ioSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
    client = await makeUser();
    owner = await makeUser({ role: UserRole.BUSINESS });
    const chain = (): any => ({ to: () => chain(), except: () => chain(), emit: () => true });
    ioSpy = vi.spyOn(emitter, 'getIO').mockReturnValue(chain());
  });

  afterEach(() => {
    vi.useRealTimers();
    ioSpy.mockRestore();
  });

  const orderFor = async (business: any) => {
    const product = await makeProduct(business._id, { price: 30000 });
    await Product.updateOne({ _id: product._id }, { stock: 10 });
    return orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      cashPayment: { needsChange: false },
      deliveryAddress: 'Cra 10 #5-23',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    } as never);
  };

  it('abierto las 24 h: el pedido entra', async () => {
    const business = await makeBusiness(owner._id);
    await expect(orderFor(business)).resolves.toBeTruthy();
  });

  it('el día marcado como cerrado rechaza el pedido con STORE_CLOSED_NOW', async () => {
    const business = await makeBusiness(owner._id, { schedule: CLOSED_ALL_WEEK });
    await expect(orderFor(business)).rejects.toMatchObject({ statusCode: 409, code: 'STORE_CLOSED_NOW' });
  });

  it('fuera de la franja del día: rechaza; dentro: acepta (hora de Colombia)', async () => {
    const all = (open: string, close: string) =>
      Object.fromEntries(
        ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [
          d,
          { open, close, isOpen: true },
        ])
      );
    const business = await makeBusiness(owner._id, { schedule: all('08:00', '22:00') });

    vi.useFakeTimers({ toFake: ['Date'] });
    // 03:00 en Colombia (UTC-5) = 08:00 UTC.
    vi.setSystemTime(new Date('2026-10-14T08:00:00Z'));
    await expect(orderFor(business)).rejects.toMatchObject({ code: 'STORE_CLOSED_NOW' });

    // 12:00 en Colombia = 17:00 UTC.
    vi.setSystemTime(new Date('2026-10-14T17:00:00Z'));
    await expect(orderFor(business)).resolves.toBeTruthy();
  });

  it('un cierre pasada la medianoche cuenta como abierto a la 1 a. m.', async () => {
    const all = Object.fromEntries(
      ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [
        d,
        { open: '18:00', close: '02:00', isOpen: true },
      ])
    );
    const business = await makeBusiness(owner._id, { schedule: all });
    vi.useFakeTimers({ toFake: ['Date'] });
    // 01:00 en Colombia = 06:00 UTC.
    vi.setSystemTime(new Date('2026-10-14T06:00:00Z'));
    await expect(orderFor(business)).resolves.toBeTruthy();
  });

  it('isCurrentlyOpen usa la zona de Colombia y entiende la medianoche', async () => {
    const business = await makeBusiness(owner._id, {
      schedule: Object.fromEntries(
        ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [
          d,
          { open: '18:00', close: '02:00', isOpen: true },
        ])
      ),
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T06:00:00Z')); // 01:00 Colombia
    expect(businessService.isCurrentlyOpen(business as never)).toBe(true);
    vi.setSystemTime(new Date('2026-10-14T17:00:00Z')); // 12:00 Colombia
    expect(businessService.isCurrentlyOpen(business as never)).toBe(false);
  });
});
