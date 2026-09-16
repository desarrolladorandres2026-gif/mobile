import { Request, Response, NextFunction } from 'express';
import {
  getOrderTracking,
  getDriverRoute,
  getActiveFleet,
  findNearestDrivers,
  suggestDriverForOrder,
  getMapConfig,
  ingestPing,
} from '../services/tracking.service';
import { sendResponse, param, query, clampLimit } from '../utils';
import { emitDriverLocation } from '../sockets/emitter';

export class TrackingController {
  /**
   * Configuración de mapas para un cliente autenticado.
   *
   * Es el único sitio por el que el token de Mapbox sale del servidor, y
   * exige sesión: sin autenticar, cualquiera podría raspar el token de la
   * plataforma y gastar la cuota de ZIPP en su propio proyecto.
   */
  async config(req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Configuración de mapas', getMapConfig(req.user!.role));
    } catch (error) { next(error); }
  }

  /**
   * Posición y ruta del repartidor de un pedido.
   *
   * Lo consume la pantalla de seguimiento al abrirse; a partir de ahí las
   * novedades llegan por socket. Sin este primer disparo, el mapa
   * arrancaría vacío hasta que el repartidor moviera el teléfono, que
   * puede ser medio minuto de pantalla en blanco.
   */
  async order(req: Request, res: Response, next: NextFunction) {
    try {
      const tracking = await getOrderTracking(param(req, 'orderId'), req.user!, {
        includeTrail: query(req, 'trail') === 'true',
      });
      sendResponse(res, 200, 'Seguimiento del pedido', tracking);
    } catch (error) { next(error); }
  }

  /** Ruta óptima para el repartidor en la etapa en curso. */
  async route(req: Request, res: Response, next: NextFunction) {
    try {
      const { lat, lng } = req.body ?? {};
      const current =
        typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : undefined;

      const route = await getDriverRoute(param(req, 'orderId'), req.user!, current);
      sendResponse(res, 200, 'Ruta calculada', route);
    } catch (error) { next(error); }
  }

  /**
   * Respaldo REST para enviar una posición.
   *
   * El canal normal es el socket. Esto existe para cuando el WebSocket no
   * está disponible —redes corporativas que bloquean upgrades, un túnel
   * caído— y para que la tarea en segundo plano de Android pueda reportar
   * sin mantener un socket vivo mientras la app está dormida, que es
   * justo lo que el sistema operativo intenta impedir.
   */
  async ping(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await ingestPing(req.user!._id.toString(), req.body);
      if (result.accepted) emitDriverLocation(req.user!._id.toString(), result, req.body);
      sendResponse(res, 200, 'Ubicación recibida', result);
    } catch (error) { next(error); }
  }

  /** Mapa de flota del panel admin. */
  async fleet(_req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Flota activa', await getActiveFleet());
    } catch (error) { next(error); }
  }

  /**
   * Ranking de repartidores por tiempo de llegada a un punto.
   *
   * Hoy es una consulta del panel: deja comparar a quién asignó el
   * despachador contra a quién habría asignado el sistema. Cuando esa
   * comparación convenza, es la misma función que hará la asignación
   * automática.
   */
  async nearest(req: Request, res: Response, next: NextFunction) {
    try {
      const orderId = query(req, 'orderId');
      if (orderId) {
        return sendResponse(res, 200, 'Repartidores sugeridos', await suggestDriverForOrder(orderId));
      }

      const lat = Number(query(req, 'lat'));
      const lng = Number(query(req, 'lng'));
      const drivers = await findNearestDrivers(
        { lat, lng },
        { limit: clampLimit(query(req, 'limit'), 100, 5) }
      );
      sendResponse(res, 200, 'Repartidores cercanos', drivers);
    } catch (error) { next(error); }
  }
}

export const trackingController = new TrackingController();
