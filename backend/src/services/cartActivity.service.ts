import { CartActivity } from '../models';
import { notificationService } from './notification.service';

/** Cuánto tiempo sin tocar la bolsa antes de considerarla abandonada. */
const ABANDON_AFTER_MS = 45 * 60_000;

export class CartActivityService {
  /**
   * El teléfono manda esto cada vez que la bolsa cambia (con rebote, no en
   * cada tecla). Un upsert: no importa si es la primera vez o la enésima.
   */
  async sync(userId: string, businessId: string, businessName: string, itemCount: number, subtotal: number) {
    await CartActivity.findOneAndUpdate(
      { userId },
      { userId, businessId, businessName, itemCount, subtotal, remindedAt: null },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }

  /** Bolsa vacía o pedido confirmado: ya no hay nada que recordar. */
  async clear(userId: string): Promise<void> {
    await CartActivity.deleteOne({ userId });
  }

  /**
   * Busca bolsas quietas hace rato y sin recordatorio todavía, avisa, y
   * marca `remindedAt` para no repetirlo. Un lote pequeño por vuelta: es un
   * barrido periódico, no un trabajo por lotes.
   */
  async sweepAbandoned(limit = 50): Promise<number> {
    const cutoff = new Date(Date.now() - ABANDON_AFTER_MS);
    const stale = await CartActivity.find({
      remindedAt: null,
      updatedAt: { $lte: cutoff },
    }).limit(limit);

    let notified = 0;
    for (const cart of stale) {
      try {
        await notificationService.notifyAbandonedCart(
          cart.userId.toString(),
          cart.businessName,
          cart.itemCount
        );
        cart.remindedAt = new Date();
        await cart.save();
        notified++;
      } catch (err) {
        console.error('[CartActivity] Falló el recordatorio:', err);
      }
    }
    return notified;
  }
}

export const cartActivityService = new CartActivityService();

let sweepTimer: NodeJS.Timeout | null = null;

/** Arranca el barrido periódico de bolsas abandonadas. Idempotente. */
export function startCartAbandonmentSweeper(intervalMs = 5 * 60_000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    cartActivityService
      .sweepAbandoned()
      .catch((err) => console.error('[CartActivity] Falló el barrido:', err));
  }, intervalMs);

  // No debe mantener vivo el proceso por sí solo.
  sweepTimer.unref?.();
}

export function stopCartAbandonmentSweeper(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}
