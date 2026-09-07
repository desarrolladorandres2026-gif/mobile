import mongoose, { Schema, Document, Types } from 'mongoose';
import { ProductExtra } from '../types';
import { productImageUrls } from '../utils/productImageUrls';

/**
 * Lo que hace falta para volver a generar la imagen de un producto.
 *
 * `publicId` es el dato autoritativo: con él se construye cualquier
 * variante y, sobre todo, se puede **borrar** el archivo cuando la foto se
 * reemplaza. Guardar solo la URL —como se hacía— significa que cada
 * cambio de foto deja la anterior viviendo en Cloudinary para siempre.
 */
export interface IProductImage {
  publicId: string;
  /** Ancho y alto del master ya recortado, para reservar el hueco en la UI. */
  width: number;
  height: number;
  bytes: number;
  format: string;
  /** SHA-256 del binario recibido: evita volver a subir la misma foto. */
  checksum: string;
  /**
   * Si las variantes se sirven con la cadena de mejora automática.
   *
   * La mejora vive en la URL de entrega, no en el archivo guardado: el
   * master queda intacto y el comercio puede desactivarla luego sin
   * volver a subir nada. Un retoque irreversible sobre el original es
   * justo lo que impide comparar con el producto real.
   */
  enhanced: boolean;
  /** Fondo retirado con el complemento de Cloudinary, si estaba disponible. */
  backgroundRemoved: boolean;
  uploadedAt: Date;
}

export interface IProduct extends Document {
  businessId: Types.ObjectId;
  categoryId: Types.ObjectId;
  name: string;
  description: string;
  /**
   * URL de la variante de catálogo.
   *
   * Se mantiene como cadena porque la app móvil la lee así
   * (`product.image`). Ahora es una URL derivada de `imageAsset`, no la
   * original de varios megas que se subía antes.
   */
  image?: string | null;
  imageAsset?: IProductImage | null;
  price: number;
  discountPrice?: number | null;
  extras: ProductExtra[];
  isAvailable: boolean;
  isFeatured: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const productImageSchema = new Schema<IProductImage>(
  {
    publicId: { type: String, required: true },
    width: { type: Number, required: true, min: 1 },
    height: { type: Number, required: true, min: 1 },
    bytes: { type: Number, required: true, min: 0 },
    format: { type: String, required: true },
    checksum: { type: String, required: true },
    enhanced: { type: Boolean, default: true },
    backgroundRemoved: { type: Boolean, default: false },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const productExtraSchema = new Schema(
  {
    name: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const productSchema = new Schema<IProduct>(
  {
    businessId: {
      type: Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
    },
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
    },
    name: {
      type: String,
      required: [true, 'El nombre del producto es requerido'],
      trim: true,
      maxlength: [100, 'El nombre no puede exceder 100 caracteres'],
    },
    description: {
      type: String,
      default: '',
      maxlength: [300, 'La descripción no puede exceder 300 caracteres'],
    },
    image: {
      type: String,
      default: null,
    },
    imageAsset: {
      type: productImageSchema,
      default: null,
    },
    price: {
      type: Number,
      required: [true, 'El precio es requerido'],
      min: [0, 'El precio no puede ser negativo'],
    },
    discountPrice: {
      type: Number,
      default: null,
      min: [0, 'El precio con descuento no puede ser negativo'],
    },
    extras: {
      type: [productExtraSchema],
      default: [],
    },
    isAvailable: {
      type: Boolean,
      default: true,
    },
    isFeatured: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

/**
 * Las variantes listas para usar, en cada consulta.
 *
 * Es un virtual y no un campo guardado porque son URLs derivadas: si se
 * persistieran, cambiar la cadena de mejora obligaría a reescribir todos
 * los productos de la base, y los que no se reescribieran seguirían
 * sirviendo la versión antigua para siempre.
 *
 * `toJSON` con virtuales activados hace que aparezcan en cada respuesta
 * de la API sin tocar un solo controlador.
 */
productSchema.virtual('images').get(function (this: IProduct) {
  return productImageUrls(this.imageAsset);
});

productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

productSchema.index({ businessId: 1, categoryId: 1 });
productSchema.index({ businessId: 1, isAvailable: 1 });
productSchema.index({ isFeatured: 1 });

export const Product = mongoose.model<IProduct>('Product', productSchema);
