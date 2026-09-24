import { describe, it, expect, beforeEach } from 'vitest';
import { Order, Pqrs } from '../models';
import { OrderStatus, UserRole, PaymentMethod } from '../types';
import { incidentCenterService } from '../services/incidentCenter.service';
import { sosService } from '../services/sos.service';
import { orderService } from '../services/order.service';
import { antiFraudService, FraudAlertType, RiskLevel } from '../security';
import {
  makeUser, makeDriver, makeBusiness, makeProduct, makePricingConfig, GARZON,
} from './factories';

/**
 * Centro de incidentes.
 *
 * Nada de lo que aparece aquí es nuevo: alertas de fraude, faltantes de
 * efectivo, botones de pánico, reclamos y pedidos detenidos ya existían,
 * pero en cinco pantallas distintas. Nadie mira cinco pantallas a la vez,
 * así que se miraba una y las otras cuatro acumulaban.
 */
const ALLOW_ALL = () => true;

describe('Centro de incidentes', () => {
  let client: any;
  let business: any;
  let product: any;

  beforeEach(async () => {
    await makePricingConfig();
    client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    product = await makeProduct(business._id);
  });

  it('sin nada abierto, la lista está vacía', async () => {
    expect(await incidentCenterService.open(ALLOW_ALL)).toEqual([]);
  });

  it('recoge una emergencia', async () => {
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    await makeDriver(driverUser._id);
    await sosService.trigger(driverUser._id.toString(), { lat: GARZON.lat, lng: GARZON.lng });

    const incidents = await incidentCenterService.open(ALLOW_ALL);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].kind).toBe('sos');
    expect(incidents[0].severity).toBe('critical');
  });

  it('recoge una alerta de fraude grave', async () => {
    await antiFraudService.raiseAlertOnce({
      userId: client._id.toString(),
      type: FraudAlertType.MOCK_LOCATION,
      riskLevel: RiskLevel.CRITICAL,
      riskScore: 95,
      description: 'Ubicación GPS falsa',
      evidence: {},
    });

    const incidents = await incidentCenterService.open(ALLOW_ALL);
    expect(incidents.some((i) => i.kind === 'fraud')).toBe(true);
  });

  it('ignora las alertas de fraude leves: el centro es para lo grave', async () => {
    await antiFraudService.raiseAlertOnce({
      userId: client._id.toString(),
      type: FraudAlertType.DEVICE_CHANGE,
      riskLevel: RiskLevel.LOW,
      riskScore: 10,
      description: 'Cambió de teléfono',
      evidence: {},
    });

    expect(await incidentCenterService.open(ALLOW_ALL)).toHaveLength(0);
  });

  it('recoge un reclamo sin resolver, pero no una sugerencia', async () => {
    await Pqrs.create({
      userId: client._id,
      type: 'claim',
      subject: 'Me cobraron de más',
      detail: 'El total no coincide',
    });
    await Pqrs.create({
      userId: client._id,
      type: 'suggestion',
      subject: 'Sería bueno tener modo oscuro',
      detail: 'Nada urgente',
    });

    const incidents = await incidentCenterService.open(ALLOW_ALL);
    expect(incidents.filter((i) => i.kind === 'complaint')).toHaveLength(1);
  });

  it('recoge un pedido que lleva demasiado tiempo detenido', async () => {
    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    });

    // Cuarenta y cinco minutos en la moto: no es un retraso, es un pedido
    // que probablemente ya no sirve.
    await Order.collection.updateOne(
      { _id: order._id },
      {
        $set: {
          status: OrderStatus.PICKED_UP,
          updatedAt: new Date(Date.now() - 60 * 60 * 1000),
        },
      }
    );

    const incidents = await incidentCenterService.open(ALLOW_ALL);
    expect(incidents.some((i) => i.kind === 'stalled_order')).toBe(true);
  });

  it('un pedido recién recogido no es un incidente', async () => {
    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    });
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.PICKED_UP });

    expect(await incidentCenterService.open(ALLOW_ALL)).toHaveLength(0);
  });

  it('las emergencias van primero aunque acaben de entrar', async () => {
    // Es la única categoría donde hay una persona en riesgo y no dinero.
    await Pqrs.create({
      userId: client._id,
      type: 'claim',
      subject: 'Reclamo viejo',
      detail: 'Lleva días',
    });

    const driverUser = await makeUser({ role: UserRole.DRIVER });
    await makeDriver(driverUser._id);
    await sosService.trigger(driverUser._id.toString(), { lat: GARZON.lat, lng: GARZON.lng });

    const incidents = await incidentCenterService.open(ALLOW_ALL);
    expect(incidents[0].kind).toBe('sos');
  });

  it('dentro de la misma gravedad, lo más antiguo va primero', async () => {
    const viejo = await Pqrs.create({
      userId: client._id,
      type: 'claim',
      subject: 'Primero',
      detail: 'x',
    });
    await Pqrs.collection.updateOne(
      { _id: viejo._id },
      { $set: { createdAt: new Date(Date.now() - 86_400_000) } }
    );

    await Pqrs.create({ userId: client._id, type: 'claim', subject: 'Después', detail: 'y' });

    const incidents = await incidentCenterService.open(ALLOW_ALL);
    // Lo que lleva más tiempo sin atenderse es lo que más ha empeorado.
    expect(incidents[0].detail).toBe('Primero');
  });

  it('cerrar la emergencia la saca del centro', async () => {
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    await makeDriver(driverUser._id);
    const admin = await makeUser({ role: UserRole.ADMIN });

    const alert = await sosService.trigger(driverUser._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
    });
    await sosService.resolve(alert._id.toString(), admin._id.toString(), 'Todo bien');

    expect(await incidentCenterService.open(ALLOW_ALL)).toHaveLength(0);
  });

  it('el resumen cuenta cada tipo por separado', async () => {
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    await makeDriver(driverUser._id);
    await sosService.trigger(driverUser._id.toString(), { lat: GARZON.lat, lng: GARZON.lng });

    await Pqrs.create({ userId: client._id, type: 'claim', subject: 'Reclamo', detail: 'x' });

    const summary = await incidentCenterService.summary(ALLOW_ALL);
    expect(summary.activeSos).toBe(1);
    expect(summary.openClaims).toBe(1);
  });

  it('cada incidente dice a quién afecta, para poder abrir su historial', async () => {
    await Pqrs.create({ userId: client._id, type: 'claim', subject: 'Reclamo', detail: 'x' });

    const incidents = await incidentCenterService.open(ALLOW_ALL);
    expect(incidents[0].userId).toBe(client._id.toString());
  });
});
