import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Coupon } from '../models';
import { UserRole, CouponFundedBy, CouponType, CouponScope } from '../types';
import { couponService } from '../services/coupon.service';
import { makeUser, makeBusiness, makeProduct, GARZON } from './factories';

/**
 * Promociones que crea el propio comercio.
 *
 * El modelo `Coupon` ya estaba diseñado para esto —tiene `fundedBy`,
 * `businessId`, `budgetLimit`— pero solo un administrador podía crearlos.
 *
 * Lo que estas pruebas fijan no es que se puedan crear, sino los tres
 * campos que el servidor NO lee de la petición: quién financia, de qué
 * negocio es, y si puede saltarse el margen mínimo. Son exactamente los
 * tres con los que un comercio podría hacer que ZIPP pague su promoción.
 */
describe('Promociones del comercio', () => {
  let owner: any;
  let business: any;

  const base = {
    code: 'MIPROMO',
    title: '15% en toda la carta',
    type: 'percentage' as const,
    value: 15,
    validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  };

  beforeEach(async () => {
    owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
  });

  it('crea la promoción a nombre del negocio', async () => {
    const coupon = await couponService.createForBusiness(
      owner._id.toString(),
      business._id.toString(),
      { ...base }
    );

    expect(coupon.code).toBe('MIPROMO');
    expect(coupon.businessId!.toString()).toBe(business._id.toString());
  });

  it('la paga el comercio, diga lo que diga la petición', async () => {
    const coupon = await couponService.createForBusiness(
      owner._id.toString(),
      business._id.toString(),
      { ...base, fundedBy: CouponFundedBy.PLATFORM }
    );

    // Si esto fallara, un comercio podría crear promociones a cargo de ZIPP.
    expect(coupon.fundedBy).toBe(CouponFundedBy.BUSINESS);
  });

  it('no puede autoaprobarse el permiso para hundir el margen', async () => {
    const coupon = await couponService.createForBusiness(
      owner._id.toString(),
      business._id.toString(),
      { ...base, campaignApproved: true }
    );

    expect(coupon.campaignApproved).toBe(false);
  });

  it('no puede crear la promoción a nombre de otro negocio', async () => {
    const otherOwner = await makeUser({ role: UserRole.BUSINESS });
    const other = await makeBusiness(otherOwner._id, { lat: GARZON.lat, lng: GARZON.lng });

    await expect(
      couponService.createForBusiness(owner._id.toString(), other._id.toString(), { ...base })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('ni colándose el businessId en el cuerpo', async () => {
    const otherOwner = await makeUser({ role: UserRole.BUSINESS });
    const other = await makeBusiness(otherOwner._id, { lat: GARZON.lat, lng: GARZON.lng });

    const coupon = await couponService.createForBusiness(
      owner._id.toString(),
      business._id.toString(),
      { ...base, businessId: other._id.toString() }
    );

    expect(coupon.businessId!.toString()).toBe(business._id.toString());
  });

  it('el código se normaliza a mayúsculas', async () => {
    const coupon = await couponService.createForBusiness(
      owner._id.toString(),
      business._id.toString(),
      { ...base, code: 'minuscula' }
    );

    expect(coupon.code).toBe('MINUSCULA');
  });

  it('no deja repetir un código que ya existe', async () => {
    await couponService.createForBusiness(owner._id.toString(), business._id.toString(), { ...base });

    await expect(
      couponService.createForBusiness(owner._id.toString(), business._id.toString(), { ...base })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('lista solo las promociones propias', async () => {
    const otherOwner = await makeUser({ role: UserRole.BUSINESS });
    const other = await makeBusiness(otherOwner._id, { lat: GARZON.lat, lng: GARZON.lng });

    await couponService.createForBusiness(owner._id.toString(), business._id.toString(), { ...base });
    await couponService.createForBusiness(otherOwner._id.toString(), other._id.toString(), {
      ...base,
      code: 'OTRA',
    });

    const mine = await couponService.listForBusiness(owner._id.toString(), business._id.toString());
    expect(mine).toHaveLength(1);
    expect(mine[0].code).toBe('MIPROMO');
  });

  it('desactivar no borra: los canjes ya hechos siguen apuntando a algo', async () => {
    const coupon = await couponService.createForBusiness(
      owner._id.toString(),
      business._id.toString(),
      { ...base }
    );

    await couponService.deactivateForBusiness(owner._id.toString(), coupon._id.toString());

    const saved = await Coupon.findById(coupon._id);
    expect(saved).not.toBeNull();
    expect(saved!.isActive).toBe(false);
  });

  it('no puede desactivar la promoción de otro', async () => {
    const coupon = await couponService.createForBusiness(
      owner._id.toString(),
      business._id.toString(),
      { ...base }
    );
    const intruso = await makeUser({ role: UserRole.BUSINESS });

    await expect(
      couponService.deactivateForBusiness(intruso._id.toString(), coupon._id.toString())
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('Promociones automáticas por producto (sin código)', () => {
  let owner: any;
  let business: any;
  let productA: any;
  let productB: any;

  const autoBase = {
    title: '20% en la hamburguesa',
    type: 'percentage' as const,
    value: 20,
    validFrom: new Date(),
    validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    autoApply: true,
  };

  beforeEach(async () => {
    owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    productA = await makeProduct(business._id, { price: 25000 });
    productB = await makeProduct(business._id, { price: 15000 });
  });

  it('crea sin código: el servicio genera uno sintético que no se expone', async () => {
    const coupon = await couponService.createForBusiness(
      owner._id.toString(),
      business._id.toString(),
      { ...autoBase, productIds: [productA._id.toString()] }
    );

    expect(coupon.autoApply).toBe(true);
    expect(coupon.code).toBeTruthy();
    expect(coupon.productIds.map((id) => id.toString())).toEqual([productA._id.toString()]);
  });

  it('rechaza productos que no pertenecen a este negocio', async () => {
    const otherOwner = await makeUser({ role: UserRole.BUSINESS });
    const other = await makeBusiness(otherOwner._id, { lat: GARZON.lat, lng: GARZON.lng });
    const ajeno = await makeProduct(other._id, { price: 9000 });

    await expect(
      couponService.createForBusiness(owner._id.toString(), business._id.toString(), {
        ...autoBase,
        productIds: [ajeno._id.toString()],
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rechaza dos promociones activas que se solapan sobre el mismo producto', async () => {
    await couponService.createForBusiness(owner._id.toString(), business._id.toString(), {
      ...autoBase,
      productIds: [productA._id.toString()],
    });

    await expect(
      couponService.createForBusiness(owner._id.toString(), business._id.toString(), {
        ...autoBase,
        title: 'Otra promo',
        productIds: [productA._id.toString()],
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('no se solapa si las fechas no se cruzan', async () => {
    await couponService.createForBusiness(owner._id.toString(), business._id.toString(), {
      ...autoBase,
      validFrom: new Date(),
      validUntil: new Date(Date.now() + 5 * 24 * 3600_000),
      productIds: [productA._id.toString()],
    });

    const second = await couponService.createForBusiness(owner._id.toString(), business._id.toString(), {
      ...autoBase,
      title: 'Empieza después',
      validFrom: new Date(Date.now() + 10 * 24 * 3600_000),
      validUntil: new Date(Date.now() + 20 * 24 * 3600_000),
      productIds: [productA._id.toString()],
    });

    expect(second.autoApply).toBe(true);
  });

  it('permite cubrir dos productos distintos en la misma promoción', async () => {
    const coupon = await couponService.createForBusiness(
      owner._id.toString(),
      business._id.toString(),
      { ...autoBase, productIds: [productA._id.toString(), productB._id.toString()] }
    );

    expect(coupon.productIds).toHaveLength(2);
  });

  it('el modelo exige al menos un producto y máximo 50', async () => {
    await expect(
      couponService.createForBusiness(owner._id.toString(), business._id.toString(), {
        ...autoBase,
        productIds: [],
      })
    ).rejects.toThrow(/al menos un producto/i);

    // El chequeo de 50 vive en el modelo, no en el servicio — se prueba
    // aparte con ids sintéticos para no depender de crear 51 productos
    // reales ni de la comprobación de pertenencia al negocio.
    const many = Array.from({ length: 51 }, () => new mongoose.Types.ObjectId());
    await expect(
      Coupon.create({
        code: 'MUCHOS',
        title: 'Demasiados productos',
        type: CouponType.PERCENTAGE,
        value: 10,
        validUntil: new Date(Date.now() + 30 * 24 * 3600_000),
        fundedBy: CouponFundedBy.BUSINESS,
        scope: CouponScope.PRODUCT,
        businessId: business._id,
        autoApply: true,
        productIds: many,
      })
    ).rejects.toThrow(/50 productos/i);
  });

  it('listForBusiness devuelve availability resuelto (activa/programada/finalizada)', async () => {
    const active = await couponService.createForBusiness(owner._id.toString(), business._id.toString(), {
      ...autoBase,
      productIds: [productA._id.toString()],
    });
    const scheduled = await couponService.createForBusiness(owner._id.toString(), business._id.toString(), {
      ...autoBase,
      title: 'Programada',
      validFrom: new Date(Date.now() + 10 * 24 * 3600_000),
      validUntil: new Date(Date.now() + 20 * 24 * 3600_000),
      productIds: [productB._id.toString()],
    });

    const mine = await couponService.listForBusiness(owner._id.toString(), business._id.toString());
    const byId = new Map(mine.map((c: any) => [c._id.toString(), c]));

    expect(byId.get(active._id.toString())!.availability.state).toBe('active');
    expect(byId.get(scheduled._id.toString())!.availability.state).toBe('scheduled');
  });

  it('updateForBusiness edita campos permitidos y revalida el solapamiento', async () => {
    const coupon = await couponService.createForBusiness(owner._id.toString(), business._id.toString(), {
      ...autoBase,
      productIds: [productA._id.toString()],
    });

    const updated = await couponService.updateForBusiness(owner._id.toString(), coupon._id.toString(), {
      value: 30,
    });
    expect(updated.value).toBe(30);

    // No puede colarse un campo forzado.
    const untouched = await couponService.updateForBusiness(owner._id.toString(), coupon._id.toString(), {
      fundedBy: 'platform', // se prueba justamente que se ignore
    });
    expect(untouched.fundedBy).toBe(CouponFundedBy.BUSINESS);
  });

  it('updateForBusiness no permite bajar el presupuesto por debajo de lo gastado', async () => {
    const coupon = await couponService.createForBusiness(owner._id.toString(), business._id.toString(), {
      ...autoBase,
      productIds: [productA._id.toString()],
      budgetLimit: 100000,
    });
    await Coupon.updateOne({ _id: coupon._id }, { $set: { budgetSpent: 50000 } });

    await expect(
      couponService.updateForBusiness(owner._id.toString(), coupon._id.toString(), { budgetLimit: 20000 })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('reactivateForBusiness vuelve a activar una promoción desactivada', async () => {
    const coupon = await couponService.createForBusiness(owner._id.toString(), business._id.toString(), {
      ...autoBase,
      productIds: [productA._id.toString()],
    });
    await couponService.deactivateForBusiness(owner._id.toString(), coupon._id.toString());

    const reactivated = await couponService.reactivateForBusiness(owner._id.toString(), coupon._id.toString());
    expect(reactivated.isActive).toBe(true);
  });

  it('deleteForBusiness borra de verdad si nunca se usó', async () => {
    const coupon = await couponService.createForBusiness(owner._id.toString(), business._id.toString(), {
      ...autoBase,
      productIds: [productA._id.toString()],
    });

    await couponService.deleteForBusiness(owner._id.toString(), coupon._id.toString());
    expect(await Coupon.findById(coupon._id)).toBeNull();
  });

  it('deleteForBusiness rechaza si ya tuvo canjes: hay que desactivar', async () => {
    const coupon = await couponService.createForBusiness(owner._id.toString(), business._id.toString(), {
      ...autoBase,
      productIds: [productA._id.toString()],
    });
    await Coupon.updateOne({ _id: coupon._id }, { $set: { usedCount: 1 } });

    await expect(
      couponService.deleteForBusiness(owner._id.toString(), coupon._id.toString())
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('autoPromotionsFor resuelve una promoción activa por producto', async () => {
    const coupon = await couponService.createForBusiness(owner._id.toString(), business._id.toString(), {
      ...autoBase,
      productIds: [productA._id.toString(), productB._id.toString()],
    });

    const map = await couponService.autoPromotionsFor(business._id.toString());
    expect(map.get(productA._id.toString())!._id.toString()).toBe(coupon._id.toString());
    expect(map.get(productB._id.toString())!._id.toString()).toBe(coupon._id.toString());
  });

  it('autoPromotionsFor no devuelve una promoción programada ni una desactivada', async () => {
    const scheduled = await couponService.createForBusiness(owner._id.toString(), business._id.toString(), {
      ...autoBase,
      validFrom: new Date(Date.now() + 24 * 3600_000),
      productIds: [productA._id.toString()],
    });
    const deactivated = await couponService.createForBusiness(owner._id.toString(), business._id.toString(), {
      ...autoBase,
      title: 'Otra',
      productIds: [productB._id.toString()],
    });
    await couponService.deactivateForBusiness(owner._id.toString(), deactivated._id.toString());

    const map = await couponService.autoPromotionsFor(business._id.toString());
    expect(map.has(productA._id.toString())).toBe(false);
    expect(map.has(productB._id.toString())).toBe(false);
    void scheduled;
  });
});
