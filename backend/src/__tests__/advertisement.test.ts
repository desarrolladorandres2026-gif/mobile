import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Advertisement, AdEvent } from '../models';
import { advertisementService } from '../services';
import { UserRole } from '../types';
import { makeUser, authHeader } from './factories';

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

describe('Publicidad — administración', () => {
  it('exige autenticación de administrador para crear una campaña', async () => {
    await request(app).post('/api/v1/advertisements').send(campaignBody()).expect(401);

    const client = await makeUser({ role: UserRole.CLIENT });
    await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(client))
      .send(campaignBody())
      .expect(403);
  });

  it('un admin crea una campaña y queda en el listado con estado calculado', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });

    const res = await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody())
      .expect(201);

    expect(res.body.data.campaignName).toBe('Lanzamiento Verano');

    const list = await request(app)
      .get('/api/v1/advertisements')
      .set(await authHeader(admin))
      .expect(200);

    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].status).toBe('active');
  });
});

describe('Publicidad — endpoint público de la app', () => {
  it('una campaña activa y vigente aparece en /advertisements/active', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody())
      .expect(201);

    const res = await request(app).get('/api/v1/advertisements/active').expect(200);

    expect(res.body.data).not.toBeNull();
    expect(res.body.data.campaignName).toBe('Lanzamiento Verano');
    // El endpoint público no debe filtrar datos internos del anunciante ni contadores.
    expect(res.body.data.advertiserName).toBeUndefined();
    expect(res.body.data.impressionCount).toBeUndefined();
  });

  it('no muestra nada cuando no hay ninguna campaña activa', async () => {
    const res = await request(app).get('/api/v1/advertisements/active').expect(200);
    expect(res.body.data).toBeNull();
  });

  it('ignora una campaña programada a futuro', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody({ startDate: hourFromNow(2), endDate: hourFromNow(48) }))
      .expect(201);

    const res = await request(app).get('/api/v1/advertisements/active').expect(200);
    expect(res.body.data).toBeNull();
  });

  it('ignora una campaña vencida', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody({ startDate: hourFromNow(-48), endDate: hourFromNow(-1) }))
      .expect(201);

    const res = await request(app).get('/api/v1/advertisements/active').expect(200);
    expect(res.body.data).toBeNull();
  });

  it('ignora una campaña desactivada por el admin', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const created = await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody())
      .expect(201);

    await request(app)
      .patch(`/api/v1/advertisements/${created.body.data._id}/toggle`)
      .set(await authHeader(admin))
      .expect(200);

    const res = await request(app).get('/api/v1/advertisements/active').expect(200);
    expect(res.body.data).toBeNull();
  });

  it('cuando hay varias activas, gana la de mayor prioridad', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await request(app).post('/api/v1/advertisements').set(await authHeader(admin))
      .send(campaignBody({ campaignName: 'Baja prioridad', priority: 1 })).expect(201);
    await request(app).post('/api/v1/advertisements').set(await authHeader(admin))
      .send(campaignBody({ campaignName: 'Alta prioridad', priority: 50 })).expect(201);

    const res = await request(app).get('/api/v1/advertisements/active').expect(200);
    expect(res.body.data.campaignName).toBe('Alta prioridad');
  });

  it('deja de mostrarse tras alcanzar el máximo de impresiones', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const created = await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody({ maxImpressions: 1 }))
      .expect(201);
    const id = created.body.data._id;

    await request(app).post(`/api/v1/advertisements/${id}/impression`).send({ deviceId: 'dev-1' }).expect(200);

    const res = await request(app).get('/api/v1/advertisements/active').expect(200);
    expect(res.body.data).toBeNull();
  });
});

describe('Publicidad — analítica', () => {
  it('registra la impresión solo cuando la app la reporta, e incrementa el contador', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const created = await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody())
      .expect(201);
    const id = created.body.data._id;

    await request(app).post(`/api/v1/advertisements/${id}/impression`).send({ deviceId: 'dev-1' }).expect(200);

    const ad = await Advertisement.findById(id);
    expect(ad!.impressionCount).toBe(1);
    expect(await AdEvent.countDocuments({ campaignId: id, eventType: 'impression' })).toBe(1);
  });

  it('registra el clic y lo distingue de la impresión', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const created = await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody())
      .expect(201);
    const id = created.body.data._id;

    await request(app).post(`/api/v1/advertisements/${id}/click`).send({ deviceId: 'dev-1' }).expect(200);

    const ad = await Advertisement.findById(id);
    expect(ad!.clickCount).toBe(1);
    expect(ad!.impressionCount).toBe(0);
    expect(await AdEvent.countDocuments({ campaignId: id, eventType: 'click' })).toBe(1);
  });
});

