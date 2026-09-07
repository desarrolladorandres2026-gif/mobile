import crypto from 'crypto';
import mongoose from 'mongoose';
import { config, cloudinary } from '../config';
import { Business, Product } from '../models';
import { productImageUrl, PRODUCT_IMAGE_VARIANTS } from '../utils/productImageUrls';

/**
 * Le pone foto real a "Carnes Sofia" y a su catálogo, sembrado por
 * `seedTestBusiness.ts`.
 *
 * No hay banco de fotos propio del comercio, así que las fotos se traen de
 * LoremFlickr (fotos reales de Flickr, servidas por etiqueta, sin API key).
 * Cada producto sube por el mismo camino que usaría el panel al subir una
 * foto de verdad — `cloudinary.uploader.upload_stream` con el mismo
 * `folder`/`transformation` que `productImage.service.ts` — así que las
 * variantes (thumb/catalog/detail/large) salen idénticas a las de una foto
 * subida a mano.
 *
 * Idempotente: un producto o negocio que ya tiene foto se salta.
 */

const FLICKR_TAG: Record<string, string> = {
  'Lomo de Res (libra)': 'beeftenderloin',
  'Carne para Asar (libra)': 'grilledbeef',
  'Carne Molida de Res (libra)': 'groundbeef',
  'Costilla de Res (libra)': 'beefribs',
  'Chuleta de Cerdo (libra)': 'porkchop',
  'Costilla de Cerdo BBQ (libra)': 'porkribs',
  'Lomo de Cerdo (libra)': 'porkloin',
  'Pechuga de Pollo (libra)': 'chickenbreast',
  'Pierna Pernil de Pollo (libra)': 'chickenleg',
  'Alitas de Pollo (libra)': 'chickenwings',
  'Chorizo Santarrosano (paquete x6)': 'chorizo',
  'Salchicha Ranchera (libra)': 'sausages',
  'Morcilla (unidad)': 'bloodsausage',
};

async function fetchPhoto(tag: string, size: number): Promise<Buffer> {
  const res = await fetch(`https://loremflickr.com/${size}/${size}/${tag}`);
  if (!res.ok) throw new Error(`LoremFlickr respondió ${res.status} para la etiqueta "${tag}"`);
  return Buffer.from(await res.arrayBuffer());
}

function uploadToCloudinary(params: {
  buffer: Buffer;
  folder: string;
  publicId: string;
  transformation: Record<string, unknown>[];
  tags: string[];
}): Promise<{ publicId: string; width: number; height: number; bytes: number; format: string; secureUrl: string }> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: params.folder,
        public_id: params.publicId,
        overwrite: true,
        invalidate: true,
        resource_type: 'image',
        transformation: params.transformation,
        tags: params.tags,
      },
      (error, result) => {
        if (error || !result) return reject(error ?? new Error('Cloudinary no devolvió resultado'));
        resolve({
          publicId: result.public_id,
          width: result.width,
          height: result.height,
          bytes: result.bytes,
          format: result.format,
          secureUrl: result.secure_url,
        });
      }
    );
    stream.end(params.buffer);
  });
}

async function main(): Promise<void> {
  if (config.nodeEnv === 'production') {
    console.error('\n❌ Este script no corre en producción — descarga fotos de un banco externo.\n');
    process.exit(1);
  }
  if (!config.cloudinary.cloudName || !config.cloudinary.apiKey) {
    console.error('\n❌ Cloudinary no está configurado (revisa CLOUDINARY_* en .env).\n');
    process.exit(1);
  }

  await mongoose.connect(config.mongodb.uri);
  console.log(`🗄️  Conectado a MongoDB (${mongoose.connection.name})`);

  const business = await Business.findOne({ name: 'Carnes Sofia' });
  if (!business) {
    console.error('\n❌ No existe "Carnes Sofia". Corre primero "npm run seed:test-business".\n');
    process.exit(1);
  }
  const businessId = business._id.toString();

  // ── Foto del negocio (logo cuadrado + portada panorámica) ──
  if (!business.logo || !business.coverImage) {
    console.log('🏪 Subiendo foto del negocio...');
    const raw = await fetchPhoto('butchershop,meat', 1200);

    if (!business.logo) {
      const logo = await uploadToCloudinary({
        buffer: raw,
        folder: `zipp/businesses/${businessId}`,
        publicId: 'logo',
        transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'auto' }, { quality: 'auto:good', fetch_format: 'auto' }],
        tags: ['business-logo', businessId],
      });
      business.logo = logo.secureUrl;
    }

    if (!business.coverImage) {
      const cover = await uploadToCloudinary({
        buffer: raw,
        folder: `zipp/businesses/${businessId}`,
        publicId: 'cover',
        transformation: [{ width: 1200, height: 480, crop: 'fill', gravity: 'auto' }, { quality: 'auto:good', fetch_format: 'auto' }],
        tags: ['business-cover', businessId],
      });
      business.coverImage = cover.secureUrl;
    }

    await business.save();
    console.log('🏪 Foto del negocio lista (logo + portada)');
  } else {
    console.log('🏪 El negocio ya tenía logo y portada — no se toca');
  }

  // ── Fotos de producto ──
  const products = await Product.find({ businessId: business._id });
  let uploaded = 0;
  let skipped = 0;

  for (const product of products) {
    if (product.imageAsset?.publicId) {
      skipped += 1;
      continue;
    }

    const tag = FLICKR_TAG[product.name] ?? 'meat';
    const buffer = await fetchPhoto(tag, 1200);
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

    const result = await uploadToCloudinary({
      buffer,
      folder: `${config.productImages.folder}/${businessId}`,
      publicId: product._id.toString(),
      transformation: [{ width: 1200, height: 1200, crop: 'limit' }],
      tags: ['product-image', businessId],
    });

    product.imageAsset = {
      publicId: result.publicId,
      width: result.width,
      height: result.height,
      bytes: result.bytes,
      format: result.format,
      checksum,
      enhanced: true,
      backgroundRemoved: false,
      uploadedAt: new Date(),
    } as any;
    product.image = productImageUrl(product.imageAsset as any, PRODUCT_IMAGE_VARIANTS.catalog);
    await product.save();

    uploaded += 1;
    console.log(`   📸 ${product.name} (${tag})`);
  }

  console.log(`\n📦 Fotos subidas: ${uploaded} — ya tenían: ${skipped}`);
  console.log('✅ Listo.');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Error subiendo fotos:', err);
  process.exit(1);
});
