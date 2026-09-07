import { Zone, IZone, Business } from '../models';
import { AppError } from '../middlewares';
import { haversineKm, isValidCoordinate, fromGeoPoint } from '../utils';
import { pricingConfigService } from './pricingConfig.service';

interface ZoneInput {
  name: string;
  city?: string;
  coordinates: number[][][];
  baseFee?: number | null;
  perKm?: number | null;
  surcharge?: number;
  minOrder?: number;
  priority?: number;
  isActive?: boolean;
}

export interface CoverageResult {
  covered: boolean;
  reason?: string;
  zone?: { id: string; name: string; minOrder: number } | null;
  distanceKm?: number;
  maxRadiusKm: number;
}

export class ZoneService {
  async create(input: ZoneInput): Promise<IZone> {
    const { coordinates, ...rest } = input;
    return Zone.create({
      ...rest,
      area: { type: 'Polygon', coordinates },
    });
  }

  async getAll(city?: string, includeInactive = false): Promise<IZone[]> {
    const filter: Record<string, unknown> = {};
    if (city) filter.city = city;
    if (!includeInactive) filter.isActive = true;
    return Zone.find(filter).sort({ priority: -1, name: 1 });
  }

  async getById(id: string): Promise<IZone> {
    const zone = await Zone.findById(id);
    if (!zone) throw new AppError('Zona no encontrada', 404);
    return zone;
  }

  async update(id: string, input: Partial<ZoneInput>): Promise<IZone> {
    const zone = await this.getById(id);
    const { coordinates, ...rest } = input;

    Object.assign(zone, rest);
    if (coordinates) {
      zone.area = { type: 'Polygon', coordinates };
    }

    await zone.save();
    return zone;
  }

  async delete(id: string): Promise<void> {
    const zone = await this.getById(id);
    await zone.deleteOne();
  }

  /**
   * Answers "can we deliver here?" before the customer builds a cart.
   *
   * When a business is given, coverage also accounts for the distance limit
   * from that specific business; otherwise it only checks zone polygons.
   */
  async checkCoverage(
    lat: number,
    lng: number,
    businessId?: string
  ): Promise<CoverageResult> {
    // El radio sale de la configuración de plataforma, no del entorno.
    // Antes esta comprobación leía `config.platform.delivery.maxRadiusKm`
    // mientras el motor de precios usaba `cfg.maxRadiusMeters`, así que
    // cambiar la cobertura desde el panel dejaba al mapa diciendo "sí
    // llegamos" y al checkout respondiendo "fuera de cobertura". Una sola
    // pregunta debe tener una sola respuesta.
    const cfg = await pricingConfigService.getCurrent();
    const maxRadiusKm = cfg.maxRadiusMeters / 1000;

    if (!isValidCoordinate(lat, lng)) {
      return { covered: false, reason: 'Coordenadas inválidas', maxRadiusKm };
    }

    const zone = await Zone.findOne({
      isActive: true,
      area: {
        $geoIntersects: {
          $geometry: { type: 'Point', coordinates: [lng, lat] },
        },
      },
    }).sort({ priority: -1 });

    const zoneInfo = zone
      ? { id: zone._id.toString(), name: zone.name, minOrder: zone.minOrder }
      : null;

    if (businessId) {
      const business = await Business.findById(businessId);
      if (!business) {
        return { covered: false, reason: 'Negocio no encontrado', maxRadiusKm };
      }

      const origin = fromGeoPoint(business.location);
      if (!origin) {
        return {
          covered: false,
          reason: 'El negocio no tiene una ubicación válida',
          maxRadiusKm,
        };
      }

      const distanceKm = Number(haversineKm(origin, { lat, lng }).toFixed(2));

      if (distanceKm > maxRadiusKm) {
        return {
          covered: false,
          reason: `La dirección está a ${distanceKm} km, fuera de nuestra cobertura de ${maxRadiusKm} km`,
          zone: zoneInfo,
          distanceKm,
          maxRadiusKm,
        };
      }

      return { covered: true, zone: zoneInfo, distanceKm, maxRadiusKm };
    }

    // No business context: a configured zone is authoritative. If no zones
    // exist at all, the platform is not zone-restricted, so allow it.
    const anyZone = await Zone.countDocuments({ isActive: true });
    if (anyZone === 0) {
      return { covered: true, zone: null, maxRadiusKm };
    }

    return zone
      ? { covered: true, zone: zoneInfo, maxRadiusKm }
      : {
          covered: false,
          reason: 'Aún no tenemos cobertura en esta dirección',
          zone: null,
          maxRadiusKm,
        };
  }
}

export const zoneService = new ZoneService();
