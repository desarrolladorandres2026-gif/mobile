import multer from 'multer';
import { config } from '../config';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * In-memory single-image upload. Nothing touches disk: the buffer is
 * streamed straight to Cloudinary by the caller. Rejects anything that
 * isn't an allowed image type or exceeds the size cap before it ever
 * reaches the controller.
 *
 * Parameterised by field name so every image feature shares one set of
 * limits — a second uploader with its own cap is how a 40MB upload
 * eventually slips through somewhere.
 */
export const singleImageUpload = (field: string, maxBytes = MAX_FILE_SIZE_BYTES) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
        cb(new Error('Formato de imagen no permitido. Usa JPG, PNG o WEBP.'));
        return;
      }
      cb(null, true);
    },
  }).single(field);

/** Flyer de una campaña publicitaria. */
export const uploadImage = singleImageUpload('flyer', config.advertisements.maxBytes);

/** Imagen de un banner promocional de la pantalla inicial. */
export const uploadBannerImage = singleImageUpload('image');

/** Mini-ilustración de una categoría de negocio en el Home. */
export const uploadHomeCategoryImage = singleImageUpload('image');

/** Foto de perfil de un usuario. */
export const uploadAvatarImage = singleImageUpload('avatar');

/**
 * Selfie de verificación de identidad en turno.
 *
 * Mismo campo y mismos límites que el avatar, pero con nombre propio: la
 * foto va a otra carpeta y a otro flujo, y confundirlos sería subir a un
 * perfil público una imagen que se pidió para comprobar quién conduce.
 */
export const uploadVerificationSelfie = singleImageUpload('selfie');

/**
 * Foto de un documento del domiciliario: cédula, licencia, SOAT.
 *
 * Va en su propio nombre y no reutiliza el de la selfie porque acaba en
 * otra carpeta y con otra retención: una selfie de verificación se pide y
 * se descarta, un documento de identidad respalda una habilitación para
 * trabajar y tiene que poder consultarse después.
 */
export const uploadDriverDocumentImage = singleImageUpload('image');

/**
 * Evidencia fotográfica de recogida o entrega.
 *
 * Su tope sale de la configuración y no de la constante de arriba: una
 * foto tomada a contraluz en la puerta de una casa pesa lo que pesa, y la
 * operación tiene que poder subirlo sin recompilar. El servicio vuelve a
 * comprobar el tamaño y además mira los bytes reales del archivo — multer
 * solo sabe lo que el cliente declara.
 */
export const uploadEvidenceImage = singleImageUpload(
  'photo',
  config.orderFlow.evidence.maxBytes
);

/**
 * Foto de un producto del catálogo.
 *
 * Su tope es mayor que el general y sale de la configuración: las fotos
 * de celular moderno pasan de 5 MB con facilidad, y rechazarlas obligaría
 * al comercio a redimensionarlas por su cuenta antes de subirlas — que es
 * exactamente el trabajo que este sistema existe para quitarle. El
 * servicio vuelve a comprobar tamaño, formato real y dimensiones sobre
 * los bytes; multer solo sabe lo que el cliente declara.
 */
export const uploadProductImage = singleImageUpload(
  'image',
  config.productImages.maxBytes
);

/**
 * Logo o portada de un comercio.
 *
 * Comparte el tope general de 5 MB y no el ampliado de catálogo: lo que
 * llega aquí ya viene recortado por el editor del panel, así que un
 * archivo grande solo puede venir de una subida hecha por fuera.
 */
export const uploadBusinessImage = singleImageUpload('image');
