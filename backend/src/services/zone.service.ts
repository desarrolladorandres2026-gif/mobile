import type { Request } from 'express';
import crypto from 'crypto';
import { Zone, IZone, IZoneVersion, Business, Order, User, ZONE_TARIFF_FIELDS, ZoneTariffField, MAX_ZONE_VERSIONS } from '../models';
import { AppError } from '../middlewares';
import { haversineKm, isValidCoordinate, fromGeoPoint } from '../utils';
import { logAudit, AuditAction, AuditSeverity } from '../security';
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

/** Quién y por qué: lo que exige cambiar la tarifa de una zona (D9). */
export interface ZoneChangeContext {
  actorId: string;
  reason?: string;
  req?: Request;
}

export interface CoverageResult {
  covered: boolean;
  reason?: string;
  zone?: { id: string; name: string; minOrder: number } | null;
  distanceKm?: number;
  maxRadiusKm: number;
}

interface TariffSnapshot {
  baseFee: number | null;
  perKm: number | null;
  surcharge: number;
  minOrder: number;
}

/** Huella del polígono: comparar dos áreas sin guardar ni comparar cada coordenada. */
const hashArea = (coordinates: number[][][]): string =>
  crypto.createHash('sha256').update(JSON.stringify(coordinates)).digest('hex');

/** Todo lo que define qué zona aplica a una dirección y cuánto se cobra en ella. */
interface EffectiveSnapshot extends TariffSnapshot {
  priority: number;
  isActive: boolean;
  areaHash: string;
}

const effectiveOf = (zone: IZone): EffectiveSnapshot => ({
  ...tariffOf(zone),
  priority: zone.priority ?? 0,
  isActive: zone.isActive ?? true,
  areaHash: hashArea(zone.area?.coordinates ?? []),
});

const tariffOf = (zone: Partial<TariffSnapshot>): TariffSnapshot => ({
  baseFee: zone.baseFee ?? null,
  perKm: zone.perKm ?? null,
  surcharge: zone.surcharge ?? 0,
  minOrder: zone.minOrder ?? 0,
});

export class ZoneService {
  /**
   * Crea una zona. Nace en la versión 1 con su tarifa inicial registrada en
   * `versions[]`, para que el historial esté completo desde el primer día y
   * no solo desde el primer cambio.
   */
  async create(input: ZoneInput, ctx?: ZoneChangeContext): Promise<IZone> {
    const { coordinates, ...rest } = input;
    const now = new Date();
    const tariff = tariffOf(rest);

    const zone = await Zone.create({
      ...rest,
      area: { type: 'Polygon', coordinates },
      version: 1,
      versions: [
        {
          version: 1,
          ...tariff,
          priority: rest.priority ?? 0,
          isActive: rest.isActive ?? true,
          areaHash: hashArea(coordinates),
          area: coordinates,
          changeReason: ctx?.reason?.trim() || 'Zona creada',
          changedBy: ctx?.actorId ?? null,
          changedAt: now,
        },
      ],
    });

    if (ctx?.req) {
      await logAudit(ctx.req, {
        action: AuditAction.ZONE_CREATED,
        entity: 'zone',
        entityId: zone._id.toString(),
        severity: AuditSeverity.MEDIUM,
        description: `Zona "${zone.name}" creada`,
        metadata: { city: zone.city, ...tariff, version: 1, isActive: zone.isActive },
      });
    }

    // El historial no viaja en la respuesta de creación: es interno.
    zone.set('versions', undefined);
    return zone;
  }

  async getAll(city?: string, includeInactive = false): Promise<IZone[]> {
    const filter: Record<string, unknown> = {};
    if (city) filter.city = city;
    if (!includeInactive) filter.isActive = true;
    return Zone.find(filter).sort({ priority: -1, name: 1 });
  }

  /**
   * La lista pública de zonas: solo lo que sirve para pintar la cobertura.
   *
   * Nunca `baseFee`/`perKm`/`surcharge` (son el pago al repartidor, ver
   * `pricing.service.ts`), ni `priority`, ni `isActive`, ni el historial, ni
   * zonas inactivas (las que están en preparación no se anuncian).
   */
  async getPublic(city?: string) {
    const filter: Record<string, unknown> = { isActive: true };
    if (city) filter.city = city;
    return Zone.find(filter).select('name city area minOrder').sort({ priority: -1, name: 1 });
  }

  async getPublicById(id: string) {
    const zone = await Zone.findOne({ _id: id, isActive: true }).select('name city area minOrder');
    if (!zone) throw new AppError('Zona no encontrada', 404);
    return zone;
  }

