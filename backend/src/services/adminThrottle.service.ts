import { AdminThrottle } from '../models/AdminThrottle';

/**
 * Cuenta un intento dentro de una ventana fija y devuelve cuántos van (el
 * actual incluido). Atómico: `findOneAndUpdate` con upsert. Si dos peticiones
 * crean la ventana a la vez, una recibe E11000 y reintenta una vez sobre el
 * documento ya creado.
 */
export async function hit(scope: string, windowMs: number, now = Date.now()): Promise<number> {
  const bucket = Math.floor(now / windowMs);
  const key = `${scope}:${bucket}`;
  const expiresAt = new Date((bucket + 1) * windowMs + 60_000);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const doc = await AdminThrottle.findOneAndUpdate(
        { key },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
        { upsert: true, new: true }
      ).lean();
      return doc!.count;
    } catch (e) {
      if ((e as { code?: number }).code !== 11000 || attempt === 1) throw e;
    }
  }
  return Number.MAX_SAFE_INTEGER;
}

export const adminThrottleService = { hit };
