import mongoose, { Schema, Document, Types } from 'mongoose';
import { ProductExtra, ModifierGroup } from '../types';
import { productImageUrls } from '../utils/productImageUrls';
import { normalize } from '../utils/text';
import { cacheInvalidationPlugin, CachePrefix, fieldFrom } from '../cache';
import { PRODUCT_TAGS, MAX_TAGS_PER_PRODUCT } from '../constants/productTags';

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
  /**
   * Fondo retirado con el complemento de Cloudinary, ya retirado.
   *
   * Solo lo llevan en `true` las fotos subidas con aquel complemento: se
   * siguen sirviendo como entonces. El recorte actual vive en `cutout`.
   */
  backgroundRemoved: boolean;
  /**
   * La miniatura borrosa como `data:` URI (~130 caracteres), calculada al
   * subir. Viaja dentro de la respuesta, así que se pinta sin otra petición
   * y aunque no haya red. Vacía en lo subido antes del relleno
   * (`backfill:image-placeholders`): ahí se sirve la URL.
   */
  placeholderDataUri?: string | null;
  uploadedAt: Date;
  /**
   * La misma foto sin fondo, como archivo aparte.
   *
   * Los campos de arriba siguen siendo la **foto original** y no se tocan
   * nunca al recortar: por eso "Usar imagen original" es un interruptor y
   * no una segunda subida. Solo la foto principal lo usa; en la galería
   * queda siempre en `null`.
   */
  cutout?: IProductImageCutout | null;
  /** En qué va el recorte de fondo de esta foto. */
  backgroundRemoval?: IBackgroundRemovalState | null;
  /** El comercio prefirió su foto con fondo aunque exista el recorte. */
  useOriginal?: boolean;
}

export type BackgroundRemovalStatus = 'none' | 'pending' | 'processing' | 'completed' | 'failed';

/** El PNG con transparencia que devolvió el proveedor, ya en Cloudinary. */
export interface IProductImageCutout {
  publicId: string;
  width: number;
  height: number;
  bytes: number;
  format: string;
  /** Quién lo recortó: si se cambia de proveedor, se sabe de dónde salió cada foto. */
  provider: string;
  /** Miniatura borrosa de la versión compuesta, la que se ve en el catálogo. */
  placeholderDataUri?: string | null;
  createdAt: Date;
}

/**
 * El estado del recorte vive en el producto, no en memoria del proceso.
 *
 * Mismo criterio que el reparto en cascada: si el proceso se reinicia a
 * mitad, el barrido encuentra el trabajo donde quedó.
 */
export interface IBackgroundRemovalState {
  status: BackgroundRemovalStatus;
  provider: string | null;
  /** Intentos automáticos de esta foto. Un "Reintentar" explícito lo pone a cero. */
  attempts: number;
  /** Código estable del último fallo; nunca el texto del proveedor. */
  errorCode: string | null;
  /** Identifica la ejecución que tiene la foto reservada. */
  claimId: string | null;
  requestedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  /**
   * Cuándo le toca al barrido: el próximo intento si está `pending`, o el
   * vencimiento de la reserva si está `processing`. `null` en los estados
   * terminales, que así quedan fuera del índice.
   */
  nextAttemptAt: Date | null;
  durationMs: number | null;
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
  /**
   * Minutos que tarda este plato en la cocina, si es distinto del resto de
   * la carta.
   *
   * `null` es "usa el tiempo general del negocio" (`Business.deliveryTime`):
   * no todo comercio quiere declarar un tiempo por cada producto, y no
   * declararlo no puede significar "instantáneo". Cuando el carrito mezcla
   * productos, manda el más lento — un asado no sale antes porque también
   * se pidió una gaseosa.
   */
  prepTimeMinutes?: number | null;
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

  /**
   * Qué es este producto, en el vocabulario cerrado de `constants/productTags`.
   *
   * Es lo que permite que una colección del inicio se exprese como "los
   * productos con la etiqueta `desayuno`" en vez de como una regex sobre el
   * nombre. La diferencia no es de estilo: un `$in` sobre un array indexado
   * usa el índice, y `{ $regex: 'cafe|pan|huevo' }` sin ancla recorre todo
   * lo que le llegue.
   *
   * Lo rellena una pasada única (`scripts/backfillProductTags.ts`) y desde
   * ahí manda lo que el comercio corrija en su panel: la máquina propone,
   * quien tiene la carta delante decide.
   */
  tags: string[];

  createdAt: Date;
  updatedAt: Date;
}