  async getById(id: string): Promise<IZone> {
    const zone = await Zone.findById(id);
    if (!zone) throw new AppError('Zona no encontrada', 404);
    return zone;
  }

  /**
   * Edita una zona.
   *
   * Si el cambio toca la tarifa (`baseFee`, `perKm`, `surcharge`, `minOrder`)
   * **y** algún valor realmente cambia, se exige un motivo (5-300) y se crea
   * una versión nueva: se guarda quién, cuándo, por qué y los valores, y la
   * versión vigente sube en 1. Es un solo `findOneAndUpdate` condicionado a
   * la versión que se leyó — dos admins editando a la vez no se pisan: el
   * segundo recibe 409 en vez de sobrescribir a ciegas.
   *
   * Reenviar los mismos valores (el panel manda el formulario entero) no es un
   * cambio de tarifa y no pide motivo. Cualquier edición se audita.
   */
  async update(id: string, input: Partial<ZoneInput>, ctx: ZoneChangeContext): Promise<IZone> {
    const { coordinates, ...rest } = input;

    const zone = await Zone.findById(id).select('+versions');
    if (!zone) throw new AppError('Zona no encontrada', 404);

    const currentVersion = zone.version ?? 1;
    const current = effectiveOf(zone);

    // Todo lo que cambia la zona **efectiva** —qué se cobra (tarifa) y a qué
    // direcciones se le aplica (polígono, prioridad, activa)— entra aquí.
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const field of ZONE_TARIFF_FIELDS) {
      if (rest[field] === undefined) continue;
      const to = (rest[field] as number | null) ?? (field === 'surcharge' || field === 'minOrder' ? 0 : null);
      if (to !== current[field]) changes[field] = { from: current[field], to };
    }
    if (rest.priority !== undefined && rest.priority !== current.priority) {
      changes.priority = { from: current.priority, to: rest.priority };
    }
    if (rest.isActive !== undefined && rest.isActive !== current.isActive) {
      changes.isActive = { from: current.isActive, to: rest.isActive };
    }
    const nextAreaHash = coordinates ? hashArea(coordinates) : null;
    if (nextAreaHash && nextAreaHash !== current.areaHash) {
      changes.area = { from: current.areaHash, to: nextAreaHash };
    }
    const tariffChanged = (ZONE_TARIFF_FIELDS as readonly string[]).some((f) => f in changes);
    const versioned = Object.keys(changes).length > 0;

    const reason = ctx.reason?.trim();
    if (versioned && (!reason || reason.length < 5)) {
      throw new AppError(
        'Cambiar la tarifa, el polígono, la prioridad o si la zona está activa exige un motivo (al menos 5 caracteres)',
        400,
        'ZONE_REASON_REQUIRED'
      );
    }

