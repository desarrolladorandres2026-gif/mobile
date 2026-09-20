import {
  pickSpotlightCoupon, isExpiringSoon, usageProgress, formatCountdown,
  bigDiscountProducts, splitBusinessOffers,
  couponStatus, indexEligibility, isUsable, scheduledCoupons, windowLabel,
} from '../lib/offers';
import type { OfferCoupon, OfferBusiness, ProductSearchHit } from '../services/endpoints';

/**
 * Las reglas de la pestaña de Descuentos, sin pantalla de por medio.
 *
 * `lib/offers.ts` decide qué cupón se lleva el spotlight, cuál se considera
 * urgente y —desde que existe la elegibilidad— qué se le puede ofrecer a
 * quien está mirando. Era lógica pura sin una sola prueba: el único sitio
 * donde se veía si estaba bien era la app corriendo.
 */

const HOUR = 3600_000;

function coupon(overrides: Partial<OfferCoupon> = {}): OfferCoupon {
  return {
    _id: 'c1',
    code: 'PROMO',
    title: 'Cupón de prueba',
    type: 'percentage',
    value: 10,
    validUntil: new Date(Date.now() + 7 * 24 * HOUR).toISOString(),
    ...overrides,
  };
}

describe('Urgencia', () => {
  it('un cupón que vence dentro de 24 h es urgente; uno de la semana que viene no', () => {
    expect(isExpiringSoon(coupon({ validUntil: new Date(Date.now() + 2 * HOUR).toISOString() }))).toBe(true);
    expect(isExpiringSoon(coupon())).toBe(false);
  });

  it('uno ya vencido no es urgente: es pasado', () => {
    expect(isExpiringSoon(coupon({ validUntil: new Date(Date.now() - HOUR).toISOString() }))).toBe(false);
  });

  it('el reloj siempre lleva dos dígitos por campo', () => {
    expect(formatCountdown(3 * HOUR + 5 * 60_000 + 9000)).toBe('03:05:09');
    expect(formatCountdown(-5000)).toBe('00:00:00');
    // Más de un día no se reinicia a cero: 26 horas son 26 horas.
    expect(formatCountdown(26 * HOUR)).toBe('26:00:00');
  });

  it('sin cupo no hay barra que pintar', () => {
    expect(usageProgress(coupon())).toBeNull();
    expect(usageProgress(coupon({ usageLimit: 100, usedCount: 25 }))).toBe(0.25);
    // Nunca pasa de lleno, aunque el contador se haya desbordado.
    expect(usageProgress(coupon({ usageLimit: 10, usedCount: 40 }))).toBe(1);
  });
});

describe('pickSpotlightCoupon', () => {
  it('sin cupones no hay destacado', () => {
    expect(pickSpotlightCoupon([])).toBeNull();
  });

  it('lo que vence antes gana al descuento más grande', () => {
    const urgente = coupon({
      _id: 'urgente', value: 5, validUntil: new Date(Date.now() + HOUR).toISOString(),
    });
    const goloso = coupon({ _id: 'goloso', value: 60 });

    expect(pickSpotlightCoupon([goloso, urgente])?._id).toBe('urgente');
  });

  it('sin nada por vencer, manda el descuento más alto', () => {
    const flojo = coupon({ _id: 'flojo', value: 10 });
    const fuerte = coupon({ _id: 'fuerte', value: 40 });

    expect(pickSpotlightCoupon([flojo, fuerte])?._id).toBe('fuerte');
  });

  it('compara tipos distintos sin que el fijo aplaste al porcentual', () => {
    // $2.000 no puede valer más que un 50%: un fijo se escala a un
    // equivalente aproximado justo para poder ordenarlos.
    const fijoPequeno = coupon({ _id: 'fijo', type: 'fixed', value: 2000 });
    const medioPorciento = coupon({ _id: 'pct', type: 'percentage', value: 50 });

    expect(pickSpotlightCoupon([fijoPequeno, medioPorciento])?._id).toBe('pct');
  });
});

