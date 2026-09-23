import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Advertisement, Business, PromotionBanner, BannerPlacement, AdPlacement, AdApprovalStatus } from '../models';
import { advertisementService } from '../services';
import { UserRole } from '../types';
import {
  makeUser, authHeader, makeBusiness, makeProduct, makePricingConfig,
  makeDiscoveryCollections,
} from './factories';

const hourFromNow = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

function campaignBody(overrides: Record<string, unknown> = {}) {
  return {
    campaignName: 'Lanzamiento Verano',
    advertiserName: 'Pollo Frito Garzón',
    flyerUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
    startDate: hourFromNow(-1),
    endDate: hourFromNow(24),
    isActive: true,
    priority: 0,
    actionType: 'none',
    maxImpressions: 0,
    ...overrides,
  };
}

/** Abre el negocio las 24 horas, para que la hora a la que corra la prueba no importe. */
async function openAllDay(businessId: any) {
  const day = { open: '00:00', close: '23:59', isOpen: true };
  await Business.updateOne(
    { _id: businessId },
    { schedule: { monday: day, tuesday: day, wednesday: day, thursday: day, friday: day, saturday: day, sunday: day } }
  );
}

describe('Publicidad — superficie (splash vs explore)', () => {
  it('una campaña de "explore" nunca sale al pedir splash, y viceversa', async () => {
    await Advertisement.create(campaignBody({ campaignName: 'Solo Explorar', placement: AdPlacement.EXPLORE }));
    await Advertisement.create(campaignBody({ campaignName: 'Solo Splash', placement: AdPlacement.SPLASH }));

    const splash = await advertisementService.getActiveForApp({}, AdPlacement.SPLASH);
    expect(splash?.campaignName).toBe('Solo Splash');

    const explore = await advertisementService.getActiveForApp({}, AdPlacement.EXPLORE);
    expect(explore?.campaignName).toBe('Solo Explorar');
  });

  it('un documento viejo sin el campo "placement" físicamente en Mongo sale en splash y no en explore', async () => {
    const created = await Advertisement.create(campaignBody({ campaignName: 'Campaña de Atlas anterior a la migración' }));
    // Simula un documento sembrado antes de que `placement` existiera: el
    // campo no está físicamente en Mongo, no es que valga `undefined` en el
    // objeto de Mongoose.
    await Advertisement.collection.updateOne({ _id: created._id }, { $unset: { placement: 1 } });

    const raw = await Advertisement.collection.findOne({ _id: created._id });
    expect(raw).not.toHaveProperty('placement');

    const splash = await advertisementService.getActiveForApp({}, AdPlacement.SPLASH);
    expect(splash?.campaignName).toBe('Campaña de Atlas anterior a la migración');

    const explore = await advertisementService.getActiveForApp({}, AdPlacement.EXPLORE);
    expect(explore).toBeNull();
  });

  it('las demás condiciones (fechas, aprobación, tope) se siguen aplicando junto con la superficie', async () => {
    // Vencida, aunque sea de "explore".
    await Advertisement.create(campaignBody({
      campaignName: 'Explore vencida', placement: AdPlacement.EXPLORE,
      startDate: hourFromNow(-48), endDate: hourFromNow(-1),
    }));
    // Pendiente de aprobación (compra de comercio), aunque sea de "explore".
    await Advertisement.create(campaignBody({
      campaignName: 'Explore pendiente', placement: AdPlacement.EXPLORE,
      approvalStatus: AdApprovalStatus.PENDING, isActive: false,
    }));
    // Tope de impresiones agotado.
    const capped = await Advertisement.create(campaignBody({
      campaignName: 'Explore agotada', placement: AdPlacement.EXPLORE, maxImpressions: 1,
    }));
    await Advertisement.updateOne({ _id: capped._id }, { $inc: { impressionCount: 1 } });
    // La única que debería calificar.
    await Advertisement.create(campaignBody({ campaignName: 'Explore vigente', placement: AdPlacement.EXPLORE }));

    const explore = await advertisementService.getActiveForApp({}, AdPlacement.EXPLORE);
    expect(explore?.campaignName).toBe('Explore vigente');
  });
});

