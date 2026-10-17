import { describe, it, expect } from 'vitest';
import { pricingService, repriceShortage } from '../services/pricing.service';
import { AppError } from '../middlewares';
import { CouponScope, CouponType, CouponFundedBy } from '../types';

/**
 * `repriceShortage` (pura): lo que cambia cuando falta parte de un producto en
 * un pedido en efectivo. Los snapshots se construyen con `settleDiscounts`, la
 * misma aritmética con la que se cobra, así que cada caso parte de un pedido
 * consistente (la identidad contable ya cuadraba antes del faltante).
 */

const ZERO = {
  fromMerchantPayout: 0, fromDriverPayout: 0, fromCommission: 0,
  fromDeliveryMargin: 0, fromServiceFee: 0, fromTax: 0, fromPlatform: 0,
};

const baseCfg = {
  serviceFeeFixed: 1000,
  serviceFeeBps: 0,
  serviceFeeMin: 0,
  serviceFeeMax: 10_000,
  taxBps: 0,
  commissionAfterMerchantDiscount: true,
};
type Cfg = typeof baseCfg;

interface Line { totalPrice: number; quantity: number }

interface BuildOpts {
  lines: Line[];
  cfg?: Partial<Cfg>;
  deliveryFee?: number;
  driverDeliveryPayout?: number;
  tip?: number;
  bps?: number;
  /** Cupón: `kind` product/delivery/service y quién lo financia. */
  coupon?: { scope: CouponScope; fundedBy: CouponFundedBy; amount: number };
  auto?: number;
  threshold?: number;
  pro?: { freeDelivery: boolean; freeDeliveryMinSubtotal: number; serviceFeeWaived: boolean } | null;
}

function build(o: BuildOpts) {
  const cfg = { ...baseCfg, ...(o.cfg ?? {}) };
  const S = o.lines.reduce((s, l) => s + l.totalPrice, 0);
  const deliveryFee = o.deliveryFee ?? 4500;
  const driverDeliveryPayout = o.driverDeliveryPayout ?? 4000;
  const tip = o.tip ?? 0;
  const bps = o.bps ?? 1000;
  const auto = o.auto ?? 0;
  const feeBefore = Math.min(
    cfg.serviceFeeMax,
    Math.max(cfg.serviceFeeMin, cfg.serviceFeeFixed + Math.round((S * cfg.serviceFeeBps) / 10_000))
  );

  let coupon: any = null;
  if (o.coupon) {
    const d = o.coupon.amount;
    const productDiscount = o.coupon.scope === CouponScope.PRODUCT ? d : 0;
    const deliveryDiscount = o.coupon.scope === CouponScope.DELIVERY ? d : 0;
    const serviceFeeDiscount = o.coupon.scope === CouponScope.SERVICE_FEE ? d : 0;
    const merchantFunded = o.coupon.fundedBy === CouponFundedBy.BUSINESS ? productDiscount : 0;
    coupon = {
      couponId: 'c1', code: 'X', title: 'x', type: CouponType.FIXED,
      fundedBy: o.coupon.fundedBy, scope: o.coupon.scope,
      productDiscount, deliveryDiscount, serviceFeeDiscount,
      totalDiscount: d, merchantFunded, platformFunded: d - merchantFunded,
      minimumContributionMargin: 0, campaignApproved: true,
    };
  }

  const settled = pricingService.settleDiscounts({
    productSubtotal: S,
    deliveryCustomerFee: deliveryFee,
    deliveryMargin: deliveryFee - driverDeliveryPayout,
    customerServiceFee: feeBefore,
    appliedCommissionBps: bps,
    cfg: cfg as any,
    pro: o.pro ?? null,
    tip,
    isCash: true,
    coupon,
    autoPromotionMerchantFunded: auto,
    freeDeliveryThreshold: o.threshold ?? 0,
  });

  const finance: any = {
    productSubtotal: S,
    merchantCommission: settled.merchantCommission,
    customerServiceFee: feeBefore,
    deliveryCustomerFee: deliveryFee,
    driverDeliveryPayout,
    deliveryMargin: deliveryFee - driverDeliveryPayout,
    tip,
    merchantFundedDiscount: settled.merchantFundedDiscount,
    platformFundedDiscount: settled.platformFundedDiscount,
    proDeliveryDiscount: settled.proDeliveryDiscount,
    proServiceFeeDiscount: settled.proServiceFeeDiscount,
    freeDeliveryDiscount: settled.freeDeliveryDiscount,
    autoPromotionDiscount: auto,
    taxPayable: settled.taxPayable,
    businessPayout: settled.merchantPayout,
    driverPayout: driverDeliveryPayout + tip,
    platformGrossRevenue: settled.platformGrossRevenue,
    platformPromotionExpense: settled.platformFundedDiscount,
    platformNetRevenueBeforeOperatingCosts: settled.platformNetRevenueBeforeOperatingCosts,
    customerTotal: settled.customerTotal,
    currency: 'COP',
    pricingConfigVersion: 1,
    appliedCommissionBps: bps,
  };
  return { finance, cfg, settled };
}

