import { Types } from 'mongoose';
import { User, Order, Business } from '../models';
import { OrderStatus, UserRole } from '../types';
import { pushService } from './push.service';
import { AppError } from '../middlewares/errorHandler';

/**
 * Envíos dirigidos.
 *
 * El servicio de push ya sabía mandar a una persona; lo que faltaba era
 * poder decidir a quiénes. Mandarle a todo el mundo la promoción de una
 * pizzería de Garzón es la forma más rápida de que la gente apague las
 * notificaciones de ZIPP — y entonces se pierde también el aviso de que su
 * pedido va en camino, que es el que de verdad importa.
 *
 * Por eso los segmentos son de operación, no de marketing genérico: quién
 * compró aquí, quién lleva tiempo sin pedir, quién está en esta ciudad.
 */

export interface Segment {
  /** Solo usuarios de esta ciudad. */
  city?: string;
  role?: UserRole;
  /** Que hayan pedido en este negocio alguna vez. */
  boughtFromBusinessId?: string;
  /** Que no pidan nada desde hace al menos N días. */
  inactiveForDays?: number;
  /** Que hayan hecho al menos N pedidos entregados. */
  minDeliveredOrders?: number;
}

export class CampaignService {
  /**
   * Resuelve a quiénes alcanza un segmento.
   *
   * Devuelve los ids y no envía nada: separar el cálculo del envío permite
   * enseñar "esto llega a 240 personas" antes de pulsar el botón, que es la
   * diferencia entre una herramienta y una escopeta.
   */
  async resolve(segment: Segment, limit = 5000): Promise<string[]> {
    const filter: Record<string, unknown> = {
      isActive: true,
      // Quien pidió no recibir comunicaciones comerciales no las recibe.
      // No es una preferencia negociable: es la ley y es lo correcto.
      marketingConsent: true,
    };

    if (segment.role) filter.role = segment.role;
    else filter.role = UserRole.CLIENT;

    if (segment.city) filter.city = segment.city;

    let ids: Types.ObjectId[] | null = null;

    if (segment.boughtFromBusinessId) {
      const business = await Business.findById(segment.boughtFromBusinessId).select('_id');
      if (!business) throw new AppError('Negocio no encontrado', 404);

      const buyers = await Order.find({
        businessId: business._id,
        status: OrderStatus.DELIVERED,
      }).distinct('clientId');

      ids = buyers as Types.ObjectId[];
    }

    if (segment.minDeliveredOrders) {
      const rows = await Order.aggregate([
        { $match: { status: OrderStatus.DELIVERED } },
        { $group: { _id: '$clientId', count: { $sum: 1 } } },
        { $match: { count: { $gte: segment.minDeliveredOrders } } },
      ]);

      const frequent = rows.map((r) => r._id.toString());
      ids = ids
        ? ids.filter((id) => frequent.includes(id.toString()))
        : rows.map((r) => r._id);
    }

    if (segment.inactiveForDays) {
      const since = new Date(Date.now() - segment.inactiveForDays * 24 * 60 * 60 * 1000);
      const recent = await Order.find({ createdAt: { $gte: since } }).distinct('clientId');
      const recentSet = new Set(recent.map(String));

      // Se excluye a quien SÍ pidió hace poco. Es la única condición que
      // resta en vez de sumar, y por eso va la última.
      if (ids) {
        ids = ids.filter((id) => !recentSet.has(id.toString()));
      } else {
        filter._id = { $nin: recent };
      }
    }

    if (ids) filter._id = { $in: ids };

    const users = await User.find(filter).select('_id').limit(limit).lean();
    return users.map((u) => u._id.toString());
  }

  /** Cuánta gente alcanza, sin mandar nada. */
  async preview(segment: Segment): Promise<number> {
    return (await this.resolve(segment)).length;
  }

  /**
   * Manda la notificación al segmento.
   *
   * En serie y no en paralelo: Expo limita el ritmo, y saturarlo consigue
   * que rechace el lote entero en vez de entregarlo despacio. Un envío que
   * tarda un minuto más es mejor que uno que no llega.
   */
  async send(
    segment: Segment,
    message: { title: string; body: string; data?: Record<string, unknown> }
  ): Promise<{ targeted: number; sent: number }> {
    const userIds = await this.resolve(segment);

    let sent = 0;
    for (const userId of userIds) {
      try {
        await pushService.sendToUser(userId, message);
        sent++;
      } catch {
        // Un token muerto no puede abortar la campaña entera. El propio
        // servicio de push se encarga de limpiar los que Expo rechaza.
      }
    }

    return { targeted: userIds.length, sent };
  }
}

export const campaignService = new CampaignService();