describe('Publicidad — el guard de cambiar superficie (controller.update)', () => {
  it('cambiar "placement" en una campaña sin tráfico se permite', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const created = await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody())
      .expect(201);
    const id = created.body.data._id;
    expect(created.body.data.placement).toBe('splash');

    const updated = await request(app)
      .patch(`/api/v1/advertisements/${id}`)
      .set(await authHeader(admin))
      .send({ placement: 'explore' })
      .expect(200);

    expect(updated.body.data.placement).toBe('explore');
    expect((await Advertisement.findById(id))!.placement).toBe('explore');
  });

  it('cambiar "placement" en una campaña con impresiones registradas devuelve 409 y no guarda el cambio', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const created = await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody())
      .expect(201);
    const id = created.body.data._id;

    // La única forma real de que impressionCount suba: la app la reporta.
    await request(app).post(`/api/v1/advertisements/${id}/impression`).send({ deviceId: 'dev-1' }).expect(200);

    await request(app)
      .patch(`/api/v1/advertisements/${id}`)
      .set(await authHeader(admin))
      .send({ placement: 'explore' })
      .expect(409);

    expect((await Advertisement.findById(id))!.placement).toBe('splash');
  });

  it('cambiar "placement" en una campaña con clics registrados también devuelve 409 y no guarda el cambio', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const created = await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody())
      .expect(201);
    const id = created.body.data._id;

    await request(app).post(`/api/v1/advertisements/${id}/click`).send({ deviceId: 'dev-1' }).expect(200);

    await request(app)
      .patch(`/api/v1/advertisements/${id}`)
      .set(await authHeader(admin))
      .send({ placement: 'explore' })
      .expect(409);

    expect((await Advertisement.findById(id))!.placement).toBe('splash');
  });

  it('editar otro campo sin tocar "placement" sigue funcionando aunque ya haya tráfico', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const created = await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody())
      .expect(201);
    const id = created.body.data._id;

    await request(app).post(`/api/v1/advertisements/${id}/impression`).send({ deviceId: 'dev-1' }).expect(200);

    const updated = await request(app)
      .patch(`/api/v1/advertisements/${id}`)
      .set(await authHeader(admin))
      .send({ campaignName: 'Nombre corregido' })
      .expect(200);

    expect(updated.body.data.campaignName).toBe('Nombre corregido');
  });

  it('mandar el mismo valor de "placement" que ya tiene no cuenta como cambio, aunque haya tráfico', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const created = await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody())
      .expect(201);
    const id = created.body.data._id;

    await request(app).post(`/api/v1/advertisements/${id}/impression`).send({ deviceId: 'dev-1' }).expect(200);

    await request(app)
      .patch(`/api/v1/advertisements/${id}`)
      .set(await authHeader(admin))
      .send({ placement: 'splash', campaignName: 'Nombre corregido' })
      .expect(200);

    expect((await Advertisement.findById(id))!.campaignName).toBe('Nombre corregido');
  });
});

