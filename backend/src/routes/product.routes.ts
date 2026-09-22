import { Router } from 'express';
import { productController } from '../controllers';
import { authenticate, authorize, validate, productImageUploadRateLimiter } from '../middlewares';
import {
  createProductSchema,
  updateProductSchema,
  productOwnerBodySchema,
  productGalleryRemoveSchema,
  productImageOptionsSchema,
} from '../validators';
import { UserRole } from '../types';

const router = Router();

// Public
router.get('/by-category/:categoryKey', (req, res, next) => productController.getByBusinessCategory(req, res, next));
router.get('/business/:businessId/sentiment', (req, res, next) => productController.sentiment(req, res, next));
router.get('/business/:businessId/top', (req, res, next) => productController.topSellers(req, res, next));
router.get('/business/:businessId', (req, res, next) => productController.getByBusiness(req, res, next));

// Antes que `/:id`: si no, Express leería "image-capabilities" como el
// identificador de un producto.
router.get('/image-capabilities', authenticate, (req, res, next) => productController.imageCapabilities(req, res, next));

router.get('/:id', (req, res, next) => productController.getById(req, res, next));

// Protected
//
// `validate(...)` faltaba en las tres rutas de escritura. Los esquemas
// existían desde el principio; nadie los había enchufado, así que el
// cuerpo entero de la petición viajaba hasta Mongoose.
router.post('/', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), validate(createProductSchema), (req, res, next) => productController.create(req, res, next));
router.put('/:id', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), validate(updateProductSchema), (req, res, next) => productController.update(req, res, next));
router.delete('/:id', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), validate(productOwnerBodySchema), (req, res, next) => productController.delete(req, res, next));

// ── Imagen del producto ──
//
// Va aparte del PUT porque es multipart y no JSON, y porque reemplazar la
// foto tiene que poder borrar la anterior de Cloudinary: mezclarlo con el
// resto de campos deja archivos huérfanos cada vez que algo falla a mitad.
router.post('/:id/image', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), productImageUploadRateLimiter, (req, res, next) => productController.uploadImage(req, res, next));
router.patch('/:id/image', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), validate(productImageOptionsSchema), (req, res, next) => productController.updateImageOptions(req, res, next));
router.delete('/:id/image', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), validate(productOwnerBodySchema), (req, res, next) => productController.deleteImage(req, res, next));

// "Reintentar" o "Quitar el fondo" sobre la foto que ya está. Cuesta un
// crédito, así que comparte limitador con las subidas.
router.post('/:id/image/background-removal', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), productImageUploadRateLimiter, validate(productOwnerBodySchema), (req, res, next) => productController.requestBackgroundRemoval(req, res, next));

// Galería: fotos adicionales para la ficha. No tocan la principal, que
// es la que leen las listas y el carrito.
router.post('/:id/gallery', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), productImageUploadRateLimiter, (req, res, next) => productController.addGalleryImage(req, res, next));
router.delete('/:id/gallery', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), validate(productGalleryRemoveSchema), (req, res, next) => productController.removeGalleryImage(req, res, next));

export default router;
