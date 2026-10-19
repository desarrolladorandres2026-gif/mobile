import { describe, it, expect } from 'vitest';
import {
  AD_TEMPLATES, adProblem, adSummary, addDays, applyAdTemplate, budgetPresets, daysToNextFriday, dayDiff,
  durationsFor, emptyDraft, offeredModels, phaseOf, ratePresets, reachOf, stateLine, templatesFor,
  type AdOffer, type Campaign,
} from './advertising';

/**
 * El asistente de campañas no inventa reglas: las tarifas, los topes y la
 * duración salen de la oferta que ZIPP configura (auditoría 2026-10-17), el
 * servidor los vuelve a exigir y un administrador revisa. Lo que se fija aquí
 * es que el borrador no ofrezca lo que se sabe rechazado y que la cuenta del
 * alcance sea la misma que hace el servidor. Las cifras de estas pruebas son
 * de ejemplo, no tarifas de ZIPP.
 */

const offer: AdOffer = {
  available: true,
  reasons: [],
  billingEnabled: true,
  models: { cpc: { enabled: true, minRate: 400, maxRate: 1200 }, cpm: { enabled: false, minRate: 0, maxRate: 0 } },
  budget: { min: 50_000, max: 2_000_000 },
  durationDays: { min: 3, max: 30 },
  placements: ['splash'],
  autoRenew: false,
  configVersion: 7,
};

const ok = { ...emptyDraft(offer), campaignName: 'Promo', flyerUrl: 'https://res.cloudinary.com/zipp/image/upload/v1/ads/a.png' };

describe('reachOf', () => {
  it('traduce el tope a eventos igual que el servidor', () => {
    expect(reachOf({ ...ok, pricingModel: 'cpm', cpmRate: 2000, budget: 100000 })).toBe(50000);
    expect(reachOf({ ...ok, pricingModel: 'cpc', cpcRate: 500, budget: 100000 })).toBe(200);
    expect(reachOf({ ...ok, pricingModel: 'cpc', cpcRate: 300, budget: 1000 })).toBe(3);
  });

  it('sin tarifa o sin tope no hay alcance', () => {
    expect(reachOf({ ...ok, pricingModel: 'cpm', cpmRate: 0 })).toBeNull();
    expect(reachOf({ ...ok, budget: 0 })).toBeNull();
    expect(reachOf({ ...ok, pricingModel: 'cpc', cpcRate: 500, budget: 100 })).toBeNull();
  });
});

describe('oferta de ZIPP', () => {
  it('el borrador arranca en la modalidad habilitada, la tarifa mínima y el tope mínimo', () => {
    expect(ok.pricingModel).toBe('cpc');
    expect(ok.cpcRate).toBe(400);
    expect(ok.budget).toBe(50_000);
    expect(offeredModels(offer)).toEqual(['cpc']);
  });

  it('con CPM apagado no se ofrece la idea «Que más gente me vea»', () => {
    expect(templatesFor(offer).map((t) => t.id)).not.toContain('seen');
    expect(templatesFor({ ...offer, models: { ...offer.models, cpm: { enabled: true, minRate: 1000, maxRate: 4000 } } }).map((t) => t.id)).toContain('seen');
  });

  it('los atajos de tarifa, tope y duración no se salen de la oferta', () => {
    for (const rate of ratePresets(offer, 'cpc')) expect(rate >= 400 && rate <= 1200).toBe(true);
    for (const budget of budgetPresets(offer)) expect(budget >= 50_000 && budget <= 2_000_000).toBe(true);
    for (const d of durationsFor({ ...offer, durationDays: { min: 3, max: 10 } })) expect(d.days).toBeLessThanOrEqual(10);
  });
});

describe('adProblem', () => {
  it('pide nombre y un flyer subido a Zipp: un enlace externo no vale', () => {
    expect(adProblem('ad', { ...ok, campaignName: ' a ' }, offer)).not.toBe('');
    expect(adProblem('ad', { ...ok, flyerUrl: 'ftp://x' }, offer)).not.toBe('');
    expect(adProblem('ad', { ...ok, flyerUrl: 'https://x.co/a.png' }, offer)).not.toBe('');
    expect(adProblem('ad', { ...ok, flyerUrl: 'http://res.cloudinary.com/zipp/a.png' }, offer)).not.toBe('');
    expect(adProblem('ad', ok, offer)).toBe('');
  });

  it('exige que termine después de empezar y dentro de la duración permitida', () => {
    expect(adProblem('when', { ...ok, startDate: '2030-01-10', endDate: '2030-01-10' }, offer)).not.toBe('');
    expect(adProblem('when', { ...ok, startDate: '2030-01-10', endDate: '2030-01-11' }, offer)).toMatch(/al menos 3/);
    expect(adProblem('when', { ...ok, startDate: '2030-01-10', endDate: '2030-03-10' }, offer)).toMatch(/máximo 30/);
    expect(adProblem('when', { ...ok, startDate: '2030-01-10', endDate: '2030-01-17' }, offer)).toBe('');
  });

  it('nunca deja firmar un gasto abierto ni salirse de los rangos', () => {
    expect(adProblem('budget', { ...ok, budget: 0 }, offer)).toMatch(/tope/i);
    expect(adProblem('budget', { ...ok, cpcRate: 0 }, offer)).toMatch(/tarifa/i);
    expect(adProblem('budget', { ...ok, cpcRate: 100 }, offer)).toMatch(/va de/);
    expect(adProblem('budget', { ...ok, budget: 10_000 }, offer)).toMatch(/va de/);
    expect(adProblem('budget', { ...ok, pricingModel: 'cpm', cpmRate: 2000 }, offer)).toMatch(/no está disponible/);
    expect(adProblem('budget', ok, offer)).toBe('');
  });
});

describe('plantillas de campaña', () => {
  it('toda plantilla ofrecida cumple lo que valida el servidor', () => {
    for (const template of templatesFor(offer)) {
      const d = applyAdTemplate(template, offer);
      expect(Number.isInteger(d.budget), template.id).toBe(true);
      expect(adProblem('budget', d, offer), template.id).toBe('');
      expect(reachOf(d), template.id).not.toBeNull();
      const days = dayDiff(d.startDate, d.endDate);
      expect(days >= 3 && days <= 30, template.id).toBe(true);
    }
  });

  it('empiezan mañana o después, nunca hoy: el anuncio se revisa antes', () => {
    const from = new Date(2030, 0, 10, 23, 0);
    for (const template of AD_TEMPLATES) {
      expect(dayDiff('2030-01-10', applyAdTemplate(template, offer, from).startDate), template.id).toBeGreaterThanOrEqual(1);
    }
  });

  it('el fin de semana arranca el próximo viernes, aunque hoy sea viernes', () => {
    expect(daysToNextFriday(new Date(2030, 0, 10))).toBe(1); // jueves → viernes 11
    expect(daysToNextFriday(new Date(2030, 0, 11))).toBe(7); // viernes → viernes 18
    expect(daysToNextFriday(new Date(2030, 0, 12))).toBe(6); // sábado → viernes 18
    const weekend = AD_TEMPLATES.find((t) => t.id === 'weekend')!;
    const d = applyAdTemplate(weekend, offer, new Date(2030, 0, 10));
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
    const text = adSummary({ ...ok, startDate: '2030-01-11', endDate: '2030-01-25', cpcRate: 500, budget: 100_000 });
    expect(text).toContain('11 de enero');
    expect(text).toContain('200 clics');
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
