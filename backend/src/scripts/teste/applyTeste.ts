import { Types } from 'mongoose';
import { cloudinary } from '../../config';
import { User, Business, Category, Product, Address, IBusiness, IProduct } from '../../models';
import { businessService } from '../../services/business.service';
import { productService } from '../../services/product.service';
import { productImageService } from '../../services/productImage.service';
import { REQUIRED_BUSINESS_DOCUMENTS, FOOD_CATEGORIES } from '../../models/BusinessDocument';
import { UserRole, ModifierGroup } from '../../types';
import { TESTE_BUSINESSES, TESTE_CLIENTS, TESTE_PASSWORD, TesteBusiness, TesteProduct } from './data/businesses';
import { TESTE_IMAGE_BY_KEY, testeImageDownloadUrl, TesteImage } from './data/images';
import { offsetPoint, assertNoAccountCollision } from './common';

/**
 * Siembra el TESTE. Idempotente y sin borrar nada.
 *
 * Cada pieza pasa por el mismo camino que usaría un comercio real: el
 * negocio por `businessService.create`, la aprobación por
 * `businessService.approve` (que exige los documentos, así que se
 * siembran aprobados con referencia `TESTE-`), los productos por
 * `productService`, y las fotos por `productImageService.replace`. Así
 * lo sembrado tiene exactamente la forma de lo que crea el panel.
 *
 * Idempotencia: usuarios por teléfono, negocios por dueño+nombre,
 * categorías y productos por negocio+nombre. Un producto que ya existe se
 * actualiza —precio, descripción, inventario, grupos— pero los grupos se
 * fusionan por nombre para **conservar los `_id`** de lo que ya existía:
 * son la identidad que guardan los carritos de los teléfonos.
 */

export interface ImageUploader {
  /** Sube la foto del producto y deja `imageAsset`/`image` guardados. */
  product(product: IProduct, buffer: Buffer, image: TesteImage): Promise<void>;
  /** Sube logo o portada y devuelve la URL que se guarda en el negocio. */
  business(business: IBusiness, buffer: Buffer, kind: 'logo' | 'cover', image: TesteImage): Promise<string>;
}

export interface ApplyOptions {
  /** Quién figura como revisor de documentos y aprobador. */
  adminId: string;
  /** `false` salta las fotos (pruebas, o una corrida rápida sin Cloudinary). */
  images?: boolean;
  fetchImage?: (url: string) => Promise<Buffer>;
  uploader?: ImageUploader;
  log?: (line: string) => void;
}

export interface ApplyReport {
  users: { created: number; existing: number };
  businesses: { created: number; existing: number; ids: Record<string, string> };
  categories: { created: number; existing: number };
  products: { created: number; updated: number; ids: Record<string, string> };
  images: { uploaded: number; skipped: number; failed: string[] };
  addresses: { created: number; existing: number };
}

const defaultFetch = async (url: string): Promise<Buffer> => {
  const res = await fetch(url, { headers: { 'User-Agent': 'curl/8.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${url}`);
  return Buffer.from(await res.arrayBuffer());
};

/** Subida real: fotos de producto por el servicio; logo y portada como en `seedTestBusinessImages`. */
export const cloudinaryUploader: ImageUploader = {
  async product(product, buffer) {
    await productImageService.replace({ product, buffer, mimetype: 'image/jpeg', enhance: true });
  },
  business(business, buffer, kind, image) {
    const businessId = business._id.toString();
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `zipp/teste/businesses/${businessId}`,
          public_id: kind,
          overwrite: true,
          invalidate: true,
          resource_type: 'image',
          transformation: kind === 'logo'
            ? [{ width: 400, height: 400, crop: 'fill', gravity: 'auto' }, { quality: 'auto:good', fetch_format: 'auto' }]
            : [{ width: 1200, height: 480, crop: 'fill', gravity: 'auto' }, { quality: 'auto:good', fetch_format: 'auto' }],
          tags: ['teste', `business-${kind}`, businessId],
          // La procedencia viaja con el archivo, sin inventar campos en la base.
          context: { source: image.source, author: image.author, license: image.license, page: image.pageUrl },
        },
        (error, result) => {
          if (error || !result) return reject(error ?? new Error('Cloudinary no devolvió resultado'));
          resolve(result.secure_url);
        }
      );
      stream.end(buffer);
    });
  },
};

