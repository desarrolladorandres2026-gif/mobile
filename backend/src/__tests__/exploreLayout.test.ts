import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import {
  AdEvent, Advertisement, AdPlacement, Business, ExploreLayoutState, ExploreLayoutVersion,
} from '../models';
import { UserRole } from '../types';
import { parseSectionsLenient, publishProblems, sectionSchema } from '../validators/exploreLayout.validator';
import { assemblePlan, type CollectionPlan, type LoadedCandidates, type SectionProduct } from '../services/discovery.service';
import { Types } from 'mongoose';
import { makeUser, authHeader, makeBusiness, makeProduct, makeDiscoveryCollections } from './factories';

const API = '/api/v1/explore-layout';
const EXPLORE = '/api/v1/explore';

const carousel = { kind: 'carousel', rows: 1, card: 'compact' };
const promoWithAd = { id: 'promo-ad', type: 'promo', includeAd: true };

async function openAllDay(businessId: any) {
  const day = { open: '00:00', close: '23:59', isOpen: true };
  await Business.updateOne(
    { _id: businessId },
    { schedule: { monday: day, tuesday: day, wednesday: day, thursday: day, friday: day, saturday: day, sunday: day } }
  );
}

/** Cinco negocios con cuatro platos rebajados cada uno: llenan cualquier sección sin tocar los topes. */
async function seedCatalog() {
  await makeDiscoveryCollections();
  const products: any[] = [];
  for (let b = 0; b < 5; b++) {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { name: `Negocio ${b}`, isApproved: true, isActive: true });
    await openAllDay(business._id);
    for (let p = 0; p < 4; p++) {
      products.push(await makeProduct(business._id, { name: `Plato ${b}-${p}`, price: 20000, discountPrice: 10000 }));
    }
  }
  return products;
}

async function adminAuth() {
  return authHeader(await makeUser({ role: UserRole.ADMIN }));
}

async function saveAndPublish(auth: Record<string, string>, sections: unknown[], revision = 0) {
  const saved = await request(app).put(`${API}/draft`).set(auth).send({ sections, revision }).expect(200);
  const published = await request(app)
    .post(`${API}/publish`).set(auth).send({ revision: saved.body.data.revision, note: 'prueba' }).expect(200);
  return { revision: saved.body.data.revision as number, version: published.body.data.version as number };
}

function campaign(overrides: Record<string, unknown> = {}) {
  return Advertisement.create({
    campaignName: 'Campaña de Explorar',
    advertiserName: 'Anunciante',
    flyerUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
    startDate: new Date(Date.now() - 3600_000),
    endDate: new Date(Date.now() + 86_400_000),
    placement: AdPlacement.EXPLORE,
    ...overrides,
  });
}

describe('Constructor de Explorar — permisos', () => {
  it('sin sesión es 401; un cliente o un comercio reciben 403', async () => {
    await request(app).get(`${API}/draft`).expect(401);

    const client = await makeUser({ role: UserRole.CLIENT });
    await request(app).get(`${API}/draft`).set(await authHeader(client)).expect(403);

    const owner = await makeUser({ role: UserRole.BUSINESS });
    await request(app)
      .put(`${API}/draft`).set(await authHeader(owner))
      .send({ sections: [promoWithAd], revision: 0 })
      .expect(403);
  });

  it('un admin ve el borrador: sin nada guardado, arranca desde el layout de siempre', async () => {
    const res = await request(app).get(`${API}/draft`).set(await adminAuth()).expect(200);
    expect(res.body.data.revision).toBe(0);
    expect(res.body.data.sections.map((s: any) => s.type)).toEqual(['discovery_band', 'promo', 'discovery_band']);
  });
});

