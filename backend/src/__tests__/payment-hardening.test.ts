import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { orderService } from '../services/order.service';
import {
  paymentService,
  setPaymentProvider,
  SandboxPaymentProvider,
  WompiPaymentProvider,
} from '../services/payments';
import { config } from '../config';
import { isAllowedRedirectUrl } from '../validators/payment.validator';
import { ledgerService } from '../services/ledger.service';
import { Order, Payment, Payout, ProcessedWebhook, LedgerEntry } from '../models';
import {
  PaymentMethod,
  PaymentStatus,
  OrderStatus,
  UserRole,
  PayoutStatus,
  LedgerAccount,
  LedgerEventType,
} from '../types';
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
    // El sandbox aprueba en cuanto se crea el intento, y aquí lo que se
    // examina es justo el estado intermedio: un Web Checkout emitido que el
    // cliente todavía no ha pagado. Se apaga la aprobación automática para
    // poder observarlo, y se restaura al salir.
    const autoApprove = config.payments.sandbox.autoApprove;

    beforeEach(() => {
      config.payments.sandbox.autoApprove = false;
    });

    afterEach(() => {
      config.payments.sandbox.autoApprove = autoApprove;
    });

    /**
     * El intento viejo se retira, NO se reescribe.
     *
     * Reescribirlo era el fallo: el enlace de Wompi anterior sigue siendo
     * pagable hasta que expira, y su webhook resuelve la fila por
     * referencia. Al pisar esa referencia con la nueva, un cliente que
     * pagara el enlace viejo generaba un evento que no casaba con ninguna
     * fila — dinero cobrado por Wompi y ni rastro de él en la plataforma.
     *
     * Retirado en su sitio, el evento tardío encuentra su fila, y
     * `applyGatewayStatus` ve un monto que ya no es el del pedido y lo
     * marca para revisión en vez de dar el pedido por cobrado de menos.
     */
    it('retira el intento anterior y abre uno nuevo con el monto correcto', async () => {
      const { client, order } = await scenario();

      const { paymentId } = await initiateFor(order, client);
      const original = await Payment.findById(paymentId);
      expect(original!.status).toBe(PaymentStatus.PENDING);
      const originalReference = original!.reference;
      const originalAmount = original!.amount;

      // El total del pedido cambia (propina añadida, re-tarifación…).
      const nuevoTotal = originalAmount + 5000;
      await Order.updateOne(
        { _id: order._id },
        { $set: { 'finance.customerTotal': nuevoTotal, paymentStatus: PaymentStatus.PENDING } }
      );

      const { paymentId: nuevoId } = await paymentService.initiate({
        orderId: order._id.toString(),
        userId: client._id.toString(),
        amount: nuevoTotal,
        description: 'Prueba',
        customer: { name: 'Cliente', phone: '3101234567' },
      });

      // El intento viejo sigue existiendo, cerrado y localizable por su
      // referencia de siempre.
      const retirado = await Payment.findById(paymentId);
      expect(retirado!.status).toBe(PaymentStatus.FAILED);
      expect(retirado!.reference).toBe(originalReference);
      expect(retirado!.amount).toBe(originalAmount);
      expect(retirado!.metadata?.supersededBy).toBeTruthy();

      // Y el nuevo cobra lo que el pedido vale ahora, con su propia
      // referencia — la que firmará el enlace nuevo.
      expect(nuevoId).not.toBe(paymentId);
      const nuevo = await Payment.findById(nuevoId);
      expect(nuevo!.status).toBe(PaymentStatus.PENDING);
      expect(nuevo!.amount).toBe(nuevoTotal);
      expect(nuevo!.reference).not.toBe(originalReference);
      expect(nuevo!.metadata?.supersedesReference).toBe(originalReference);
    });

    it('un pago tardío del enlace viejo no da el pedido por cobrado', async () => {
      const { client, order } = await scenario();

      const { paymentId } = await initiateFor(order, client);
      const original = await Payment.findById(paymentId);
      const referenciaVieja = original!.reference!;
      const montoViejo = original!.amount;

      // Se re-tarifa el pedido y se emite un intento nuevo.
      const nuevoTotal = montoViejo + 5000;
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

      // El cliente paga el enlace VIEJO, que sigue vivo hasta que expire.
      const payload = JSON.stringify({
        eventId: 'evt-enlace-viejo',
        paymentId: referenciaVieja,
        status: 'approved',
        amount: montoViejo,
      });
      const res = await paymentService.handleWebhook(payload, provider.sign(payload));
      expect(res.accepted).toBe(true);

      // El cobro se reconoce —el dinero entró de verdad— pero el pedido NO
      // queda pagado: llegó menos de lo que cuesta.
      const pagado = await Payment.findById(paymentId);
      expect(pagado!.status).toBe(PaymentStatus.PAID);
      expect(pagado!.metadata?.requiresReview).toBe(true);

      const pedido = await Order.findById(order._id);
      expect(pedido!.paymentStatus).not.toBe(PaymentStatus.PAID);

      // Y nada se libera para liquidar: pagarle al comercio por un pedido
      // cobrado de menos es exactamente la fuga que esto cierra.
      const payouts = await Payout.find({ orderId: order._id });
      expect(payouts.every((p) => p.status === PayoutStatus.ACCRUED)).toBe(true);
    });

    it('conserva la referencia y la fila cuando el monto no cambió', async () => {
      const { client, order } = await scenario();

      const { paymentId } = await initiateFor(order, client);
      const original = await Payment.findById(paymentId);

      const retry = await initiateFor(order, client);

      // Mismo intento, misma referencia: un reintento no es un cobro nuevo.
      expect(retry.paymentId).toBe(paymentId);
      const updated = await Payment.findById(paymentId);
      expect(updated!.reference).toBe(original!.reference);
      expect(await Payment.countDocuments({ orderId: order._id })).toBe(1);
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

  // ── Endurecimiento nuevo ────────────────────────────────────────────

  describe('Un pedido tiene como mucho un intento de cobro abierto', () => {
    const autoApprove = config.payments.sandbox.autoApprove;
    beforeEach(() => { config.payments.sandbox.autoApprove = false; });
    afterEach(() => { config.payments.sandbox.autoApprove = autoApprove; });

    it('dos checkouts simultáneos producen un solo intento, no dos enlaces cobrables', async () => {
      const { client, order } = await scenario();

      // El caso real: doble toque en "Pagar", o el reintento automático de
      // una petición que pareció fallar. Antes los dos pasaban la
      // comprobación de "¿ya hay uno pendiente?" antes de que ninguno la
      // hubiera escrito, y salían dos referencias distintas: dos enlaces de
      // Wompi vivos para el mismo pedido, cada uno cobrable por su cuenta.
      const [a, b] = await Promise.all([
        initiateFor(order, client),
        initiateFor(order, client),
      ]);

      expect(await Payment.countDocuments({ orderId: order._id })).toBe(1);
      expect(a.paymentId).toBe(b.paymentId);
      expect(a.intent.id).toBe(b.intent.id);
    });

    it('cinco a la vez siguen dejando un solo intento', async () => {
      const { client, order } = await scenario();

      const results = await Promise.all(
        Array.from({ length: 5 }, () => initiateFor(order, client))
      );

      expect(await Payment.countDocuments({ orderId: order._id })).toBe(1);
      expect(new Set(results.map((r) => r.paymentId)).size).toBe(1);
    });
  });

  describe('El estado del cobro no puede aplicarse dos veces', () => {
    it('dos entregas del mismo hecho solo mueven el pago una vez', async () => {
      const { client, order } = await scenario();
      const { intent } = await initiateFor(order, client);

      // Dos eventos distintos —claves distintas, así que la deduplicación
      // por `eventKey` no los frena— que dicen lo mismo. Es lo que ocurre
      // cuando el webhook de Wompi y el `sync()` que dispara la app (cada 3
      // segundos mientras el pago está pendiente) coinciden en el tiempo.
      const payloads = ['evt-a', 'evt-b'].map((id) =>
        JSON.stringify({
          eventId: id,
          paymentId: intent.id,
          status: 'approved',
          amount: order.finance.customerTotal,
        })
      );

      const results = await Promise.all(
        payloads.map((p) => paymentService.handleWebhook(p, provider.sign(p)))
      );

      expect(results.every((r) => r.accepted)).toBe(true);

      // Un solo asiento de captura en el libro mayor.
      const capturas = await LedgerEntry.countDocuments({
        orderId: order._id,
        event: LedgerEventType.PAYMENT_CAPTURED,
        account: LedgerAccount.CUSTOMER_PAYMENT,
      });
      expect(capturas).toBe(1);

      // Y una sola transición a PAID en la historia del pago.
      const payment = await Payment.findOne({ orderId: order._id });
      const aPagado = payment!.statusHistory.filter((h) => h.status === PaymentStatus.PAID);
      expect(aPagado.length).toBe(1);

      expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
    });
  });

  describe('Un pedido cancelado no se liquida aunque llegue el cobro', () => {
    const autoApprove = config.payments.sandbox.autoApprove;
    beforeEach(() => { config.payments.sandbox.autoApprove = false; });
    afterEach(() => { config.payments.sandbox.autoApprove = autoApprove; });

    it('reconoce el dinero pero no libera las liquidaciones', async () => {
      const { client, owner, order } = await scenario();
      const { intent } = await initiateFor(order, client);

      // El cliente abandona el checkout y el comercio cancela. Las cuentas
      // se deshacen y el intento queda invalidado.
      await orderService.updateStatus(
        order._id.toString(),
        OrderStatus.CANCELLED,
        owner._id.toString(),
        UserRole.BUSINESS,
        'El cliente no completó el pago'
      );

      // Pero el enlace seguía vivo y lo paga igualmente.
      const payload = JSON.stringify({
        eventId: 'evt-tarde',
        paymentId: intent.id,
        status: 'approved',
        amount: order.finance.customerTotal,
      });
      const res = await paymentService.handleWebhook(payload, provider.sign(payload));
      expect(res.accepted).toBe(true);

      // El cobro consta —el dinero entró de verdad— y queda marcado para
      // que una persona decida el reembolso.
      const payment = await Payment.findOne({ orderId: order._id });
      expect(payment!.status).toBe(PaymentStatus.PAID);
      expect(payment!.metadata?.requiresReview).toBe(true);

      // Lo que NO pasa: pagarle al comercio un pedido cancelado.
      const payouts = await Payout.find({ orderId: order._id });
      expect(payouts.some((p) => p.status === PayoutStatus.PAYABLE)).toBe(false);
    });
  });

  describe('La moneda es parte del importe', () => {
    // Con la aprobación automática del sandbox el pago nacería ya en PAID, y
    // la comprobación de idempotencia saldría antes de llegar a la divisa.
    // Lo que se examina aquí es un cobro pendiente que recibe su evento.
    const autoApprove = config.payments.sandbox.autoApprove;
    beforeEach(() => { config.payments.sandbox.autoApprove = false; });
    afterEach(() => { config.payments.sandbox.autoApprove = autoApprove; });

    it('rechaza un evento que declara otra divisa', async () => {
      const { client, order } = await scenario();
      const { intent } = await initiateFor(order, client);

      await expect(
        paymentService.applyGatewayStatus(intent.id, 'approved', order.finance.customerTotal, {
          currency: 'USD',
          source: 'webhook',
        })
      ).rejects.toThrow(/moneda/i);

      const untouched = await Order.findById(order._id);
      expect(untouched!.paymentStatus).not.toBe(PaymentStatus.PAID);
    });
  });

  describe('Una pasarela no puede cerrar un cobro en efectivo', () => {
    it('ignora un evento de pasarela apuntado a un pago contra entrega', async () => {
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

      const cash = await Payment.findOne({ orderId: order._id });
      expect(cash!.status).toBe(PaymentStatus.PENDING_CASH);

      const { changed } = await paymentService.applyGatewayStatus(
        cash!.reference!,
        'approved',
        cash!.amount,
        { source: 'webhook' }
      );

      expect(changed).toBe(false);
      const after = await Payment.findById(cash!._id);
      expect(after!.status).toBe(PaymentStatus.PENDING_CASH);
    });
  });
});
