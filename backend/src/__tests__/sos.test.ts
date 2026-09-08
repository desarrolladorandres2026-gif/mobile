import { describe, it, expect, beforeEach } from 'vitest';
import { SosAlert, SosStatus, Driver, Order } from '../models';
import { OrderStatus, UserRole, PaymentMethod } from '../types';
import { sosService } from '../services/sos.service';
import { orderService } from '../services/order.service';
import {
  makeUser, makeDriver, makeBusiness, makeProduct, makePricingConfig, GARZON,
} from './factories';

/**
 * Botón de pánico.
 *
 * Casi todo lo necesario ya existía —seguimiento en segundo plano, salas de
 * socket, mapa de flota—; lo que faltaba era una forma de decir "esto no es
 * un pedido, esto es una emergencia".
 *
 * La regla que gobierna estas pruebas: ante la duda, se activa. Negarle una
 * alerta a alguien que la pide es el único fallo que no se puede cometer
 * aquí, así que no hay límite de frecuencia ni comprobaciones que puedan
 * rechazarla.
 */
describe('Emergencias del domiciliario', () => {
  let driverUser: any;
  let driver: any;
  let admin: any;

  beforeEach(async () => {
    driverUser = await makeUser({ role: UserRole.DRIVER });
    driver = await makeDriver(driverUser._id);
    admin = await makeUser({ role: UserRole.ADMIN });
  });

  it('activa una alerta con la posición, que es el dato que más importa', async () => {
    const alert = await sosService.trigger(driverUser._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
      note: 'Me están siguiendo',
    });

    expect(alert.status).toBe(SosStatus.ACTIVE);
    expect(alert.location.coordinates).toEqual([GARZON.lng, GARZON.lat]);
    expect(alert.note).toBe('Me están siguiendo');
  });

  it('guarda una copia del contacto de emergencia de ese momento', async () => {
    await Driver.updateOne(
      { _id: driver._id },
      { emergencyContact: { name: 'Mi hermana', phone: '3001234567', relationship: 'hermana' } }
    );

    const alert = await sosService.trigger(driverUser._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
    });

    // Si mañana cambia el contacto, esta alerta tiene que seguir diciendo a
    // quién había que llamar hoy.
    expect(alert.emergencyContact!.phone).toBe('3001234567');

    await Driver.updateOne(
      { _id: driver._id },
      { emergencyContact: { name: 'Otro', phone: '3009999999' } }
    );
    const saved = await SosAlert.findById(alert._id);
    expect(saved!.emergencyContact!.phone).toBe('3001234567');
  });

  it('pulsar tres veces no crea tres alertas: actualiza la abierta', async () => {
    // Una persona en peligro puede pulsar varias veces. Multiplicar las
    // alertas divide la atención de quien responde.
    const first = await sosService.trigger(driverUser._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
    });

    const moved = { lat: GARZON.lat + 0.001, lng: GARZON.lng + 0.001 };
    await sosService.trigger(driverUser._id.toString(), moved);
    await sosService.trigger(driverUser._id.toString(), moved);

    expect(await SosAlert.countDocuments({ driverId: driver._id })).toBe(1);

    const saved = await SosAlert.findById(first._id);
    expect(saved!.location.coordinates[1]).toBeCloseTo(moved.lat, 5);
  });

  it('engancha el pedido en curso, si lo hay', async () => {
    await makePricingConfig();
    const client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    const product = await makeProduct(business._id);

    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    });
    await Order.updateOne(
      { _id: order._id },
      { status: OrderStatus.ON_WAY, driverId: driver._id }
    );

    const alert = await sosService.trigger(driverUser._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
    });

    expect(alert.orderId!.toString()).toBe(order._id.toString());
  });

  it('sin pedido en curso la alerta vale igual', async () => {
    // Repartir de noche tiene riesgos aunque no se lleve nada encima.
    const alert = await sosService.trigger(driverUser._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
    });

    expect(alert.orderId).toBeNull();
    expect(alert.status).toBe(SosStatus.ACTIVE);
  });

  it('atender la alerta deja constancia de quién', async () => {
    const alert = await sosService.trigger(driverUser._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
    });

    const acked = await sosService.acknowledge(alert._id.toString(), admin._id.toString());

    expect(acked.status).toBe(SosStatus.ACKNOWLEDGED);
    expect(acked.acknowledgedBy!.toString()).toBe(admin._id.toString());
    expect(acked.acknowledgedAt).toBeInstanceOf(Date);
  });

  it('no se puede atender dos veces la misma alerta', async () => {
    const alert = await sosService.trigger(driverUser._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
    });

    await sosService.acknowledge(alert._id.toString(), admin._id.toString());
    await expect(
      sosService.acknowledge(alert._id.toString(), admin._id.toString())
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('cerrarla exige decir qué pasó', async () => {
    const alert = await sosService.trigger(driverUser._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
    });

    const resolved = await sosService.resolve(
      alert._id.toString(),
      admin._id.toString(),
      'Se contactó al domiciliario, estaba bien'
    );

    expect(resolved.status).toBe(SosStatus.RESOLVED);
    expect(resolved.resolution).toContain('estaba bien');
  });

  it('una falsa alarma se conserva, no se borra', async () => {
    const alert = await sosService.trigger(driverUser._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
    });

    const resolved = await sosService.resolve(
      alert._id.toString(),
      admin._id.toString(),
      'Pulsado sin querer',
      true
    );

    // Los falsos positivos también informan: si son muchos, el botón está
    // mal colocado.
    expect(resolved.status).toBe(SosStatus.FALSE_ALARM);
    expect(await SosAlert.countDocuments()).toBe(1);
  });

  it('tras cerrarla, una nueva emergencia abre otra alerta', async () => {
    const first = await sosService.trigger(driverUser._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
    });
    await sosService.resolve(first._id.toString(), admin._id.toString(), 'Resuelto');

    const second = await sosService.trigger(driverUser._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
    });

    expect(second._id.toString()).not.toBe(first._id.toString());
  });

  it('la lista de activas trae al domiciliario y su teléfono', async () => {
    await sosService.trigger(driverUser._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
    });

    const active = await sosService.active();
    expect(active).toHaveLength(1);
    expect((active[0] as any).driverId.userId.phone).toBeDefined();
  });

  it('las cerradas salen de la lista de activas', async () => {
    const alert = await sosService.trigger(driverUser._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
    });
    await sosService.resolve(alert._id.toString(), admin._id.toString(), 'Resuelto');

    expect(await sosService.active()).toHaveLength(0);
    expect(await sosService.history()).toHaveLength(1);
  });

  it('alguien que no es domiciliario no puede activar el botón', async () => {
    const cliente = await makeUser({ role: UserRole.CLIENT });

    await expect(
      sosService.trigger(cliente._id.toString(), { lat: GARZON.lat, lng: GARZON.lng })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
