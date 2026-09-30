import type { Types } from 'mongoose';
import { DriverShift } from '../models/DriverShift';

const DAY_MS = 86_400_000;
/** Un turno abierto sin señal de vida más allá de esto se da por caído (app cerrada sin desconectar). */
const STALE_OPEN_SHIFT_MS = 10 * 60_000;

export const driverShiftService = {
  /** Abre el turno. Un turno ya abierto no se duplica (el índice parcial lo impide). */
  async open(driverId: Types.ObjectId, now = new Date()): Promise<void> {
    try {
      await DriverShift.updateOne(
        { driverId, open: true },
        { $setOnInsert: { driverId, startedAt: now, open: true } },
        { upsert: true }
      );
    } catch (error) {
      // Registrar el turno nunca debe impedir conectarse.
      console.error('[driver-shift] open', error);
    }
  },

  async close(driverId: Types.ObjectId, now = new Date()): Promise<void> {
    try {
      await DriverShift.updateOne({ driverId, open: true }, { $set: { endedAt: now, open: false } });
    } catch (error) {
      console.error('[driver-shift] close', error);
    }
  },

  /**
   * Segundos conectado en los últimos `days`, o `null` si aún no hay ningún
   * turno registrado (0 s sería afirmar que no trabajó, y lo que falta es el dato).
   * Un turno abierto cuenta hasta la última señal del dispositivo.
   */
  async connectedSeconds(
    driverId: Types.ObjectId,
    days: number,
    lastSignalAt?: Date,
    now = new Date()
  ): Promise<number | null> {
    const since = new Date(now.getTime() - days * DAY_MS);
    if (!(await DriverShift.exists({ driverId }))) return null;

    const shifts = await DriverShift.find({
      driverId,
      $or: [{ endedAt: { $gte: since } }, { open: true }],
    })
      .select('startedAt endedAt')
      .lean();

    let ms = 0;
    for (const s of shifts) {
      const start = Math.max(s.startedAt.getTime(), since.getTime());
      let end: number;
      if (s.endedAt) end = s.endedAt.getTime();
      else {
        const signal = lastSignalAt?.getTime() ?? s.startedAt.getTime();
        end = now.getTime() - signal > STALE_OPEN_SHIFT_MS ? signal : now.getTime();
      }
      if (end > start) ms += end - start;
    }
    return Math.round(ms / 1000);
  },
};