describe('Constructor de Explorar — validación', () => {
  it('rechaza tipos desconocidos, cuadrículas de más de doce, ids inválidos, precios sin rango e ids repetidos', async () => {
    const auth = await adminAuth();
    const bad = [
      [{ id: 'xx1', type: 'hero_magico' }],
      [{ id: 'grid-1', type: 'products', dataSource: { kind: 'collection', key: 'descuentosLocos' }, layout: { kind: 'grid', columns: 4, rows: 4 } }],
      [{ id: 'man-1', type: 'products', dataSource: { kind: 'manual', productIds: ['no-es-un-id'] }, layout: carousel }],
      [{ id: 'rule-1', type: 'products', dataSource: { kind: 'rule', rule: { all: [{ source: 'price' }] } }, layout: carousel }],
      [promoWithAd, { ...promoWithAd }],
    ];
    for (const sections of bad) {
      await request(app).put(`${API}/draft`).set(auth).send({ sections, revision: 0 }).expect(400);
    }
    // Nada de eso llegó a guardarse.
    expect(await ExploreLayoutState.countDocuments()).toBe(0);
  });

  it('al leer secciones guardadas, una inválida se descarta sola y el resto sigue', () => {
    const { sections, dropped } = parseSectionsLenient([
      promoWithAd,
      { id: 'roto', type: 'products', layout: carousel },
      { id: 'band-1', type: 'discovery_band', pattern: [carousel] },
    ]);
    expect(dropped).toBe(1);
    expect(sections.map((s) => s.id)).toEqual(['promo-ad', 'band-1']);
  });

  it('publicar exige un bloque de banners visible con el anuncio pagado, y contenido', () => {
    const band = sectionSchema.parse({ id: 'band-1', type: 'discovery_band', pattern: [carousel] });
    const promo = sectionSchema.parse(promoWithAd);
    const hiddenPromo = sectionSchema.parse({ ...promoWithAd, hidden: true });

    expect(publishProblems([band, promo])).toEqual([]);
    expect(publishProblems([band])).toHaveLength(1);
    expect(publishProblems([band, hiddenPromo]).length).toBeGreaterThan(0);
    expect(publishProblems([promo]).length).toBeGreaterThan(0);
  });
});

