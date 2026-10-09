import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Coupon } from '../models';
import { UserRole, CouponFundedBy, CouponType, CouponScope } from '../types';
import { couponService } from '../services/coupon.service';
import { makeUser, makeBusiness, authHeader } from './factories';

/**
 * El tope del 90 % de una promoción de comercio vale al crear Y al editar
 * (auditoría 2026-10-09, fase 7).
 *
 * Antes solo lo aplicaba el validador de creación: bastaba crear al 90 % y
 * subirla a 100 % con un PATCH. Ahora lo exige el modelo, que ve el documento
 * ya mezclado en todos los caminos que lo escriben.
 */

let owner: any;
let business: any;
let couponId: string;

const body = {
  code: 'TOPE90',
  title: 'Promo de prueba',
  type: 'percentage',
  value: 20,
  validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
};

const create = async (overrides: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/v1/coupons/business/${business._id}`)
    .set(await authHeader(owner))
    .send({ ...body, ...overrides });

const patch = async (id: string, data: Record<string, unknown>, path = '') =>
  request(app)
    .patch(`/api/v1/coupons/business/${id}${path}`)
    .set(await authHeader(owner))
    .send(data);

beforeEach(async () => {
  owner = await makeUser({ role: UserRole.BUSINESS });
  business = await makeBusiness(owner._id);
  const coupon = await couponService.createForBusiness(owner._id.toString(), business._id.toString(), {
    ...body,
    validUntil: new Date(body.validUntil),
  } as any);
  couponId = coupon._id.toString();
});

describe('Tope del descuento porcentual de comercio', () => {
  it('crear: 90 % pasa, 91 % y 100 % no', async () => {
    expect((await create({ code: 'OK90', value: 90 })).status).toBe(201);
    expect((await create({ code: 'NO91', value: 91 })).status).toBe(400);
    expect((await create({ code: 'NO100', value: 100 })).status).toBe(400);
  });

  it('editar: subir una promoción válida a 95 % o 100 % se rechaza por la API directa', async () => {
    for (const value of [91, 95, 100]) {
      const res = await patch(couponId, { value });
      expect(res.status, String(value)).toBe(400);
    }
    expect((await Coupon.findById(couponId))!.value).toBe(20);
  });

  it('editar: hasta 90 % sigue permitido', async () => {
    expect((await patch(couponId, { value: 90 })).status).toBe(200);
    expect((await Coupon.findById(couponId))!.value).toBe(90);
  });

  it('el modelo lo exige también por el camino del administrador (asignar y guardar)', async () => {
    const coupon = (await Coupon.findById(couponId))!;
    Object.assign(coupon, { value: 100 });
    await expect(coupon.save()).rejects.toThrow(/90%/);

    await expect(
      Coupon.create({
        code: 'ADMIN95', title: 'Admin', description: 'x', type: CouponType.PERCENTAGE, value: 95,
        fundedBy: CouponFundedBy.BUSINESS, scope: CouponScope.PRODUCT, businessId: business._id,
        validFrom: new Date(), validUntil: new Date(Date.now() + 86_400_000),
      })
    ).rejects.toThrow(/90%/);
  });

  it('cambiar el tipo a porcentual con un valor alto también se rechaza', async () => {
    const fixed = await couponService.createForBusiness(owner._id.toString(), business._id.toString(), {
      ...body, code: 'FIJO', type: 'fixed', value: 95, validUntil: new Date(body.validUntil),
    } as any);
    const doc = (await Coupon.findById(fixed._id))!;
    doc.type = CouponType.PERCENTAGE;
    await expect(doc.save()).rejects.toThrow(/90%/);
  });

  it('una promoción antigua que ya pasaba del tope se puede apagar, pero no subir ni reactivar', async () => {
    // Dato heredado, escrito saltándose las validaciones.
    await Coupon.collection.updateOne({ _id: (await Coupon.findById(couponId))!._id }, { $set: { value: 95 } });

    expect((await patch(couponId, {}, '/deactivate')).status).toBe(200);
    expect((await Coupon.findById(couponId))!.isActive).toBe(false);

    expect((await patch(couponId, {}, '/reactivate')).status).toBe(400);
    expect((await Coupon.findById(couponId))!.isActive).toBe(false);

    // Editar otra cosa sin tocar el descuento no se bloquea por el dato viejo.
    expect((await patch(couponId, { title: 'Nuevo título' })).status).toBe(200);
    // Pero tocar el valor, aunque sea para dejarlo igual de alto, sí.
    expect((await patch(couponId, { value: 96 })).status).toBe(400);
  });

  it('las promociones de la plataforma no se ven afectadas por el tope de comercio', async () => {
    const platform = await Coupon.create({
      code: 'PLAT100', title: 'Plataforma', description: 'x', type: CouponType.PERCENTAGE, value: 100,
      fundedBy: CouponFundedBy.PLATFORM, scope: CouponScope.PRODUCT,
      validFrom: new Date(), validUntil: new Date(Date.now() + 86_400_000),
    });
    expect(platform.value).toBe(100);
  });
});
