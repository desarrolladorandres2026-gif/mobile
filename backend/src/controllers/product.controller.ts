import { Request, Response, NextFunction } from 'express';
import { productService } from '../services';
import { productImageService } from '../services/productImage.service';
import { sendResponse, param, query } from '../utils';
import { AppError } from '../middlewares';
import { uploadProductImage } from '../middlewares/upload';
import { UserRole } from '../types';
import { Business } from '../models';

async function assertOwnsBusiness(req: Request, businessId: string) {
  if (req.user!.role === UserRole.ADMIN) return;
  const owned = await Business.exists({ _id: businessId, ownerId: req.user!._id });
  if (!owned) throw new AppError('No autorizado para modificar este comercio', 403);
}

export class ProductController {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      await assertOwnsBusiness(req, req.body.businessId);
      const product = await productService.create(req.body);
      sendResponse(res, 201, 'Producto creado', product);
    } catch (error) { next(error); }
  }

  async getByBusiness(req: Request, res: Response, next: NextFunction) {
    try {
      const includeUnavailable = query(req, 'includeUnavailable') === 'true';
      const products = await productService.getByBusiness(
        param(req, 'businessId'),
        query(req, 'categoryId'),
        includeUnavailable
      );
      sendResponse(res, 200, 'Productos obtenidos', products);
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
        if (err) {
          throw new AppError(
            err instanceof Error ? err.message : 'No se pudo procesar la imagen',
            400,
            'PRODUCT_IMAGE_INVALID_FILE'
          );
        }
        if (!req.file) {
          throw new AppError('Adjunta una imagen', 400, 'PRODUCT_IMAGE_INVALID_FILE');
        }

        const businessId = String(req.body?.businessId ?? '');
        await assertOwnsBusiness(req, businessId);

        const product = await productService.getOwned(param(req, 'id'), businessId);
        const updated = await productImageService.replace({
          product,
          buffer: req.file.buffer,
          mimetype: req.file.mimetype,
          enhance: req.body?.enhance !== 'false',
          removeBackground: req.body?.removeBackground === 'true',
        });

        sendResponse(res, 201, 'Imagen actualizada', updated);
      } catch (error) { next(error); }
    });
  }

  /** Activa o desactiva la mejora sin volver a subir el archivo. */
  async updateImageOptions(req: Request, res: Response, next: NextFunction) {
    try {
      const businessId = String(req.body?.businessId ?? '');
      await assertOwnsBusiness(req, businessId);

      const product = await productService.getOwned(param(req, 'id'), businessId);
      const updated = await productImageService.updateOptions(product, {
        enhance: typeof req.body?.enhance === 'boolean' ? req.body.enhance : undefined,
      });

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
