import { describe, it, expect, beforeEach } from 'vitest';
import { SandboxPaymentProvider } from '../services/payments/sandbox.provider';
import { toPaymentStatus } from '../services/payments';
import { PaymentStatus } from '../types';

const customer = { name: 'Cliente', phone: '3101234567' };

const input = (amount: number) => ({
  orderId: 'order-1',
  userId: 'user-1',
  amount,
  currency: 'COP',
  description: 'Pedido de prueba',
  customer,
});

describe('SandboxPaymentProvider', () => {
  let provider: SandboxPaymentProvider;

  beforeEach(() => {
    provider = new SandboxPaymentProvider();
  });

  it('no requiere credenciales', () => {
    expect(provider.isConfigured()).toBe(true);
  });

  it('aprueba un pago normal y le asigna un identificador', async () => {
    const intent = await provider.createPayment(input(25000));

    expect(intent.status).toBe('approved');
    expect(intent.id).toMatch(/^sbx_/);
    expect(intent.amount).toBe(25000);
  });

  it('rechaza de forma determinista los importes con el sufijo de fallo', async () => {
    // SANDBOX_FAIL_SUFFIX por defecto es 13 → cualquier importe %100 === 13
    const intent = await provider.createPayment(input(25013));

    expect(intent.status).toBe('declined');
    expect(intent.declineReason).toBeTruthy();
  });

  it('recupera un pago creado', async () => {
    const created = await provider.createPayment(input(10000));
    const fetched = await provider.getPayment(created.id);

    expect(fetched.id).toBe(created.id);
  });

  it('falla al consultar un pago inexistente', async () => {
    await expect(provider.getPayment('sbx_noexiste')).rejects.toThrow(/no encontrado/i);
  });

  it('reembolsa un pago aprobado', async () => {
    const created = await provider.createPayment(input(30000));
    const refunded = await provider.refund(created.id);

    expect(refunded.status).toBe('refunded');
  });

  it('no reembolsa un pago rechazado', async () => {
    const declined = await provider.createPayment(input(30013));

    await expect(provider.refund(declined.id)).rejects.toThrow(/aprobados/i);
  });

  it('no reembolsa más que el monto cobrado', async () => {
    const created = await provider.createPayment(input(30000));

    await expect(provider.refund(created.id, 40000)).rejects.toThrow(/superar/i);
  });

  describe('webhooks', () => {
    it('acepta una firma válida', () => {
      const body = JSON.stringify({ paymentId: 'sbx_abc', status: 'approved' });
      expect(provider.verifyWebhookSignature(body, provider.sign(body))).toBe(true);
    });

    it('rechaza una firma manipulada', () => {
      const body = JSON.stringify({ paymentId: 'sbx_abc', status: 'approved' });
      const tampered = JSON.stringify({ paymentId: 'sbx_abc', status: 'declined' });
      expect(provider.verifyWebhookSignature(tampered, provider.sign(body))).toBe(false);
    });

    it('rechaza firmas vacías o de longitud distinta', () => {
      const body = JSON.stringify({ paymentId: 'sbx_abc' });
      expect(provider.verifyWebhookSignature(body, '')).toBe(false);
      expect(provider.verifyWebhookSignature(body, 'abc')).toBe(false);
      expect(provider.verifyWebhookSignature('', provider.sign(body))).toBe(false);
    });

    it('interpreta un evento válido', () => {
      const event = provider.parseWebhook({ paymentId: 'sbx_abc', status: 'approved', amount: 5000 });

      expect(event).toEqual(
        expect.objectContaining({ paymentId: 'sbx_abc', status: 'approved', amount: 5000 })
      );
    });

    it('descarta cargas útiles inválidas', () => {
      expect(provider.parseWebhook(null)).toBeNull();
      expect(provider.parseWebhook('texto')).toBeNull();
      expect(provider.parseWebhook({ paymentId: 'x', status: 'inventado' })).toBeNull();
      expect(provider.parseWebhook({ status: 'approved' })).toBeNull();
    });

    it('un webhook actualiza el estado local del pago', async () => {
      const created = await provider.createPayment(input(12000));
      provider.parseWebhook({ paymentId: created.id, status: 'refunded' });

      expect((await provider.getPayment(created.id)).status).toBe('refunded');
    });
  });
});

describe('toPaymentStatus', () => {
  it('traduce los estados del proveedor a los de la plataforma', () => {
    expect(toPaymentStatus('approved')).toBe(PaymentStatus.PAID);
    expect(toPaymentStatus('refunded')).toBe(PaymentStatus.REFUNDED);
    expect(toPaymentStatus('declined')).toBe(PaymentStatus.FAILED);
    expect(toPaymentStatus('cancelled')).toBe(PaymentStatus.FAILED);
    expect(toPaymentStatus('pending')).toBe(PaymentStatus.PENDING);
    expect(toPaymentStatus('processing')).toBe(PaymentStatus.PENDING);
  });
});