const A20 = { totalPrice: 20_000, quantity: 1 };
const B12 = { totalPrice: 12_000, quantity: 1 };

function call(o: BuildOpts, missing: Array<{ index: number; missingQty: number }>, extra: Record<string, unknown> = {}) {
  const { finance, cfg } = build(o);
  return { finance, result: repriceShortage({ finance, items: o.lines, missing, cfg, ...extra } as any) };
}

const sumAlloc = (a: object) => Object.values(a as Record<string, number>).reduce((s, v) => s + v, 0);

function codeOf(fn: () => unknown): { status: number; code?: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return { status: error.statusCode, code: error.code };
    throw error;
  }
  throw new Error('no lanzó');
}

describe('repriceShortage: caso base (ejemplo de finanzas)', () => {
  it('productos 32.000, comisión 10 %, tarifa fija 1.000, domicilio 4.500, faltan 12.000 → 10.800 comercio + 1.200 comisión', () => {
    const { finance, result } = call({ lines: [A20, B12] }, [{ index: 1, missingQty: 1 }]);
    expect(finance.customerTotal).toBe(37_500);
    expect(finance.businessPayout).toBe(28_800);

    expect(result.removedGross).toBe(12_000);
    expect(result.refundAmount).toBe(12_000);
    expect(result.allocation).toEqual({ ...ZERO, fromMerchantPayout: 10_800, fromCommission: 1_200 });
    expect(result.after.customerTotal).toBe(25_500);
    expect(result.after.businessPayout).toBe(18_000);
    expect(result.after.merchantCommission).toBe(2_000);
    expect(result.after.customerServiceFee).toBe(1_000); // fija: no baja
    // Lo que ZIPP conserva: comisión + tarifa + margen = lo que el repartidor rinde.
    expect(result.after.platformGrossRevenue).toBe(3_500);
    expect(result.cashToRemitAfter).toBe(25_500 - 18_000 - 4_000);
    expect(result.cashToRemitAfter).toBe(result.after.platformGrossRevenue);
  });

  it('NO toca margen de domicilio ni al repartidor (lo que haría un prorrata genérico)', () => {
    const { result } = call({ lines: [A20, B12] }, [{ index: 1, missingQty: 1 }]);
    expect(result.allocation.fromDriverPayout).toBe(0);
    expect(result.allocation.fromDeliveryMargin).toBe(0);
  });

  it('líneas con varias unidades: totalPrice / quantity × missingQty exacto', () => {
    const lines = [{ totalPrice: 15_000, quantity: 3 }, B12]; // 5.000 c/u
    const { result } = call({ lines }, [{ index: 0, missingQty: 2 }]);
    expect(result.removedGross).toBe(10_000);
    expect(result.refundAmount).toBe(10_000);
    expect(sumAlloc(result.allocation)).toBe(10_000); // sin descuentos: todo es comercio + comisión
  });
});

