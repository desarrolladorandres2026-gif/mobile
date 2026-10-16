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
import { BusinessPermission } from '../models';
import { assertBusinessCan, businessStaffService } from '../services/businessStaff.service';
import { AuditAction, AuditSeverity, logAudit } from '../security';

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

/**
 * Quién puede tocar el catálogo de un negocio lo decide el permiso, no el
 * papel ni la propiedad: el propietario y el administrador entran por
 * `catalog:*`; el empleado solo consulta, y el 403 sale de aquí
 * aunque llamen al endpoint directamente.
 */
function assertCatalog(req: Request, businessId: string, permission: BusinessPermission, action: string) {
  return assertBusinessCan(req.user!, businessId, permission, `Sin permisos para ${action}.`, req.sessionScope);
}

/** Campos que `catalog:availability` puede escribir: la cocina del momento. */
const AVAILABILITY_FIELDS = new Set(['isAvailable', 'stock', 'unavailableForMinutes']);

function isAvailabilityOnly(body: Record<string, unknown>): boolean {
  const fields = Object.keys(body).filter((key) => key !== 'businessId' && body[key] !== undefined);
  return fields.length > 0 && fields.every((key) => AVAILABILITY_FIELDS.has(key));
}

/** El papel de quien actúa en este negocio, para dejarlo escrito en la auditoría. */
async function actorRoleLabel(req: Request, businessId: string): Promise<string | undefined> {
  if (req.user!.role === UserRole.ADMIN) return 'platform_admin';
  return (await businessStaffService.accessFor(req.user!._id.toString(), businessId, req.sessionScope))?.role;
}

type CatalogSnapshot = {
  name: string;
  price: number;
  discountPrice?: number | null;
  isAvailable: boolean;
  stock?: number | null;
  extras: unknown;
  modifierGroups: unknown;
};