describe('Constructor de Explorar — borrador, publicación y versiones', () => {
  it('guardar exige la revisión que se leyó: la segunda edición simultánea recibe 409', async () => {
    const auth = await adminAuth();
    const sections = [{ id: 'band-1', type: 'discovery_band', pattern: [carousel] }, promoWithAd];

    const first = await request(app).put(`${API}/draft`).set(auth).send({ sections, revision: 0 }).expect(200);
    expect(first.body.data.revision).toBe(1);

    await request(app).put(`${API}/draft`).set(auth).send({ sections, revision: 0 }).expect(409);
    const second = await request(app).put(`${API}/draft`).set(auth).send({ sections, revision: 1 }).expect(200);
    expect(second.body.data.revision).toBe(2);
  });

  it('no publica sin el anuncio, ni con una revisión que ya no es la del borrador', async () => {
    const auth = await adminAuth();
    const noAd = [{ id: 'band-1', type: 'discovery_band', pattern: [carousel] }];
    const saved = await request(app).put(`${API}/draft`).set(auth).send({ sections: noAd, revision: 0 }).expect(200);
    await request(app).post(`${API}/publish`).set(auth).send({ revision: saved.body.data.revision }).expect(400);

    const fixed = await request(app)
      .put(`${API}/draft`).set(auth).send({ sections: [...noAd, promoWithAd], revision: saved.body.data.revision }).expect(200);
    await request(app).post(`${API}/publish`).set(auth).send({ revision: saved.body.data.revision }).expect(409);
    await request(app).post(`${API}/publish`).set(auth).send({ revision: fixed.body.data.revision }).expect(200);
  });

  it('dos publicaciones simultáneas dejan una sola versión vigente', async () => {
    await ExploreLayoutVersion.init();
    const auth = await adminAuth();
    const sections = [{ id: 'band-1', type: 'discovery_band', pattern: [carousel] }, promoWithAd];
    const saved = await request(app).put(`${API}/draft`).set(auth).send({ sections, revision: 0 }).expect(200);

    const results = await Promise.all([
      request(app).post(`${API}/publish`).set(auth).send({ revision: saved.body.data.revision }),
      request(app).post(`${API}/publish`).set(auth).send({ revision: saved.body.data.revision }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await ExploreLayoutVersion.countDocuments()).toBe(1);
    expect((await ExploreLayoutState.findOne())!.currentVersion).toBe(1);
  });

  it('restaurar trae una versión al borrador, o la republica como una versión nueva', async () => {
    const auth = await adminAuth();
    const layoutA = [{ id: 'band-a', type: 'discovery_band', pattern: [carousel] }, promoWithAd];
    const layoutB = [promoWithAd, { id: 'band-b', type: 'discovery_band', pattern: [{ kind: 'grid', columns: 3, rows: 2 }] }];

    const v1 = await saveAndPublish(auth, layoutA);
    const v2 = await saveAndPublish(auth, layoutB, v1.revision);
    expect(v2.version).toBe(2);

    const toDraft = await request(app)
      .post(`${API}/versions/1/restore`).set(auth).send({ revision: v2.revision, mode: 'draft' }).expect(200);
    expect(toDraft.body.data.publishedVersion).toBeNull();
    let state = await ExploreLayoutState.findOne().lean();
    expect(state!.currentVersion).toBe(2);
    expect((state!.draft as any[]).map((s) => s.id)).toEqual(['band-a', 'promo-ad']);

    const republished = await request(app)
      .post(`${API}/versions/1/restore`).set(auth).send({ revision: toDraft.body.data.revision, mode: 'publish' }).expect(200);
    expect(republished.body.data.publishedVersion).toBe(3);
    state = await ExploreLayoutState.findOne().lean();
    expect(state!.currentVersion).toBe(3);

    const history = await request(app).get(`${API}/versions`).set(auth).expect(200);
    expect(history.body.data.versions.map((v: any) => v.version)).toEqual([3, 2, 1]);
    expect(history.body.data.versions[0].restoredFrom).toBe(1);
  });
});

describe('Constructor de Explorar — lo que ve la app', () => {
  it('sin nada publicado, un APK viejo (sin ?layout=1) recibe la forma de siempre y la app nueva recibe secciones', async () => {
    await seedCatalog();

    const legacy = await request(app).get(EXPLORE).expect(200);
    expect(legacy.body.data).not.toHaveProperty('sections');
    expect(Object.keys(legacy.body.data).sort()).toEqual(['daypart', 'entries', 'personalized']);
    const collection = legacy.body.data.entries.find((e: any) => e.kind === 'collection');
    expect(collection).toBeDefined();
    expect(Object.keys(collection)).toEqual(
      expect.arrayContaining(['kind', 'order', 'key', 'title', 'displayVariant', 'products'])
    );
    const keys = legacy.body.data.entries.filter((e: any) => e.kind === 'collection').map((e: any) => e.key);
    expect(new Set(keys).size).toBe(keys.length);

    const modern = await request(app).get(EXPLORE).query({ layout: '1' }).expect(200);
    expect(modern.body.data.layoutVersion).toBe(0);
    const products = modern.body.data.sections.filter((s: any) => s.type === 'products');
    expect(products.length).toBeGreaterThan(0);
    expect(products[0].layout).toBeDefined();
  });

  it('respeta el orden publicado: una lista a mano, una colección fijada y una regla propia', async () => {
    const products = await seedCatalog();
    const auth = await adminAuth();
    const chosen = [products[7], products[2], products[15]].map((p) => p._id.toString());

    const { version } = await saveAndPublish(auth, [
      { id: 'manual-1', type: 'products', title: 'Elegidos a mano', dataSource: { kind: 'manual', productIds: chosen }, layout: carousel },
      promoWithAd,
      { id: 'pinned-1', type: 'products', dataSource: { kind: 'collection', key: 'descuentosLocos' }, layout: { kind: 'carousel', rows: 2 } },
      {
        id: 'rule-1', type: 'products', title: 'Mitad de precio',
        dataSource: { kind: 'rule', rule: { all: [{ source: 'discount', minPercent: 40 }], sortBy: 'discount' } },
        layout: { kind: 'grid', columns: 3, rows: 2 },
      },
    ]);

    const res = await request(app).get(EXPLORE).query({ layout: '1' }).expect(200);
    expect(res.body.data.layoutVersion).toBe(version);

    const sections = res.body.data.sections;
    // Sin banners ni campaña, el bloque de banners queda vacío y no se manda.
    expect(sections.map((s: any) => s.id)).toEqual(['manual-1', 'pinned-1', 'rule-1']);
    expect(sections[0].products.map((p: any) => p._id)).toEqual(chosen);
    expect(sections[1].key).toBe('descuentosLocos');
    expect(sections[1].layout).toEqual({ kind: 'carousel', rows: 2, card: 'compact' });
    // Una cuadrícula de 3 columnas solo enseña filas completas.
    expect(sections[2].products.length % 3).toBe(0);
    expect(sections[2].products.length).toBeGreaterThan(0);
  });

  it('una sección vencida no sale, y una colección que no existe se descarta sin tumbar el resto', async () => {
    await seedCatalog();
    const auth = await adminAuth();
    await saveAndPublish(auth, [
      {
        id: 'expired', type: 'products', dataSource: { kind: 'collection', key: 'descuentosLocos' }, layout: carousel,
        rules: { startDate: new Date(Date.now() - 86_400_000 * 2).toISOString(), endDate: new Date(Date.now() - 86_400_000).toISOString() },
      },
      { id: 'ghost', type: 'products', dataSource: { kind: 'collection', key: 'noExiste' }, layout: carousel },
      promoWithAd,
      { id: 'band-1', type: 'discovery_band', pattern: [carousel] },
    ]);

    const res = await request(app).get(EXPLORE).query({ layout: '1' }).expect(200);
    const ids = res.body.data.sections.map((s: any) => s.id);
    expect(ids).not.toContain('expired');
    expect(ids).not.toContain('ghost');
    expect(ids.some((id: string) => id.startsWith('band-1:'))).toBe(true);
  });

  it('una versión publicada ilegible cae al layout por defecto: Explorar nunca queda en blanco', async () => {
    await seedCatalog();
    await ExploreLayoutVersion.create({
      scope: 'global', version: 1, sections: [{ id: 'xx', type: 'bogus' }], schemaVersion: 1, publishedAt: new Date(),
    });
    await ExploreLayoutState.create({ scope: 'global', draft: [], schemaVersion: 1, revision: 1, currentVersion: 1 });

    const res = await request(app).get(EXPLORE).query({ layout: '1' }).expect(200);
    expect(res.body.data.layoutVersion).toBe(0);
    expect(res.body.data.sections.some((s: any) => s.type === 'products')).toBe(true);
  });

  it('la vista previa muestra dónde cae el anuncio, avisa de lo que falta y no registra impresiones', async () => {
    await seedCatalog();
    await campaign();
    const auth = await adminAuth();

    const res = await request(app)
      .post(`${API}/preview`).set(auth)
      .send({
        sections: [
          { id: 'ghost', type: 'products', dataSource: { kind: 'collection', key: 'noExiste' }, layout: carousel },
          promoWithAd,
          { id: 'band-1', type: 'discovery_band', pattern: [carousel] },
        ],
      })
      .expect(200);

    const promo = res.body.data.sections.find((s: any) => s.type === 'promo');
    expect(promo.banners[0].isAd).toBe(true);
    expect(res.body.data.warnings.some((w: string) => w.includes('noExiste'))).toBe(true);
    expect(res.body.data.blockers).toEqual([]);

    expect(await AdEvent.countDocuments()).toBe(0);
    expect((await Advertisement.findOne())!.impressionCount).toBe(0);
    // Previsualizar no publica ni guarda nada.
    expect(await ExploreLayoutState.countDocuments()).toBe(0);
  });
});

describe('Reparto entre bandas (assemblePlan)', () => {
  const allDay = { open: '00:00', close: '23:59', isOpen: true };
  const schedule = {
    sunday: allDay, monday: allDay, tuesday: allDay, wednesday: allDay,
    thursday: allDay, friday: allDay, saturday: allDay,
  };

  /** Un negocio con `count` productos: con un solo negocio, los topes de exposición mandan. */
  function catalog(count: number): SectionProduct[] {
    const businessId = new Types.ObjectId();
    return Array.from({ length: count }, (_, i) => ({
      _id: new Types.ObjectId(),
      name: `Plato ${i}`,
      price: 10000,
      discountPercent: 0,
      effectivePrice: 10000,
      isFeatured: false,
      createdAt: new Date(),
      tags: [],
      businessId,
      businessName: 'Único',
      businessCategory: 'restaurant',
      businessRating: 4.5,
      businessTotalReviews: 10,
      businessDeliveryTime: 30,
      businessFreeDeliveryThreshold: 0,
      businessSchedule: schedule,
      businessCreatedAt: new Date(),
    }));
  }

  function plan(key: string): CollectionPlan {
    return {
      key, order: 0, title: key, displayVariant: 'compact',
      rule: { all: [{ source: 'featured' }], sortBy: 'relevance' },
      rotation: 'none', targetSize: 4, minSize: 4,
    };
  }

  it('con un catálogo pequeño, lo rescatado llena la primera banda hasta su tope y el resto pasa a la siguiente', () => {
    const products = catalog(12);
    const plans = ['a', 'b', 'c', 'd'].map(plan);
    const loaded: LoadedCandidates = {
      raw: Object.fromEntries(plans.map((p) => [p.key, products])),
      coords: null,
      salesIds: {},
      seed: 0,
    };
    const sizing = (p: CollectionPlan) => ({ targetSize: p.targetSize, minSize: p.minSize });

    const [top, rest] = assemblePlan(
      [{ kind: 'band', take: 2, sizing }, { kind: 'band', take: 'rest', sizing }],
      plans,
      loaded
    );

    // Con un solo negocio, todas fallan la primera pasada (dos por negocio
    // por sección) y se rescatan relajadas: dos arriba, lo demás abajo.
    expect(top.map((e) => e.key)).toEqual(['a', 'b']);
    expect(rest.map((e) => e.key)).toEqual(['c', 'd']);
  });

  it('una sola banda que se lo lleva todo se comporta como el feed de siempre', () => {
    const products = catalog(12);
    const plans = ['a', 'b'].map(plan);
    const loaded: LoadedCandidates = {
      raw: Object.fromEntries(plans.map((p) => [p.key, products])),
      coords: null,
      salesIds: {},
      seed: 0,
    };
    const [entries] = assemblePlan(
      [{ kind: 'band', take: 'rest', sizing: (p) => ({ targetSize: p.targetSize, minSize: p.minSize }) }],
      plans,
      loaded
    );
    expect(entries.map((e) => e.key)).toEqual(['a', 'b']);
  });
});
