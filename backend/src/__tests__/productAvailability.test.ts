import { describe, it, expect } from 'vitest';
import request from 'supertest';

import app from '../app';
import { Category, Product } from '../models';
import { productService } from '../services/product.service';
import { UserRole } from '../types';
import { makeUser, makeBusiness, makeProduct, authHeader } from './factories';

/**
 * Agotar un producto por un tiempo («por 2 h», «hoy»): se apaga ahora y un
 * barrido lo devuelve a la carta. El inventario manda sobre el reloj.
 */
async function scenario() {
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id);
  await Category.create({ businessId: business._id, name: 'Platos', sortOrder: 1 });
  const product = await makeProduct(business._id, { price: 20000 });
  return { owner, business, product };
}

const put = async (owner: any, productId: string, body: Record<string, unknown>) =>
  request(app).put(`/api/v1/products/${productId}`).set(await authHeader(owner)).send(body);

describe('Agotado por un tiempo', () => {
  it('apaga el producto y guarda hasta cuándo, contado en el servidor', async () => {
    const { owner, business, product } = await scenario();
    const before = Date.now();

    const res = await put(owner, product._id.toString(), {
      businessId: business._id.toString(),
      unavailableForMinutes: 120,
    });

    expect(res.status).toBe(200);
    const saved = await Product.findById(product._id);
    expect(saved!.isAvailable).toBe(false);
    const until = saved!.unavailableUntil!.getTime();
    expect(until).toBeGreaterThanOrEqual(before + 120 * 60_000 - 1000);
    expect(until).toBeLessThanOrEqual(Date.now() + 120 * 60_000 + 1000);
  });

  it('rechaza plazos fuera de rango', async () => {
    const { owner, business, product } = await scenario();
    for (const minutes of [0, 4, 1441, -5]) {
      const res = await put(owner, product._id.toString(), {
        businessId: business._id.toString(),
        unavailableForMinutes: minutes,
      });
      expect(res.status).toBe(400);
    }
  });

  it('el barrido lo devuelve a la carta al vencer, y no antes', async () => {
    const { owner, business, product } = await scenario();
    await put(owner, product._id.toString(), { businessId: business._id.toString(), unavailableForMinutes: 60 });

    expect(await productService.reopenDue(new Date(Date.now() + 30 * 60_000))).toBe(0);
    expect((await Product.findById(product._id))!.isAvailable).toBe(false);

    expect(await productService.reopenDue(new Date(Date.now() + 61 * 60_000))).toBe(1);
    const back = await Product.findById(product._id);
    expect(back!.isAvailable).toBe(true);
    expect(back!.unavailableUntil).toBeNull();
  });

  it('un producto sin unidades no vuelve a la carta: solo se limpia el plazo', async () => {
    const { owner, business, product } = await scenario();
    await put(owner, product._id.toString(), { businessId: business._id.toString(), unavailableForMinutes: 60 });
    await Product.updateOne({ _id: product._id }, { stock: 0 });

    await productService.reopenDue(new Date(Date.now() + 61 * 60_000));

    const saved = await Product.findById(product._id);
    expect(saved!.isAvailable).toBe(false);
    expect(saved!.unavailableUntil).toBeNull();
  });

  it('activarlo a mano cancela el plazo', async () => {
    const { owner, business, product } = await scenario();
    await put(owner, product._id.toString(), { businessId: business._id.toString(), unavailableForMinutes: 60 });

    await put(owner, product._id.toString(), { businessId: business._id.toString(), isAvailable: true });

    const saved = await Product.findById(product._id);
    expect(saved!.isAvailable).toBe(true);
    expect(saved!.unavailableUntil).toBeNull();
  });

  it('agotarlo sin plazo («hasta que yo lo active») no deja fecha', async () => {
    const { owner, business, product } = await scenario();
    await put(owner, product._id.toString(), { businessId: business._id.toString(), unavailableForMinutes: 60 });

    await put(owner, product._id.toString(), { businessId: business._id.toString(), isAvailable: false });

    const saved = await Product.findById(product._id);
    expect(saved!.isAvailable).toBe(false);
    expect(saved!.unavailableUntil).toBeNull();
    expect(await productService.reopenDue(new Date(Date.now() + 24 * 60 * 60_000))).toBe(0);
  });

  it('reponer unidades lo devuelve a la carta y cancela el plazo', async () => {
    const { owner, business, product } = await scenario();
    await put(owner, product._id.toString(), { businessId: business._id.toString(), unavailableForMinutes: 60 });

    await put(owner, product._id.toString(), { businessId: business._id.toString(), stock: 8 });

    const saved = await Product.findById(product._id);
    expect(saved!.isAvailable).toBe(true);
    expect(saved!.stock).toBe(8);
    expect(saved!.unavailableUntil).toBeNull();
  });
});