const productImageCutoutSchema = new Schema<IProductImageCutout>(
  {
    publicId: { type: String, required: true },
    width: { type: Number, required: true, min: 1 },
    height: { type: Number, required: true, min: 1 },
    bytes: { type: Number, required: true, min: 0 },
    format: { type: String, required: true },
    provider: { type: String, required: true },
    placeholderDataUri: { type: String, default: null, maxlength: 2048 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const backgroundRemovalStateSchema = new Schema<IBackgroundRemovalState>(
  {
    status: {
      type: String,
      enum: ['none', 'pending', 'processing', 'completed', 'failed'],
      default: 'none',
    },
    provider: { type: String, default: null },
    attempts: { type: Number, default: 0, min: 0 },
    errorCode: { type: String, default: null },
    claimId: { type: String, default: null },
    requestedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
  },
  { _id: false }
);

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
    // El tope protege el tamaño de cada carta: una miniatura de 24 px pesa
    // cien bytes, y algo que ocupe más no es un placeholder.
    placeholderDataUri: { type: String, default: null, maxlength: 2048 },
    uploadedAt: { type: Date, default: Date.now },
    // Opcionales y en `null` por defecto: los productos de antes no los
    // tienen y se leen como "sin recorte", exactamente como se veían.
    cutout: { type: productImageCutoutSchema, default: null },
    backgroundRemoval: { type: backgroundRemovalStateSchema, default: null },
    useOriginal: { type: Boolean, default: false },
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
    prepTimeMinutes: {
      type: Number,
      default: null,
      min: [1, 'El tiempo de preparación no puede ser menor a 1 minuto'],
      max: [180, 'El tiempo de preparación no puede superar 180 minutos'],
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
    tags: {
      type: [String],
      default: [],
      // `enum` sobre el array valida cada elemento, no el array entero: un
      // término inventado desde el panel se rechaza aquí y no llega a
      // ensuciar las colecciones, que es donde costaría descubrirlo.
      enum: {
        values: PRODUCT_TAGS as unknown as string[],
        message: 'La etiqueta "{VALUE}" no existe en el vocabulario',
      },
      validate: {
        validator: (value: string[]) => value.length <= MAX_TAGS_PER_PRODUCT,
        message: `Máximo ${MAX_TAGS_PER_PRODUCT} etiquetas por producto`,
      },
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

productSchema.set('toJSON', {
  virtuals: true,
  // La miniatura incrustada ya sale en `images.placeholder`: repetirla en
  // `imageAsset` y en cada foto de `gallery` la mandaría dos veces por
  // producto en cada carta, y la guardaría dos veces en la caché del móvil.
  transform: (_doc, ret: Record<string, any>) => {
    for (const image of [ret.imageAsset, ...(ret.gallery ?? [])]) {
      if (!image) continue;
      delete image.placeholderDataUri;
      // Las URLs del recorte ya van en `images`; el archivo en crudo, no.
      delete image.cutout;
      // Del recorte solo sale lo que el panel del comercio lee: por qué
      // falló y cuándo se pidió. El proveedor, los intentos y la reserva
      // son maquinaria interna —y este JSON lo sirve también la carta
      // pública, a cualquiera—; el estado ya va en `images`.
      if (image.backgroundRemoval) {
        const { errorCode, requestedAt } = image.backgroundRemoval;
        image.backgroundRemoval = { errorCode, requestedAt };
      }
    }
    return ret;
  },
});
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

/**
 * El índice que sostiene las colecciones por etiqueta.
 *
 * Multiclave (Mongo indexa cada elemento del array por separado), y con
 * `isAvailable` detrás porque ninguna colección quiere productos apagados:
 * poner el filtro dentro del índice evita que el motor tenga que ir al
 * documento para descartarlo.
 *
 * El orden importa: `tags` primero porque es el campo selectivo. Al revés
 * —`isAvailable` delante— la primera clave solo tendría dos valores y el
 * índice serviría para poco.
 */
productSchema.index({ tags: 1, isAvailable: 1 });

// Lo que busca el barrido del recorte de fondo. Parcial porque
// `nextAttemptAt` solo tiene fecha mientras hay trabajo pendiente: la carta
// entera, con sus fotos ya terminadas, se queda fuera del índice.
productSchema.index(
  { 'imageAsset.backgroundRemoval.nextAttemptAt': 1 },
  {
    name: 'background_removal_due',
    partialFilterExpression: { 'imageAsset.backgroundRemoval.nextAttemptAt': { $type: 'date' } },
  }
);

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

// Cada escritura limpia lo que la caché de lecturas tenga de este modelo.
productSchema.plugin(cacheInvalidationPlugin, {
  prefixesFor: (ctx) => {
    const businessId = fieldFrom(ctx, 'businessId');
    return [
      businessId ? CachePrefix.business(businessId) : CachePrefix.BUSINESS_ALL,
      CachePrefix.HOME,
      CachePrefix.EXPLORE,
      CachePrefix.OFFERS,
    ];
  },
});

export const Product = mongoose.model<IProduct>('Product', productSchema);
