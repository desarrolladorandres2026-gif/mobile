import { Request, Response, NextFunction } from 'express';
import { productService, publicCatalogService, couponService } from '../services';
import { MulterError } from 'multer';
import { config } from '../config';
import { productImageService } from '../services/productImage.service';
import { backgroundRemovalService } from '../services/backgroundRemoval.service';
import { sendResponse, param, query, clampLimit } from '../utils';
import { AppError, cacheHeaders } from '../middlewares';
import { uploadProductImage } from '../middlewares/upload';
import { UserRole } from '../types';
import { Business } from '../models';

/**
 * El error de multer, en el idioma y con el código del resto de la API.
 *
 * Un archivo demasiado grande salía como 400 "File too large": en inglés y
 * con el mismo código que un archivo corrupto, así que el panel no podía
 * decirle al comercio qué hacer.
 */
function uploadError(err: unknown): AppError {
  if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
    const mb = (config.productImages.maxBytes / (1024 * 1024)).toFixed(0);
    return new AppError(
      `La imagen pesa más de ${mb} MB. Tómala de nuevo o redúcela antes de subirla.`,
      413,
      'PRODUCT_IMAGE_TOO_LARGE'
    );
  }
  return new AppError(
    err instanceof Error ? err.message : 'No se pudo procesar la imagen',
    400,
    'PRODUCT_IMAGE_INVALID_FILE'
  );
}

async function assertOwnsBusiness(req: Request, businessId: string) {
  if (req.user!.role === UserRole.ADMIN) return;
  const owned = await Business.exists({ _id: businessId, ownerId: req.user!._id });
  if (!owned) throw new AppError('No autorizado para modificar este comercio', 403);
}

export class ProductController {
  /** Cuántos pulgares lleva cada plato del negocio. */
  async sentiment(req: Request, res: Response, next: NextFunction) {
    try {
      const sentiment = await publicCatalogService.sentiment(param(req, 'businessId'));
      cacheHeaders(res, 'revalidate');
      sendResponse(res, 200, 'Opinión por producto', sentiment);
    } catch (error) { next(error); }
  }

