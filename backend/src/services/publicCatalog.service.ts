import { Types } from 'mongoose';
import { IBusiness } from '../models';
import { cache, CachePrefix } from '../cache';
import { businessService } from './business.service';
import { categoryService } from './category.service';
import { productService } from './product.service';
import { pricingService } from './pricing.service';

/**
 * Lo que la app lee de un negocio sin sesión —ficha, secciones, carta, los
 * más pedidos y la opinión por producto—, ya cacheado.
 *
 * Vive aparte de los controladores porque lo usan dos rutas: las de
 * siempre (`/businesses/:id`, `/products/business/:id`…, que siguen ahí
 * para las versiones de la app ya instaladas y para el panel) y
 * `/businesses/:id/storefront`, que devuelve las cinco en una sola
 * petición. Con las mismas claves, las dos se sirven de la misma caché y
 * se invalidan juntas.
 *
 * Lo que se devuelve es JSON plano (ver `cache.wrap`): el payload final,
 * no documentos de Mongoose.
 */

const DETAIL_TTL_SECONDS = 120;
const MENU_TTL_SECONDS = 120;
/** Sale de pedidos entregados de 30 días: no cambia de un minuto a otro. */
const TOP_SELLERS_TTL_SECONDS = 600;

/**
 * Un id que no es ObjectId no se cachea: la respuesta sería un error o una
 * lista vacía, y dejar que cualquier texto en la URL cree una entrada es
 * regalar la caché a quien quiera llenarla.
 */
const cacheable = (id: string | undefined) => !!id && Types.ObjectId.isValid(id);

/**
 * Añade a la ficha el piso de su domicilio, el "Desde $X" del encabezado.
 *
 * Se calcula aquí y no en el servicio del negocio porque es información de
 * presentación: quien pide el negocio para operar con él —el checkout, el
 * reparto— no quiere un número aproximado rondando en el documento, quiere
 * la cotización real de su dirección.
 *
 * Una consulta geoespacial indexada por apertura de ficha, contra la
 * alternativa de guardarlo en el negocio y que quede viejo cada vez que
 * administración toque una zona o la tarifa base. (Con la caché, una por
 * negocio cada dos minutos; tocar zonas o tarifas limpia todas las fichas.)
 */
async function withDeliveryFloor(business: IBusiness) {
  const deliveryFeeFrom = await pricingService.minimumDeliveryFee(business);
  return { ...business.toJSON(), deliveryFeeFrom };
}

export const publicCatalogService = {
  async businessDetail(id: string) {
    const load = async () => withDeliveryFloor(await businessService.getById(id));
    if (!cacheable(id)) return load();
    return cache.wrap(`${CachePrefix.business(id)}detail`, DETAIL_TTL_SECONDS, load);
  },

  async businessBySlug(slug: string) {
    const load = async () => withDeliveryFloor(await businessService.getBySlug(slug));
    if (!slug || slug.length > 120) return load();
    return cache.wrap(`${CachePrefix.BUSINESS_SLUG}${encodeURIComponent(slug)}`, DETAIL_TTL_SECONDS, load);
  },

  async categories(businessId: string) {
    const load = () => categoryService.getByBusiness(businessId);
    if (!cacheable(businessId)) return load();
    return cache.wrap(`${CachePrefix.business(businessId)}categories`, MENU_TTL_SECONDS, load);
  },

  /** La carta que ve el cliente: solo lo disponible. */
  async products(businessId: string, categoryId?: string) {
    const load = () => productService.getByBusiness(businessId, categoryId, false);
    if (!cacheable(businessId) || (categoryId && !cacheable(categoryId))) return load();
    return cache.wrap(
      `${CachePrefix.business(businessId)}products:${categoryId || 'all'}`,
      MENU_TTL_SECONDS,
      load
    );
  },

  async topSellers(businessId: string, limit: number) {
    const load = () => productService.topSellers(businessId, limit);
    if (!cacheable(businessId)) return load();
    return cache.wrap(`${CachePrefix.business(businessId)}top:${limit}`, TOP_SELLERS_TTL_SECONDS, load);
  },

  async sentiment(businessId: string) {
    const { reviewService } = await import('./review.service');
    const load = () => reviewService.productSentiment(businessId);
    if (!cacheable(businessId)) return load();
    return cache.wrap(`${CachePrefix.business(businessId)}sentiment`, MENU_TTL_SECONDS, load);
  },

  /**
   * Todo lo que pinta la pantalla de un negocio, en una petición.
   *
   * La app hacía cinco llamadas en paralelo al abrir una tienda. En
   * paralelo no suman latencia en el servidor, pero en una red móvil lenta
   * son cinco peticiones compitiendo por la misma conexión, y cinco
   * oportunidades de que una falle y deje la pantalla a medias.
   */
  async storefront(businessId: string, topLimit = 5) {
    const [business, categories, products, topSellers, sentiment] = await Promise.all([
      this.businessDetail(businessId),
      this.categories(businessId),
      this.products(businessId),
      this.topSellers(businessId, topLimit),
      this.sentiment(businessId),
    ]);
    return { business, categories, products, topSellers, sentiment };
  },
};
