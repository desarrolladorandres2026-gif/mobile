import { describe, it, expect } from 'vitest';
import {
  buildComparison,
  deriveHealthFlags,
  type DaySnapshot,
} from '../services/dailySummary.service';

/**
 * Las dos funciones puras del cierre del día.
 *
 * No tocan la base de datos: reciben el retrato de un día y devuelven la
 * lectura que ve quien abre el panel por la mañana. Eso las hace baratas
 * de probar y, sobre todo, hace que valga la pena — un umbral mal puesto
 * no rompe nada, simplemente hace que la gente deje de mirar las alertas,
 * y eso no se nota hasta que se pasa por alto la que importaba.
 */

/** Un día cualquiera y sin sobresaltos, para ir moviendo una cosa a la vez. */
function day(overrides: Partial<DaySnapshot> = {}): DaySnapshot {
  return {
    date: '2026-09-04',
    ordersCreated: 100,
    ordersDelivered: 90,
    ordersCancelled: 5,
    avgTicket: 35000,
    avgDeliveryMinutes: 32,
    gmv: 3_150_000,
    platformGrossRevenue: 400_000,
    promotionExpense: 50_000,
    netRevenue: 350_000,
    businessPayouts: 2_400_000,
    driverPayouts: 350_000,
    tips: 20_000,
    tax: 0,
    merchantFundedDiscount: 0,
    platformFundedDiscount: 50_000,
    payDigitalCount: 60,
    payDigitalAmount: 2_100_000,
    payCashCount: 30,
    payCashAmount: 1_050_000,
    newClients: 8,
    newBusinesses: 1,
    newDrivers: 2,
    activeDrivers: 12,
    deliveriesPerActiveDriver: 7.5,
    reviewsCount: 20,
    avgBusinessRating: 4.6,
    avgDriverRating: 4.7,
    lowRatingsCount: 1,
    pqrsOpened: 2,
    refundsCount: 1,
    refundsAmount: 30_000,
    ...overrides,
  };
}

describe('buildComparison', () => {
  it('calcula variación absoluta, porcentual y dirección', () => {
    const rows = buildComparison(
      day({ ordersDelivered: 120, gmv: 4_000_000 }),
      day({ ordersDelivered: 100, gmv: 5_000_000 })
    );

    const entregados = rows.find((r) => r.metric === 'ordersDelivered')!;
    expect(entregados.deltaAbs).toBe(20);
    expect(entregados.deltaPct).toBe(20);
    expect(entregados.direction).toBe('up');
    expect(entregados.goodWhenUp).toBe(true);

    const gmv = rows.find((r) => r.metric === 'gmv')!;
    expect(gmv.deltaAbs).toBe(-1_000_000);
    expect(gmv.deltaPct).toBe(-20);
    expect(gmv.direction).toBe('down');
  });

  it('una base de cero no produce un porcentaje inventado', () => {
    // Pasar de 0 a 3 no es "+300 %": es un dato que no admite porcentaje.
    // Devolver `null` obliga a la interfaz a decirlo en vez de enseñar una
    // cifra que alguien acabaría metiendo en una diapositiva.
    const rows = buildComparison(day({ newClients: 3 }), day({ newClients: 0 }));
    const nuevos = rows.find((r) => r.metric === 'newClients')!;

    expect(nuevos.deltaPct).toBeNull();
    expect(nuevos.deltaAbs).toBe(3);
    expect(nuevos.direction).toBe('up');
  });

  it('una variación por debajo del 1 % cuenta como plana', () => {
    const rows = buildComparison(day({ gmv: 3_150_000 }), day({ gmv: 3_149_000 }));
    const gmv = rows.find((r) => r.metric === 'gmv')!;

    expect(gmv.deltaAbs).toBe(1000);
    expect(gmv.direction).toBe('flat');
  });

  it('marca las cancelaciones como métrica donde subir es malo', () => {
    const rows = buildComparison(day(), day());
    expect(rows.find((r) => r.metric === 'ordersCancelled')!.goodWhenUp).toBe(false);
    expect(rows.every((r) => r.direction === 'flat')).toBe(true);
  });
});

