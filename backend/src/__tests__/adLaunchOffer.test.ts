import { describe, it, expect, beforeEach } from 'vitest';
import { PlatformPricingConfig, AD_LAUNCH_OFFER, AdPlacement } from '../models';
import { pricingConfigService } from '../services/pricingConfig.service';
import { adOffer, campaignProblems } from '../services/advertisement.service';
import { migrateAdLaunchOffer } from '../migrations/032-ad-launch-offer';
import { makePricingConfig } from './factories';

/**
 * Valores de lanzamiento de la publicidad (2026-10-19): CPC $100–$1.000, tope
 * $10.000–$500.000, 1–30 días. Son configurables desde Tarifas y Monetización;
 * aquí se comprueba que el arranque los trae, que no abren la compra por sí
 * solos y que la migración no pisa lo que ZIPP ya configuró.
 */

const SWITCHES_ON = { adSelfServiceEnabled: true, adBillingEnabled: true, adCpcEnabled: true };

describe('Oferta de publicidad de lanzamiento', () => {
  beforeEach(() => pricingConfigService.invalidate());

  it('una configuración nueva nace con los valores de lanzamiento y los interruptores apagados', async () => {
    const cfg = await makePricingConfig({});
    expect(cfg).toMatchObject({
      adCpcMinRate: 100, adCpcMaxRate: 1_000,
      adMinBudget: 10_000, adMaxBudget: 500_000,
      adMinDurationDays: 1, adMaxDurationDays: 30,
      adSelfServiceEnabled: false, adBillingEnabled: false, adCpcEnabled: false,
      adClickDedupeWindowMinutes: 1440, adClickImpressionWindowMinutes: 30, adMaxBillableClicksPerIpPerDay: 10,
    });
    expect([...cfg.adPlacements]).toEqual(['explore']);
    // Tener la oferta definida no abre la compra: faltan los interruptores.
    const offer = adOffer(cfg);
    expect(offer.available).toBe(false);
    expect(offer.reasons.join(' ')).toMatch(/todavía no ha abierto la compra/);
  });

  it('con los interruptores encendidos la oferta es exactamente la del lanzamiento', async () => {
    const offer = adOffer(await makePricingConfig(SWITCHES_ON));
    expect(offer.available).toBe(true);
    expect(offer.models.cpc).toEqual({ enabled: true, minRate: 100, maxRate: 1_000 });
    expect(offer.budget).toEqual({ min: 10_000, max: 500_000 });
    expect(offer.durationDays).toEqual({ min: 1, max: 30 });
    expect(offer.placements).toEqual([AdPlacement.EXPLORE]);
  });

  describe('límites de una campaña', () => {
    const day = 86_400_000;
    const start = new Date('2026-11-01T00:00:00Z');
    const campaign = (o: Record<string, unknown> = {}) => ({
      pricingModel: 'cpc', cpcRate: 500, cpmRate: 0, budget: 100_000,
      startDate: start, endDate: new Date(start.getTime() + 7 * day), placement: 'explore', ...o,
    });
    let offer: ReturnType<typeof adOffer>;
    beforeEach(async () => { offer = adOffer(await makePricingConfig(SWITCHES_ON)); });

    it('dentro de los límites no hay problemas', () => {
      expect(campaignProblems(offer, campaign() as never)).toEqual([]);
    });

    it.each([
      ['CPC $99 (bajo el mínimo)', { cpcRate: 99 }],
      ['CPC $1.001 (sobre el máximo)', { cpcRate: 1_001 }],
      ['presupuesto $9.999', { budget: 9_999 }],
      ['presupuesto $500.001', { budget: 500_001 }],
    ])('rechaza %s', (_label, override) => {
      expect(campaignProblems(offer, campaign(override) as never)).toHaveLength(1);
    });

    it('los extremos exactos sí se aceptan', () => {
      expect(campaignProblems(offer, campaign({ cpcRate: 100, budget: 10_000 }) as never)).toEqual([]);
      expect(campaignProblems(offer, campaign({ cpcRate: 1_000, budget: 500_000 }) as never)).toEqual([]);
    });

    it('duración: 1 día sí, 31 días no, cero no', () => {
      const end = (days: number) => new Date(start.getTime() + days * day);
      expect(campaignProblems(offer, campaign({ endDate: end(1) }) as never)).toEqual([]);
      expect(campaignProblems(offer, campaign({ endDate: end(30) }) as never)).toEqual([]);
      expect(campaignProblems(offer, campaign({ endDate: end(31) }) as never)).toHaveLength(1);
      expect(campaignProblems(offer, campaign({ endDate: start }) as never)).toHaveLength(1);
    });

    it('solo las ubicaciones implementadas: inicio/búsqueda/listado no existen como superficie', () => {
      expect(campaignProblems(offer, campaign({ placement: 'search' }) as never)).toHaveLength(1);
      expect(campaignProblems(offer, campaign({ placement: 'business_list' }) as never)).toHaveLength(1);
      // `splash` existe pero ZIPP no lo ofrece en el lanzamiento.
      expect(campaignProblems(offer, campaign({ placement: 'splash' }) as never)).toHaveLength(1);
      expect(Object.values(AdPlacement).sort()).toEqual(['explore', 'splash']);
    });
  });

  describe('migración 032', () => {
    const baseConfig = async (overrides: Record<string, unknown>) =>
      makePricingConfig({
        adCpcMinRate: 0, adCpcMaxRate: 0, adMinBudget: 0, adMaxBudget: 0,
        adMinDurationDays: 0, adMaxDurationDays: 0, adPlacements: [], ...overrides,
      });

    it('aplica el lanzamiento donde nadie había configurado nada, sin encender nada', async () => {
      await baseConfig({});
      const result = await migrateAdLaunchOffer();
      expect(result.applied.sort()).toEqual(Object.keys(AD_LAUNCH_OFFER).sort());
      expect(result.version).toBe(2);

      const versions = await PlatformPricingConfig.find().sort({ version: 1 });
      expect(versions.map((v) => v.isCurrent)).toEqual([false, true]);
      expect(versions[1]).toMatchObject({ adCpcMinRate: 100, adMaxBudget: 500_000, adSelfServiceEnabled: false, adBillingEnabled: false });
      expect(versions[1].changeReason).toMatch(/migración 032/);
    });

    it('no pisa lo que ZIPP ya configuró', async () => {
      await baseConfig({ adCpcMinRate: 250, adCpcMaxRate: 2_000, adPlacements: ['splash'] });
      const result = await migrateAdLaunchOffer();
      expect(result.applied).not.toContain('adCpcMinRate');
      expect(result.applied).not.toContain('adPlacements');
      const current = await pricingConfigService.getCurrent();
      expect(current).toMatchObject({ adCpcMinRate: 250, adCpcMaxRate: 2_000, adMinBudget: 10_000 });
      expect([...current.adPlacements]).toEqual(['splash']);
    });

    it('es idempotente: la segunda vez no publica otra versión', async () => {
      await baseConfig({});
      await migrateAdLaunchOffer();
      const again = await migrateAdLaunchOffer();
      expect(again.applied).toEqual([]);
      expect(await PlatformPricingConfig.countDocuments()).toBe(2);
    });

    it('con la base vacía no hace nada', async () => {
      await PlatformPricingConfig.deleteMany({});
      expect(await migrateAdLaunchOffer()).toEqual({ applied: [], version: null });
    });
  });
});
