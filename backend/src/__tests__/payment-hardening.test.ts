import { describe, it, expect, beforeEach, vi } from 'vitest';
import { orderService } from '../services/order.service';
import {
  paymentService,
  setPaymentProvider,
  SandboxPaymentProvider,
  WompiPaymentProvider,
} from '../services/payments';
import { config } from '../config';
import { isAllowedRedirectUrl } from '../validators/payment.validator';
import { Order, Payment, Payout, ProcessedWebhook } from '../models';
import { PaymentMethod, PaymentStatus, OrderStatus, UserRole, PayoutStatus } from '../types';
import {
  makeUser,
  makeBusiness,
  makeProduct,
  makeDriver,
  makePricingConfig,
  GARZON,
  offsetKm,
} from './factories';

/** ~1 km from the business, so delivery pricing produces realistic numbers. */
const DESTINATION = offsetKm(GARZON, 1);

/**
 * Regression cover for the payment hardening pass.
 *
 * Every case here corresponds to a way money could previously go missing or
 * a way an untrusted input could reach the gateway. They are written against
 * the sandbox provider, because what is under test is PaymentService's own
 * bookkeeping — the Wompi-specific signing lives in wompi.test.ts.
 */

async function scenario() {
  await makePricingConfig();
  const client = await makeUser();
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id, { commissionRateBps: 1000 });
  const product = await makeProduct(business._id, { price: 30000 });

  const order = await orderService.create({
    clientId: client._id.toString(),
    businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }],
    paymentMethod: PaymentMethod.ONLINE,
    deliveryAddress: 'Cra 10 #5-23',
    deliveryLatitude: DESTINATION.lat,
    deliveryLongitude: DESTINATION.lng,
  });

  return { client, owner, business, product, order };
}

const initiateFor = (order: any, client: any) =>
  paymentService.initiate({
    orderId: order._id.toString(),
    userId: client._id.toString(),
    amount: order.finance.customerTotal,
    description: 'Prueba',
    customer: { name: 'Cliente', phone: '3101234567' },
  });

