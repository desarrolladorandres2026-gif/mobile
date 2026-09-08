import { describe, it, expect, beforeEach } from 'vitest';
import { Advertisement, AdEvent, AdInvoice, AdPricingModel, AdApprovalStatus } from '../models';
import { UserRole } from '../types';
import { advertisementService } from '../services/advertisement.service';
import { makeUser, makeBusiness, GARZON } from './factories';

/**
 * Publicidad que se cobra.
 *
 * Hasta ahora `pricePaid` era un número que un admin anotaba a mano después
 * de que el equipo comercial cerrara el trato por fuera. Eso funciona con
 * cinco anunciantes y deja de funcionar en cuanto un comercio quiere comprar
 * solo un martes por la noche.
 *
 * Lo que se cobra sale de lo que de verdad se sirvió, y el presupuesto se
 * respeta convirtiéndolo en un tope de eventos — no comprobando el gasto
 * después de cada impresión, que es donde estaría la carrera.
 */
describe('Facturación de publicidad', () => {
  let owner: any;
  let business: any;

  const buy = (overrides: Record<string, unknown> = {}) =>
    advertisementService.requestFromBusiness({
      ownerId: owner._id.toString(),
      businessId: business._id.toString(),
      campaignName: 'Promo de la semana',
      flyerUrl: 'https://cdn.example.com/flyer.jpg',
      startDate: new Date(Date.now() - 86_400_000),
      endDate: new Date(Date.now() + 86_400_000),
      pricingModel: AdPricingModel.CPM,
      cpmRate: 2000,
      cpcRate: 0,
      budget: 100_000,
      ...overrides,
    } as never);

  beforeEach(async () => {
    await Advertisement.deleteMany({});
    await AdEvent.deleteMany({});
    await AdInvoice.deleteMany({});

    owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
  });

  // ── Comprar ──

  it('un comercio compra su campaña y nace pendiente de revisión', async () => {
    const ad = await buy();

    // Un comercio no publica en la app de ZIPP sin que alguien mire lo que
    // va a salir.
    expect(ad.approvalStatus).toBe(AdApprovalStatus.PENDING);
    expect(ad.isActive).toBe(false);
  });

  it('el destino del toque es su propio negocio, no lo elige', async () => {
    const ad = await buy();

    // Si pudiera elegirlo, podría pagar por mandar tráfico a un tercero.
    expect(ad.businessId!.toString()).toBe(business._id.toString());
    expect(ad.billedToBusinessId!.toString()).toBe(business._id.toString());
  });

  it('no se puede comprar publicidad para el negocio de otro', async () => {
    const intruso = await makeUser({ role: UserRole.BUSINESS });

    await expect(
      buy({ ownerId: intruso._id.toString() })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('sin tope de gasto no se compra', async () => {
    await expect(buy({ budget: 0 })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('si el presupuesto no alcanza ni para una impresión, se dice', async () => {
    // Mil pesos de presupuesto a un CPM de dos millones no compra nada, y
    // crear la campaña igualmente sería cobrarle por un cartel invisible.
    await expect(
      buy({ budget: 1000, cpmRate: 2_000_000 })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  // ── El presupuesto como tope ──

  it('el presupuesto se traduce a impresiones, y ahí lo defiende el tope atómico', async () => {
    // $100.000 a $2.000 el mil = 50.000 impresiones exactas.
    const ad = await buy({ budget: 100_000, cpmRate: 2000 });
    expect(ad.maxImpressions).toBe(50_000);
  });

  it('con CPC el tope es de clics', async () => {
    const ad = await buy({
      pricingModel: AdPricingModel.CPC,
      cpmRate: 0,
      cpcRate: 500,
      budget: 100_000,
    });

    expect(ad.maxClicks).toBe(200);
    expect(ad.maxImpressions).toBe(0);
  });

  it('agotado el tope de clics, deja de contarlos', async () => {
    const ad = await buy({
      pricingModel: AdPricingModel.CPC,
      cpmRate: 0,
      cpcRate: 50_000,
      budget: 100_000,
    });
    await advertisementService.approve(ad._id.toString());

    await advertisementService.registerClick(ad._id.toString(), 'device-1');
    await advertisementService.registerClick(ad._id.toString(), 'device-2');

    // Antes `registerClick` no comprobaba nada: con CPC eso era gasto puro
    // por encima de lo que el comercio autorizó.
    await expect(
      advertisementService.registerClick(ad._id.toString(), 'device-3')
    ).rejects.toMatchObject({ statusCode: 404 });

    const saved = await Advertisement.findById(ad._id);
    expect(saved!.clickCount).toBe(2);
  });

  // ── Revisión ──

  it('una campaña pendiente no se sirve en la app', async () => {
    await buy();
    expect(await advertisementService.getActiveForApp()).toBeNull();
  });

  it('aprobarla la enciende y la pone a rodar', async () => {
    const ad = await buy();
    await advertisementService.approve(ad._id.toString());

    expect((await advertisementService.getActiveForApp())?.campaignName).toBe('Promo de la semana');
  });

  it('rechazar sin motivo no se puede', async () => {
    const ad = await buy();

    // Un "no" sin explicación obliga a adivinar, y lo normal es que reenvíe
    // exactamente lo mismo.
    await expect(
      advertisementService.reject(ad._id.toString(), '   ')
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('una campaña rechazada guarda el motivo y no sale', async () => {
    const ad = await buy();
    await advertisementService.reject(ad._id.toString(), 'El flyer tiene el logo de otra marca');

    const saved = await Advertisement.findById(ad._id);
    expect(saved!.rejectionReason).toContain('otra marca');
    expect(await advertisementService.getActiveForApp()).toBeNull();
  });

  // ── El importe ──

  it('el gasto se calcula, no se acumula', async () => {
    const ad = await buy({ cpmRate: 2000 });
    await Advertisement.updateOne({ _id: ad._id }, { impressionCount: 1501 });

    const saved = await Advertisement.findById(ad._id);

    // 1501 × 2000 / 1000 = 3002. Sumar 2 pesos por impresión habría dado
    // 3002 aquí también, pero con un CPM de 1500 la suma redondea mil
    // quinientas veces y esto una sola.
    expect(advertisementService.spendOf(saved!)).toBe(3002);
  });

  it('un CPM que no divide exacto se redondea una sola vez', async () => {
    const ad = await buy({ cpmRate: 1500 });
    await Advertisement.updateOne({ _id: ad._id }, { impressionCount: 777 });

    const saved = await Advertisement.findById(ad._id);
    // 777 × 1500 / 1000 = 1165,5 → 1166. Acumulando 1,5 pesos por impresión
    // con redondeo en cada paso habrían salido 1554.
    expect(advertisementService.spendOf(saved!)).toBe(1166);
  });

  // ── Cerrar y facturar ──

  it('cerrar congela los contadores en la factura', async () => {
    const ad = await buy({ cpmRate: 2000 });
    await advertisementService.approve(ad._id.toString());
    await Advertisement.updateOne({ _id: ad._id }, { impressionCount: 10_000, clickCount: 42 });

    const invoice = await advertisementService.closeAndInvoice(ad._id.toString());

    expect(invoice.impressions).toBe(10_000);
    expect(invoice.clicks).toBe(42);
    expect(invoice.amount).toBe(20_000);
  });

  it('la factura sobrevive a que cambien las tarifas después', async () => {
    const ad = await buy({ cpmRate: 2000 });
    await Advertisement.updateOne({ _id: ad._id }, { impressionCount: 10_000 });
    const invoice = await advertisementService.closeAndInvoice(ad._id.toString());

    // Subir la tarifa mañana no puede reescribir lo que se cobró ayer.
    await Advertisement.updateOne({ _id: ad._id }, { cpmRate: 9000 });

    const saved = await AdInvoice.findById(invoice._id);
    expect(saved!.amount).toBe(20_000);
    expect(saved!.cpmRate).toBe(2000);
  });

  it('cerrar dos veces no factura dos veces', async () => {
    const ad = await buy();
    await Advertisement.updateOne({ _id: ad._id }, { impressionCount: 5000 });

    const first = await advertisementService.closeAndInvoice(ad._id.toString());
    const second = await advertisementService.closeAndInvoice(ad._id.toString());

    expect(second._id.toString()).toBe(first._id.toString());
    expect(await AdInvoice.countDocuments({ campaignId: ad._id })).toBe(1);
  });

  it('cerrar apaga la campaña', async () => {
    const ad = await buy();
    await advertisementService.approve(ad._id.toString());
    await advertisementService.closeAndInvoice(ad._id.toString());

    expect((await Advertisement.findById(ad._id))!.isActive).toBe(false);
  });

  it('lo que compró un comercio se descuenta de su liquidación', async () => {
    const ad = await buy({ cpmRate: 2000 });
    await Advertisement.updateOne({ _id: ad._id }, { impressionCount: 10_000 });
    await advertisementService.closeAndInvoice(ad._id.toString());

    // Es lo que permite comprar publicidad sin tarjeta ni pasarela: ya
    // recibe un pago semanal de ZIPP, y esto es una resta sobre él.
    expect(await advertisementService.outstandingForBusiness(business._id.toString())).toBe(20_000);
  });

  // ── El descuento en la liquidación ──

  it('la publicidad se descuenta del pago semanal del comercio', async () => {
    const { payoutService } = await import('../services/payout.service');
    const { Payout, AdInvoice: Invoices } = await import('../models');
    const { PayoutBeneficiary, PayoutStatus } = await import('../types');

    const ad = await buy({ cpmRate: 2000 });
    await Advertisement.updateOne({ _id: ad._id }, { impressionCount: 10_000 });
    await advertisementService.closeAndInvoice(ad._id.toString());

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

    // Es lo que la pantalla del comercio promete. Sin esto sería una
    // promesa que el código no cumple.
    expect(settlement!.adSpendAmount).toBe(20_000);
    expect(settlement!.netAmount).toBe(480_000);
    expect((await Invoices.findOne({ campaignId: ad._id }))!.settledAt).toBeTruthy();
  });

  it('un mes flojo no deja al comercio debiéndole dinero a ZIPP', async () => {
    const { payoutService } = await import('../services/payout.service');
    const { Payout, AdInvoice: Invoices } = await import('../models');
    const { PayoutBeneficiary, PayoutStatus } = await import('../types');

    const ad = await buy({ cpmRate: 2000 });
    await Advertisement.updateOne({ _id: ad._id }, { impressionCount: 10_000 });
    await advertisementService.closeAndInvoice(ad._id.toString());

    // Vendió menos de lo que gastó en anunciarse.
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

    // Se cobra lo que cabe y el resto espera. Convertir una compra de
    // publicidad en una deuda es la forma más rápida de que nadie vuelva a
    // comprar publicidad.
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