  /** Los más pedidos de un negocio, según los pedidos entregados. */
  async topSellers(req: Request, res: Response, next: NextFunction) {
    try {
      const products = await publicCatalogService.topSellers(
        param(req, 'businessId'),
        clampLimit(query(req, 'limit'), 100, 5)
      );
      cacheHeaders(res, 'revalidate');
      sendResponse(res, 200, 'Los más pedidos', products);
    } catch (error) { next(error); }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      await assertOwnsBusiness(req, req.body.businessId);
      const product = await productService.create(req.body);
      sendResponse(res, 201, 'Producto creado', product);
    } catch (error) { next(error); }
  }

  async getByBusiness(req: Request, res: Response, next: NextFunction) {
    try {
      // Con lo no disponible es la vista del panel del comercio: siempre
      // fresca y fuera de cualquier caché compartida.
      const includeUnavailable = query(req, 'includeUnavailable') === 'true';

      if (includeUnavailable) {
        const businessId = param(req, 'businessId');
        const raw = await productService.getByBusiness(businessId, query(req, 'categoryId'), true);

        // `promotedBy`: solo para que el panel sepa que el precio con
        // descuento manual está bloqueado mientras dure la promoción — el
        // valor de `discountPrice` que ve el comercio aquí sigue siendo el
        // suyo, sin resolver, porque este es el formulario donde lo edita.
        const promotions = await couponService.autoPromotionsFor(businessId, new Date());
        const products = raw.map((product) => ({
          ...product.toJSON(),
          promotedBy: promotions.get(product._id.toString())?._id.toString() ?? null,
        }));

        cacheHeaders(res, 'none');
        sendResponse(res, 200, 'Productos obtenidos', products);
        return;
      }

      const products = await publicCatalogService.products(param(req, 'businessId'), query(req, 'categoryId'));
      cacheHeaders(res, 'revalidate');
      sendResponse(res, 200, 'Productos obtenidos', products);
    } catch (error) { next(error); }
  }


  /** Productos de negocios de una categoría, para el carrusel del home. */
  async getByBusinessCategory(req: Request, res: Response, next: NextFunction) {
    try {
      const products = await productService.getByBusinessCategory(
        param(req, 'categoryKey'),
        clampLimit(query(req, 'limit'), 100, 20)
      );
      sendResponse(res, 200, 'Productos por categoría', products);
    } catch (error) { next(error); }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const product = await productService.getById(param(req, 'id'));
      sendResponse(res, 200, 'Producto obtenido', product);
    } catch (error) { next(error); }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      await assertOwnsBusiness(req, req.body.businessId);
      const product = await productService.update(param(req, 'id'), req.body.businessId, req.body);
      sendResponse(res, 200, 'Producto actualizado', product);
    } catch (error) { next(error); }
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      await assertOwnsBusiness(req, req.body.businessId);
      await productService.delete(param(req, 'id'), req.body.businessId);
      sendResponse(res, 200, 'Producto eliminado');
    } catch (error) { next(error); }
  }

  // ── Imagen del producto ────────────────────────────────────────────

  /** Qué puede hacer este entorno. El panel no pinta botones sin esto. */
  async imageCapabilities(_req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Capacidades de imagen', productImageService.capabilities());
    } catch (error) { next(error); }
  }

  /**
   * Sube o reemplaza la foto de un producto.
   *
   * `multer` corre aquí dentro y no como middleware de ruta a propósito:
   * así el formato y el tamaño se rechazan antes de resolver la propiedad
   * del producto, pero la propiedad se comprueba antes de tocar
   * Cloudinary — un desconocido no puede hacernos subir imágenes al
   * catálogo de otro.
   *
   * `businessId`, `enhance` y `removeBackground` viajan como campos del
   * multipart, así que llegan siempre como texto.
   */
  async uploadImage(req: Request, res: Response, next: NextFunction) {
    uploadProductImage(req, res, async (err: unknown) => {
      try {
        if (err) throw uploadError(err);
        if (!req.file) {
          throw new AppError('Adjunta una imagen', 400, 'PRODUCT_IMAGE_INVALID_FILE');
        }

        const businessId = String(req.body?.businessId ?? '');
        await assertOwnsBusiness(req, businessId);

        const product = await productService.getOwned(param(req, 'id'), businessId);
        let updated = await productImageService.replace({
          product,
          buffer: req.file.buffer,
          mimetype: req.file.mimetype,
          enhance: req.body?.enhance !== 'false',
        });

        // El recorte no se espera: la respuesta sale con la original y el
        // estado `pending`, y el panel pregunta hasta verlo terminado.
        if (req.body?.removeBackground === 'true') {
          updated = await backgroundRemovalService.requestIfNeeded(updated);
        }

        sendResponse(res, 201, 'Imagen actualizada', updated);
      } catch (error) { next(error); }
    });
  }

  /**
   * "Reintentar" o "Quitar el fondo" sobre la foto que ya tiene.
   *
   * Es la única forma de volver a cobrar un recorte de la misma foto, y
   * por eso pasa por el limitador de subidas y por el tope diario.
   */
  async requestBackgroundRemoval(req: Request, res: Response, next: NextFunction) {
    try {
      await assertOwnsBusiness(req, req.body.businessId);
      const product = await productService.getOwned(param(req, 'id'), req.body.businessId);
      const updated = await backgroundRemovalService.request(product, 'retry');
      const status = updated.imageAsset?.backgroundRemoval?.status;
      sendResponse(
        res,
        status === 'pending' || status === 'processing' ? 202 : 200,
        'Recorte de fondo solicitado',
        updated
      );
    } catch (error) { next(error); }
  }

  /**
   * Añade una foto a la galería del producto.
   *
   * Mismo camino que la principal —multer, dueño del negocio, producto
   * suyo— pero contra `addToGallery`, que no toca `imageAsset`.
   */
  async addGalleryImage(req: Request, res: Response, next: NextFunction) {
    uploadProductImage(req, res, async (err: unknown) => {
      try {
        if (err) throw uploadError(err);
        if (!req.file) {
          throw new AppError('Adjunta una imagen', 400, 'PRODUCT_IMAGE_INVALID_FILE');
        }

        const businessId = String(req.body?.businessId ?? '');
        await assertOwnsBusiness(req, businessId);

        const product = await productService.getOwned(param(req, 'id'), businessId);
        const updated = await productImageService.addToGallery({
          product,
          buffer: req.file.buffer,
          mimetype: req.file.mimetype,
        });

        sendResponse(res, 201, 'Foto añadida', updated);
      } catch (error) { next(error); }
    });
  }

  async removeGalleryImage(req: Request, res: Response, next: NextFunction) {
    try {
      const { businessId, publicId } = req.body;
      await assertOwnsBusiness(req, businessId);

      const product = await productService.getOwned(param(req, 'id'), businessId);
      const updated = await productImageService.removeFromGallery(product, publicId);

      sendResponse(res, 200, 'Foto eliminada', updated);
    } catch (error) { next(error); }
  }

  /**
   * "Mejorar" y "Usar imagen original", sin volver a subir el archivo ni
   * gastar un recorte: los dos viven en la URL de entrega.
   */
  async updateImageOptions(req: Request, res: Response, next: NextFunction) {
    try {
      const { businessId, enhance, useOriginal } = req.body;
      await assertOwnsBusiness(req, businessId);

      const product = await productService.getOwned(param(req, 'id'), businessId);
      const updated = await productImageService.updateOptions(product, { enhance, useOriginal });

      sendResponse(res, 200, 'Imagen actualizada', updated);
    } catch (error) { next(error); }
  }

  async deleteImage(req: Request, res: Response, next: NextFunction) {
    try {
      await assertOwnsBusiness(req, req.body.businessId);
      const product = await productService.getOwned(param(req, 'id'), req.body.businessId);
      const updated = await productImageService.remove(product);
      sendResponse(res, 200, 'Imagen eliminada', updated);
    } catch (error) { next(error); }
  }
}

export const productController = new ProductController();
