import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Advertisement, AdEvent, AdInvoice, AdPricingModel, AdApprovalStatus, AdClick, AdClickRejection, AdClickSignal, AdNetworkQuota, Business } from '../models';
import { UserRole } from '../types';
import { advertisementService } from '../services/advertisement.service';
import { makeUser, makeBusiness, makePricingConfig, GARZON } from './factories';

/**
 * Publicidad que se cobra.
 *
 * Desde el 2026-10-17 las reglas (modalidad, rango de tarifa, presupuesto,
 * duración, ubicaciones) salen de `PlatformPricingConfig` y no del comercio:
 * sin oferta configurada no se compra, una campaña fuera de la oferta vigente
 * no se aprueba, y cada clic cobrable deja evidencia idempotente en `AdClick`.
 * El presupuesto sigue siendo un tope de eventos que defiende el `$inc`
 * atómico. CPC primero; CPM queda preparado y cerrado.
 *
 * Las cifras de la oferta de estas pruebas son de ejemplo, no tarifas de ZIPP.
 */

const OFFER = {
  adSelfServiceEnabled: true,
  adBillingEnabled: true,
  adCpcEnabled: true,
  adCpcMinRate: 300,
  adCpcMaxRate: 50_000,
  adMinBudget: 10_000,
  adMaxBudget: 2_000_000,
  adMinDurationDays: 1,
  adMaxDurationDays: 60,
  adPlacements: ['splash'],
  adClickDedupeWindowMinutes: 1440,
  adClickImpressionWindowMinutes: 30,
  adMaxBillableClicksPerIpPerDay: 10,
};