    // Lo que no afecta a la zona efectiva (nombre, ciudad) se aplica siempre.
    const $set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) continue;
      if ((ZONE_TARIFF_FIELDS as readonly string[]).includes(key)) continue;
      $set[key] = value;
    }
    if (coordinates) $set.area = { type: 'Polygon', coordinates };

    const filter: Record<string, unknown> = { _id: id };
    const update: Record<string, unknown> = {};
    let nextVersion = currentVersion;

    if (versioned) {
      const now = new Date();
      nextVersion = currentVersion + 1;
      // Condición de versión dentro del filtro: si otro admin cambió la zona
      // entre la lectura y esta escritura, no se escribe nada.
      filter.$or = [{ version: currentVersion }, ...(currentVersion === 1 ? [{ version: { $exists: false } }] : [])];

      const entries: IZoneVersion[] = [];
      // Una zona anterior al versionado (o creada sin pasar por `create`) no
      // trae su versión vigente registrada: se guarda antes del cambio, para
      // que el historial no arranque en el primer cambio.
      if (!(zone.versions ?? []).some((v) => v.version === currentVersion)) {
        entries.push({
          version: currentVersion,
          baseFee: current.baseFee,
          perKm: current.perKm,
          surcharge: current.surcharge,
          minOrder: current.minOrder,
          priority: current.priority,
          isActive: current.isActive,
          areaHash: current.areaHash,
          area: zone.area?.coordinates,
          changeReason: 'Configuración vigente antes del versionado',
          changedBy: null,
          changedAt: zone.updatedAt ?? now,
        });
      }

      const next = { ...current } as Record<string, unknown>;
      for (const [field, change] of Object.entries(changes)) {
        if (field === 'area') {
          next.areaHash = change.to;
          continue;
        }
        next[field] = change.to;
        $set[field] = change.to;
      }
      entries.push({
        version: nextVersion,
        baseFee: next.baseFee as number | null,
        perKm: next.perKm as number | null,
        surcharge: next.surcharge as number,
        minOrder: next.minOrder as number,
        priority: next.priority as number,
        isActive: next.isActive as boolean,
        areaHash: next.areaHash as string,
        // El polígono viaja en la versión solo cuando cambió: el hash basta
        // para saber si es el mismo, y el polígono para poder reconstruirlo.
        ...(changes.area && coordinates ? { area: coordinates } : {}),
        changeReason: reason!,
        changedBy: ctx.actorId as unknown as IZoneVersion['changedBy'],
        changedAt: now,
      });

      $set.version = nextVersion;
      update.$push = { versions: { $each: entries, $slice: -MAX_ZONE_VERSIONS } };
    }

    if (Object.keys($set).length === 0) return this.getById(id);
    update.$set = $set;

    const updated = await Zone.findOneAndUpdate(filter, update, { new: true, runValidators: true });
    if (!updated) {
      throw new AppError(
        'La zona cambió mientras la editabas. Recárgala y vuelve a intentarlo.',
        409,
        'ZONE_CHANGED'
      );
    }

    if (ctx.req) {
      const describe = (field: string) => `${field}: ${changes[field]?.from} → ${changes[field]?.to}`;
      await logAudit(ctx.req, {
        action: tariffChanged ? AuditAction.ZONE_TARIFF_CHANGED : AuditAction.ZONE_UPDATED,
        entity: 'zone',
        entityId: id,
        severity: versioned ? AuditSeverity.HIGH : AuditSeverity.MEDIUM,
        description: versioned
          ? `Zona "${updated.name}" cambiada (v${currentVersion} → v${nextVersion}): ${Object.keys(changes).map(describe).join(', ')}`
          : `Zona "${updated.name}" editada`,
        metadata: {
          fromVersion: currentVersion,
          toVersion: nextVersion,
          changes: versioned ? changes : undefined,
          reason: reason || undefined,
          otherFields: Object.keys($set).filter((k) => k !== 'version' && !(k in changes)),
        },
      });
    }

    // El historial es interno: no viaja en la respuesta.
    updated.set('versions', undefined);
    return updated;
  }

  /** El historial de tarifas, la versión más reciente primero, con el nombre de quien cambió. */
  async listVersions(id: string): Promise<{
    zone: { _id: string; name: string; version: number };
    versions: Array<Omit<IZoneVersion, 'changedBy' | 'area'> & { areaChanged: boolean; changedBy: string | null; changedByName: string | null }>;
  }> {
    const zone = await Zone.findById(id).select('name version +versions').lean();
    if (!zone) throw new AppError('Zona no encontrada', 404);

    // Sin `populate`: sobre `+versions` colisiona con la proyección del
    // subcampo (`versions.changedBy`).
    const authorIds = [...new Set((zone.versions ?? []).map((v) => v.changedBy).filter(Boolean).map(String))];
    const authors = authorIds.length ? await User.find({ _id: { $in: authorIds } }).select('name').lean() : [];
    const names = new Map(authors.map((u) => [String(u._id), u.name]));

    const versions = [...(zone.versions ?? [])]
      .sort((a, b) => b.version - a.version)
      .map(({ area, ...v }) => ({
        ...v,
        // El polígono no viaja (puede ser grande): solo si esa versión lo cambió.
        areaChanged: !!area,
        changedBy: v.changedBy ? String(v.changedBy) : null,
        changedByName: v.changedBy ? names.get(String(v.changedBy)) ?? null : null,
      }));

    return { zone: { _id: String(zone._id), name: zone.name, version: zone.version ?? 1 }, versions };
  }

  /**
   * Borra una zona **solo si ningún pedido la usó**. Un pedido guarda
   * `zoneId` + `zoneVersion` para poder explicarse después; sin la zona (y su
   * historial de versiones) esa explicación se pierde. Una zona con pedidos se
   * desactiva, no se borra.
   */
  async delete(id: string, ctx?: Partial<ZoneChangeContext>): Promise<void> {
    const zone = await this.getById(id);

    if (await Order.exists({ zoneId: zone._id })) {
      throw new AppError(
        'Esta zona ya tiene pedidos y no se puede borrar: desactívala para dejar de usarla.',
        409,
        'ZONE_HAS_ORDERS'
      );
    }

    await zone.deleteOne();

    if (ctx?.req) {
      await logAudit(ctx.req, {
        action: AuditAction.ZONE_DELETED,
        entity: 'zone',
        entityId: id,
        severity: AuditSeverity.HIGH,
        description: `Zona "${zone.name}" eliminada`,
        metadata: { city: zone.city, ...tariffOf(zone), version: zone.version ?? 1, reason: ctx.reason || undefined },
      });
    }
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
