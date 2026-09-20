import mongoose, { Schema, Document } from 'mongoose';
import { cacheInvalidationPlugin, CachePrefix } from '../cache';

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
  createdAt: Date;
  updatedAt: Date;
}

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
    baseFee: { type: Number, default: null, min: 0 },
    perKm: { type: Number, default: null, min: 0 },
    surcharge: { type: Number, default: 0, min: 0 },
    minOrder: { type: Number, default: 0, min: 0 },
    priority: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
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