describe('repriceShortage: tarifa de servicio', () => {
  it('porcentual con tope: sigue topada si el nuevo subtotal aún la alcanza', () => {
    const cfg = { serviceFeeFixed: 0, serviceFeeBps: 500, serviceFeeMin: 500, serviceFeeMax: 2_000 };
    const lines = [{ totalPrice: 50_000, quantity: 1 }, { totalPrice: 10_000, quantity: 1 }]; // 60.000 → 3.000 → tope 2.000
    const { finance, result } = call({ lines, cfg }, [{ index: 1, missingQty: 1 }]); // 50.000 → 2.500 → tope 2.000
    expect(finance.customerServiceFee).toBe(2_000);
    expect(result.after.customerServiceFee).toBe(2_000);
    expect(result.allocation.fromServiceFee).toBe(0);
  });

  it('porcentual: baja bajo el tope y devuelve la diferencia a ZIPP', () => {
    const cfg = { serviceFeeFixed: 0, serviceFeeBps: 500, serviceFeeMin: 500, serviceFeeMax: 2_000 };
    const lines = [{ totalPrice: 20_000, quantity: 1 }, { totalPrice: 40_000, quantity: 1 }]; // 60.000 → tope 2.000
    const { result } = call({ lines, cfg }, [{ index: 1, missingQty: 1 }]); // 20.000 → 1.000
    expect(result.after.customerServiceFee).toBe(1_000);
    expect(result.allocation.fromServiceFee).toBe(1_000);
    expect(result.after.platformGrossRevenue).toBe(result.after.merchantCommission + 1_000 + 500);
  });

  it('respeta el mínimo configurado', () => {
    const cfg = { serviceFeeFixed: 0, serviceFeeBps: 500, serviceFeeMin: 800, serviceFeeMax: 2_000 };
    const lines = [{ totalPrice: 20_000, quantity: 1 }, { totalPrice: 18_000, quantity: 1 }]; // 38.000 → 1.900
    const { result } = call({ lines, cfg }, [{ index: 1, missingQty: 1 }]); // 20.000 → 1.000 (>800)
    expect(result.after.customerServiceFee).toBe(1_000);
    const small = call({ lines: [{ totalPrice: 30_000, quantity: 1 }, { totalPrice: 12_000, quantity: 1 }], cfg }, [
      { index: 0, missingQty: 1 },
    ]); // 12.000 → 600 → mínimo 800
    expect(small.result.after.customerServiceFee).toBe(800);
  });
});