describe('couponStatus', () => {
  it('sin información del servidor, se asume usable', () => {
    // Un backend anterior no manda `availability`; la pantalla no puede
    // apagarse por eso.
    expect(couponStatus(coupon())).toEqual({ kind: 'active' });
  });

  it('fuera de franja queda programado, con la hora de apertura', () => {
    const opensAt = new Date(Date.now() + 5 * HOUR).toISOString();
    const status = couponStatus(coupon({
      availability: {
        state: 'scheduled',
        nextOpensAt: opensAt,
        window: { from: '11:00', to: '13:00', days: [] },
      },
    }));

    expect(status.kind).toBe('scheduled');
    expect(status.opensAt).toBe(opensAt);
    expect(isUsable(status)).toBe(false);
  });

  it('lo personal manda sobre el horario', () => {
    // Decirle "abre a las 6" de un cupón que ya gastó es mandarlo a
    // esperar para nada.
    const eligibility = indexEligibility([
      { couponId: 'c1', usable: false, reason: 'already_used' },
    ]);

    const status = couponStatus(coupon({
      availability: {
        state: 'scheduled',
        nextOpensAt: new Date(Date.now() + HOUR).toISOString(),
        window: { from: '11:00', to: '13:00', days: [] },
      },
    }), eligibility);

    expect(status.kind).toBe('used');
  });

  it('distingue el que ya usaste del que era solo para estrenar', () => {
    const used = couponStatus(coupon(), indexEligibility([
      { couponId: 'c1', usable: false, reason: 'already_used' },
    ]));
    const first = couponStatus(coupon(), indexEligibility([
      { couponId: 'c1', usable: false, reason: 'not_first_order' },
    ]));

    expect(used.kind).toBe('used');
    expect(first.kind).toBe('not_first_order');
  });

  it('activo dentro de una franja conserva cuándo cierra', () => {
    const closesAt = new Date(Date.now() + HOUR).toISOString();
    const status = couponStatus(coupon({
      availability: {
        state: 'active',
        closesAt,
        window: { from: '11:00', to: '13:00', days: [] },
      },
    }));

    expect(isUsable(status)).toBe(true);
    expect(status.closesAt).toBe(closesAt);
  });
});

describe('Horas Zipp', () => {
  it('solo entran los cupones con franja', () => {
    const conFranja = coupon({
      _id: 'franja',
      availability: { state: 'active', window: { from: '11:00', to: '13:00', days: [] } },
    });
    const sinFranja = coupon({ _id: 'libre', availability: { state: 'active' } });

    expect(scheduledCoupons([conFranja, sinFranja]).map((c) => c._id)).toEqual(['franja']);
  });

  it('los días solo se nombran cuando no son todos', () => {
    expect(windowLabel({ from: '11:00', to: '13:00', days: [] })).toBe('11:00 a 13:00');
    expect(windowLabel({ from: '18:00', to: '20:00', days: [1, 5] })).toBe('L V · 18:00 a 20:00');
    expect(windowLabel(undefined)).toBe('');
  });
});

describe('Productos y negocios', () => {
  const product = (overrides: Partial<ProductSearchHit> = {}) => ({
    _id: 'p1', name: 'Plato', price: 20000, businessId: 'b1', businessName: 'Negocio',
    discountPercent: 10,
    ...overrides,
  }) as ProductSearchHit;

  it('solo las rebajas grandes se adelantan a "Se acaban hoy"', () => {
    const rows = [
      product({ _id: 'grande', discountPercent: 45 }),
      product({ _id: 'chico', discountPercent: 12 }),
    ];

    expect(bigDiscountProducts(rows).map((p) => p._id)).toEqual(['grande']);
  });

  it('la lista destacada se recorta: es un riel, no un catálogo', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      product({ _id: `p${i}`, discountPercent: 50 }));

    expect(bigDiscountProducts(rows)).toHaveLength(6);
  });

  it('envío gratis y descuento en la carta son promesas distintas', () => {
    const rows = [
      { _id: 'a', offer: { kind: 'free_delivery', label: 'Envío gratis desde $30k' } },
      { _id: 'b', offer: { kind: 'discount', label: 'Hasta -40%' } },
    ] as OfferBusiness[];

    const { freeDelivery, discounted } = splitBusinessOffers(rows);
    expect(freeDelivery.map((b) => b._id)).toEqual(['a']);
    expect(discounted.map((b) => b._id)).toEqual(['b']);
  });
});
