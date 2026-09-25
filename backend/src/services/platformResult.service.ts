import { LedgerEntry } from '../models';
import { LedgerAccount, LedgerDirection } from '../types';
import type { DateRange } from '../utils/period';

/**
 * El resultado de ZIPP en un periodo, leído del libro mayor.
 *
 * Es la ÚNICA definición de "ingreso" del panel. Dashboard, Resumen diario y
 * Finanzas leen de aquí, así que para el mismo periodo dan el mismo número.
 * Antes eran tres: `Order.platformCommission` (solo la comisión del comercio),
 * `finance.platformGrossRevenue` (una foto del cálculo al crear el pedido) y
 * el libro de todo el histórico. Solo el libro refleja lo que de verdad pasó,
 * incluidos reembolsos, ajustes y compensaciones, que reversan las cuentas de
 * ingreso con asientos de signo contrario.
 *
 * Definición (balance = débito − crédito):
 * - Ingreso bruto = −(balance de `commission_revenue` + `service_fee_revenue`
 *   + `delivery_margin_revenue`). Un ingreso es un saldo acreedor, de ahí el
 *   signo. Un margen de domicilio subsidiado se asienta como débito y por
 *   tanto RESTA del ingreso, no suma.
 * - Gastos (saldo deudor, se muestran en positivo): gasto promocional,
 *   faltantes de efectivo asumidos, tarifas de domiciliario asumidas por
 *   reembolso y arrastres incobrables.
 *
 * El periodo filtra por la fecha del asiento (`LedgerEntry.createdAt`), no
 * por la del pedido: un reembolso de hoy sobre un pedido de la semana pasada
 * le resta a hoy, que es cuando salió el dinero.
 *
 * SIEMPRE `incomplete: true`: el libro todavía no lleva la comisión de Wompi
 * ni el costo de transferencia, así que `netBeforeGatewayCosts` NO es
 * rentabilidad. Cuando esos costos entren al libro, se suman aquí y este
 * indicador podrá apagarse — no antes (regla financiera de CLAUDE.md).
 *
 * Este servicio solo LEE el libro; la escritura contable sigue siendo
 * exclusiva de `ledger.service.ts`.
 */

export const PLATFORM_RESULT_INCOMPLETE_REASON =
  'Falta el costo de transferencia de los pagos y la comisión de Wompi de los cobros anteriores a configurarla';

export interface PlatformResult {
  /** Comisión + tarifa de servicio + margen de domicilio, netos de reversos. COP entero. */
  grossRevenue: number;
  promotionExpense: number;
  cashShortageExpense: number;
  driverFeeAbsorbed: number;
  badDebt: number;
  /** Comisión estimada de la pasarela (0 mientras la tarifa esté sin configurar). */
  processingExpense: number;
  /** grossRevenue − todos los gastos anteriores. Puede ser negativo. */
  netBeforeGatewayCosts: number;
  /** `netBeforeGatewayCosts` − comisión estimada de la pasarela. */
  netAfterGatewayCosts: number;
  incomplete: true;
  incompleteReason: string;
  /** El periodo consultado; `null` en ambos extremos = todo el histórico. */
  range: { from: string | null; to: string | null };
}

const REVENUE_ACCOUNTS = [
  LedgerAccount.COMMISSION_REVENUE,
  LedgerAccount.SERVICE_FEE_REVENUE,
  LedgerAccount.DELIVERY_MARGIN_REVENUE,
] as const;

const EXPENSE_ACCOUNTS = [
  LedgerAccount.PROMOTION_EXPENSE,
  LedgerAccount.CASH_SHORTAGE_EXPENSE,
  LedgerAccount.DRIVER_FEE_ABSORBED_EXPENSE,
  LedgerAccount.BAD_DEBT_EXPENSE,
  LedgerAccount.PAYMENT_PROCESSING_EXPENSE,
] as const;

export const platformResultService = {
  /**
   * Ingreso bruto por día de Bogotá (misma definición que `forRange`), para
   * el gráfico. Solo los días con asientos de ingreso; el llamador une.
   */
  async grossRevenueByDay(range: DateRange): Promise<Array<{ _id: string; grossRevenue: number }>> {
    const rows: Array<{ _id: string; balance: number }> = await LedgerEntry.aggregate([
      {
        $match: {
          account: { $in: [...REVENUE_ACCOUNTS] },
          createdAt: { $gte: range.from, $lte: range.to },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '-05:00' } },
          balance: {
            $sum: {
              $cond: [{ $eq: ['$direction', LedgerDirection.DEBIT] }, '$amount', { $multiply: ['$amount', -1] }],
            },
          },
        },
      },
    ]);
    return rows.map((r) => ({ _id: r._id, grossRevenue: -r.balance + 0 }));
  },

  /**
   * Resultado de la plataforma en `range`; sin rango, todo el histórico.
   * Una sola agregación sobre el libro, agrupada por cuenta.
   */
  async forRange(range?: DateRange): Promise<PlatformResult> {
    const match: Record<string, unknown> = {
      account: { $in: [...REVENUE_ACCOUNTS, ...EXPENSE_ACCOUNTS] },
    };
    if (range) match.createdAt = { $gte: range.from, $lte: range.to };

    const rows: Array<{ _id: LedgerAccount; balance: number }> = await LedgerEntry.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$account',
          balance: {
            $sum: {
              $cond: [{ $eq: ['$direction', LedgerDirection.DEBIT] }, '$amount', { $multiply: ['$amount', -1] }],
            },
          },
        },
      },
    ]);

    const balance = (account: LedgerAccount) => rows.find((r) => r._id === account)?.balance ?? 0;

    const grossRevenue = -REVENUE_ACCOUNTS.reduce((sum, a) => sum + balance(a), 0);
    const promotionExpense = balance(LedgerAccount.PROMOTION_EXPENSE);
    const cashShortageExpense = balance(LedgerAccount.CASH_SHORTAGE_EXPENSE);
    const driverFeeAbsorbed = balance(LedgerAccount.DRIVER_FEE_ABSORBED_EXPENSE);
    const badDebt = balance(LedgerAccount.BAD_DEBT_EXPENSE);
    const processingExpense = balance(LedgerAccount.PAYMENT_PROCESSING_EXPENSE);

    return {
      // `+ 0` evita un `-0` cuando no hay asientos.
      grossRevenue: grossRevenue + 0,
      promotionExpense,
      cashShortageExpense,
      driverFeeAbsorbed,
      badDebt,
      processingExpense,
      netBeforeGatewayCosts:
        grossRevenue - promotionExpense - cashShortageExpense - driverFeeAbsorbed - badDebt + 0,
      netAfterGatewayCosts:
        grossRevenue - promotionExpense - cashShortageExpense - driverFeeAbsorbed - badDebt - processingExpense + 0,
      incomplete: true,
      incompleteReason: PLATFORM_RESULT_INCOMPLETE_REASON,
      range: {
        from: range ? range.from.toISOString() : null,
        to: range ? range.to.toISOString() : null,
      },
    };
  },
};
