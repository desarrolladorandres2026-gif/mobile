import { Router } from 'express';
import { sendResponse } from '../utils';

const router = Router();

/**
 * Versión mínima de la app que se sigue aceptando.
 *
 * Sin esto, una versión vieja con un fallo en el flujo de dinero sigue viva
 * en los teléfonos indefinidamente: no hay forma de sacarla del aire, ni
 * siquiera sabiendo que está mal. Las actualizaciones por aire arreglan el
 * JavaScript, pero no sirven cuando el problema exige una build nueva.
 *
 * Va por variable de entorno y no en base de datos a propósito: es una
 * palanca de emergencia, y una palanca de emergencia tiene que poder moverse
 * sin depender de que la base responda.
 */
const MIN_SUPPORTED = process.env.MIN_APP_VERSION || '1.0.0';

/**
 * Público y sin autenticación.
 *
 * Una app demasiado vieja puede tener rota justamente la sesión, y exigirle
 * iniciar sesión para enterarse de que tiene que actualizarse la dejaría
 * atrapada: no puede entrar, y no sabe por qué.
 */
router.get('/version', (_req, res) => {
  sendResponse(res, 200, 'Versión mínima soportada', {
    minSupported: MIN_SUPPORTED,
    /** Dónde mandar a quien tiene que actualizar. */
    androidUrl: process.env.ANDROID_STORE_URL || null,
    iosUrl: process.env.IOS_STORE_URL || null,
  });
});

export default router;
