import { describe, expect, it } from 'vitest';
import { balanceNotice, ledgerRows, withDepth } from './reports.js';

describe('informes: ayudas de presentación', () => {
  it('sangra cada cuenta según los prefijos que la contienen', () => {
    const rows = withDepth([{ code: '1' }, { code: '11' }, { code: '110505' }, { code: '13' }, { code: '130505' }, { code: '2' }]);
    expect(rows.map((r) => [r.code, r.depth])).toEqual([['1', 0], ['11', 1], ['110505', 2], ['13', 1], ['130505', 2], ['2', 0]]);
  });

  it('un código que solo comparte dígitos con otro no es su hijo', () => {
    expect(withDepth([{ code: '11' }, { code: '12' }, { code: '110' }]).map((r) => r.depth)).toEqual([0, 0, 1]);
  });

  it('el libro auxiliar pone el saldo inicial solo al comienzo y el final solo al terminar', () => {
    const page = (extra) => ({ items: [{ journalId: 'a', balance: 5 }], ...extra });
    const first = page({ opening: { debit: 1, credit: 0, balance: 1 }, nextCursor: 'x' });
    const lastPage = page({ closing: { debit: 9, credit: 2, balance: 7 }, nextCursor: null });
    expect(ledgerRows(first, { first: true, last: false }).map((r) => r.kind)).toEqual(['opening', 'entry']);
    expect(ledgerRows(lastPage, { first: false, last: true }).map((r) => r.kind)).toEqual(['entry', 'closing']);
    expect(ledgerRows(first, { first: false, last: false }).map((r) => r.kind)).toEqual(['entry']);
  });

  it('avisa si un informe no cuadra', () => {
    expect(balanceNotice({ balanced: true }).kind).toBe('success');
    expect(balanceNotice({ balanced: false })).toMatchObject({ kind: 'error' });
  });
});
