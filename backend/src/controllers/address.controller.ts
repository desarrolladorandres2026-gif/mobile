import { Request, Response, NextFunction } from 'express';
import { addressService, reverseGeocode } from '../services';
import { sendResponse, param, query } from '../utils';

export class AddressController {
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const addresses = await addressService.getAll(req.user!._id.toString());
      sendResponse(res, 200, 'Direcciones obtenidas', addresses);
    } catch (error) { next(error); }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const address = await addressService.create(req.user!._id.toString(), req.body);
      sendResponse(res, 201, 'Dirección creada exitosamente', address);
    } catch (error) { next(error); }
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      await addressService.delete(req.user!._id.toString(), param(req, 'id'));
      sendResponse(res, 200, 'Dirección eliminada');
    } catch (error) { next(error); }
  }

  /**
   * Qué dirección hay en un punto del mapa.
   *
   * Deja que marcar el punto baste: quien ya señaló su casa en el mapa no
   * debería tener que escribir después la misma dirección con palabras.
   *
   * Responde 200 con `null` cuando no hay nada cartografiado ahí, en vez
   * de 404. No es un error —el punto es perfectamente válido y con él ya
   * se puede cobrar el envío y llegar— así que tratarlo como fallo haría
   * que la app pintara una alarma donde solo falta un nombre de calle.
   */
  async reverseGeocode(req: Request, res: Response, next: NextFunction) {
    try {
      const place = await reverseGeocode({
        lat: Number(query(req, 'lat')),
        lng: Number(query(req, 'lng')),
      });
      sendResponse(res, 200, place ? 'Dirección encontrada' : 'Sin dirección para ese punto', place);
    } catch (error) { next(error); }
  }

  async setDefault(req: Request, res: Response, next: NextFunction) {
    try {
      const address = await addressService.setDefault(req.user!._id.toString(), param(req, 'id'));
      sendResponse(res, 200, 'Dirección establecida como predeterminada', address);
    } catch (error) { next(error); }
  }
}

export const addressController = new AddressController();
