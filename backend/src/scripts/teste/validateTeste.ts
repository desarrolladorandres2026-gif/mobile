import type mongoose from 'mongoose';
import { User, Business, Category, Product, Order, IProduct } from '../../models';
import { pricingService } from '../../services/pricing.service';
import { productImageUrls } from '../../utils/productImageUrls';
import { UserRole } from '../../types';
import { TESTE_BUSINESSES } from './data/businesses';
import { TESTE_IMAGE_BY_KEY } from './data/images';
import { testeUserFilter } from './common';

/**
 * Revisión de solo lectura del TESTE sembrado.
 *
 * No escribe nada en la base: lee, calcula y compara. Cada comprobación
 * deja un hallazgo con severidad, y el veredicto es PASS solo si no hay
 * ninguno de severidad alta. Se ejecuta también desde la prueba
 * automática contra la Mongo en memoria, así que lo que valida aquí es lo
 * mismo que se valida en CI.
 *
 * Las comprobaciones de precio "reales" cotizan de verdad con
 * `pricingService.priceItems` —el mismo código del checkout— con la
 * selección mínima válida y la máxima de cada producto, y comparan contra
 * una suma hecha aparte. Si difieren, el cliente pagaría otra cosa.
 */

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  severity: Severity;
  check: string;
  detail: string;
}

export interface ValidationReport {
  findings: Finding[];
  counts: {
    businesses: number;
    products: number;
    categories: number;
    groups: number;
    options: number;
    orders: number;
  };
  verdict: 'PASS' | 'FAIL';
}

const ok = (n: number) => Number.isInteger(n) && n >= 0;

/** Selección mínima válida (los obligatorios, opciones disponibles y sin precio si se puede) y máxima (todo lo que quepa, lo más caro). */
function selections(product: IProduct) {
  const minimal: Array<{ groupId: string; optionId: string }> = [];
  const maximal: Array<{ groupId: string; optionId: string }> = [];
  let minTotal = 0;
  let maxTotal = 0;

  for (const group of product.modifierGroups ?? []) {
    const available = group.options.filter((o) => o.isAvailable !== false);
    const cheapest = [...available].sort((a, b) => a.price - b.price).slice(0, group.minSelect);
    for (const option of cheapest) {
      minimal.push({ groupId: String(group._id), optionId: String(option._id) });
      minTotal += option.price;
    }
    const dearest = [...available].sort((a, b) => b.price - a.price).slice(0, group.maxSelect);
    for (const option of dearest) {
      maximal.push({ groupId: String(group._id), optionId: String(option._id) });
      maxTotal += option.price;
    }
  }
  return { minimal, maximal, minTotal, maxTotal };
}

/** HEAD a una URL; `null` si respondió 200 con una imagen, o el motivo. */
async function probeImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) return `HTTP ${res.status}`;
    const type = res.headers.get('content-type') ?? '';
    return type.startsWith('image/') ? null : `content-type ${type}`;
  } catch (error) {
    return (error as Error).message;
  }
}