/** Los grupos nuevos, heredando el `_id` de los que ya existían con el mismo nombre. */
function mergeGroups(existing: ModifierGroup[] | undefined, wanted: TesteProduct['groups']): ModifierGroup[] {
  return (wanted ?? []).map((group, index) => {
    const previous = (existing ?? []).find((g) => g.name === group.name);
    return {
      ...(previous?._id ? { _id: previous._id } : {}),
      name: group.name,
      minSelect: group.minSelect,
      maxSelect: group.maxSelect,
      sortOrder: index,
      options: group.options.map((option) => {
        const prevOption = previous?.options.find((o) => o.name === option.name);
        return {
          ...(prevOption?._id ? { _id: prevOption._id } : {}),
          name: option.name,
          price: option.price,
          isAvailable: option.isAvailable !== false,
        };
      }),
    } as ModifierGroup;
  });
}

async function ensureUser(spec: { name: string; phone: string; email: string }, role: UserRole, report: ApplyReport, log: (s: string) => void) {
  let user = await User.findOne({ phone: spec.phone });
  if (user) {
    report.users.existing += 1;
    return user;
  }
  // `User.create` y no un upsert: el hash de la contraseña vive en `pre('save')`.
  user = await User.create({
    name: spec.name,
    phone: spec.phone,
    email: spec.email,
    password: TESTE_PASSWORD,
    role,
    isActive: true,
    isVerified: true,
  });
  report.users.created += 1;
  log(`👤 ${role}: ${spec.name} (${spec.phone})`);
  return user;
}

async function ensureApproved(business: IBusiness, adminId: string, log: (s: string) => void) {
  const required = [...REQUIRED_BUSINESS_DOCUMENTS];
  if (FOOD_CATEGORIES.includes(business.category)) required.push('health_permit');

  for (const type of required) {
    const doc = await businessService.submitDocument(business._id.toString(), {
      type,
      reference: `TESTE-${type.toUpperCase()}-${business.slug}`,
    });
    if (doc && doc.status !== 'approved') {
      await businessService.reviewDocument(doc._id.toString(), adminId, 'approved');
    }
  }

  if (!business.isApproved) {
    await businessService.approve(business._id.toString(), adminId);
    log(`   ✅ aprobado con ${required.length} documentos TESTE`);
  }
}

async function ensureBusiness(spec: TesteBusiness, ownerId: Types.ObjectId, report: ApplyReport, log: (s: string) => void) {
  const found = await Business.findOne({ ownerId, name: spec.name });
  const point = offsetPoint(spec.offsetKm);
  let business: IBusiness;

  if (!found) {
    business = await businessService.create({
      ownerId: ownerId.toString(),
      name: spec.name,
      description: spec.description,
      category: spec.category,
      address: spec.address,
      longitude: point.lng,
      latitude: point.lat,
      phone: spec.phone,
      deliveryTime: spec.deliveryTime,
      minOrder: spec.minOrder,
      freeDeliveryThreshold: spec.freeDeliveryThreshold,
      schedule: spec.schedule as unknown as Record<string, { open?: string; close?: string; isOpen?: boolean }>,
    });
    report.businesses.created += 1;
    log(`🏪 ${spec.name} (${business.slug})`);
  } else {
    business = found;
    // Lo editable se pone al día; los términos comerciales no se tocan.
    business.description = spec.description;
    business.address = spec.address;
    business.phone = spec.phone;
    business.deliveryTime = spec.deliveryTime;
    business.minOrder = spec.minOrder;
    business.freeDeliveryThreshold = spec.freeDeliveryThreshold;
    business.schedule = spec.schedule;
    business.isActive = true;
    await business.save();
    report.businesses.existing += 1;
  }

  report.businesses.ids[spec.key] = business._id.toString();
  return business;
}

async function ensureCatalog(spec: TesteBusiness, business: IBusiness, report: ApplyReport, log: (s: string) => void) {
  const categories = new Map<string, Types.ObjectId>();
  for (const [index, name] of spec.categories.entries()) {
    let category = await Category.findOne({ businessId: business._id, name });
    if (!category) {
      category = await Category.create({ businessId: business._id, name, sortOrder: index, isActive: true });
      report.categories.created += 1;
    } else {
      if (category.sortOrder !== index || !category.isActive) {
        category.sortOrder = index;
        category.isActive = true;
        await category.save();
      }
      report.categories.existing += 1;
    }
    categories.set(name, category._id as Types.ObjectId);
  }

  const products: IProduct[] = [];
  for (const item of spec.products) {
    const categoryId = categories.get(item.category);
    if (!categoryId) throw new Error(`"${item.name}" apunta a una categoría que ${spec.name} no declara: ${item.category}`);

    const fields = {
      categoryId: categoryId.toString(),
      name: item.name,
      description: item.description,
      price: item.price,
      discountPrice: item.discountPrice ?? null,
      extras: item.extras ?? [],
      stock: item.stock ?? null,
      lowStockThreshold: item.lowStockThreshold ?? 0,
      requiresAgeVerification: item.requiresAgeVerification ?? false,
      isFeatured: item.isFeatured ?? false,
      isAvailable: item.isAvailable ?? (item.stock === 0 ? false : true),
    };

    const existing = await Product.findOne({ businessId: business._id, name: item.name });
    let product: IProduct;
    if (!existing) {
      product = await productService.create({
        businessId: business._id.toString(),
        ...fields,
        modifierGroups: mergeGroups(undefined, item.groups),
      });
      report.products.created += 1;
    } else {
      product = await productService.update(existing._id.toString(), business._id.toString(), {
        ...fields,
        modifierGroups: mergeGroups(existing.modifierGroups, item.groups),
      });
      report.products.updated += 1;
    }
    report.products.ids[`${spec.key}.${item.imageKey}`] = product._id.toString();
    products.push(product);
  }
  log(`   📦 ${spec.products.length} productos en ${spec.categories.length} categorías`);
  return products;
}

