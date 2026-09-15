import mongoose, { Schema, Document, Types } from 'mongoose';
import { ProductExtra, ModifierGroup } from '../types';
import { productImageUrls } from '../utils/productImageUrls';
import { normalize } from '../utils/text';

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
   * `name` sin tildes ni mayúsculas, para buscar por prefijo.
   *
   * Derivado, nunca escrito a mano: lo mantienen los hooks del esquema.
   */
  searchName: string;
  /**
   * URL de la variante de catálogo.
   *
   * Se mantiene como cadena porque la app móvil la lee así
   * (`product.image`). Ahora es una URL derivada de `imageAsset`, no la
   * original de varios megas que se subía antes.
   */
  image?: string | null;
  imageAsset?: IProductImage | null;
  /**
   * Fotos adicionales, para la ficha del producto.
   *
   * Aparte de `imageAsset` y no como `images[0]` a propósito: la imagen
   * principal la leen las listas, las tarjetas, el carrito y el histórico
   * de pedidos. Convertirla en el primer elemento de un array obligaría a
   * tocar todos esos sitios, y bastaría con olvidar uno para que un
   * producto se quedara sin miniatura sin que nadie lo notara.
   *
   * Aquí van las que enseñan lo que la principal no puede: el plato por
   * dentro, el tamaño real al lado de una mano, la etiqueta de una
   * botella.
   */
  gallery: IProductImage[];
  price: number;
  discountPrice?: number | null;
  extras: ProductExtra[];
  /**
   * Grupos de modificadores: "Tipo de carne", "Salsas", "Tamaño".
   *
   * Conviven con `extras` y no lo sustituyen: la carta que ya existe usa
   * la lista plana y sigue funcionando sin tocarla. Un producto nuevo
   * puede usar los dos —adiciones sueltas abajo y grupos con reglas
   * arriba— y el precio del pedido suma ambos.
   */
  modifierGroups: ModifierGroup[];
  /**
   * El producto solo se vende a mayores de edad.
   *
   * En Colombia aplica a licor y cigarrillos, y la responsabilidad de no
   * vendérselo a un menor es del comercio y de quien entrega, no de la
   * plataforma que los conecta. Marcarlo aquí es lo que permite que ambos
   * sepan que tienen que pedir la cédula.
   */
  requiresAgeVerification: boolean;

  isAvailable: boolean;

  /**
   * Unidades que quedan, o null si el negocio no lleva cuenta.
   *
   * Null y cero significan cosas opuestas y por eso no se puede usar cero
   * como "sin control": null es "hay de sobra, no lo cuento" —el caso de
   * una cocina— y cero es "se acabó" —el caso de una panadería a las ocho
   * de la noche—. Confundirlos apagaría media carta del pueblo.
   */
  stock?: number | null;

  /** Aviso al negocio cuando queda poco. Cero lo desactiva. */
  lowStockThreshold: number;
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

const modifierOptionSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    price: { type: Number, required: true, min: 0 },
    isAvailable: { type: Boolean, default: true },
  },
  // Con `_id`: es la identidad estable que guarda el carrito del teléfono
  // y "Lo de siempre". Renombrar "Angus" a "Angus 150 g" no puede romper
  // una bolsa a medio armar.
  { _id: true }
);

const modifierGroupSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    minSelect: { type: Number, required: true, min: 0 },
    maxSelect: { type: Number, required: true, min: 1 },
    sortOrder: { type: Number, default: 0 },
    options: {
      type: [modifierOptionSchema],
      validate: {
        validator: (value: unknown[]) => value.length >= 1 && value.length <= 30,
        message: 'Cada grupo necesita entre 1 y 30 opciones',
      },
    },
  },
  { _id: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/** `min > 0`: el cliente tiene que elegir algo antes de agregar. */
modifierGroupSchema.virtual('isRequired').get(function (this: { minSelect: number }) {
  return this.minSelect > 0;
});

/** `max === 1` se pinta como radio; lo demás, como casillas. */
modifierGroupSchema.virtual('selectionType').get(function (this: { maxSelect: number }) {
  return this.maxSelect === 1 ? 'single' : 'multiple';
});

modifierGroupSchema.path('maxSelect').validate(function (this: { minSelect: number; maxSelect: number; options: unknown[] }) {
  return this.maxSelect >= this.minSelect && this.maxSelect <= (this.options?.length ?? 0);
}, 'El máximo debe estar entre el mínimo y el número de opciones');

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
    // `select: false` porque es maquinaria de búsqueda: la app no lo pinta
    // en ningún sitio y mandarlo en cada carta sería peso por nada.
    searchName: {
      type: String,
      default: '',
      select: false,
    },
    image: {
      type: String,
      default: null,
    },
    imageAsset: {
      type: productImageSchema,
      default: null,
    },
    gallery: {
      type: [productImageSchema],
      default: [],
      // Un tope bajo a propósito: cada foto es una descarga en un móvil
      // con datos contados, y a partir de la cuarta o quinta nadie sigue
      // deslizando. Es un límite de producto, no de almacenamiento.
      validate: {
        validator: (value: unknown[]) => value.length <= 5,
        message: 'Máximo 5 fotos adicionales por producto',
      },
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
    modifierGroups: {
      type: [modifierGroupSchema],
      default: [],
      validate: {
        validator: (value: unknown[]) => value.length <= 15,
        message: 'Máximo 15 grupos de modificadores por producto',
      },
    },
    requiresAgeVerification: { type: Boolean, default: false },
    stock: { type: Number, default: null, min: 0 },
    lowStockThreshold: { type: Number, default: 0, min: 0 },
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

/**
 * Las fotos adicionales, con sus variantes, por el mismo camino.
 *
 * Devuelve solo lo derivable: la app no necesita `publicId` ni `checksum`
 * para pintar un carrusel, y no mandarlos evita filtrar la estructura del
 * almacenamiento a cualquiera que abra la carta.
 */
productSchema.virtual('galleryImages').get(function (this: IProduct) {
  return (this.gallery ?? [])
    .map((image) => productImageUrls(image))
    .filter(Boolean);
});

productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

/**
 * `searchName` se deriva de `name` por los dos caminos que lo cambian.
 *
 * El hook de `save` cubre el alta y cualquier edición que cargue el
 * documento; el de `findOneAndUpdate` cubre al panel del comercio, que
 * actualiza en una sola operación y nunca llega a instanciarlo. Hace falta
 * escribir los dos: sin el segundo, un producto renombrado conserva el
 * `searchName` viejo y deja de encontrarse por su nombre nuevo. Y es un
 * fallo mudo —el producto sigue en la carta y todo se ve bien— así que
 * nadie lo reporta, simplemente deja de venderse.
 */
productSchema.pre('save', function (next) {
  if (this.isModified('name')) this.searchName = normalize(this.name);
  next();
});

productSchema.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate() as Record<string, any> | null;
  if (!update) return next();

  const name = update.name ?? update.$set?.name;
  if (typeof name === 'string') this.set('searchName', normalize(name));
  next();
});

productSchema.index({ businessId: 1, categoryId: 1 });
productSchema.index({ businessId: 1, isAvailable: 1 });
productSchema.index({ isFeatured: 1 });
// La búsqueda por prefijo ancla el patrón (`^termino`), que es la única
// forma de `$regex` que sabe apoyarse en un índice en vez de recorrer la
// colección entera por cada tecla.
productSchema.index({ searchName: 1 });

// Lo que necesita la pantalla de Descuentos: productos rebajados y
// disponibles. Parcial y no completo porque `discountPrice` es `null` en
// la inmensa mayoría de la carta —solo entra al índice quien de verdad
// está en oferta.
productSchema.index(
  { isAvailable: 1, discountPrice: 1 },
  { partialFilterExpression: { discountPrice: { $gt: 0 } } }
);

/**
 * Búsqueda por texto del catálogo.
 *
 * Con idioma español, que no es un detalle cosmético: le enseña a Mongo a
 * reducir "empanadas" y "empanada" a la misma raíz y a ignorar palabras
 * vacías como "de" o "con". Sin eso, buscar "arroz con pollo" trata "con"
 * como término de búsqueda.
 *
 * El nombre pesa diez veces más que la descripción: quien escribe "pollo"
 * quiere el plato que se llama pollo, no la hamburguesa cuya descripción
 * menciona que también hay pollo.
 */
productSchema.index(
  { name: 'text', description: 'text' },
  { weights: { name: 10, description: 1 }, default_language: 'spanish', name: 'product_search' }
);

export const Product = mongoose.model<IProduct>('Product', productSchema);
