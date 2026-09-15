import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Address } from '../models/Address';
import { UserRole } from '../types';
import { zoneService } from '../services/zone.service';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeZone, makePricingConfig, authHeader,
} from './factories';

const NEW_ADDRESS = {
  label: 'Casa',
  address: 'Calle 5 # 3-21',
  details: 'Portón negro',
  latitude: GARZON.lat,
  longitude: GARZON.lng,
};

async function withAddress(overrides: Record<string, unknown> = {}) {
  const client = await makeUser({ role: UserRole.CLIENT });

  const res = await request(app)
    .post('/api/v1/addresses')
    .set(await authHeader(client))
    .send({ ...NEW_ADDRESS, ...overrides })
    .expect(201);

  return { client, address: res.body.data };
}

describe('PATCH /api/v1/addresses/:id', () => {
  it('cambia solo los campos que llegan y conserva el resto', async () => {
    const { client, address } = await withAddress();

    const res = await request(app)
      .patch(`/api/v1/addresses/${address._id}`)
      .set(await authHeader(client))
      .send({ apartment: 'Torre B, apto 502' })
      .expect(200);

    expect(res.body.data.apartment).toBe('Torre B, apto 502');
    // Lo que no se mandó sigue igual: editar el piso no puede vaciar la calle.
    expect(res.body.data.label).toBe('Casa');
    expect(res.body.data.address).toBe('Calle 5 # 3-21');
    expect(res.body.data.details).toBe('Portón negro');
  });

  it('conserva el identificador, que es la razón de editar en vez de recrear', async () => {
    const { client, address } = await withAddress();

    const res = await request(app)
      .patch(`/api/v1/addresses/${address._id}`)
      .set(await authHeader(client))
      .send({ label: 'Casa de mi mamá' })
      .expect(200);

    expect(res.body.data._id).toBe(address._id);
  });

  it('mueve el punto cuando llegan las dos coordenadas', async () => {
    const { client, address } = await withAddress();
    const moved = offsetKm(GARZON, 1);

    const res = await request(app)
      .patch(`/api/v1/addresses/${address._id}`)
      .set(await authHeader(client))
      .send({ latitude: moved.lat, longitude: moved.lng })
      .expect(200);

    expect(res.body.data.location.coordinates[0]).toBeCloseTo(moved.lng, 5);
    expect(res.body.data.location.coordinates[1]).toBeCloseTo(moved.lat, 5);
  });

  it('rechaza media coordenada en vez de moverla a un sitio inventado', async () => {
    const { client, address } = await withAddress();

    await request(app)
      .patch(`/api/v1/addresses/${address._id}`)
      .set(await authHeader(client))
      .send({ latitude: 2.5 })
      .expect(400);

    // Y el punto original sigue intacto.
    const stored = await Address.findById(address._id);
    expect(stored!.location.coordinates[1]).toBeCloseTo(GARZON.lat, 5);
  });

  it('no deja editar la dirección de otro usuario', async () => {
    const { address } = await withAddress();
    const intruder = await makeUser({ role: UserRole.CLIENT });

    await request(app)
      .patch(`/api/v1/addresses/${address._id}`)
      .set(await authHeader(intruder))
      .send({ label: 'Mía ahora' })
      .expect(404);
  });

  it('ignora isDefault: marcar la principal tiene su propia ruta', async () => {
    const { client, address: first } = await withAddress();

    const second = await request(app)
      .post('/api/v1/addresses')
      .set(await authHeader(client))
      .send({ ...NEW_ADDRESS, label: 'Trabajo' })
      .expect(201);

    expect(second.body.data.isDefault).toBe(false);

    const res = await request(app)
      .patch(`/api/v1/addresses/${second.body.data._id}`)
      .set(await authHeader(client))
      .send({ label: 'Oficina', isDefault: true })
      .expect(200);

    expect(res.body.data.label).toBe('Oficina');
    // El campo se descarta al validar, así que la principal no se movió.
    expect(res.body.data.isDefault).toBe(false);
    const stillDefault = await Address.findById(first._id);
    expect(stillDefault!.isDefault).toBe(true);
  });

  it('requiere autenticación', async () => {
    const { address } = await withAddress();

    await request(app)
      .patch(`/api/v1/addresses/${address._id}`)
      .send({ label: 'Sin token' })
      .expect(401);
  });
});