async function ensureImages(
  spec: TesteBusiness,
  business: IBusiness,
  products: IProduct[],
  options: Required<Pick<ApplyOptions, 'fetchImage' | 'uploader'>>,
  report: ApplyReport,
  log: (s: string) => void
) {
  const pick = (key: string): TesteImage => {
    const image = TESTE_IMAGE_BY_KEY[key];
    if (!image) throw new Error(`No hay imagen registrada para ${key}`);
    return image;
  };

  for (const kind of ['logo', 'cover'] as const) {
    const field = kind === 'logo' ? 'logo' : 'coverImage';
    if (business[field]) { report.images.skipped += 1; continue; }
    const image = pick(`${spec.key}.${kind}`);
    try {
      const buffer = await options.fetchImage(testeImageDownloadUrl(image));
      business[field] = await options.uploader.business(business, buffer, kind, image);
      await business.save();
      report.images.uploaded += 1;
    } catch (error) {
      report.images.failed.push(`${spec.key}.${kind}: ${(error as Error).message}`);
    }
  }

  for (const [index, product] of products.entries()) {
    if (product.imageAsset?.publicId) { report.images.skipped += 1; continue; }
    const key = `${spec.key}.${spec.products[index].imageKey}`;
    const image = pick(key);
    try {
      const buffer = await options.fetchImage(testeImageDownloadUrl(image));
      await options.uploader.product(product, buffer, image);
      report.images.uploaded += 1;
    } catch (error) {
      report.images.failed.push(`${key}: ${(error as Error).message}`);
    }
  }
  log(`   📸 fotos: ${report.images.uploaded} subidas, ${report.images.skipped} ya estaban`);
}

async function ensureClients(report: ApplyReport, log: (s: string) => void) {
  for (const spec of TESTE_CLIENTS) {
    const user = await ensureUser(spec, UserRole.CLIENT, report, log);
    // También a un cliente que ya existía: sin fecha, A-01 (+18) no se puede pedir.
    if (!user.birthDate) {
      await User.updateOne({ _id: user._id }, { $set: { birthDate: new Date(`${spec.birthDate}T00:00:00.000Z`) } });
    }
    const existing = await Address.findOne({ userId: user._id, label: spec.address.label });
    if (existing) { report.addresses.existing += 1; continue; }
    const point = offsetPoint(spec.address.offsetKm);
    await Address.create({
      userId: user._id,
      label: spec.address.label,
      address: spec.address.address,
      details: spec.address.details,
      location: { type: 'Point', coordinates: [point.lng, point.lat] },
      isDefault: true,
    });
    report.addresses.created += 1;
  }
}

export async function applyTeste(options: ApplyOptions): Promise<ApplyReport> {
  const log = options.log ?? (() => {});
  const report: ApplyReport = {
    users: { created: 0, existing: 0 },
    businesses: { created: 0, existing: 0, ids: {} },
    categories: { created: 0, existing: 0 },
    products: { created: 0, updated: 0, ids: {} },
    images: { uploaded: 0, skipped: 0, failed: [] },
    addresses: { created: 0, existing: 0 },
  };

  await assertNoAccountCollision([
    ...TESTE_BUSINESSES.map((b) => b.owner),
    ...TESTE_CLIENTS.map((c) => ({ phone: c.phone, email: c.email })),
  ]);

  for (const spec of TESTE_BUSINESSES) {
    const owner = await ensureUser(spec.owner, UserRole.BUSINESS, report, log);
    const business = await ensureBusiness(spec, owner._id as Types.ObjectId, report, log);
    await ensureApproved(business, options.adminId, log);
    const products = await ensureCatalog(spec, business, report, log);

    if (options.images !== false) {
      await ensureImages(
        spec,
        business,
        products,
        { fetchImage: options.fetchImage ?? defaultFetch, uploader: options.uploader ?? cloudinaryUploader },
        report,
        log
      );
    }
  }

  await ensureClients(report, log);
  return report;
}
