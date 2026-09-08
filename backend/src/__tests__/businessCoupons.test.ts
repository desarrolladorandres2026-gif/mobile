import { describe, it, expect, beforeEach } from 'vitest';
import { Coupon } from '../models';
import { UserRole, CouponFundedBy } from '../types';
import { couponService } from '../services/coupon.service';
import { makeUser, makeBusiness, GARZON } from './factories';

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
