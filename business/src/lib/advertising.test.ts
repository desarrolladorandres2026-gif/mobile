import { describe, it, expect } from 'vitest';
import {
  AD_TEMPLATES, adProblem, adSummary, addDays, applyAdTemplate, daysToNextFriday, dayDiff,
  emptyDraft, phaseOf, reachOf, stateLine, type Campaign,
} from './advertising';

/**
 * El asistente de campañas no inventa reglas: el servidor traduce el tope a un
 * número de eventos (`capsFor`) y un administrador revisa. Lo que se fija aquí
 * es que el borrador no ofrezca lo que se sabe rechazado y que la cuenta del
 * alcance sea la misma que hace el servidor.
 */

const ok = { ...emptyDraft(), campaignName: 'Promo', flyerUrl: 'https://x.co/a.png' };

describe('reachOf', () => {
  it('traduce el tope a impresiones por mil o a clics, con piso entero', () => {
    expect(reachOf({ ...ok, pricingModel: 'cpm', cpmRate: 2000, budget: 100000 })).toBe(50000);
    expect(reachOf({ ...ok, pricingModel: 'cpc', cpcRate: 500, budget: 100000 })).toBe(200);
    expect(reachOf({ ...ok, pricingModel: 'cpc', cpcRate: 300, budget: 1000 })).toBe(3);
  });

  it('sin tarifa, sin tope o con un tope que no alcanza para nada no hay alcance', () => {
    expect(reachOf({ ...ok, pricingModel: 'cpm', cpmRate: 0 })).toBeNull();
    expect(reachOf({ ...ok, budget: 0 })).toBeNull();
    expect(reachOf({ ...ok, pricingModel: 'cpc', cpcRate: 500, budget: 100 })).toBeNull();
  });
});

describe('adProblem', () => {
  it('pide nombre y un flyer con https', () => {
    expect(adProblem('ad', { ...ok, campaignName: ' a ' })).not.toBe('');
    expect(adProblem('ad', { ...ok, flyerUrl: 'ftp://x' })).not.toBe('');
    expect(adProblem('ad', ok)).toBe('');
  });

  it('exige que termine después de empezar', () => {
    expect(adProblem('when', { ...ok, startDate: '2030-01-10', endDate: '2030-01-10' })).not.toBe('');
    expect(adProblem('when', { ...ok, startDate: '2030-01-10', endDate: '2030-01-11' })).toBe('');
  });

  it('nunca deja firmar un gasto abierto', () => {
    expect(adProblem('budget', { ...ok, budget: 0 })).toMatch(/tope/i);
    expect(adProblem('budget', { ...ok, cpmRate: 0 })).toMatch(/tarifa/i);
    expect(adProblem('budget', ok)).toBe('');
  });
});

describe('plantillas de campaña', () => {
  it('toda plantilla (menos «desde cero» sin nombre) cumple lo que valida el servidor', () => {
    for (const template of AD_TEMPLATES) {
      const d = applyAdTemplate(template);
      expect(Number.isInteger(d.budget), template.id).toBe(true);
      expect(d.budget, template.id).toBeGreaterThan(0);
      expect(d.budget, template.id).toBeLessThanOrEqual(20_000_000);
      expect(reachOf(d), template.id).not.toBeNull();
      expect(dayDiff(d.startDate, d.endDate), template.id).toBeGreaterThan(0);
    }
  });

  it('empiezan mañana o después, nunca hoy: el anuncio se revisa antes', () => {
    const from = new Date(2030, 0, 10, 23, 0);
    for (const template of AD_TEMPLATES) {
      expect(dayDiff('2030-01-10', applyAdTemplate(template, from).startDate), template.id).toBeGreaterThanOrEqual(1);
    }
  });

  it('el fin de semana arranca el próximo viernes, aunque hoy sea viernes', () => {
    expect(daysToNextFriday(new Date(2030, 0, 10))).toBe(1); // jueves → viernes 11
    expect(daysToNextFriday(new Date(2030, 0, 11))).toBe(7); // viernes → viernes 18
    expect(daysToNextFriday(new Date(2030, 0, 12))).toBe(6); // sábado → viernes 18
    const weekend = AD_TEMPLATES.find((t) => t.id === 'weekend')!;
    const d = applyAdTemplate(weekend, new Date(2030, 0, 10));
    expect(d.startDate).toBe('2030-01-11');
    expect(d.endDate).toBe('2030-01-14');
  });

  it('addDays suma sobre la fecha local sin saltos por zona horaria', () => {
    expect(addDays('2030-01-31', 1)).toBe('2030-02-01');
    expect(addDays('2030-03-01', -1)).toBe('2030-02-28');
  });
});

describe('adSummary', () => {
  it('dice qué pagas, el tope y que sale de la liquidación', () => {
    const text = adSummary({ ...ok, startDate: '2030-01-11', endDate: '2030-01-25' });
    expect(text).toContain('11 de enero');
    expect(text).toContain('50.000 impresiones');
    expect(text).toContain('liquidación');
  });
});

describe('fases de una campaña', () => {
  const base: Campaign = {
    _id: '1', campaignName: 'x', flyerUrl: '', startDate: '2030-01-01', endDate: '2030-02-01',
    pricingModel: 'cpm', cpmRate: 2000, cpcRate: 0, budget: 1000, maxImpressions: 500, maxClicks: 0,
    impressionCount: 0, clickCount: 0, approvalStatus: 'approved', isActive: true,
  };
  const now = new Date('2030-01-15').getTime();

  it('rechazada pide atención y pendiente espera revisión', () => {
    expect(phaseOf({ ...base, approvalStatus: 'rejected' }, now)).toBe('attention');
    expect(phaseOf({ ...base, approvalStatus: 'pending' }, now)).toBe('review');
  });

  it('se cierra por fecha, por cancelación o al llegar a su tope', () => {
    expect(phaseOf(base, now)).toBe('active');
    expect(phaseOf(base, new Date('2030-03-01').getTime())).toBe('closed');
    expect(phaseOf({ ...base, cancelledAt: '2030-01-10' }, now)).toBe('closed');
    expect(phaseOf({ ...base, impressionCount: 500 }, now)).toBe('closed');
  });

  it('el color del estado distingue en curso, programada y pausada', () => {
    expect(stateLine(base, 'active', now).tone).toBe('success');
    expect(stateLine({ ...base, startDate: '2030-02-01', endDate: '2030-03-01' }, 'active', now).tone).toBe('info');
    expect(stateLine({ ...base, isActive: false }, 'active', now).tone).toBe('warning');
  });
});