describe('Facturación de publicidad', () => {
  let owner: any;
  let business: any;

  const buy = (overrides: Record<string, unknown> = {}) =>
    advertisementService.requestFromBusiness({
      ownerId: owner._id.toString(),
      businessId: business._id.toString(),
      campaignName: 'Promo de la semana',
      flyerUrl: 'https://res.cloudinary.com/demo/image/upload/v1/ads/flyer.jpg',
      startDate: new Date(Date.now() - 86_400_000),
      endDate: new Date(Date.now() + 86_400_000),
      pricingModel: AdPricingModel.CPC,
      cpmRate: 0,
      cpcRate: 500,
      budget: 100_000,
      ...overrides,
    } as never);

  const live = async (overrides: Record<string, unknown> = {}) => {
    const ad = await buy(overrides);
    await advertisementService.approve(ad._id.toString());
    return ad;
  };

  /** La impresión ocurrió hace unos segundos: una persona tarda más de medio segundo en tocar. */
  const seen = async (ad: any, device: string, secondsAgo = 5) => {
    await advertisementService.registerImpression(ad._id.toString(), device);
    await AdEvent.updateMany(
      { campaignId: ad._id, deviceId: device, eventType: 'impression' },
      { $set: { timestamp: new Date(Date.now() - secondsAgo * 1000) } }
    );
  };

  const UA = 'ZippApp/1.0 (Android 14; okhttp/4.12)';

  /** Lo que hace la app: pinta el flyer (impresión) y luego el toque. */
  const seeAndClick = async (
    ad: any,
    device: string,
    opts: { clickId?: string; ip?: string; userId?: string; userAgent?: string } = {}
  ) => {
    await seen(ad, device);
    return advertisementService.registerClick(ad._id.toString(), device, { userAgent: UA, ...opts });
  };

  beforeEach(async () => {
    await Advertisement.deleteMany({});
    await AdEvent.deleteMany({});
    await AdInvoice.deleteMany({});
    await AdClick.deleteMany({});
    await makePricingConfig(OFFER);

    owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
  });

  // ── Comprar dentro de la oferta ──

  it('un comercio compra su campaña y nace pendiente de revisión, con la versión de la oferta', async () => {
    const ad = await buy();
    expect(ad.approvalStatus).toBe(AdApprovalStatus.PENDING);
    expect(ad.isActive).toBe(false);
    expect(ad.adConfigVersion).toBe(1);
    expect(ad.placement).toBe('splash');
  });

  it('el destino del toque es su propio negocio, no lo elige', async () => {
    const ad = await buy();
    expect(ad.businessId!.toString()).toBe(business._id.toString());
    expect(ad.billedToBusinessId!.toString()).toBe(business._id.toString());
  });

  it('no se puede comprar publicidad para el negocio de otro', async () => {
    const intruso = await makeUser({ role: UserRole.BUSINESS });
    await expect(buy({ ownerId: intruso._id.toString() })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('sin tope de gasto no se compra', async () => {
    await expect(buy({ budget: 0 })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('sin oferta configurada no se compra: no hay tarifa por defecto que adivinar', async () => {
    await makePricingConfig({});
    await expect(buy()).rejects.toMatchObject({ statusCode: 409, code: 'AD_OFFER_UNAVAILABLE' });
    await makePricingConfig({ ...OFFER, adCpcMinRate: 0 });
    await expect(buy()).rejects.toMatchObject({ statusCode: 409 });
    await makePricingConfig({ ...OFFER, adBillingEnabled: false });
    await expect(buy()).rejects.toMatchObject({ statusCode: 409 });
    expect(await Advertisement.countDocuments()).toBe(0);
  });

  it('fuera de la oferta no se compra: tarifa, tope, duración, ubicación y CPM', async () => {
    for (const overrides of [
      { cpcRate: 100 },
      { cpcRate: 60_000 },
      { budget: 5_000 },
      { budget: 3_000_000 },
      { endDate: new Date(Date.now() + 90 * 86_400_000) },
      { placement: 'explore' },
      { pricingModel: AdPricingModel.CPM, cpmRate: 2000, cpcRate: 0 },
    ]) {
      await expect(buy(overrides), JSON.stringify(overrides)).rejects.toMatchObject({ statusCode: 422 });
    }
  });

  it('un negocio suspendido no compra', async () => {
    await Business.updateOne({ _id: business._id }, { isSuspended: true });
    await expect(buy()).rejects.toMatchObject({ statusCode: 403 });
  });

  it('con CPC el presupuesto se traduce a un tope de clics', async () => {
    const ad = await buy({ cpcRate: 500, budget: 100_000 });
    expect(ad.maxClicks).toBe(200);
    expect(ad.maxImpressions).toBe(0);
  });

  // ── Revisión ──

  it('una campaña pendiente no se sirve en la app', async () => {
    await buy();
    expect(await advertisementService.getActiveForApp()).toBeNull();
  });

  it('aprobarla la enciende y la pone a rodar', async () => {
    const ad = await live();
    expect((await advertisementService.getActiveForApp())?.id).toBe(ad._id.toString());
  });

  it('no se aprueba si la oferta cambió y la campaña ya no cabe', async () => {
    const ad = await buy({ cpcRate: 500 });
    await makePricingConfig({ ...OFFER, adCpcMinRate: 1000 });
    await expect(advertisementService.approve(ad._id.toString())).rejects.toMatchObject({ statusCode: 409, code: 'AD_OUT_OF_OFFER' });
    expect((await Advertisement.findById(ad._id))!.approvalStatus).toBe(AdApprovalStatus.PENDING);
  });

  it('no se aprueba con la facturación apagada', async () => {
    const ad = await buy();
    await makePricingConfig({ ...OFFER, adBillingEnabled: false });
    await expect(advertisementService.approve(ad._id.toString())).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rechazar sin motivo no se puede', async () => {
    const ad = await buy();
    await expect(advertisementService.reject(ad._id.toString(), '   ')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('una campaña rechazada guarda el motivo y no sale', async () => {
    const ad = await buy();
    await advertisementService.reject(ad._id.toString(), 'El flyer tiene el logo de otra marca');
    const saved = await Advertisement.findById(ad._id);
    expect(saved!.rejectionReason).toContain('otra marca');
    expect(await advertisementService.getActiveForApp()).toBeNull();
  });

  it('apagar la facturación saca de la app lo que compró un comercio y deja de cobrar sus clics', async () => {
    const ad = await live();
    await makePricingConfig({ ...OFFER, adBillingEnabled: false });
    expect(await advertisementService.getActiveForApp()).toBeNull();

    const result = await seeAndClick(ad, 'dev-1');
    expect(result).toMatchObject({ billable: false, rejection: AdClickRejection.BILLING_DISABLED });
    expect((await Advertisement.findById(ad._id))!.clickCount).toBe(0);
  });

  // ── El clic cobrable ──

  it('un clic con impresión previa se cobra y deja su evidencia', async () => {
    const ad = await live({ cpcRate: 700 });
    const result = await seeAndClick(ad, 'dev-1', { clickId: 'click-0001' });

    expect(result).toEqual({ billable: true });
    const row = await AdClick.findOne({ campaignId: ad._id, clickId: 'click-0001' }).lean();
    expect(row).toMatchObject({ billable: true, amount: 700, rate: 700, deviceId: 'dev-1' });
    expect((await Advertisement.findById(ad._id))!.clickCount).toBe(1);
  });

  it('un clic sin impresión de ese dispositivo no se cobra: es la firma de un script', async () => {
    const ad = await live();
    await advertisementService.registerImpression(ad._id.toString(), 'otro-dispositivo');
    const result = await advertisementService.registerClick(ad._id.toString(), 'dev-1');
    expect(result).toMatchObject({ billable: false, rejection: AdClickRejection.NO_IMPRESSION });
    expect((await Advertisement.findById(ad._id))!.clickCount).toBe(0);
  });

  it('el mismo clickId dos veces (doble toque, reintento) cuenta una sola', async () => {
    const ad = await live();
    await seeAndClick(ad, 'dev-1', { clickId: 'tap-aaaa-1111' });
    const again = await advertisementService.registerClick(ad._id.toString(), 'dev-1', { clickId: 'tap-aaaa-1111' });

    expect(again).toMatchObject({ billable: true, replay: true });
    expect(await AdClick.countDocuments({ campaignId: ad._id })).toBe(1);
    expect((await Advertisement.findById(ad._id))!.clickCount).toBe(1);
  });

  it('el mismo dispositivo dentro de la ventana: el segundo clic queda registrado sin cobro', async () => {
    const ad = await live();
    await seeAndClick(ad, 'dev-1');
    const second = await seeAndClick(ad, 'dev-1');

    expect(second).toMatchObject({ billable: false, rejection: AdClickRejection.DUPLICATE_DEVICE });
    expect(await AdClick.countDocuments({ campaignId: ad._id, billable: true })).toBe(1);
    expect(await AdClick.countDocuments({ campaignId: ad._id, billable: false })).toBe(1);
  });

  it('cinco clics simultáneos del mismo dispositivo cobran uno', async () => {
    const ad = await live();
    await seen(ad, 'dev-1');
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        advertisementService.registerClick(ad._id.toString(), 'dev-1', { clickId: `burst-${i}-xxxx`, userAgent: UA }))
    );
    expect(await AdClick.countDocuments({ campaignId: ad._id, billable: true })).toBe(1);
    expect((await Advertisement.findById(ad._id))!.clickCount).toBe(1);
  });

  it('demasiados clics cobrables desde la misma red se registran sin cobro', async () => {
    await makePricingConfig({ ...OFFER, adMaxBillableClicksPerIpPerDay: 2 });
    const ad = await live();
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await seeAndClick(ad, `dev-${i}`, { ip: '181.55.10.20' }));

    expect(results.filter((r) => r.billable)).toHaveLength(2);
    expect(results.at(-1)).toMatchObject({ rejection: AdClickRejection.IP_LIMIT });
    // Otra red no se ve afectada.
    expect(await seeAndClick(ad, 'dev-9', { ip: '190.1.1.1' })).toEqual({ billable: true });
  });

  // ── Antifraude: concurrencia, cuentas, señales ──

  it('seis clics simultáneos de dispositivos distintos en la misma red: el cupo de la red no se supera', async () => {
    await makePricingConfig({ ...OFFER, adMaxBillableClicksPerIpPerDay: 3 });
    const ad = await live();
    const devices = Array.from({ length: 6 }, (_, i) => `dev-${i}`);
    for (const d of devices) await seen(ad, d);

    const results = await Promise.all(
      devices.map((d, i) => advertisementService.registerClick(ad._id.toString(), d, { ip: '181.55.10.20', userAgent: UA, clickId: `net-${i}-aaaaaa` }))
    );

    expect(results.filter((r) => r.billable)).toHaveLength(3);
    expect(results.filter((r) => r.rejection === AdClickRejection.IP_LIMIT)).toHaveLength(3);
    expect((await Advertisement.findById(ad._id))!.clickCount).toBe(3);
    expect(await AdClick.countDocuments({ campaignId: ad._id, billable: true })).toBe(3);
  });

  it('la red no es la identidad: varios clientes distintos detrás de la misma IP cobran hasta el cupo', async () => {
    const ad = await live();
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await seeAndClick(ad, `dev-${i}`, { ip: '181.55.10.20' }));
    expect(results.every((r) => r.billable)).toBe(true);
  });

  it('la misma cuenta con otro dispositivo no abre otro clic cobrable', async () => {
    const ad = await live();
    const first = await seeAndClick(ad, 'dev-1', { userId: 'a'.repeat(24) });
    const second = await seeAndClick(ad, 'dev-2', { userId: 'a'.repeat(24) });

    expect(first.billable).toBe(true);
    expect(second).toMatchObject({ billable: false, rejection: AdClickRejection.DUPLICATE_USER });
    expect(await AdClick.countDocuments({ campaignId: ad._id, billable: true })).toBe(1);
  });

  it('el cupo de la red se devuelve si el clic no llega a cobrarse (presupuesto agotado)', async () => {
    await makePricingConfig({ ...OFFER, adMaxBillableClicksPerIpPerDay: 2 });
    const ad = await live({ cpcRate: 50_000, budget: 50_000 });
    expect((await seeAndClick(ad, 'dev-1', { ip: '181.55.10.20' })).billable).toBe(true);
    expect(await seeAndClick(ad, 'dev-2', { ip: '181.55.10.20' })).toMatchObject({ rejection: AdClickRejection.BUDGET_EXHAUSTED });

    const quota = await AdNetworkQuota.findOne({ campaignId: ad._id }).lean();
    expect(quota?.count).toBe(1);
  });

  it('un clic más rápido que una persona no se cobra: va a revisión y no gasta la ventana del dispositivo', async () => {
    const ad = await live();
    await advertisementService.registerImpression(ad._id.toString(), 'dev-1');
    const fast = await advertisementService.registerClick(ad._id.toString(), 'dev-1', { userAgent: UA, clickId: 'fast-click-1' });

    expect(fast).toMatchObject({ billable: false, rejection: AdClickRejection.SUSPICIOUS });
    const row = await AdClick.findOne({ campaignId: ad._id, clickId: 'fast-click-1' }).lean();
    expect(row).toMatchObject({ review: true, billable: false, amount: 0 });
    expect(row?.signals).toContain(AdClickSignal.TOO_FAST);
    expect(row?.dedupeKey).toBeUndefined();
    expect((await Advertisement.findById(ad._id))!.clickCount).toBe(0);

    // El cliente de verdad, que toca después, sí cobra: el sospechoso no le quitó el turno.
    await AdEvent.updateMany({ campaignId: ad._id }, { $set: { timestamp: new Date(Date.now() - 5000) } });
    expect(await advertisementService.registerClick(ad._id.toString(), 'dev-1', { userAgent: UA, clickId: 'real-click-2' }))
      .toEqual({ billable: true });
  });

  it('una herramienta de automatización se anuncia y no se cobra', async () => {
    const ad = await live();
    const result = await seeAndClick(ad, 'dev-1', { userAgent: 'python-requests/2.31.0' });
    expect(result).toMatchObject({ billable: false, rejection: AdClickRejection.SUSPICIOUS });
    expect((await AdClick.findOne({ campaignId: ad._id }).lean())?.signals).toContain(AdClickSignal.AUTOMATION_AGENT);
  });

  it('sin agente de usuario no se bloquea: se anota la señal y se cobra', async () => {
    const ad = await live();
    await seen(ad, 'dev-1');
    const result = await advertisementService.registerClick(ad._id.toString(), 'dev-1', {});
    expect(result.billable).toBe(true);
    expect((await AdClick.findOne({ campaignId: ad._id }).lean())?.signals).toEqual([AdClickSignal.NO_AGENT]);
  });

  it('una ráfaga de dispositivos desde una red se anota como señal blanda y no bloquea', async () => {
    const ad = await live();
    for (let i = 0; i < 5; i += 1) await seeAndClick(ad, `dev-${i}`, { ip: '181.55.10.20' });
    const last = await AdClick.findOne({ campaignId: ad._id, deviceId: 'dev-4' }).lean();
    expect(last?.billable).toBe(true);
    expect(last?.signals).toContain(AdClickSignal.NETWORK_BURST);
  });

  it('cada clic guarda la evidencia de su decisión: red con hash, agente, retraso y versión de la configuración', async () => {
    const ad = await live();
    await seeAndClick(ad, 'dev-1', { ip: '181.55.10.20', clickId: 'evidence-0001' });
    const row = await AdClick.findOne({ campaignId: ad._id, clickId: 'evidence-0001' }).lean();
    expect(row?.ipHash).toMatch(/^[0-9a-f]{32}$/);
    expect(row?.userAgent).toBe(UA);
    expect(row?.msSinceImpression).toBeGreaterThanOrEqual(4000);
    expect(row?.configVersion).toBeGreaterThan(0);
  });

  it('la investigación lista cada clic con su veredicto y un resumen de toda la campaña', async () => {
    const ad = await live({ cpcRate: 500 });
    await seeAndClick(ad, 'dev-1');
    await seeAndClick(ad, 'dev-1'); // duplicado
    await seeAndClick(ad, 'dev-2', { userAgent: 'curl/8.0' }); // sospechoso
    const all = await advertisementService.listClicks(ad._id.toString(), { page: 1, limit: 2 });
    expect(all.total).toBe(3);
    expect(all.clicks).toHaveLength(2);
    expect(all.summary).toMatchObject({ billable: 1, billedAmount: 500, rejected: 2, review: 1 });
    expect(all.summary.byRejection).toMatchObject({ duplicate_device: 1, suspicious: 1 });

    const review = await advertisementService.listClicks(ad._id.toString(), { verdict: 'review', page: 1, limit: 10 });
    expect(review.clicks).toHaveLength(1);
    expect(review.clicks[0]).not.toHaveProperty('dedupeKey');
  });

  describe('el «un clic por día» es el día de Colombia, no el de UTC', () => {
    afterEach(() => vi.useRealTimers());

    const clickAt = async (ad: any, iso: string, clickId: string) => {
      // Solo se simula el reloj de `Date`: los temporizadores de Mongo siguen reales.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(new Date(iso).getTime() - 5_000));
      await advertisementService.registerImpression(ad._id.toString(), 'dev-day');
      // El esquema de AdEvent captura `Date.now` real al definirse: se fija la hora de la impresión a mano.
      await AdEvent.updateMany({ campaignId: ad._id, deviceId: 'dev-day' }, { $set: { timestamp: new Date(new Date(iso).getTime() - 5_000) } });
      vi.setSystemTime(new Date(iso));
      const result = await advertisementService.registerClick(ad._id.toString(), 'dev-day', { userAgent: UA, clickId });
      vi.useRealTimers();
      return result;
    };

    it('18:59 y 19:01 hora de Colombia (a ambos lados de la medianoche UTC) son el mismo día: el segundo no cobra', async () => {
      const ad = await live();
      await Advertisement.updateOne({ _id: ad._id }, { startDate: new Date('2026-01-01'), endDate: new Date('2027-01-01') });
      expect((await clickAt(ad, '2026-11-10T23:59:00Z', 'dia-a-0001')).billable).toBe(true); // 18:59 Bogotá
      expect(await clickAt(ad, '2026-11-11T00:01:00Z', 'dia-a-0002')).toMatchObject({ billable: false, rejection: AdClickRejection.DUPLICATE_DEVICE }); // 19:01 Bogotá
    });

    it('23:59 y 00:01 hora de Colombia son días distintos: los dos cobran', async () => {
      const ad = await live();
      await Advertisement.updateOne({ _id: ad._id }, { startDate: new Date('2026-01-01'), endDate: new Date('2027-01-01') });
      expect((await clickAt(ad, '2026-11-11T04:59:00Z', 'dia-b-0001')).billable).toBe(true); // 23:59 Bogotá
      expect((await clickAt(ad, '2026-11-11T05:01:00Z', 'dia-b-0002')).billable).toBe(true); // 00:01 Bogotá
    });
  });

  it('agotado el tope de clics del presupuesto, ninguno más se cobra', async () => {
    const ad = await live({ cpcRate: 50_000, budget: 100_000 });
    expect((await seeAndClick(ad, 'dev-1')).billable).toBe(true);
    expect((await seeAndClick(ad, 'dev-2')).billable).toBe(true);
    expect(await seeAndClick(ad, 'dev-3')).toMatchObject({ billable: false, rejection: AdClickRejection.BUDGET_EXHAUSTED });
    expect((await Advertisement.findById(ad._id))!.clickCount).toBe(2);
  });

  it('una campaña cancelada no cobra ni un clic más', async () => {
    const ad = await live();
    await seen(ad, 'dev-1');
    await advertisementService.cancel(ad._id.toString());

    await expect(advertisementService.registerClick(ad._id.toString(), 'dev-1')).rejects.toMatchObject({ statusCode: 404 });
    expect((await Advertisement.findById(ad._id))!.clickCount).toBe(0);
    expect(await AdClick.countDocuments({ campaignId: ad._id })).toBe(0);
  });

  it('una campaña vencida o pausada tampoco', async () => {
    const ad = await live();
    await Advertisement.updateOne({ _id: ad._id }, { isActive: false });
    await expect(seeAndClick(ad, 'dev-1')).rejects.toMatchObject({ statusCode: 404 });
    await Advertisement.updateOne({ _id: ad._id }, { isActive: true, endDate: new Date(Date.now() - 1000) });
    await expect(advertisementService.registerClick(ad._id.toString(), 'dev-1')).rejects.toMatchObject({ statusCode: 404 });
  });

  // ── El importe ──

  const adminCpm = (cpmRate: number, impressionCount: number) =>
    Advertisement.create({
      campaignName: 'CPM vendida por fuera',
      advertiserName: 'Alcaldía',
      flyerUrl: 'https://res.cloudinary.com/demo/image/upload/v1/ads/x.jpg',
      startDate: new Date(Date.now() - 86_400_000),
      endDate: new Date(Date.now() + 86_400_000),
      pricingModel: AdPricingModel.CPM,
      cpmRate,
      impressionCount,
    });

  it('el gasto de CPM se calcula, no se acumula', async () => {
    expect(advertisementService.spendOf(await adminCpm(2000, 1501))).toBe(3002);
  });

  it('un CPM que no divide exacto se redondea una sola vez', async () => {
    // 777 × 1500 / 1000 = 1165,5 → 1166.
    expect(advertisementService.spendOf(await adminCpm(1500, 777))).toBe(1166);
  });

  // ── Cerrar y facturar ──

  it('la factura de CPC cobra por la evidencia, clic a clic', async () => {
    const ad = await live({ cpcRate: 1000 });
    for (let i = 0; i < 3; i += 1) await seeAndClick(ad, `dev-${i}`);
    await seeAndClick(ad, 'dev-0'); // repetido: registrado, no cobrado

    const invoice = await advertisementService.closeAndInvoice(ad._id.toString());
    expect(invoice.clicks).toBe(3);
    expect(invoice.verifiedClicks).toBe(3);
    expect(invoice.amount).toBe(3000);
    expect(invoice.evidenceMismatch).toBe(false);
  });

  it('si el contador no coincide con la evidencia, se cobra la evidencia y se marca', async () => {
    const ad = await live({ cpcRate: 1000 });
    await seeAndClick(ad, 'dev-1');
    await Advertisement.updateOne({ _id: ad._id }, { clickCount: 50 });

    const invoice = await advertisementService.closeAndInvoice(ad._id.toString());
    expect(invoice.amount).toBe(1000);
    expect(invoice.evidenceMismatch).toBe(true);
  });

  it('la factura sobrevive a que cambien las tarifas después', async () => {
    const ad = await live({ cpcRate: 1000 });
    await seeAndClick(ad, 'dev-1');
    const invoice = await advertisementService.closeAndInvoice(ad._id.toString());
    await Advertisement.updateOne({ _id: ad._id }, { cpcRate: 9000 });

    const saved = await AdInvoice.findById(invoice._id);
    expect(saved!.amount).toBe(1000);
    expect(saved!.cpcRate).toBe(1000);
  });

  it('cerrar dos veces no factura dos veces', async () => {
    const ad = await live();
    await seeAndClick(ad, 'dev-1');
    const first = await advertisementService.closeAndInvoice(ad._id.toString());
    const second = await advertisementService.closeAndInvoice(ad._id.toString());
    expect(second._id.toString()).toBe(first._id.toString());
    expect(await AdInvoice.countDocuments({ campaignId: ad._id })).toBe(1);
  });

  it('cerrar apaga la campaña y ya no cobra clics', async () => {
    const ad = await live();
    await advertisementService.registerImpression(ad._id.toString(), 'dev-1');
    await advertisementService.closeAndInvoice(ad._id.toString());
    expect((await Advertisement.findById(ad._id))!.isActive).toBe(false);
    await expect(advertisementService.registerClick(ad._id.toString(), 'dev-1')).rejects.toMatchObject({ statusCode: 404 });
  });

  // ── El descuento en la liquidación ──

  const billTwenty = async () => {
    const ad = await live({ cpcRate: 1000 });
    for (let i = 0; i < 20; i += 1) await seeAndClick(ad, `dev-${i}`);
    await advertisementService.closeAndInvoice(ad._id.toString());
    return ad;
  };

  it('lo que compró un comercio se descuenta de su liquidación', async () => {
    await billTwenty();
    expect(await advertisementService.outstandingForBusiness(business._id.toString())).toBe(20_000);
  });

  it('la publicidad se descuenta del pago semanal del comercio', async () => {
    const { payoutService } = await import('../services/payout.service');
    const { Payout, AdInvoice: Invoices } = await import('../models');
    const { PayoutBeneficiary, PayoutStatus } = await import('../types');

    const ad = await billTwenty();
    await Payout.create({
      orderId: business._id,
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: business._id,
      amount: 500_000,
      status: PayoutStatus.PAYABLE,
      becamePayableAt: new Date(),
      pricingConfigVersion: 1,
    });

    const admin = await makeUser({ role: UserRole.ADMIN });
    const { settlement } = await payoutService.settle({
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: business._id.toString(),
      createdBy: admin._id.toString(),
    });

    expect(settlement!.adSpendAmount).toBe(20_000);
    expect(settlement!.netAmount).toBe(480_000);
    expect((await Invoices.findOne({ campaignId: ad._id }))!.settledAt).toBeTruthy();
  });

  it('un mes flojo no deja al comercio debiéndole dinero a ZIPP', async () => {
    const { payoutService } = await import('../services/payout.service');
    const { Payout, AdInvoice: Invoices } = await import('../models');
    const { PayoutBeneficiary, PayoutStatus } = await import('../types');

    const ad = await billTwenty();
    await Payout.create({
      orderId: business._id,
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: business._id,
      amount: 5_000,
      status: PayoutStatus.PAYABLE,
      becamePayableAt: new Date(),
      pricingConfigVersion: 1,
    });

    const admin = await makeUser({ role: UserRole.ADMIN });
    const { settlement } = await payoutService.settle({
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: business._id.toString(),
      createdBy: admin._id.toString(),
    });

    expect(settlement!.adSpendAmount).toBe(0);
    expect(settlement!.netAmount).toBe(5_000);
    expect((await Invoices.findOne({ campaignId: ad._id }))!.settledAt).toBeNull();
  });

  it('lo que vendió el equipo comercial no toca ninguna liquidación', async () => {
    const ad = await Advertisement.create({
      campaignName: 'Vendida por fuera',
      advertiserName: 'Alcaldía',
      flyerUrl: 'https://cdn.example.com/flyer.jpg',
      startDate: new Date(),
      endDate: new Date(Date.now() + 86_400_000),
      pricePaid: 500_000,
    });

    const invoice = await advertisementService.closeAndInvoice(ad._id.toString());
    expect(invoice.settledAgainstPayout).toBe(false);
    expect(invoice.amount).toBe(500_000);
  });
});
