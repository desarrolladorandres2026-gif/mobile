import { describe, it, expect, beforeEach } from 'vitest';
import { Advertisement, AdEvent } from '../models';
import { UserRole } from '../types';
import { advertisementService } from '../services/advertisement.service';

/**
 * Publicidad dirigida y repartida.
 *
 * La base ya existía —campañas, impresiones, clics con tope— pero servía
 * siempre lo mismo a todo el mundo: sin segmento, y con la campaña más
 * nueva llevándose todo el tráfico hasta agotar su tope.
 *
 * Las dos cosas cuestan dinero al anunciante: impresiones fuera de su
 * público y quince impresiones a la misma persona, que son quince cobros
 * por un alcance de uno.
 */
describe('Selección de publicidad', () => {
  const makeAd = (overrides: Record<string, unknown> = {}) =>
    Advertisement.create({
      campaignName: 'Campaña',
      advertiserName: 'Anunciante de prueba',
      flyerUrl: 'https://cdn.example.com/flyer.jpg',
      startDate: new Date(Date.now() - 86_400_000),
      endDate: new Date(Date.now() + 86_400_000),
      isActive: true,
      ...overrides,
    });

  beforeEach(async () => {
    await Advertisement.deleteMany({});
    await AdEvent.deleteMany({});
  });

  it('sin campañas no devuelve nada', async () => {
    expect(await advertisementService.getActiveForApp()).toBeNull();
  });

  it('una campaña sin segmento la ve todo el mundo', async () => {
    await makeAd({ campaignName: 'Para todos' });

    const ad = await advertisementService.getActiveForApp({ city: 'Neiva' });
    expect(ad?.campaignName).toBe('Para todos');
  });

  it('una campaña de otra ciudad no se enseña', async () => {
    await makeAd({ campaignName: 'Solo Garzón', targetCities: ['Garzón'] });

    // Enseñársela a alguien de otro municipio es quemar impresiones que el
    // anunciante paga.
    expect(await advertisementService.getActiveForApp({ city: 'Neiva' })).toBeNull();
    expect((await advertisementService.getActiveForApp({ city: 'Garzón' }))?.campaignName).toBe(
      'Solo Garzón'
    );
  });

  it('segmenta por rol', async () => {
    await makeAd({ campaignName: 'Para domiciliarios', targetRoles: [UserRole.DRIVER] });

    expect(await advertisementService.getActiveForApp({ role: UserRole.CLIENT })).toBeNull();
    expect(
      (await advertisementService.getActiveForApp({ role: UserRole.DRIVER }))?.campaignName
    ).toBe('Para domiciliarios');
  });

  it('sin saber la ciudad del usuario, no se filtra por ciudad', async () => {
    // Un visitante sin sesión también ve publicidad; descartar todo lo
    // segmentado le dejaría la pantalla vacía.
    await makeAd({ campaignName: 'Solo Garzón', targetCities: ['Garzón'] });

    expect((await advertisementService.getActiveForApp())?.campaignName).toBe('Solo Garzón');
  });

  it('la prioridad manda por encima del reparto', async () => {
    await makeAd({ campaignName: 'Baja', priority: 1, impressionCount: 0 });
    await makeAd({ campaignName: 'Alta', priority: 10, impressionCount: 500 });

    expect((await advertisementService.getActiveForApp())?.campaignName).toBe('Alta');
  });

  it('entre empatadas, va la que menos impresiones lleva', async () => {
    await makeAd({ campaignName: 'Ya muy vista', priority: 5, impressionCount: 900 });
    await makeAd({ campaignName: 'Poco vista', priority: 5, impressionCount: 10 });

    // Antes la más nueva se llevaba todo el tráfico hasta agotar su tope, y
    // la otra no se veía hasta entonces.
    expect((await advertisementService.getActiveForApp())?.campaignName).toBe('Poco vista');
  });

  it('respeta el tope global de impresiones', async () => {
    await makeAd({ campaignName: 'Agotada', maxImpressions: 100, impressionCount: 100 });

    expect(await advertisementService.getActiveForApp()).toBeNull();
  });

  it('no repite la misma campaña a quien ya la vio bastante', async () => {
    const ad = await makeAd({ campaignName: 'Con tope por persona', maxImpressionsPerUser: 2 });

    await AdEvent.create({
      campaignId: ad._id,
      campaignName: ad.campaignName,
      eventType: 'impression',
      deviceId: 'device-1',
    });
    await AdEvent.create({
      campaignId: ad._id,
      campaignName: ad.campaignName,
      eventType: 'impression',
      deviceId: 'device-1',
    });

    // Quince impresiones al mismo usuario son quince cobros por un alcance
    // de uno, y para él son quince veces el mismo cartel.
    expect(await advertisementService.getActiveForApp({ deviceId: 'device-1' })).toBeNull();
    expect(
      (await advertisementService.getActiveForApp({ deviceId: 'device-2' }))?.campaignName
    ).toBe('Con tope por persona');
  });

  it('pasa a la siguiente campaña cuando la primera se agotó para esa persona', async () => {
    const primera = await makeAd({
      campaignName: 'Ya vista',
      priority: 10,
      maxImpressionsPerUser: 1,
    });
    await makeAd({ campaignName: 'Todavía no vista', priority: 5 });

    await AdEvent.create({
      campaignId: primera._id,
      campaignName: primera.campaignName,
      eventType: 'impression',
      deviceId: 'device-1',
    });

    expect(
      (await advertisementService.getActiveForApp({ deviceId: 'device-1' }))?.campaignName
    ).toBe('Todavía no vista');
  });

  it('sin tope por persona no se consulta el historial', async () => {
    await makeAd({ campaignName: 'Sin tope', maxImpressionsPerUser: 0 });

    // Se sirve igual aunque el dispositivo la haya visto mil veces: el caso
    // normal no paga ninguna lectura extra.
    expect((await advertisementService.getActiveForApp({ deviceId: 'device-1' }))?.campaignName).toBe(
      'Sin tope'
    );
  });

  it('una campaña cancelada no se sirve aunque esté en fechas', async () => {
    await makeAd({ campaignName: 'Cancelada', cancelledAt: new Date() });

    expect(await advertisementService.getActiveForApp()).toBeNull();
  });

  it('una campaña futura todavía no se sirve', async () => {
    await makeAd({
      campaignName: 'Programada',
      startDate: new Date(Date.now() + 86_400_000),
      endDate: new Date(Date.now() + 172_800_000),
    });

    expect(await advertisementService.getActiveForApp()).toBeNull();
  });
});