describe('Endurecimiento de pagos', () => {
  let provider: SandboxPaymentProvider;

  beforeEach(() => {
    provider = new SandboxPaymentProvider();
    // El sandbox aprueba al crear; para los casos de reintento y webhook
    // hace falta que el pago se quede pendiente, así que cada test que lo
    // necesite reconfigura el proveedor.
    setPaymentProvider(provider);
  });

  describe('V2 · un webhook que falla debe poder reintentarse', () => {
    it('libera el registro anti-duplicado cuando aplicar el evento falla', async () => {
      const { client, order } = await scenario();
      const { intent } = await initiateFor(order, client);

      const payload = JSON.stringify({
        eventId: 'evt-falla',
        paymentId: intent.id,
        status: 'approved',
        amount: order.finance.customerTotal,
      });
      const signature = provider.sign(payload);

      // Falla una sola vez, como lo haría una caída puntual de Mongo o un
      // error del ledger a mitad de la captura.
      const spy = vi
        .spyOn(paymentService, 'applyGatewayStatus')
        .mockRejectedValueOnce(new Error('caída transitoria'));

      await expect(paymentService.handleWebhook(payload, signature)).rejects.toThrow(
        'caída transitoria'
      );

      // El claim tiene que haberse soltado: si sobrevive, el reintento del
      // gateway se responde "ya procesado" y el pago se pierde para siempre.
      expect(await ProcessedWebhook.countDocuments({ eventKey: 'evt-falla' })).toBe(0);

      spy.mockRestore();

      // El reintento de Wompi ahora sí procesa de verdad.
      const retry = await paymentService.handleWebhook(payload, signature);
      expect(retry).toEqual({ accepted: true, duplicated: false });

      const payment = await Payment.findOne({ orderId: order._id });
      expect(payment!.status).toBe(PaymentStatus.PAID);
    });

    it('sigue tratando como duplicado un evento que sí se aplicó', async () => {
      const { client, order } = await scenario();
      const { intent } = await initiateFor(order, client);

      const payload = JSON.stringify({
        eventId: 'evt-ok',
        paymentId: intent.id,
        status: 'approved',
        amount: order.finance.customerTotal,
      });
      const signature = provider.sign(payload);

      expect((await paymentService.handleWebhook(payload, signature)).accepted).toBe(true);
      expect((await paymentService.handleWebhook(payload, signature)).duplicated).toBe(true);
      expect(await ProcessedWebhook.countDocuments({ eventKey: 'evt-ok' })).toBe(1);
    });
  });

  describe('V3 · reintento tras cambiar el total del pedido', () => {
    it('resincroniza el monto y emite una referencia nueva', async () => {
      const { client, order } = await scenario();

      // El sandbox aprueba al crear, así que para simular un intento
      // pendiente se fuerza el pago a PENDING como lo estaría un Web
      // Checkout que el cliente aún no ha completado.
      const { paymentId } = await initiateFor(order, client);
      const original = await Payment.findById(paymentId);
      original!.status = PaymentStatus.PENDING;
      await original!.save();
      const originalReference = original!.reference;
      const originalAmount = original!.amount;

      // El total del pedido cambia (propina añadida, re-tarifación…).
      const nuevoTotal = originalAmount + 5000;
      await Order.updateOne(
        { _id: order._id },
        { $set: { 'finance.customerTotal': nuevoTotal, paymentStatus: PaymentStatus.PENDING } }
      );

      await paymentService.initiate({
        orderId: order._id.toString(),
        userId: client._id.toString(),
        amount: nuevoTotal,
        description: 'Prueba',
        customer: { name: 'Cliente', phone: '3101234567' },
      });

      const updated = await Payment.findById(paymentId);

      // Antes, el monto quedaba con el valor viejo mientras el enlace se
      // firmaba con el nuevo: el webhook fallaba su propio chequeo de monto.
      expect(updated!.amount).toBe(nuevoTotal);
      // Y la referencia vieja, atada por firma al monto viejo, se retira.
      expect(updated!.reference).not.toBe(originalReference);
      expect(updated!.metadata?.supersededReference).toBe(originalReference);
      expect(updated!.metadata?.supersededAmount).toBe(originalAmount);
    });

    it('conserva la referencia cuando el monto no cambió', async () => {
      const { client, order } = await scenario();

      const { paymentId } = await initiateFor(order, client);
      const original = await Payment.findById(paymentId);
      original!.status = PaymentStatus.PENDING;
      await original!.save();

      await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: PaymentStatus.PENDING } });

      await initiateFor(order, client);

      const updated = await Payment.findById(paymentId);
      expect(updated!.reference).toBe(original!.reference);
      expect(updated!.metadata?.supersededReference).toBeUndefined();
    });
  });

  describe('V10 · un pedido cancelado no admite pago', () => {
    it('rechaza iniciar el cobro de un pedido cancelado', async () => {
      const { client, order } = await scenario();
      await Order.updateOne({ _id: order._id }, { $set: { status: OrderStatus.CANCELLED } });

      await expect(initiateFor(order, client)).rejects.toThrow(/cancelado/i);
    });
  });

  describe('V9 · un enlace de checkout expirado se recrea correctamente', () => {
    const WOMPI_KEYS = {
      publicKey: 'pub_test_hardening',
      privateKey: 'prv_test_hardening',
      integritySecret: 'test_integrity_hardening',
      eventsSecret: 'test_events_hardening',
    };

    it('un intento nunca abierto (sin transacción en Wompi) se reconstruye con una expiración nueva', async () => {
      const original = { ...config.payments.wompi };
      Object.assign(config.payments.wompi, WOMPI_KEYS);
      setPaymentProvider(new WompiPaymentProvider());

      try {
        const { client, order } = await scenario();

        const first = await initiateFor(order, client);
        const firstUrl = new URL(first.intent.checkoutUrl!);
        const firstExpiration = firstUrl.searchParams.get('expiration-time');
        const firstSignature = firstUrl.searchParams.get('signature:integrity');

        // El pago quedó PENDING (Web Checkout, nadie lo completó). Wompi no
        // tiene ninguna transacción registrada para esa referencia — es
        // exactamente lo que pasa con un enlace que expiró sin que el
        // cliente lo abriera.
        const pending = await Payment.findOne({ orderId: order._id });
        expect(pending!.status).toBe(PaymentStatus.PENDING);

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

        const second = await initiateFor(order, client);
        const secondUrl = new URL(second.intent.checkoutUrl!);

        // Misma referencia y mismo monto — nada cambió del lado del
        // pedido — pero una expiración y firma nuevas, así que el enlace
        // recién generado es válido de nuevo aunque el anterior ya no lo sea.
        expect(secondUrl.searchParams.get('reference')).toBe(
          firstUrl.searchParams.get('reference')
        );
        expect(secondUrl.searchParams.get('amount-in-cents')).toBe(
          firstUrl.searchParams.get('amount-in-cents')
        );
        expect(secondUrl.searchParams.get('expiration-time')).not.toBe(firstExpiration);
        expect(secondUrl.searchParams.get('signature:integrity')).not.toBe(firstSignature);

        // Sigue habiendo un solo Payment para este pedido — reconstruir el
        // enlace no crea un segundo registro.
        expect(await Payment.countDocuments({ orderId: order._id })).toBe(1);
      } finally {
        Object.assign(config.payments.wompi, original);
        vi.unstubAllGlobals();
      }
    });
  });

  describe('V6 · un pedido online no pagado no puede aceptarse', () => {
    it('bloquea que el negocio acepte antes de que el pago se confirme', async () => {
      const { owner, order } = await scenario();

      await expect(
        orderService.updateStatus(
          order._id.toString(),
          OrderStatus.ACCEPTED,
          owner._id.toString(),
          UserRole.BUSINESS
        )
      ).rejects.toThrow(/aún no está pagado/i);

      const untouched = await Order.findById(order._id);
      expect(untouched!.status).toBe(OrderStatus.PENDING);
    });

    it('permite aceptarlo en cuanto el gateway confirma el pago', async () => {
      const { client, owner, order } = await scenario();
      const { intent } = await initiateFor(order, client);

      const payload = JSON.stringify({
        eventId: 'evt-acepta',
        paymentId: intent.id,
        status: 'approved',
        amount: order.finance.customerTotal,
      });
      await paymentService.handleWebhook(payload, provider.sign(payload));

      const accepted = await orderService.updateStatus(
        order._id.toString(),
        OrderStatus.ACCEPTED,
        owner._id.toString(),
        UserRole.BUSINESS
      );
      expect(accepted.status).toBe(OrderStatus.ACCEPTED);
    });

    it('deja cancelar un pedido online impago — es como termina un checkout abandonado', async () => {
      const { owner, order } = await scenario();

      const cancelled = await orderService.updateStatus(
        order._id.toString(),
        OrderStatus.CANCELLED,
        owner._id.toString(),
        UserRole.BUSINESS,
        'El cliente no completó el pago'
      );
      expect(cancelled.status).toBe(OrderStatus.CANCELLED);
    });

    it('no estorba a un pedido contra entrega', async () => {
      // La barrera es específica de PaymentMethod.ONLINE: un pedido contra
      // entrega no tiene nada que confirmar con el gateway.
      await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
      const client = await makeUser();
      const owner = await makeUser({ role: UserRole.BUSINESS });
      const business = await makeBusiness(owner._id, { commissionRateBps: 1000 });
      const product = await makeProduct(business._id, { price: 30000 });

      const order = await orderService.create({
        clientId: client._id.toString(),
        businessId: business._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }],
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        deliveryAddress: 'Cra 10 #5-23',
        deliveryLatitude: DESTINATION.lat,
        deliveryLongitude: DESTINATION.lng,
      });

      const accepted = await orderService.updateStatus(
        order._id.toString(),
        OrderStatus.ACCEPTED,
        owner._id.toString(),
        UserRole.BUSINESS
      );
      expect(accepted.status).toBe(OrderStatus.ACCEPTED);
    });
  });

  describe('Liquidaciones bajo el nuevo orden "pagar antes de aceptar"', () => {
    it('un payout creado después de la captura nace PAGADERO, no devengado', async () => {
      const { client, owner, order } = await scenario();

      // Se cobra primero, como exige ahora la máquina de estados. En ese
      // momento solo existe el payout del negocio: al repartidor todavía no
      // se le ha asignado nada.
      const { intent } = await initiateFor(order, client);
      const payload = JSON.stringify({
        eventId: 'evt-payout',
        paymentId: intent.id,
        status: 'approved',
        amount: order.finance.customerTotal,
      });
      await paymentService.handleWebhook(payload, provider.sign(payload));

      await orderService.updateStatus(
        order._id.toString(),
        OrderStatus.ACCEPTED,
        owner._id.toString(),
        UserRole.BUSINESS
      );

      // Ahora aparece el repartidor, y con él su payout — ya con el dinero
      // cobrado. release() ya corrió y no volverá a correr, así que si este
      // payout naciera ACCRUED se quedaría así para siempre: el repartidor
      // nunca cobraría un pedido en línea.
      const driverUser = await makeUser({ role: UserRole.DRIVER });
      const driver = await makeDriver(driverUser._id);
      await orderService.assignDriver(order._id.toString(), driver._id.toString());

      const payouts = await Payout.find({ orderId: order._id });
      expect(payouts.length).toBe(2);
      expect(payouts.every((p) => p.status === PayoutStatus.PAYABLE)).toBe(true);
      expect(payouts.every((p) => p.becamePayableAt)).toBeTruthy();
    });

    it('sin captura, el payout sigue naciendo devengado', async () => {
      const { owner, order } = await scenario();
      await Order.updateOne({ _id: order._id }, { $set: { status: OrderStatus.ACCEPTED } });

      const driverUser = await makeUser({ role: UserRole.DRIVER });
      const driver = await makeDriver(driverUser._id);
      await orderService.assignDriver(order._id.toString(), driver._id.toString());

      const payouts = await Payout.find({ orderId: order._id });
      expect(payouts.every((p) => p.status === PayoutStatus.ACCRUED)).toBe(true);
      expect(owner).toBeTruthy();
    });
  });

  describe('V4 · lista blanca de la URL de retorno', () => {
    it('acepta el deep link propio de la app', () => {
      expect(isAllowedRedirectUrl('zipp://payment-result')).toBe(true);
      expect(isAllowedRedirectUrl('zipp://payment-result?id=abc')).toBe(true);
    });

    it('acepta un origen web propio ya configurado en CORS', () => {
      expect(isAllowedRedirectUrl('http://localhost:3000/payment-result')).toBe(true);
    });

    it('rechaza un destino externo', () => {
      expect(isAllowedRedirectUrl('https://evil.com/phish')).toBe(false);
      expect(isAllowedRedirectUrl('http://evil.com')).toBe(false);
    });

    it('rechaza las evasiones clásicas de lista blanca', () => {
      // Userinfo: el host real es evil.com, no localhost.
      expect(isAllowedRedirectUrl('https://localhost:3000@evil.com/x')).toBe(false);
      // Protocolo peligroso.
      expect(isAllowedRedirectUrl('javascript:alert(1)')).toBe(false);
      expect(isAllowedRedirectUrl('data:text/html,<script>1</script>')).toBe(false);
      // Sin esquema: no parsea como URL absoluta.
      expect(isAllowedRedirectUrl('//evil.com')).toBe(false);
      expect(isAllowedRedirectUrl('/payment-result')).toBe(false);
      // Esquema parecido pero distinto.
      expect(isAllowedRedirectUrl('zippx://payment-result')).toBe(false);
      expect(isAllowedRedirectUrl('')).toBe(false);
    });

    it('rechaza un puerto distinto en un host permitido', () => {
      expect(isAllowedRedirectUrl('http://localhost:9999/payment-result')).toBe(false);
    });
  });

  describe('V12 · Expo Go, sin wildcard', () => {
    it('fuera de desarrollo, la lista de hosts de Expo Go está vacía — ningún exp:// se acepta', () => {
      // `config.isDev` es falso bajo pruebas (NODE_ENV=test), así que esto
      // ejercita exactamente el estado con el que corre un build empaquetado:
      // sin cliente Expo Go al que volver, la lista no concede nada.
      expect(config.devExpoRedirectHosts).toEqual([]);
      expect(isAllowedRedirectUrl('exp://192.168.1.50:8081/--/payment-result')).toBe(false);
    });

    it('en desarrollo, acepta solo el host:puerto exacto configurado — no cualquier exp://', () => {
      const original = config.devExpoRedirectHosts;
      // Simula lo que buildDevExpoRedirectHosts produciría en un equipo de
      // desarrollo real: la IP LAN del propio backend en los puertos de
      // Expo/Metro. Se asigna directamente en vez de forzar `config.isDev`,
      // que otros módulos ya leyeron al arrancar.
      (config as any).devExpoRedirectHosts = ['192.168.1.50:8081'];

      try {
        expect(isAllowedRedirectUrl('exp://192.168.1.50:8081/--/payment-result')).toBe(true);
        // Ni un puerto distinto...
        expect(isAllowedRedirectUrl('exp://192.168.1.50:9999/--/payment-result')).toBe(false);
        // ...ni un host distinto, aunque esté en la misma red, cuela.
        expect(isAllowedRedirectUrl('exp://10.0.0.5:8081/--/payment-result')).toBe(false);
        // Ni el mismo host:puerto con otro esquema.
        expect(isAllowedRedirectUrl('http://192.168.1.50:8081/--/payment-result')).toBe(false);
      } finally {
        (config as any).devExpoRedirectHosts = original;
      }
    });
  });
});
