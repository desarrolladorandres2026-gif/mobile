import mongoose, { Schema, Document, Types } from 'mongoose';
import { cacheInvalidationPlugin, CachePrefix } from '../cache';

/**
 * Los campos de una zona que cambian lo que se cobra o se paga por un
 * domicilio (o el pedido mínimo). Tocar cualquiera crea una versión nueva,
 * con motivo y autor — ver `zone.service.ts#update` y D9 del plan del panel.
 *
 * También versionan (con la misma regla) el polígono (`area`), la `priority`
 * y `isActive`: no son tarifa, pero cambiar cualquiera altera qué zona aplica
 * a una dirección y por tanto cuánto se cobra y se paga por ese domicilio.
 */
export const ZONE_TARIFF_FIELDS = ['baseFee', 'perKm', 'surcharge', 'minOrder'] as const;
export type ZoneTariffField = (typeof ZONE_TARIFF_FIELDS)[number];

/**
 * Una versión de la tarifa de una zona.
 *
 * Vive **dentro** del documento (`versions[]`) y no en una colección aparte
 * como `PlatformPricingConfig`: esa es una fila global de la que cuelgan todos
 * los pedidos, y aquí hay una versión por zona; el pedido ya guarda `zoneId`,
 * así que `(zoneId, zoneVersion)` lo explica sin un modelo más. El arreglo se
 * acota y se descarta de toda lectura pública (`select: false`).
 */
export interface IZoneVersion {
  version: number;
  baseFee: number | null;
  perKm: number | null;
  surcharge: number;
  minOrder: number;
  /**
   * El resto de lo que define la zona efectiva. Opcionales: las versiones
   * anteriores al versionado de área/prioridad/activa (migración 018 no las
   * reescribe) no los traen.
   */
  priority?: number;
  isActive?: boolean;
  /** SHA-256 del polígono vigente en esa versión. */
  areaHash?: string;
  /** El polígono, solo en la versión donde se creó o se cambió. */
  area?: number[][][];
  /** Por qué cambió. Obligatorio salvo en la versión 1. */
  changeReason: string;
  changedBy: Types.ObjectId | null;
  changedAt: Date;
}

/** Cuántas versiones de tarifa se conservan por zona (las más recientes). */
export const MAX_ZONE_VERSIONS = 200;

/**
 * A delivery coverage zone.
 *
 * Coverage is a real GeoJSON polygon queried with $geoIntersects, so
 * "is this address inside our coverage?" is answered by the database
 * rather than by a radius approximation. Each zone can override the
 * platform's delivery pricing.
 */
export interface IZone extends Document {
  name: string;
  city: string;
  /** GeoJSON Polygon. First and last coordinate must match. */
  area: {
    type: 'Polygon';
    coordinates: number[][][];
  };
  /** Overrides config.platform.delivery.baseFee when set (>= 0). */
  baseFee?: number | null;
  /** Overrides config.platform.delivery.perKm when set (>= 0). */
  perKm?: number | null;
  /** Extra charge for this zone, e.g. hard-to-reach areas. */
  surcharge: number;
  minOrder: number;
  /** Higher priority wins when polygons overlap. */
  priority: number;
  isActive: boolean;
  /**
   * Versión vigente de la tarifa (`baseFee`, `perKm`, `surcharge`,
   * `minOrder`). Sube en 1 con cada cambio de tarifa; cada pedido guarda la
   * que usó (`Order.zoneVersion`), así un pedido viejo se explica con las
   * reglas de su día.
   */
  version: number;
  /** Historial de tarifas, la más antigua primero. `select: false`. */
  versions?: IZoneVersion[];
  createdAt: Date;
  updatedAt: Date;
}

const integerMoney = {
  validator: (value: number | null | undefined) => value === null || value === undefined || Number.isInteger(value),
  message: 'Debe ser un entero en COP',
};

const zoneVersionSchema = new Schema<IZoneVersion>(
  {
    version: { type: Number, required: true, min: 1 },
    baseFee: { type: Number, default: null },
    perKm: { type: Number, default: null },
    surcharge: { type: Number, default: 0 },
    minOrder: { type: Number, default: 0 },
    priority: { type: Number, default: undefined },
    isActive: { type: Boolean, default: undefined },
    areaHash: { type: String, default: undefined },
    area: { type: [[[Number]]], default: undefined },
    changeReason: { type: String, required: true, trim: true, maxlength: 300 },
    changedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    changedAt: { type: Date, required: true },
  },
  { _id: false }
);

const zoneSchema = new Schema<IZone>(
  {
    name: {
      type: String,
      required: [true, 'El nombre de la zona es requerido'],
      trim: true,
      maxlength: [80, 'El nombre no puede exceder 80 caracteres'],
    },
    city: { type: String, default: 'Garzón', trim: true },
    area: {
      type: {
        type: String,
        enum: ['Polygon'],
        default: 'Polygon',
        required: true,
      },
      coordinates: {
        type: [[[Number]]],
        required: [true, 'El área de la zona es requerida'],
        validate: {
          validator(v: number[][][]) {
            if (!Array.isArray(v) || v.length === 0) return false;
            const ring = v[0];
            if (!Array.isArray(ring) || ring.length < 4) return false;
            const [first] = ring;
            const last = ring[ring.length - 1];
            return first[0] === last[0] && first[1] === last[1];
          },
          message:
            'El polígono debe tener al menos 4 puntos y cerrarse (el primero igual al último)',
        },
      },
    },
    baseFee: { type: Number, default: null, min: 0, validate: integerMoney },
    perKm: { type: Number, default: null, min: 0, validate: integerMoney },
    surcharge: { type: Number, default: 0, min: 0, validate: integerMoney },
    minOrder: { type: Number, default: 0, min: 0, validate: integerMoney },
    priority: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    version: { type: Number, default: 1, min: 1 },
    versions: { type: [zoneVersionSchema], default: undefined, select: false },
  },
  { timestamps: true }
);

zoneSchema.index({ area: '2dsphere' });
zoneSchema.index({ city: 1, isActive: 1 });

// Cada escritura limpia lo que la caché de lecturas tenga de este modelo.
zoneSchema.plugin(cacheInvalidationPlugin, {
  // El "Desde $X" de cada ficha sale de las zonas.
  prefixesFor: () => [CachePrefix.ZONES, CachePrefix.BUSINESS_ALL, CachePrefix.BUSINESS_SLUG, CachePrefix.HOME, CachePrefix.EXPLORE],
});

export const Zone = mongoose.model<IZone>('Zone', zoneSchema);
