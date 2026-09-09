import { Request, Response, NextFunction } from 'express';
import { addressService, reverseGeocode, searchPlaces } from '../services';
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

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const address = await addressService.update(
        req.user!._id.toString(),
        param(req, 'id'),
        req.body
      );
      sendResponse(res, 200, 'Dirección actualizada', address);
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

  /**
   * Direcciones que coinciden con lo que se está escribiendo.
   *
   * El punto del mapa, si la app lo manda, no filtra: sesga. Mapbox ordena
   * los resultados por cercanía a él, que es lo que hace que "calle 5"
   * devuelva primero la del barrio de quien busca y no la de otra ciudad
   * con el mismo nombre.
   *
   * Devuelve una lista vacía —nunca un error— cuando no hay coincidencias
   * o Mapbox no responde. Buscar es un atajo para llenar el formulario, no
   * un requisito: quien no encuentre su calle todavía tiene el mapa.
   */
  async search(req: Request, res: Response, next: NextFunction) {
    try {
      const lat = req.query.lat === undefined ? undefined : Number(req.query.lat);
      const lng = req.query.lng === undefined ? undefined : Number(req.query.lng);
      const proximity = lat !== undefined && lng !== undefined ? { lat, lng } : undefined;

      // El esquema ya exige `q`; el `?? ''` es para el compilador, y
      // `searchPlaces` devuelve [] ante un texto vacío de todas formas.
      const places = await searchPlaces(query(req, 'q') ?? '', proximity);
      sendResponse(res, 200, places.length ? 'Direcciones encontradas' : 'Sin resultados', places);
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
