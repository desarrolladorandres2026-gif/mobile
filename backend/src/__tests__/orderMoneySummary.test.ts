import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Order, Payment } from '../models';
import { OrderStatus, PaymentMethod, PaymentStatus, UserRole } from '../types';
import { featureFlagService } from '../services/featureFlag.service';
import { orderService } from '../services/order.service';
import { paymentService, setPaymentProvider, SandboxPaymentProvider } from '../services/payments';
import { cache } from '../cache';
import { gatewayFeeBreakdown } from '../utils/gatewayFee';
import { platformResultService } from '../services/platformResult.service';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, makeStaff, authHeader, GARZON } from './factories';

const A = '/api/v1/admin/orders';
const FEES = { gatewayCardFixed: 700, gatewayOtherFixed: 700, gatewayFeeVatBps: 1900 };

describe('Resumen de dinero del pedido según el método de pago real', () => {
  let client: any;
  let business: any;
  let product: any;

  const newOrder = (paymentMethod: PaymentMethod) =>
    orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    });

  const pay = async (order: any) => {
    setPaymentProvider(new SandboxPaymentProvider());
    await paymentService.initiate({
      orderId: order._id.toString(),
      userId: client._id.toString(),
      amount: order.finance.customerTotal,
      description: 'Prueba',
      customer: { name: 'Cliente', phone: '3101234567' },
    });
  };

  const fetch = async (orderId: string) => {
    const fin = await makeStaff({ roleSlug: 'finanzas' });
    const res = await request(app).get(`${A}/${orderId}/profile-360`).set(await authHeader(fin));
    expect(res.status).toBe(200);
    return res.body.data;
  };

  beforeEach(async () => {
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    await cache.flush();
    await makePricingConfig({ ...FEES, cashOnDeliveryEnabled: true });
    client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    product = await makeProduct(business._id, { price: 20000 });
  });

  it('desglosa la comisión de Wompi en porcentaje, fijo e IVA', () => {
    const b = gatewayFeeBreakdown({ gatewayCardBps: 265, gatewayCardFixed: 700, gatewayFeeVatBps: 1900 }, 'CARD', 20000);
    expect(b.fixed).toBe(700);
    expect(b.percentage).toBe(530);
    expect(b.vat).toBe(Math.round(((530 + 700) * 1900) / 10000));
    expect(b.total).toBe(b.percentage + b.fixed + b.vat);
  });

  it('el IVA se puede calcular solo sobre la tarifa fija y por defecto sigue sobre todo', () => {
    const cfg = { gatewayCardBps: 265, gatewayCardFixed: 700, gatewayFeeVatBps: 1900 };
    expect(gatewayFeeBreakdown(cfg, 'CARD', 20000).vat).toBe(Math.round((1230 * 1900) / 10000));
    const fixedOnly = gatewayFeeBreakdown({ ...cfg, gatewayFeeVatBase: 'fixed' }, 'CARD', 20000);
    expect(fixedOnly.vat).toBe(133);
    expect(fixedOnly.total).toBe(530 + 700 + 133);
  });

  it('sin tarifas configuradas el costo es 0 y se marca sin configurar (no se inventa)', async () => {
    await makePricingConfig({ gatewayCardFixed: 0, gatewayOtherFixed: 0, gatewayFeeVatBps: 0 });
    const order = await newOrder(PaymentMethod.ONLINE);
    await pay(order);
    const p = (await fetch(order._id.toString())).money.payments[0];
    expect(p.gatewayFee.total).toBe(0);
    expect(p.gatewayFee.source).toBe('unconfigured');
  });

  it('reembolso de comisión sin definir viaja como null; transactionId y referencia solo por su endpoint', async () => {
    const order = await newOrder(PaymentMethod.ONLINE);
    await pay(order);
    const d = await fetch(order._id.toString());
    expect(d.money.summary.gatewayFeeRefundBps).toBeNull();
    expect(JSON.stringify(d.money)).not.toMatch(/transactionId|metadata|reference/);

    const fin = await makeStaff({ roleSlug: 'finanzas' });
    const ops = await makeStaff({ roleSlug: 'operaciones' });
    const ok = await request(app).get(`${A}/${order._id}/payment-refs`).set(await authHeader(fin));
    expect(ok.status).toBe(200);
    expect(ok.body.data[0].reference).toBeTruthy();
    expect(ok.body.data[0].transactionId).toBeTruthy();
    const denied = await request(app).get(`${A}/${order._id}/payment-refs`).set(await authHeader(ops));
    expect(denied.status).toBe(403);
  });

  it('efectivo: sin costo Wompi, sin proveedor y resultado = neto de ZIPP', async () => {
    const order = await newOrder(PaymentMethod.CASH_ON_DELIVERY);
    const d = await fetch(order._id.toString());
    const s = d.money.summary;
    expect(s.kind).toBe('cash');
    expect(s.provider).toBeNull();
    expect(s.gatewayFee).toBe(0);
    expect(s.gatewayFeeApplies).toBe(false);
    // Sin cobro ni entrega el libro no tiene asientos de resultado: no se muestra un cero.
    expect(s.collected).toBe(false);
    expect(s.platformResult).toBe((await platformResultService.forOrder(order._id))?.netAfterGatewayCosts ?? null);
    expect(d.money.payments.every((p: any) => p.gatewayFee === null)).toBe(true);
  });

  it('online pagado: costo Wompi de la configuración, resta al resultado y da neto recibido', async () => {
    const order = await newOrder(PaymentMethod.ONLINE);
    await pay(order);
    const d = await fetch(order._id.toString());
    const s = d.money.summary;
    expect(s.kind).toBe('online');
    expect(s.provider).toBe('Wompi');
    expect(s.gatewayFee).toBe(833);
    expect(s.gatewayFeeApplies).toBe(true);
    // Una sola definición: el resultado del pedido sale del libro y ya resta la comisión asentada.
    const ledger = await platformResultService.forOrder(order._id);
    expect(ledger?.processingExpense).toBe(833);
    expect(s.platformResult).toBe(ledger?.netAfterGatewayCosts);
    expect(s.collected).toBe(true);
    const p = d.money.payments[0];
    expect(p.gatewayFee.total).toBe(833);
    expect(p.gatewayFee.source).toBe('ledger');
    expect(p.netReceived).toBe(p.amount - 833);
  });

  it('online sin capturar (pendiente o fallido): sin costo Wompi', async () => {
    const order = await newOrder(PaymentMethod.ONLINE);
    const pending = (await fetch(order._id.toString())).money.summary;
    expect(pending.gatewayFee).toBe(0);
    expect(pending.gatewayFeeApplies).toBe(false);

    await Order.updateOne({ _id: order._id }, { paymentStatus: PaymentStatus.FAILED });
    await Payment.updateMany({ orderId: order._id }, { status: PaymentStatus.FAILED });
    const failed = (await fetch(order._id.toString())).money.summary;
    expect(failed.gatewayFee).toBe(0);
    expect(failed.gatewayFeeApplies).toBe(false);
  });

  it('reembolsado o cancelado: el costo ya pagado se ve y el resultado sigue al libro', async () => {
    const order = await newOrder(PaymentMethod.ONLINE);
    await pay(order);
    await Order.updateOne({ _id: order._id }, { paymentStatus: PaymentStatus.REFUNDED, status: OrderStatus.CANCELLED });
    await Payment.updateMany({ orderId: order._id }, { status: PaymentStatus.REFUNDED });
    const s = (await fetch(order._id.toString())).money.summary;
    expect(s.gatewayFee).toBe(833);
    expect(s.platformResult).toBe((await platformResultService.forOrder(order._id))?.netAfterGatewayCosts ?? null);
  });
});