describe('deriveHealthFlags', () => {
  it('un día normal devuelve un único "ok", no una lista vacía', () => {
    const flags = deriveHealthFlags(day());
    expect(flags).toHaveLength(1);
    expect(flags[0].level).toBe('ok');
    // "No hay alertas" y "no se calcularon" tienen que verse distinto.
    expect(flags[0].code).toBe('SIN_ALERTAS');
  });

  it('un margen negativo es crítico', () => {
    const flags = deriveHealthFlags(day({ netRevenue: -120_000 }));
    const flag = flags.find((f) => f.code === 'MARGEN_NEGATIVO')!;
    expect(flag.level).toBe('critical');
    expect(flag.message).toContain('120.000');
  });

  it('distingue cancelación alta de cancelación crítica', () => {
    const alta = deriveHealthFlags(day({ ordersCreated: 100, ordersCancelled: 20 }));
    expect(alta.find((f) => f.code === 'CANCELACION_ALTA')!.level).toBe('warn');

    const critica = deriveHealthFlags(day({ ordersCreated: 100, ordersCancelled: 40 }));
    expect(critica.find((f) => f.code === 'CANCELACION_ALTA')!.level).toBe('critical');
  });

  it('mide en proporción, no en cifras absolutas', () => {
    // Diez cancelaciones sobre mil pedidos es un martes cualquiera; sobre
    // veinte, un problema. Solo la proporción separa los dos casos.
    const muchosPedidos = deriveHealthFlags(day({ ordersCreated: 1000, ordersCancelled: 10 }));
    expect(muchosPedidos.some((f) => f.code === 'CANCELACION_ALTA')).toBe(false);

    const pocosPedidos = deriveHealthFlags(day({ ordersCreated: 20, ordersCancelled: 10 }));
    expect(pocosPedidos.some((f) => f.code === 'CANCELACION_ALTA')).toBe(true);
  });

  it('avisa cuando la promoción se come más del 10 % de la venta', () => {
    const flags = deriveHealthFlags(day({ gmv: 1_000_000, promotionExpense: 150_000 }));
    expect(flags.some((f) => f.code === 'PROMOCION_CARA')).toBe(true);

    const sano = deriveHealthFlags(day({ gmv: 1_000_000, promotionExpense: 50_000 }));
    expect(sano.some((f) => f.code === 'PROMOCION_CARA')).toBe(false);
  });

  it('no se queja de la cobertura en un día sin entregas', () => {
    // Sin pedidos no hay problema de flota; hay problema de demanda, que
    // es otra conversación y no la resuelve contratar domiciliarios.
    const flags = deriveHealthFlags(
      day({ ordersDelivered: 0, activeDrivers: 0, deliveriesPerActiveDriver: 0 })
    );
    expect(flags.some((f) => f.code === 'COBERTURA_BAJA')).toBe(false);
  });

  it('exige una muestra mínima antes de alertar por calificaciones', () => {
    // Una mala nota sobre dos reseñas es el 50 %, y no dice nada.
    const pocas = deriveHealthFlags(day({ reviewsCount: 2, lowRatingsCount: 1 }));
    expect(pocas.some((f) => f.code === 'CALIFICACIONES_BAJAS')).toBe(false);

    const suficientes = deriveHealthFlags(day({ reviewsCount: 20, lowRatingsCount: 8 }));
    expect(suficientes.some((f) => f.code === 'CALIFICACIONES_BAJAS')).toBe(true);
  });

  it('pone lo crítico primero, que es por donde se empieza a leer', () => {
    const flags = deriveHealthFlags(
      day({
        netRevenue: -50_000,
        gmv: 1_000_000,
        promotionExpense: 200_000,
        ordersCreated: 100,
        ordersCancelled: 40,
      })
    );

    expect(flags.length).toBeGreaterThan(2);
    expect(flags[0].level).toBe('critical');
    const niveles = flags.map((f) => f.level);
    expect(niveles.indexOf('warn')).toBeGreaterThan(niveles.lastIndexOf('critical'));
  });
});