const snapshotOf = (p: any): CatalogSnapshot => ({
  name: p.name,
  price: p.price,
  discountPrice: p.discountPrice ?? null,
  isAvailable: p.isAvailable,
  stock: p.stock ?? null,
  extras: JSON.parse(JSON.stringify(p.extras ?? [])),
  modifierGroups: JSON.parse(JSON.stringify(p.modifierGroups ?? [])),
});

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class ProductController {
  /**
   * Deja en la auditoría quién tocó el precio, la disponibilidad o el stock de
   * un producto. Compara antes y después: reenviar el mismo valor no es un
   * cambio y no escribe nada, así que un reintento no duplica el registro.
   * Del precio y del stock se guardan los valores —es lo que se investiga—;
   * de las opciones solo que cambiaron.
   */
  private async auditCatalogChange(
    req: Request,
    productId: string,
    businessId: string,
    before: CatalogSnapshot,
    after: CatalogSnapshot,
    sent: string[]
  ) {
    const actorBusinessRole = await actorRoleLabel(req, businessId);
    const base = { businessId, productName: after.name, actorBusinessRole };

    const priceChanged =
      before.price !== after.price ||
      before.discountPrice !== after.discountPrice ||
      !same(before.extras, after.extras) ||
      !same(before.modifierGroups, after.modifierGroups);
    if (priceChanged) {
      void logAudit(req, {
        action: AuditAction.PRODUCT_PRICE_CHANGED,
        entity: 'product',
        entityId: productId,
        severity: AuditSeverity.MEDIUM,
        description: `Precio de "${after.name}" modificado`,
        metadata: {
          ...base,
          price: { from: before.price, to: after.price },
          discountPrice: { from: before.discountPrice, to: after.discountPrice },
          extrasChanged: !same(before.extras, after.extras),
          modifierGroupsChanged: !same(before.modifierGroups, after.modifierGroups),
        },
      });
    }

    if (before.isAvailable !== after.isAvailable || before.stock !== after.stock) {
      void logAudit(req, {
        action: AuditAction.PRODUCT_AVAILABILITY_CHANGED,
        entity: 'product',
        entityId: productId,
        description: `Disponibilidad de "${after.name}" modificada`,
        metadata: {
          ...base,
          isAvailable: { from: before.isAvailable, to: after.isAvailable },
          stock: { from: before.stock, to: after.stock },
        },
      });
    }

    // El resto de la ficha (nombre, descripción, foto, categoría…): quién y qué campos.
    const handled = new Set(['price', 'discountPrice', 'extras', 'modifierGroups', 'isAvailable', 'stock', 'businessId']);
    const others = sent.filter((key) => !handled.has(key));
    if (others.length > 0) {
      void logAudit(req, {
        action: AuditAction.PRODUCT_UPDATED,
        entity: 'product',
        entityId: productId,
        description: `Producto "${after.name}" modificado`,
        metadata: { ...base, changes: others },
      });
    }
  }

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
      await assertCatalog(req, req.body.businessId, BusinessPermission.CATALOG_CREATE, 'crear productos');
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
      // Agotar o reponer lo hace quien está en la cocina (`catalog:availability`)
      // sin poder tocar la ficha. Solo vale si el cuerpo trae EXACTAMENTE
      // esos campos: cualquier otro exige `catalog:edit`, y así un operador
      // no puede colar un nombre o un precio junto a `isAvailable`.
      if (isAvailabilityOnly(req.body)) {
        await assertBusinessCan(
          req.user!,
          req.body.businessId,
          BusinessPermission.CATALOG_AVAILABILITY,
          'Sin permisos para cambiar la disponibilidad de productos.',
          req.sessionScope
        );
      } else {
        await assertCatalog(req, req.body.businessId, BusinessPermission.CATALOG_EDIT, 'modificar productos');
      }
      // El precio es dinero: tocarlo (o las opciones, que también cobran) pide
      // su propio permiso, aparte de editar el resto de la ficha.
      const current = await productService.getOwned(param(req, 'id'), req.body.businessId);
      // También cobran el precio con descuento y los adicionales: sin esto,
      // un rol con `catalog:edit` pero sin `catalog:change_price` cambiaba
      // precios por esos dos campos (auditoría 2026-10-09, BAJO 8).
      const body = req.body as Record<string, unknown>;
      const moneyChanged =
        (body.price !== undefined && body.price !== current.price) ||
        (body.discountPrice !== undefined && (body.discountPrice ?? null) !== (current.discountPrice ?? null)) ||
        (body.extras !== undefined && !same(body.extras, JSON.parse(JSON.stringify(current.extras ?? [])))) ||
        body.modifierGroups !== undefined;
      if (moneyChanged) {
        await assertCatalog(req, req.body.businessId, BusinessPermission.CATALOG_CHANGE_PRICE, 'modificar precios');
      }
      const before = snapshotOf(current);
      const product = await productService.update(param(req, 'id'), req.body.businessId, req.body);
      // Sin `await` y con `catch`: el cambio ya está guardado, y un fallo al
      // auditar no puede devolverle al cliente un 500 de algo que sí pasó.
      this.auditCatalogChange(
        req,
        product._id.toString(),
        req.body.businessId,
        before,
        snapshotOf(product),
        Object.keys(req.body).filter((key) => req.body[key] !== undefined)
      ).catch((err) => console.error('[AUDIT] No se pudo auditar el cambio de catálogo:', err));
      sendResponse(res, 200, 'Producto actualizado', product);
    } catch (error) { next(error); }
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      await assertCatalog(req, req.body.businessId, BusinessPermission.CATALOG_DELETE, 'eliminar productos');
      const product = await productService.getOwned(param(req, 'id'), req.body.businessId);
      const snapshot = snapshotOf(product);
      await productService.delete(param(req, 'id'), req.body.businessId);
      void logAudit(req, {
        action: AuditAction.PRODUCT_DELETED,
        entity: 'product',
        entityId: product._id.toString(),
        severity: AuditSeverity.MEDIUM,
        description: `Producto "${snapshot.name}" eliminado`,
        metadata: {
          businessId: req.body.businessId,
          productName: snapshot.name,
          price: snapshot.price,
          actorBusinessRole: await actorRoleLabel(req, req.body.businessId).catch(() => undefined),
        },
      });
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
        await assertCatalog(req, businessId, BusinessPermission.CATALOG_EDIT, 'modificar productos');

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
      await assertCatalog(req, req.body.businessId, BusinessPermission.CATALOG_EDIT, 'modificar productos');
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
        await assertCatalog(req, businessId, BusinessPermission.CATALOG_EDIT, 'modificar productos');

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
      await assertCatalog(req, businessId, BusinessPermission.CATALOG_EDIT, 'modificar productos');

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
      await assertCatalog(req, businessId, BusinessPermission.CATALOG_EDIT, 'modificar productos');

      const product = await productService.getOwned(param(req, 'id'), businessId);
      const updated = await productImageService.updateOptions(product, { enhance, useOriginal });

      sendResponse(res, 200, 'Imagen actualizada', updated);
    } catch (error) { next(error); }
  }

  async deleteImage(req: Request, res: Response, next: NextFunction) {
    try {
      await assertCatalog(req, req.body.businessId, BusinessPermission.CATALOG_EDIT, 'modificar productos');
      const product = await productService.getOwned(param(req, 'id'), req.body.businessId);
      const updated = await productImageService.remove(product);
      sendResponse(res, 200, 'Imagen eliminada', updated);
    } catch (error) { next(error); }
  }
}

export const productController = new ProductController();