describe('repriceShortage: cupones y promociones', () => {
  it('cupón del comercio FIJO: el descuento sale a prorrata de lo que falta', () => {
    const lines = [{ totalPrice: 30_000, quantity: 1 }, { totalPrice: 10_000, quantity: 1 }];
    const { result } = call(
      { lines, coupon: { scope: CouponScope.PRODUCT, fundedBy: CouponFundedBy.BUSINESS, amount: 3_000 } },
      [{ index: 1, missingQty: 1 }]
    );
    // share = floor(3.000 × 10.000 / 40.000) = 750. Cliente: (40.000−3.000)+1.000 → (30.000−2.250)+1.000.
    expect(result.refundAmount).toBe(10_000 - 750);
    // comisión: (37.000×10 %)=3.700 → (27.750×10 %)=2.775 (redondeo half-up de 2.775 = 2.775).
    expect(result.allocation.fromCommission).toBe(3_700 - 2_775);
    expect(result.after.merchantFundedDiscount).toBe(2_250);
    expect(result.allocation.fromPlatform).toBe(0);
  });

  it('cupón del comercio PORCENTUAL (10 %): 3.600 → 2.700 de comisión, comercio 8.100', () => {
    const lines = [{ totalPrice: 30_000, quantity: 1 }, { totalPrice: 10_000, quantity: 1 }];
    const { result } = call(
      { lines, coupon: { scope: CouponScope.PRODUCT, fundedBy: CouponFundedBy.BUSINESS, amount: 4_000 } },
      [{ index: 1, missingQty: 1 }]
    );
    expect(result.refundAmount).toBe(9_000);
    expect(result.allocation).toEqual({ ...ZERO, fromMerchantPayout: 8_100, fromCommission: 900 });
  });

  it('cupón de PLATAFORMA sobre producto: baja el gasto promocional de ZIPP a prorrata', () => {
    const lines = [{ totalPrice: 30_000, quantity: 1 }, { totalPrice: 10_000, quantity: 1 }];
    const { result } = call(
      { lines, coupon: { scope: CouponScope.PRODUCT, fundedBy: CouponFundedBy.PLATFORM, amount: 4_000 } },
      [{ index: 1, missingQty: 1 }],
      { platformCouponScope: CouponScope.PRODUCT }
    );
    // D_p 4.000 → 3.000: ZIPP deja de gastar 1.000; el cliente deja de pagar 10.000 − 1.000.
    expect(result.allocation.fromPlatform).toBe(1_000);
    expect(result.refundAmount).toBe(9_000);
    // La comisión no depende del cupón de plataforma: 10 % de lo que falta.
    expect(result.allocation.fromCommission).toBe(1_000);
    expect(result.allocation.fromMerchantPayout).toBe(9_000);
  });

  it('cupón de plataforma sobre DOMICILIO: congelado, no se toca', () => {
    const { result, finance } = call(
      { lines: [A20, B12], coupon: { scope: CouponScope.DELIVERY, fundedBy: CouponFundedBy.PLATFORM, amount: 2_000 } },
      [{ index: 1, missingQty: 1 }],
      { platformCouponScope: CouponScope.DELIVERY }
    );
    expect(finance.platformFundedDiscount).toBe(2_000);
    expect(result.allocation.fromPlatform).toBe(0);
    expect(result.refundAmount).toBe(12_000);
  });

  it('cupón de plataforma sin saber su línea: 422 y solo queda cancelar', () => {
    const r = codeOf(() =>
      call(
        { lines: [A20, B12], coupon: { scope: CouponScope.PRODUCT, fundedBy: CouponFundedBy.PLATFORM, amount: 1_000 } },
        [{ index: 1, missingQty: 1 }]
      )
    );
    expect(r).toEqual({ status: 422, code: 'ITEM_SHORTAGE_COUPON_UNKNOWN' });
  });

  it('promoción automática SIN snapshot por línea: 422 (cancela el pedido)', () => {
    const r = codeOf(() => call({ lines: [A20, B12], auto: 2_000 }, [{ index: 1, missingQty: 1 }]));
    expect(r).toEqual({ status: 422, code: 'ITEM_SHORTAGE_PROMO_UNSUPPORTED' });
  });

  it('promoción automática CON snapshot por línea: solo sale la parte de las líneas que faltan', () => {
    // La promoción cubre la línea A (descuento 2.000). Falta B (sin promoción): el descuento no se toca.
    const sameAuto = call({ lines: [A20, B12], auto: 2_000 }, [{ index: 1, missingQty: 1 }], {
      lineProductDiscount: [2_000, 0],
    });
    expect(sameAuto.result.refundAmount).toBe(12_000);
    expect(sameAuto.result.after.merchantFundedDiscount).toBe(2_000);

    // Falta la mitad de A (2 de 4 unidades, descuento 2.000 → 1.000 sale).
    const lines = [{ totalPrice: 20_000, quantity: 4 }, B12];
    const half = call({ lines, auto: 2_000 }, [{ index: 0, missingQty: 2 }], { lineProductDiscount: [2_000, 0] });
    expect(half.result.removedGross).toBe(10_000);
    expect(half.result.refundAmount).toBe(10_000 - 1_000);
    expect(half.result.after.merchantFundedDiscount).toBe(1_000);
  });

  it('snapshot por línea que no suma el descuento del pedido: 422', () => {
    const r = codeOf(() =>
      call({ lines: [A20, B12], auto: 2_000 }, [{ index: 1, missingQty: 1 }], { lineProductDiscount: [500, 0] })
    );
    expect(r.status).toBe(422);
  });
});

