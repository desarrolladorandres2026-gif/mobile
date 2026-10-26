import { describe, expect, it } from 'vitest';
import { attentionItems, fillMonths, homeRanges, localDay, share, wholeAmount } from './home.js';

const totals = (o) => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0, ...o });

describe('inicio', () => {
  it('formatea importes sin centavos', () => {
    expect(wholeAmount(123456700, 'COP')).toBe('1.234.567');
    expect(wholeAmount(0, 'COP')).toBe('0');
  });

  it('usa el día local, no el UTC', () => {
    expect(localDay(new Date(2026, 9, 5, 23, 30))).toBe('2026-10-05');
  });

  it('calcula seis meses cruzando el año', () => {
    const r = homeRanges(new Date(2026, 1, 15));
    expect(r.monthKeys).toEqual(['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02']);
    expect(r.monthsFrom).toBe('2025-09-01');
    expect(r.yearStart).toBe('2026-01-01');
  });

  it('rellena los meses sin ventas con ceros', () => {
    const rows = fillMonths(['2026-09', '2026-10'], [{ key: '2026-10', invoices: 2, subtotal: 500 }]);
    expect(rows).toEqual([{ key: '2026-09', invoices: 0, subtotal: 0 }, { key: '2026-10', invoices: 2, subtotal: 500 }]);
  });

  it('share no divide por cero ni muestra negativos', () => {
    expect(share(1, 0)).toBe(0);
    expect(share(-5, 100)).toBe(0);
    expect(share(25, 100)).toBe(25);
  });

  it('no señala nada si todo está al día', () => {
    const out = attentionItems({ onboarding: { requiredPending: 0, sandbox: false }, receivables: { totals: totals({ current: 100, total: 100 }) }, payables: { totals: totals({}) }, lowStock: [] }, 'COP');
    expect(out).toEqual([]);
  });

  it('ordena: configuración, cartera, pagos, existencias; omite lo que no cargó', () => {
    const out = attentionItems(
      {
        onboarding: { requiredPending: 2, sandbox: false },
        receivables: { totals: totals({ current: 100, d1_30: 50, d90plus: 20, total: 170 }) },
        payables: { totals: totals({ d1_30: 40, total: 40 }) },
        lowStock: [{ name: 'Tornillo' }],
      },
      'COP',
    );
    expect(out.map((i) => i.key)).toEqual(['setup', 'receivables', 'payables', 'stock']);
    expect(attentionItems({ onboarding: null, receivables: null, payables: null, lowStock: null }, 'COP')).toEqual([]);
  });
});
