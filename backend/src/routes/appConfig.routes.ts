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
 *
 * Hay una palanca por app. Zipp (clientes) y Zipp Domiciliarios son dos
 * binarios distintos, con sus propias fichas de tienda y sus propios
 * ciclos de publicación: forzar la actualización de una no puede dejar sin
 * trabajar a los domiciliarios de la otra.
 *
 * `business-desktop` es Zipp Negocios (desktop/): no tiene tienda de
 * aplicaciones, así que en vez de `androidUrl`/`iosUrl` lleva `downloadUrl`
 * — el alias estable que publica `desktop/scripts/release.mjs`. El
 * contenedor normalmente ya se actualiza solo (`main/updater.ts`); esta
 * palanca es para el caso en que esa actualización automática esté rota y
 * una versión vieja con un fallo siga corriendo en el mostrador de un
 * comercio sin que nadie lo note.
 */
const APPS = {
  client: {
    minSupported: process.env.MIN_APP_VERSION || '1.0.0',
    androidUrl: process.env.ANDROID_STORE_URL || null,
    iosUrl: process.env.IOS_STORE_URL || null,
  },
  driver: {
    minSupported: process.env.DRIVER_MIN_APP_VERSION || '1.0.0',
    androidUrl: process.env.DRIVER_ANDROID_STORE_URL || null,
    iosUrl: process.env.DRIVER_IOS_STORE_URL || null,
  },
  'business-desktop': {
    minSupported: process.env.MIN_BUSINESS_DESKTOP_VERSION || '0.0.0',
    downloadUrl: process.env.BUSINESS_DESKTOP_DOWNLOAD_URL || null,
  },
} as const;

type AppKey = keyof typeof APPS;

/**
 * Público y sin autenticación.
 *
 * Una app demasiado vieja puede tener rota justamente la sesión, y exigirle
 * iniciar sesión para enterarse de que tiene que actualizarse la dejaría
 * atrapada: no puede entrar, y no sabe por qué.
 *
 * Sin `?app=` responde lo del cliente: es lo que piden las builds anteriores
 * a la separación en dos apps, y todas ellas son de clientes.
 */
router.get('/version', (req, res) => {
  const app: AppKey =
    req.query.app === 'driver' ? 'driver' : req.query.app === 'business-desktop' ? 'business-desktop' : 'client';

  sendResponse(res, 200, 'Versión mínima soportada', {
    app,
    ...APPS[app],
  });
});

export default router;