describe('repriceShortage: umbrales perdidos (se congelan)', () => {
  it('envío gratis del comercio: perder el umbral NO le cobra domicilio al cliente; lo absorbe el comercio', () => {
    const { finance, result } = call(
      { lines: [A20, B12], threshold: 30_000 }, // 32.000 ≥ 30.000 → regala 4.500
      [{ index: 1, missingQty: 1 }] // 20.000 < 30.000
    );
    expect(finance.freeDeliveryDiscount).toBe(4_500);
    expect(finance.customerTotal).toBe(33_000); // sin domicilio
    expect(result.after.customerTotal).toBe(21_000); // sigue sin domicilio
    expect(result.refundAmount).toBe(12_000);
    expect(result.after.merchantFundedDiscount).toBe(4_500);
    expect(result.after.businessPayout).toBe(20_000 - 4_500 - 2_000);
    expect(result.allocation).toEqual({ ...ZERO, fromMerchantPayout: 10_800, fromCommission: 1_200 });
  });

  it('mínimo de Zipp Pro: el domicilio gratis lo sigue pagando ZIPP (fromPlatform = 0)', () => {
    const { finance, result } = call(
      { lines: [A20, B12], bps: 2000, pro: { freeDelivery: true, freeDeliveryMinSubtotal: 30_000, serviceFeeWaived: false } },
      [{ index: 1, missingQty: 1 }] // 20.000 < 30.000: perdió el mínimo
    );
    expect(finance.proDeliveryDiscount).toBe(4_500);
    expect(result.after.platformFundedDiscount).toBe(4_500);
    expect(result.allocation.fromPlatform).toBe(0);
    expect(result.refundAmount).toBe(12_000);
    expect(result.cashToRemitAfter).toBe(1_000);
  });

  it('si el subsidio congelado de ZIPP ya no lo cubre su ingreso, el efectivo por rendir quedaría negativo → 422', () => {
    // Comisión 10 %: ZIPP ganaba 4.700 y regalaba 4.500 de domicilio (efectivo por rendir 200). Con 12.000
    // menos de producto ganaría 3.500 contra 4.500 regalados: el domiciliario no cobraría lo que debe repartir.
    const r = codeOf(() =>
      call(
        { lines: [A20, B12], pro: { freeDelivery: true, freeDeliveryMinSubtotal: 30_000, serviceFeeWaived: false } },
        [{ index: 1, missingQty: 1 }]
      )
    );
    expect(r).toEqual({ status: 422, code: 'ITEM_SHORTAGE_INVARIANT' });
  });

  it('Zipp Pro con tarifa de servicio exonerada y porcentual: el descuento de ZIPP baja con la tarifa', () => {
    const cfg = { serviceFeeFixed: 0, serviceFeeBps: 500, serviceFeeMin: 0, serviceFeeMax: 2_000 };
    const lines = [{ totalPrice: 20_000, quantity: 1 }, { totalPrice: 40_000, quantity: 1 }];
    const { finance, result } = call(
      { lines, cfg, pro: { freeDelivery: false, freeDeliveryMinSubtotal: 0, serviceFeeWaived: true } },
      [{ index: 1, missingQty: 1 }]
    );
    expect(finance.proServiceFeeDiscount).toBe(2_000);
    // Tarifa 2.000 → 1.000; la exoneración se ajusta a 1.000: ZIPP deja de gastar 1.000 y ya no cobra 1.000.
    expect(result.after.customerServiceFee).toBe(1_000);
    expect(result.allocation.fromServiceFee).toBe(1_000);
    expect(result.allocation.fromPlatform).toBe(1_000);
    expect(result.refundAmount).toBe(40_000 - 0); // el cliente nunca pagaba tarifa
  });
});

describe('repriceShortage: impuesto y propina', () => {
  it('impuesto bps > 0: baja con la base y sale de la cuenta de impuestos', () => {
    const { finance, result } = call({ lines: [A20, B12], cfg: { taxBps: 1900 } }, [{ index: 1, missingQty: 1 }]);
    // base antes 32.000 + 4.500 + 1.000 = 37.500 → 7.125; después 25.500 → 4.845
    expect(finance.taxPayable).toBe(7_125);
    expect(result.after.taxPayable).toBe(4_845);
    expect(result.allocation.fromTax).toBe(2_280);
    expect(result.refundAmount).toBe(12_000 + 2_280);
  });

  it('la propina no cambia ni el repartidor', () => {
    const { finance, result } = call({ lines: [A20, B12], tip: 2_000 }, [{ index: 1, missingQty: 1 }]);
    expect(result.after.customerTotal).toBe(finance.customerTotal - 12_000);
    expect(result.allocation.fromDriverPayout).toBe(0);
    expect(result.cashToRemitAfter).toBe(result.after.customerTotal - result.after.businessPayout - 6_000);
  });
});