describe('GET /api/v1/addresses/search', () => {
  it('requiere autenticación', async () => {
    await request(app)
      .get('/api/v1/addresses/search')
      .query({ q: 'calle 5' })
      .expect(401);
  });

  it('exige al menos tres letras antes de gastar una consulta', async () => {
    const client = await makeUser({ role: UserRole.CLIENT });

    await request(app)
      .get('/api/v1/addresses/search')
      .set(await authHeader(client))
      .query({ q: 'ca' })
      .expect(400);
  });

  it('rechaza media coordenada de proximidad', async () => {
    const client = await makeUser({ role: UserRole.CLIENT });

    await request(app)
      .get('/api/v1/addresses/search')
      .set(await authHeader(client))
      .query({ q: 'calle 5', lat: GARZON.lat })
      .expect(400);
  });

  /**
   * No se afirma *qué* devuelve, sino que siempre devuelve una lista.
   *
   * Sin token de Mapbox el servicio contesta `[]` y con token contestaría
   * direcciones reales; atarse a un contenido concreto haría que la prueba
   * dependiera de si quien la corre tiene credenciales en su `.env`. Lo que
   * importa aquí es el contrato: nunca un error, nunca `null`.
   */
  it('siempre responde una lista, con o sin resultados', async () => {
    const client = await makeUser({ role: UserRole.CLIENT });

    const res = await request(app)
      .get('/api/v1/addresses/search')
      .set(await authHeader(client))
      .query({ q: 'calle 5', lat: GARZON.lat, lng: GARZON.lng })
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('zoneService.checkCoverage', () => {
  it('acepta cualquier punto cuando no hay zonas configuradas', async () => {
    await makePricingConfig();

    const result = await zoneService.checkCoverage(GARZON.lat, GARZON.lng);

    expect(result.covered).toBe(true);
    expect(result.zone).toBeNull();
  });

  it('acepta un punto dentro del polígono', async () => {
    await makePricingConfig();
    const zone = await makeZone(GARZON, 3);

    const result = await zoneService.checkCoverage(GARZON.lat, GARZON.lng);

    expect(result.covered).toBe(true);
    expect(result.zone?.id).toBe(zone._id.toString());
  });

  it('rechaza un punto fuera de toda zona, con motivo legible', async () => {
    await makePricingConfig();
    await makeZone(GARZON, 1);
    const faraway = offsetKm(GARZON, 20);

    const result = await zoneService.checkCoverage(faraway.lat, faraway.lng);

    expect(result.covered).toBe(false);
    expect(result.reason).toMatch(/cobertura/i);
  });

  it('mide la distancia al negocio cuando se indica cuál', async () => {
    await makePricingConfig({ maxRadiusMeters: 5000 });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    const faraway = offsetKm(GARZON, 12);

    const result = await zoneService.checkCoverage(
      faraway.lat,
      faraway.lng,
      business._id.toString()
    );

    expect(result.covered).toBe(false);
    expect(result.distanceKm).toBeGreaterThan(5);
    expect(result.maxRadiusKm).toBe(5);
  });

  /**
   * El mismo radio que usa el motor de precios.
   *
   * Si estos dos se separan, el mapa diría "sí repartimos" y el checkout
   * respondería 422 sobre la misma dirección — que es exactamente la
   * contradicción que la configuración compartida existe para evitar.
   */
  it('usa el radio de la configuración de plataforma, no uno propio', async () => {
    await makePricingConfig({ maxRadiusMeters: 8000 });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);

    const result = await zoneService.checkCoverage(
      GARZON.lat,
      GARZON.lng,
      business._id.toString()
    );

    expect(result.maxRadiusKm).toBe(8);
  });

  it('no acepta coordenadas imposibles', async () => {
    await makePricingConfig();

    const result = await zoneService.checkCoverage(999, 999);

    expect(result.covered).toBe(false);
    expect(result.reason).toMatch(/inválidas/i);
  });
});
