import { paymentPollInterval } from '../lib/paymentPolling';

describe('paymentPollInterval', () => {
  it('pregunta rápido al principio, cuando una tarjeta suele resolverse', () => {
    expect(paymentPollInterval(0)).toBe(3_000);
    expect(paymentPollInterval(29_999)).toBe(3_000);
  });

  it('se espacia mientras la persona aprueba en su app de Nequi', () => {
    expect(paymentPollInterval(30_000)).toBe(5_000);
    expect(paymentPollInterval(119_999)).toBe(5_000);
    expect(paymentPollInterval(120_000)).toBe(10_000);
  });

  it('diez minutos de espera caben en el limitador del backend (150 cada 5 min)', () => {
    let elapsed = 0;
    let requests = 0;
    const windowStart = 5 * 60_000;
    let inLastWindow = 0;
    while (elapsed < 10 * 60_000) {
      requests += 1;
      if (elapsed >= windowStart) inLastWindow += 1;
      elapsed += paymentPollInterval(elapsed);
    }
    expect(requests).toBeLessThan(150);
    expect(inLastWindow).toBeLessThan(150);
  });
});