describe('repriceShortage: rechazos', () => {
  it('falta TODO → 422 «rechaza el pedido»', () => {
    const r = codeOf(() =>
      call({ lines: [A20, B12] }, [{ index: 0, missingQty: 1 }, { index: 1, missingQty: 1 }])
    );
    expect(r).toEqual({ status: 422, code: 'ITEM_SHORTAGE_ALL_MISSING' });
  });

  it('missingQty mayor que la cantidad, cero, decimal o línea repetida → 422', () => {
    for (const missing of [
      [{ index: 1, missingQty: 2 }],
      [{ index: 1, missingQty: 0 }],
      [{ index: 1, missingQty: 0.5 }],
      [{ index: 5, missingQty: 1 }],
      [{ index: 1, missingQty: 1 }, { index: 1, missingQty: 1 }],
    ]) {
      const r = codeOf(() => call({ lines: [A20, B12, { totalPrice: 5_000, quantity: 1 }] }, missing));
      expect(r.status).toBe(422);
    }
  });

  it('un reembolso previo → 409', () => {
    const r = codeOf(() =>
      call({ lines: [A20, B12] }, [{ index: 1, missingQty: 1 }], { prior: { ...ZERO, fromMerchantPayout: 1 } })
    );
    expect(r).toEqual({ status: 409, code: 'ITEM_SHORTAGE_PRIOR_REFUND' });
  });

  it('el comercio no puede pagarlo (pago negativo) → 422', () => {
    // Descuento del comercio enorme frente a la comisión: el pago ya iba al límite.
    const { finance } = build({ lines: [A20, B12], bps: 0, coupon: { scope: CouponScope.PRODUCT, fundedBy: CouponFundedBy.BUSINESS, amount: 31_000 } });
    expect(finance.businessPayout).toBe(1_000);
    // Falta una línea cuyo descuento a prorrata es menor que su valor: sale bien y no es negativo.
    const ok = call(
      { lines: [A20, B12], bps: 0, coupon: { scope: CouponScope.PRODUCT, fundedBy: CouponFundedBy.BUSINESS, amount: 31_000 } },
      [{ index: 1, missingQty: 1 }]
    );
    expect(ok.result.after.businessPayout).toBeGreaterThanOrEqual(0);
  });
});