export async function validateTeste(options: { checkImages?: boolean; probeUrls?: boolean } = {}): Promise<ValidationReport> {
  const findings: Finding[] = [];
  const add = (severity: Severity, check: string, detail: string) => findings.push({ severity, check, detail });

  const owners = await User.find({ ...testeUserFilter(), role: UserRole.BUSINESS });
  const ownerIds = owners.map((u) => u._id);
  const businesses = await Business.find({ ownerId: { $in: ownerIds } }).select('+searchName');
  const businessIds = businesses.map((b) => b._id);
  // `searchName` es `select: false` en el modelo: sin pedirlo explícito,
  // cada producto llegaría sin él y el hallazgo de abajo sería un falso
  // positivo del validador, no un dato real que falte.
  const products = await Product.find({ businessId: { $in: businessIds } }).select('+searchName');
  const categories = await Category.find({ businessId: { $in: businessIds } });
  const clients = await User.find({ ...testeUserFilter(), role: UserRole.CLIENT });
  const orders = await Order.find({ clientId: { $in: clients.map((c) => c._id) } });

  // ── Conteos ──
  if (businesses.length !== TESTE_BUSINESSES.length) add('high', 'conteo.negocios', `Hay ${businesses.length}, se esperaban ${TESTE_BUSINESSES.length}`);
  const expectedProducts = TESTE_BUSINESSES.reduce((n, b) => n + b.products.length, 0);
  if (products.length !== expectedProducts) add('high', 'conteo.productos', `Hay ${products.length}, se esperaban ${expectedProducts}`);
  for (const business of businesses) {
    const n = products.filter((p) => p.businessId.equals(business._id)).length;
    const spec = TESTE_BUSINESSES.find((b) => b.name === business.name);
    if (!spec) add('high', 'negocio.desconocido', `"${business.name}" es de un dueño TESTE pero no está en los datos`);
    else if (n !== spec.products.length) add('high', 'conteo.porNegocio', `${business.name}: ${n} productos, se esperaban ${spec.products.length}`);
  }

  // ── Negocios ──
  const slugs = new Set<string>();
  for (const business of businesses) {
    if (!business.isApproved) add('high', 'negocio.aprobado', `${business.name} no está aprobado`);
    if (!business.isActive) add('high', 'negocio.activo', `${business.name} no está activo`);
    if (slugs.has(business.slug)) add('high', 'negocio.slug', `slug repetido: ${business.slug}`);
    slugs.add(business.slug);
    if (!business.searchName) add('medium', 'negocio.searchName', `${business.name} sin searchName`);
    for (const [dayName, day] of Object.entries(business.schedule ?? {})) {
      const d = day as { open?: string; close?: string; isOpen?: boolean };
      if (!/^\d{2}:\d{2}$/.test(d.open ?? '') || !/^\d{2}:\d{2}$/.test(d.close ?? '')) {
        add('medium', 'negocio.horario', `${business.name} ${dayName}: formato inválido (${d.open}–${d.close})`);
      }
    }
    const owner = owners.find((o) => o._id.equals(business.ownerId));
    if (!owner) add('high', 'negocio.dueno', `${business.name} sin dueño TESTE`);
    if (options.checkImages !== false) {
      if (!business.logo) add('medium', 'negocio.logo', `${business.name} sin logo`);
      if (!business.coverImage) add('medium', 'negocio.portada', `${business.name} sin portada`);
      if (options.probeUrls) {
        for (const [kind, url] of [['logo', business.logo], ['portada', business.coverImage]] as const) {
          if (!url) continue;
          const problem = await probeImage(url);
          if (problem) add('high', `negocio.${kind}Rota`, `${business.name}: ${problem}`);
        }
      }
    }
  }

  // ── Categorías y relaciones ──
  const categoryById = new Map(categories.map((c) => [c._id.toString(), c]));
  for (const category of categories) {
    if (!products.some((p) => p.categoryId.equals(category._id))) add('low', 'categoria.vacia', `${category.name} (${category._id}) sin productos`);
  }

  // ── Productos ──
  const groupIds = new Set<string>();
  const optionIds = new Set<string>();
  const checksums = new Map<string, string>();
  let groupCount = 0;
  let optionCount = 0;

  for (const product of products) {
    const label = product.name;
    const category = categoryById.get(product.categoryId.toString());
    if (!category) add('high', 'producto.categoria', `${label}: categoría ${product.categoryId} no existe`);
    else if (!category.businessId.equals(product.businessId)) add('high', 'producto.categoriaAjena', `${label}: su categoría es de otro negocio`);

    if (!ok(product.price) || product.price <= 0) add('high', 'producto.precio', `${label}: precio ${product.price}`);
    if (product.price % 100 !== 0) add('low', 'producto.precioRedondo', `${label}: ${product.price} no es múltiplo de 100`);
    if (product.discountPrice != null) {
      if (!ok(product.discountPrice) || product.discountPrice >= product.price) add('high', 'producto.descuento', `${label}: descuento ${product.discountPrice} ≥ precio ${product.price}`);
    }
    if (!product.description) add('medium', 'producto.descripcion', `${label} sin descripción`);
    if (!product.searchName) add('medium', 'producto.searchName', `${label} sin searchName`);
    if (product.stock === 0 && product.isAvailable) add('high', 'producto.stockCero', `${label}: stock 0 pero disponible`);
    if (product.stock != null && product.stock < 0) add('high', 'producto.stockNegativo', `${label}: stock ${product.stock}`);

    for (const extra of product.extras ?? []) {
      if (!ok(extra.price)) add('high', 'producto.extra', `${label}: extra "${extra.name}" precio ${extra.price}`);
    }

    const groupNames = new Set<string>();
    for (const group of product.modifierGroups ?? []) {
      groupCount += 1;
      const gid = String(group._id);
      if (groupIds.has(gid)) add('high', 'grupo.idRepetido', `${label}: grupo ${gid} ya existe en otro producto`);
      groupIds.add(gid);
      if (groupNames.has(group.name)) add('medium', 'grupo.nombreRepetido', `${label}: dos grupos "${group.name}"`);
      groupNames.add(group.name);
      if (!(0 <= group.minSelect && group.minSelect <= group.maxSelect && group.maxSelect <= group.options.length)) {
        add('high', 'grupo.limites', `${label} / ${group.name}: min ${group.minSelect}, max ${group.maxSelect}, opciones ${group.options.length}`);
      }
      if (!group.options.length) add('high', 'grupo.vacio', `${label} / ${group.name} sin opciones`);
      const available = group.options.filter((o) => o.isAvailable !== false).length;
      if (group.minSelect > 0 && available < group.minSelect) add('high', 'grupo.obligatorioSinOpciones', `${label} / ${group.name}: obligatorio con ${available} disponibles`);
      const optionNames = new Set<string>();
      for (const option of group.options) {
        optionCount += 1;
        const oid = String(option._id);
        if (optionIds.has(oid)) add('high', 'opcion.idRepetida', `${label} / ${group.name} / ${option.name}: id repetido`);
        optionIds.add(oid);
        if (optionNames.has(option.name)) add('medium', 'opcion.nombreRepetido', `${label} / ${group.name}: dos "${option.name}"`);
        optionNames.add(option.name);
        if (!ok(option.price)) add('high', 'opcion.precio', `${label} / ${group.name} / ${option.name}: ${option.price}`);
      }
    }

    if (options.checkImages !== false) {
      if (!product.imageAsset?.publicId) add('medium', 'producto.imagen', `${label} sin foto`);
      else {
        const seen = checksums.get(product.imageAsset.checksum);
        if (seen) add('medium', 'producto.imagenRepetida', `${label} usa la misma foto que ${seen}`);
        checksums.set(product.imageAsset.checksum, label);
        if (Math.min(product.imageAsset.width, product.imageAsset.height) < 1200 && Math.max(product.imageAsset.width, product.imageAsset.height) < 1200) {
          add('low', 'producto.imagenPequena', `${label}: master ${product.imageAsset.width}×${product.imageAsset.height}`);
        }
        if (options.probeUrls) {
          const urls = productImageUrls(product.imageAsset);
          for (const variant of ['thumb', 'catalog', 'detail', 'large'] as const) {
            const problem = urls ? await probeImage(urls[variant]) : 'sin URL';
            if (problem) add('high', 'producto.imagenRota', `${label} (${variant}): ${problem}`);
          }
        }
        const spec = TESTE_BUSINESSES.find((b) => b.name === businesses.find((x) => x._id.equals(product.businessId))?.name);
        const item = spec?.products.find((p) => p.name === product.name);
        if (spec && item && !TESTE_IMAGE_BY_KEY[`${spec.key}.${item.imageKey}`]) add('high', 'producto.imagenSinRegistro', `${label} no tiene entrada en images.ts`);
      }
    }

    // ── Uso real en una cotización ──
    try {
      const { minimal, maximal, minTotal, maxTotal } = selections(product);
      const unit = Math.round(product.discountPrice ?? product.price);
      if (product.isAvailable) {
        const priced = await pricingService.priceItems(product.businessId.toString(), [
          { productId: product._id.toString(), quantity: 1, selectedExtras: minimal },
        ]);
        if (priced.subtotal !== unit + minTotal) add('high', 'cotizacion.minima', `${label}: cotizó ${priced.subtotal}, esperado ${unit + minTotal}`);
        const pricedMax = await pricingService.priceItems(product.businessId.toString(), [
          { productId: product._id.toString(), quantity: 2, selectedExtras: maximal },
        ]);
        if (pricedMax.subtotal !== (unit + maxTotal) * 2) add('high', 'cotizacion.maxima', `${label}: cotizó ${pricedMax.subtotal}, esperado ${(unit + maxTotal) * 2}`);

        // Un obligatorio omitido tiene que fallar.
        const required = (product.modifierGroups ?? []).find((g) => g.minSelect > 0);
        if (required) {
          const without = minimal.filter((m) => m.groupId !== String(required._id));
          let rejected = false;
          try {
            await pricingService.priceItems(product.businessId.toString(), [{ productId: product._id.toString(), quantity: 1, selectedExtras: without }]);
          } catch (error) {
            rejected = (error as { code?: string }).code === 'MODIFIER_REQUIRED';
          }
          if (!rejected) add('high', 'cotizacion.obligatorio', `${label}: se cotizó sin "${required.name}"`);
        }
      }
    } catch (error) {
      add('high', 'cotizacion.error', `${label}: ${(error as Error).message}`);
    }
  }

  // ── Pedidos de clientes TESTE ──
  const idempotency = new Map<string, number>();
  for (const order of orders) {
    const label = `pedido ${order.orderNumber ?? order._id}`;
    if (order.idempotencyKey) idempotency.set(order.idempotencyKey, (idempotency.get(order.idempotencyKey) ?? 0) + 1);
    let subtotal = 0;
    for (const item of order.items) {
      const product = products.find((p) => p._id.equals(item.productId));
      if (product && !product.businessId.equals(order.businessId as mongoose.Types.ObjectId)) {
        add('high', 'pedido.productoAjeno', `${label}: "${item.productName}" no es del negocio del pedido`);
      }
      let extrasTotal = 0;
      for (const extra of item.selectedExtras ?? []) {
        if (!ok(extra.price)) add('high', 'pedido.extraPrecio', `${label}: "${extra.name}" precio ${extra.price}`);
        if (extra.optionId && (!extra.groupId || !extra.groupName)) add('high', 'pedido.opcionSinGrupo', `${label}: "${extra.name}" con optionId sin grupo`);
        if (extra.optionId && product) {
          const group = product.modifierGroups.find((g) => String(g._id) === extra.groupId);
          const option = group?.options.find((o) => String(o._id) === extra.optionId);
          // Que ya no exista es legítimo (el comercio pudo borrarla); que
          // exista en otro producto no.
          if (!option) {
            const elsewhere = products.some((p) => !p._id.equals(product._id) && p.modifierGroups.some((g) => g.options.some((o) => String(o._id) === extra.optionId)));
            if (elsewhere) add('high', 'pedido.opcionAjena', `${label}: "${extra.name}" pertenece a otro producto`);
          }
        }
        extrasTotal += extra.price * (extra.quantity ?? 1);
      }
      const expected = (item.unitPrice + extrasTotal) * item.quantity;
      if (item.totalPrice !== expected) add('high', 'pedido.totalLinea', `${label}: "${item.productName}" total ${item.totalPrice}, esperado ${expected}`);
      subtotal += item.totalPrice;
    }
    if (order.subtotal !== subtotal) add('high', 'pedido.subtotal', `${label}: subtotal ${order.subtotal}, líneas suman ${subtotal}`);
    if (order.finance?.productSubtotal != null && order.finance.productSubtotal !== subtotal) add('high', 'pedido.finance', `${label}: finance.productSubtotal ${order.finance.productSubtotal} ≠ ${subtotal}`);
  }
  for (const [key, n] of idempotency) if (n > 1) add('high', 'pedido.duplicado', `idempotencyKey ${key} en ${n} pedidos`);

  const negative = await Product.countDocuments({ businessId: { $in: businessIds }, stock: { $lt: 0 } });
  if (negative) add('high', 'stock.negativo', `${negative} productos con stock negativo`);

  const verdict = findings.some((f) => f.severity === 'high') ? 'FAIL' : 'PASS';
  return {
    findings,
    counts: { businesses: businesses.length, products: products.length, categories: categories.length, groups: groupCount, options: optionCount, orders: orders.length },
    verdict,
  };
}