describe('Explorar — mezcla de la campaña con el feed', () => {
  const EXPLORE_API = '/api/v1/explore';
  let owner: any;

  async function seedCatalog(count = 12) {
    const business = await makeBusiness(owner._id, { isApproved: true, isActive: true });
    await openAllDay(business._id);
    for (let i = 0; i < count; i++) {
      await makeProduct(business._id, { name: `Pizza ${i}`, price: 20000, discountPrice: 10000 });
    }
    return business;
  }

  async function seedAdmin() {
    await makePricingConfig();
    await makeDiscoveryCollections();
    owner = await makeUser({ role: UserRole.BUSINESS });
  }

  it('sin campaña activa de "explore", el feed sale igual que antes (sin anuncio)', async () => {
    await seedAdmin();
    await seedCatalog();
    // Hay una campaña, pero es de splash: no debe aparecer en Explorar.
    await Advertisement.create(campaignBody({ placement: AdPlacement.SPLASH }));

    const res = await request(app).get(EXPLORE_API).expect(200);
    const promo = res.body.data.entries.find((e: any) => e.kind === 'promo');
    if (promo) {
      expect(promo.banners.some((b: any) => b.isAd)).toBe(false);
    }
  });

  it('con campaña de "explore" activa y sin ningún banner gratuito, crea el bloque promo con el anuncio', async () => {
    await seedAdmin();
    await seedCatalog();
    await Advertisement.create(campaignBody({ campaignName: 'Ads de Explorar', placement: AdPlacement.EXPLORE }));

    const res = await request(app).get(EXPLORE_API).expect(200);
    const promo = res.body.data.entries.find((e: any) => e.kind === 'promo');

    expect(promo).toBeDefined();
    expect(promo.banners).toHaveLength(1);
    expect(promo.banners[0].isAd).toBe(true);
    expect(promo.banners[0].title).toBe('Ads de Explorar');
  });

  it('con campaña Y un PromotionBanner ya en Explorar, la campaña queda primera en "banners"', async () => {
    await seedAdmin();
    await seedCatalog();
    await PromotionBanner.create({
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/banner.jpg',
      title: 'Banner gratuito',
      startDate: new Date(Date.now() - 3600_000),
      endDate: new Date(Date.now() + 3600_000),
      isActive: true,
      placement: BannerPlacement.EXPLORE,
    });
    await Advertisement.create(campaignBody({ campaignName: 'Ads pagado', placement: AdPlacement.EXPLORE }));

    const res = await request(app).get(EXPLORE_API).expect(200);
    const promo = res.body.data.entries.find((e: any) => e.kind === 'promo');

    expect(promo).toBeDefined();
    expect(promo.banners.length).toBeGreaterThanOrEqual(2);
    expect(promo.banners[0].isAd).toBe(true);
    expect(promo.banners[0].title).toBe('Ads pagado');
    expect(promo.banners[1].isAd).toBeFalsy();
    expect(promo.banners[1].title).toBe('Banner gratuito');
  });

  it('la campaña se resuelve por petición: dos consultas a la misma zona no se pisan aunque el feed venga de la misma entrada de caché', async () => {
    await seedAdmin();
    await seedCatalog();

    const first = await Advertisement.create(campaignBody({ campaignName: 'Primera campaña', placement: AdPlacement.EXPLORE }));

    const res1 = await request(app).get(EXPLORE_API).expect(200);
    const promo1 = res1.body.data.entries.find((e: any) => e.kind === 'promo');
    expect(promo1.banners[0].title).toBe('Primera campaña');

    // La primera campaña deja de calificar y otra toma su lugar. Mismo host,
    // misma zona/franja: si el feed cacheado llevara el anuncio dentro, la
    // segunda petición seguiría mostrando la primera campaña.
    await advertisementService.cancel(first._id.toString());
    await Advertisement.create(campaignBody({ campaignName: 'Segunda campaña', placement: AdPlacement.EXPLORE }));

    const res2 = await request(app).get(EXPLORE_API).expect(200);
    const promo2 = res2.body.data.entries.find((e: any) => e.kind === 'promo');
    expect(promo2.banners[0].title).toBe('Segunda campaña');

    // Y las colecciones —lo que sí viene de la caché compartida— son
    // idénticas entre ambas respuestas: la prueba de que se reutilizó la
    // misma entrada de caché y no se recalculó el feed entero.
    const collections1 = res1.body.data.entries.filter((e: any) => e.kind !== 'promo');
    const collections2 = res2.body.data.entries.filter((e: any) => e.kind !== 'promo');
    expect(collections2).toEqual(collections1);
  });
});