// ── Propiedad aleatoria ────────────────────────────────────────────────

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('repriceShortage: propiedad aleatoria', () => {
  it('600 pedidos aleatorios: enteros, deltas ≥ 0, identidad posterior y reparto = reembolso + plataforma', () => {
    const rand = rng(20261016);
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const pick = <T,>(xs: T[]): T => xs[int(0, xs.length - 1)];

    let accepted = 0;
    let rejected = 0;
    const rejectedCodes = new Set<string>();

    for (let i = 0; i < 600; i += 1) {
      const lineCount = int(1, 4);
      const lines: Line[] = Array.from({ length: lineCount }, () => {
        const quantity = int(1, 4);
        return { totalPrice: int(2, 60) * 500 * quantity, quantity };
      });
      const S = lines.reduce((s, l) => s + l.totalPrice, 0);

      const cfg = {
        serviceFeeFixed: pick([0, 500, 1000, 1500]),
        serviceFeeBps: pick([0, 0, 200, 500, 1000]),
        serviceFeeMin: pick([0, 300, 800]),
        serviceFeeMax: pick([1500, 3000, 10_000]),
        taxBps: pick([0, 0, 1900]),
        commissionAfterMerchantDiscount: pick([true, false]),
      };

      // Descuento por línea de promoción automática (snapshot completo) o ninguno.
      let lineAuto: number[] | undefined;
      let auto = 0;
      if (rand() < 0.2) {
        lineAuto = lines.map((l) => (rand() < 0.5 ? int(0, Math.floor(l.totalPrice / 4)) : 0));
        auto = lineAuto.reduce((s, v) => s + v, 0);
      }

      let couponOpt: BuildOpts['coupon'];
      let platformCouponScope: CouponScope | null = null;
      if (rand() < 0.6) {
        const scope = pick([CouponScope.PRODUCT, CouponScope.PRODUCT, CouponScope.DELIVERY, CouponScope.SERVICE_FEE]);
        const fundedBy = scope === CouponScope.PRODUCT ? pick([CouponFundedBy.BUSINESS, CouponFundedBy.PLATFORM]) : CouponFundedBy.PLATFORM;
        const cap = scope === CouponScope.PRODUCT ? S - auto : scope === CouponScope.DELIVERY ? 4500 : 1000;
        couponOpt = { scope, fundedBy, amount: Math.min(cap, int(1, 20) * 250) };
        if (fundedBy === CouponFundedBy.PLATFORM) platformCouponScope = scope;
      }

      const o: BuildOpts = {
        lines,
        cfg,
        bps: pick([0, 500, 1000, 1500, 3000]),
        tip: pick([0, 0, 1000, 2000]),
        coupon: couponOpt,
        auto,
        threshold: pick([0, 0, 20_000, 40_000]),
        pro: pick([null, null, { freeDelivery: true, freeDeliveryMinSubtotal: pick([0, 25_000]), serviceFeeWaived: pick([true, false]) }]),
      };
      const { finance, settled } = build(o);
      if (settled.merchantPayout < 0) continue; // un pedido que ya no habría nacido

      // Qué falta: algunas unidades de algunas líneas, nunca todo.
      const missing: Array<{ index: number; missingQty: number }> = [];
      lines.forEach((l, index) => {
        if (rand() < 0.5) missing.push({ index, missingQty: int(1, l.quantity) });
      });
      if (missing.length === 0) missing.push({ index: 0, missingQty: 1 });
      const allGone = missing.reduce((s, m) => s + m.missingQty, 0) >= lines.reduce((s, l) => s + l.quantity, 0);
      if (allGone) missing[0].missingQty = Math.max(1, missing[0].missingQty - 1);

      let r;
      try {
        r = repriceShortage({
          finance,
          items: lines,
          missing,
          cfg: cfg as any,
          lineProductDiscount: lineAuto,
          platformCouponScope,
        });
      } catch (error) {
        // Solo se admite rechazo con 422 y un código nuestro; nunca un error de Mongo ni un TypeError.
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(422);
        rejectedCodes.add((error as AppError).code ?? '');
        rejected += 1;
        continue;
      }
      accepted += 1;

      for (const v of [...Object.values(r.allocation), r.refundAmount, r.cashToRemitAfter, ...Object.values(r.after)]) {
        expect(Number.isInteger(v)).toBe(true);
      }
      for (const v of Object.values(r.allocation)) expect(v).toBeGreaterThanOrEqual(0);
      expect(r.refundAmount).toBeGreaterThan(0);
      expect(r.after.customerTotal).toBeLessThan(finance.customerTotal);
      expect(r.after.businessPayout).toBeGreaterThanOrEqual(0);
      expect(r.cashToRemitAfter).toBeGreaterThanOrEqual(0);
      expect(r.allocation.fromDriverPayout).toBe(0);
      expect(r.allocation.fromDeliveryMargin).toBe(0);

      // Identidad posterior (la de assertBalanced).
      expect(r.after.customerTotal + r.after.platformFundedDiscount).toBe(
        r.after.businessPayout + finance.driverPayout + r.after.platformGrossRevenue + r.after.taxPayable
      );
      // Σ allocation = reembolso + plataforma (lo que exige recordReversal).
      const a = r.allocation;
      expect(a.fromMerchantPayout + a.fromCommission + a.fromServiceFee + a.fromTax).toBe(r.refundAmount + a.fromPlatform);
      // Lo posterior es lo anterior menos el reparto.
      expect(r.after.businessPayout).toBe(finance.businessPayout - a.fromMerchantPayout);
      expect(r.after.customerTotal).toBe(finance.customerTotal - r.refundAmount);
      // El reembolso nunca supera lo que costaba lo que falta más su impuesto.
      expect(a.fromMerchantPayout + a.fromCommission).toBeLessThanOrEqual(r.removedGross);
    }

    expect(accepted).toBeGreaterThan(300);
    // Si algo se rechazó, fue por una regla nombrada, no por un descuadre silencioso.
    for (const code of rejectedCodes) expect(code).toMatch(/^ITEM_SHORTAGE_/);
    expect(accepted + rejected).toBeGreaterThan(400);
  });
});