describe('Publicidad — eliminar', () => {
  afterEach(() => vi.restoreAllMocks());

  it('un admin elimina una campaña y deja de existir', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const created = await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody())
      .expect(201);
    const id = created.body.data._id;

    await request(app).delete(`/api/v1/advertisements/${id}`).set(await authHeader(admin)).expect(200);

    expect(await Advertisement.findById(id)).toBeNull();
  });

  it('borra el flyer anterior de Cloudinary al eliminar la campaña', async () => {
    const destroyFlyer = vi.spyOn(advertisementService, 'destroyFlyer').mockResolvedValue();
    const admin = await makeUser({ role: UserRole.ADMIN });
    const created = await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody())
      .expect(201);
    const id = created.body.data._id;

    await request(app).delete(`/api/v1/advertisements/${id}`).set(await authHeader(admin)).expect(200);

    expect(destroyFlyer).toHaveBeenCalledWith(campaignBody().flyerUrl);
  });
});

describe('Publicidad — duración de visualización', () => {
  it('trae 5 segundos por defecto, y el endpoint público la incluye', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const created = await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody())
      .expect(201);
    expect(created.body.data.durationSeconds).toBe(5);

    const res = await request(app).get('/api/v1/advertisements/active').expect(200);
    expect(res.body.data.durationSeconds).toBe(5);
  });

  it('respeta una duración personalizada dentro del rango permitido', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody({ durationSeconds: 8 }))
      .expect(201);

    const res = await request(app).get('/api/v1/advertisements/active').expect(200);
    expect(res.body.data.durationSeconds).toBe(8);
  });

  it('rechaza una duración fuera de rango', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody({ durationSeconds: 60 }))
      .expect(400);
  });
});

describe('Publicidad — cancelar', () => {
  it('un admin cancela una campaña, deja de mostrarse y no puede reactivarse', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const created = await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody())
      .expect(201);
    const id = created.body.data._id;

    const cancelled = await request(app)
      .patch(`/api/v1/advertisements/${id}/cancel`)
      .set(await authHeader(admin))
      .expect(200);
    expect(cancelled.body.data.status).toBe('cancelled');

    const active = await request(app).get('/api/v1/advertisements/active').expect(200);
    expect(active.body.data).toBeNull();

    // Ni "reactivar" (toggle) ni cancelar dos veces deben poder revertirlo.
    await request(app).patch(`/api/v1/advertisements/${id}/toggle`).set(await authHeader(admin)).expect(409);
    await request(app).patch(`/api/v1/advertisements/${id}/cancel`).set(await authHeader(admin)).expect(409);
  });

  it('pausar y reactivar (toggle) no afecta a una campaña que no está cancelada', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const created = await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody())
      .expect(201);
    const id = created.body.data._id;

    const paused = await request(app)
      .patch(`/api/v1/advertisements/${id}/toggle`)
      .set(await authHeader(admin))
      .expect(200);
    expect(paused.body.data.status).toBe('paused');

    const reactivated = await request(app)
      .patch(`/api/v1/advertisements/${id}/toggle`)
      .set(await authHeader(admin))
      .expect(200);
    expect(reactivated.body.data.status).toBe('active');
  });
});

describe('Publicidad — estadísticas', () => {
  it('separa el total acumulado de las impresiones/clics de hoy', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const created = await request(app)
      .post('/api/v1/advertisements')
      .set(await authHeader(admin))
      .send(campaignBody())
      .expect(201);
    const id = created.body.data._id;

    await request(app).post(`/api/v1/advertisements/${id}/impression`).send({ deviceId: 'dev-1' }).expect(200);
    await request(app).post(`/api/v1/advertisements/${id}/impression`).send({ deviceId: 'dev-2' }).expect(200);
    await request(app).post(`/api/v1/advertisements/${id}/click`).send({ deviceId: 'dev-1' }).expect(200);

    const stats = await request(app)
      .get(`/api/v1/advertisements/${id}/stats`)
      .set(await authHeader(admin))
      .expect(200);

    expect(stats.body.data).toEqual({
      totalImpressions: 2,
      totalClicks: 1,
      todayImpressions: 2,
      todayClicks: 1,
    });
  });

  it('el resumen global suma todas las campañas', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const a = await request(app).post('/api/v1/advertisements').set(await authHeader(admin))
      .send(campaignBody({ campaignName: 'Campaña A' })).expect(201);
    const b = await request(app).post('/api/v1/advertisements').set(await authHeader(admin))
      .send(campaignBody({ campaignName: 'Campaña B' })).expect(201);

    await request(app).post(`/api/v1/advertisements/${a.body.data._id}/impression`).send({ deviceId: 'dev-1' }).expect(200);
    await request(app).post(`/api/v1/advertisements/${b.body.data._id}/impression`).send({ deviceId: 'dev-2' }).expect(200);

    const summary = await request(app)
      .get('/api/v1/advertisements/stats/summary')
      .set(await authHeader(admin))
      .expect(200);

    expect(summary.body.data.totalImpressions).toBe(2);
    expect(summary.body.data.todayImpressions).toBe(2);
  });

  it('exige autenticación de administrador', async () => {
    await request(app).get('/api/v1/advertisements/stats/summary').expect(401);
  });
});
