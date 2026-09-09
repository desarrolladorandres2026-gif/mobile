import { Types } from 'mongoose';
import { Order, IOrder } from '../models';
import { OrderStatus } from '../types';
import { suggestDriverForOrder, NearestDriver } from './tracking.service';
import { emitToUser, getIO } from '../sockets/emitter';
import { logSystemAudit, AuditAction, AuditSeverity } from '../security';
import { config } from '../config';

/**
 * Reparto automático de pedidos.
 *
 * Hasta ahora ZIPP funcionaba en modo autoservicio: el pedido aparecía en
 * una lista y se lo quedaba quien pulsara primero, que no es
 * necesariamente quien está más cerca. El ranking por ETA real llevaba
 * tiempo escrito en `tracking.service.ts` sin que nadie lo llamara; esto es
 * lo que lo llama.
 *
 * El autoservicio no desaparece. Sigue siendo la red de seguridad para
 * cuando la cascada se queda sin candidatos, y para los pedidos que ya
 * estaban en circulación cuando esto se desplegó.
 */

/**
 * La cascada.
 *
 * Empieza estrecha y se abre. La primera ronda respeta el orden por
 * cercanía —premiar al más cercano es lo que hace que el reparto sea
 * eficiente y que las entregas se paguen solas—, pero un pedido no puede
 * quedarse esperando a alguien que dejó el teléfono en el bolsillo. Cada
 * ronda que pasa cambia un poco de justicia por un poco de velocidad, y la
 * última se lo ofrece a todo el mundo.
 *
 * La ventana se acorta a la vez que se ensancha el grupo: con más gente
 * mirando el mismo pedido hace falta menos tiempo para que alguien
 * responda, y a esas alturas la prisa ya es real.
 */
const ROUNDS: Array<{ candidates: number; windowMs: number }> = [
  { candidates: 1, windowMs: 45_000 },
  { candidates: 3, windowMs: 30_000 },
  // 0 significa "todos los que haya".
  { candidates: 0, windowMs: 20_000 },
];

/** Cuánto se espera antes de volver a empezar cuando nadie ha aceptado. */
const CYCLE_PAUSE_MS = 30_000;

/**
 * Vueltas completas antes de avisar a un administrador.
 *
 * El ciclo no se detiene al llegar aquí: un pedido sin repartir tiene que
 * seguir buscando, porque hay un cliente esperando y un negocio con la
 * comida hecha. Lo que cambia es que deja de ser un problema silencioso.
 */
const CYCLES_BEFORE_ALERT = 3;

/**
 * Interruptor del reparto.
 *
 * Vive en una variable del módulo y no se lee de la configuración en cada
 * llamada para que las pruebas puedan encenderlo sin reconstruir el objeto
 * de configuración entero, que se congela al importarse.
 *
 * Apagado, todo el subsistema se vuelve transparente: los pedidos no se
 * ofrecen y `canClaim` deja pasar a cualquiera, que es exactamente como
 * funcionaba ZIPP antes. Es la diferencia entre desplegar código nuevo y
 * cambiar el comportamiento de la calle, y conviene poder hacer lo primero
 * sin lo segundo.
 */
let enabled = config.dispatch.enabled;

/** Clave del interruptor que gobierna esto desde el panel. */
export const DISPATCH_FLAG = 'dispatch.cascade';

export function setDispatchEnabled(value: boolean): void {
  enabled = value;
}

export function isDispatchEnabled(): boolean {
  return enabled;
}

/**
 * Sincroniza el interruptor con lo que diga el panel.
 *
 * La variable de entorno sigue siendo el suelo: si `DISPATCH_ENABLED` está
 * encendida, el reparto funciona aunque nadie haya creado el interruptor en
 * la base. Lo que añade el panel es poder encenderlo —y sobre todo
 * apagarlo— sin un redespliegue, que es lo que hace falta cuando algo se
 * tuerce a las nueve de la noche de un viernes.
 */
export async function syncDispatchFlag(): Promise<boolean> {
  try {
    const { isEnabled } = await import('./featureFlag.service');
    const fromPanel = await isEnabled(DISPATCH_FLAG);
    enabled = config.dispatch.enabled || fromPanel;
  } catch (err) {
    // Si la consulta falla, se mantiene lo que hubiera: un fallo leyendo un
    // interruptor no puede cambiar el comportamiento de la operación.
    console.error('[Dispatch] No se pudo leer el interruptor:', err);
  }
  return enabled;
}

export interface OfferPayload {
  orderId: string;
  orderNumber: string;
  businessName?: string;
  round: number;
  expiresAt: Date;
  etaSeconds: number;
}

/** ¿Este pedido debería estar buscando domiciliario? */
function needsDriver(order: Pick<IOrder, 'status' | 'driverId'>): boolean {
  return order.status === OrderStatus.READY && !order.driverId;
}

/**
 * Arranca la búsqueda. Se llama cuando el comercio marca el pedido listo.
 *
 * No espera a que termine el reparto: quien cambia el estado del pedido no
 * puede quedarse bloqueado mientras se calculan rutas contra Mapbox.
 */
export async function startDispatch(orderId: string): Promise<void> {
  if (!enabled) return;

  await Order.updateOne(
    { _id: orderId },
    {
      $set: {
        dispatch: {
          round: 0,
          cycle: 0,
          offeredDriverIds: [],
          declinedDriverIds: [],
          expiresAt: null,
          lastOfferedAt: null,
        },
      },
    }
  );

  await offerNextRound(orderId);
}

/**
 * Ofrece el pedido a los candidatos de la siguiente ronda.
 *
 * Devuelve `false` cuando no hay a quién ofrecérselo, que es información
 * distinta de "falló": significa que no hay nadie conectado y disponible
 * cerca, y que hay que esperar a que aparezca alguien.
 */
export async function offerNextRound(orderId: string): Promise<boolean> {
  if (!enabled) return false;

  const order = await Order.findById(orderId).populate('businessId', 'name');
  if (!order || !needsDriver(order)) return false;

  const current = order.dispatch;
  const round = (current?.round ?? 0) + 1;

  // Agotadas las rondas, empieza otra vuelta. La lista de rechazos se
  // borra con ella: quien dijo que no hace tres minutos puede haber
  // terminado su entrega y querer esta.
  if (round > ROUNDS.length) {
    return restartCycle(order);
  }

  const config = ROUNDS[round - 1];
  const declined = new Set((current?.declinedDriverIds ?? []).map(String));

  let ranked: NearestDriver[] = [];
  try {
    ranked = await suggestDriverForOrder(orderId);
  } catch (err) {
    console.error('[Dispatch] No se pudo calcular el ranking de domiciliarios:', err);
    return false;
  }

  const eligible = ranked.filter((d) => !declined.has(d.driverId));
  const chosen = config.candidates > 0 ? eligible.slice(0, config.candidates) : eligible;

  if (!chosen.length) {
    // Nadie a quien ofrecer en esta ronda. Se marca igualmente el paso de
    // ronda para que el barrido siga avanzando en vez de quedarse
    // reintentando la misma ronda vacía para siempre.
    await Order.updateOne(
      { _id: order._id, 'dispatch.round': current?.round ?? 0 },
      {
        $set: {
          'dispatch.round': round,
          'dispatch.offeredDriverIds': [],
          'dispatch.expiresAt': new Date(Date.now() + config.windowMs),
        },
      }
    );
    return false;
  }

  const expiresAt = new Date(Date.now() + config.windowMs);

  // La escritura lleva la ronda anterior en el filtro. Si otra instancia
  // del servidor —o el barrido— ya avanzó este pedido, esta se cae sola en
  // vez de ofrecerlo dos veces con dos relojes distintos.
  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, driverId: null, 'dispatch.round': current?.round ?? 0 },
    {
      $set: {
        'dispatch.round': round,
        'dispatch.offeredDriverIds': chosen.map((d) => new Types.ObjectId(d.driverId)),
        'dispatch.expiresAt': expiresAt,
        'dispatch.lastOfferedAt': new Date(),
      },
    },
    { new: true }
  );

  if (!claimed) return false;

  const businessName = (order.businessId as any)?.name as string | undefined;

  for (const candidate of chosen) {
    const payload: OfferPayload = {
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      businessName,
      round,
      expiresAt,
      etaSeconds: candidate.etaSeconds,
    };
    emitToUser(candidate.userId, 'order:offer', payload);
  }

  return true;
}

/** Vuelve a empezar la cascada tras una pausa, sin memoria de rechazos. */
async function restartCycle(order: IOrder): Promise<boolean> {
  const cycle = (order.dispatch?.cycle ?? 0) + 1;

  await Order.updateOne(
    { _id: order._id },
    {
      $set: {
        'dispatch.round': 0,
        'dispatch.cycle': cycle,
        'dispatch.offeredDriverIds': [],
        'dispatch.declinedDriverIds': [],
        // El barrido usa esta fecha como "cuándo volver a mirar", así que
        // la pausa entre vueltas se expresa igual que una ronda en curso.
        'dispatch.expiresAt': new Date(Date.now() + CYCLE_PAUSE_MS),
        'dispatch.lastOfferedAt': null,
      },
    }
  );

  if (cycle === CYCLES_BEFORE_ALERT) {
    const stalled = {
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      cycles: cycle,
    };

    getIO()?.to('admin').emit('order:dispatch:stalled', stalled);

    /**
     * El cliente también se entera.
     *
     * Antes esto solo llegaba a la sala `admin`: quien había pagado se
     * quedaba mirando una pantalla que no cambiaba, sin saber si su pedido
     * seguía vivo. El peor momento del servicio ocurría en silencio, y el
     * silencio es lo que convierte una demora en una llamada a soporte.
     *
     * Decirlo no arregla la falta de domiciliarios, pero cambia lo que le
     * pasa a la persona: puede esperar sabiendo, o cancelar.
     */
    emitToUser(order.clientId.toString(), 'order:dispatch:stalled', stalled);

    await logSystemAudit({
      userId: 'system',
      role: 'system',
      action: AuditAction.SUSPICIOUS_ACTIVITY,
      entity: 'order',
      entityId: order._id.toString(),
      severity: AuditSeverity.MEDIUM,
      description:
        `El pedido ${order.orderNumber} lleva ${cycle} vueltas completas sin que ` +
        `ningún domiciliario lo acepte`,
      metadata: { orderNumber: order.orderNumber, cycles: cycle },
    });
  }

  return false;
}

/**
 * El domiciliario dice que no.
 *
 * Rechazar explícitamente vale más que dejar que expire: libera el pedido
 * en el acto en vez de retener a todo el mundo los cuarenta y cinco
 * segundos, y en un pueblo con pocos repartidores esa diferencia es la
 * comida caliente.
 */
export async function declineOffer(orderId: string, driverId: string): Promise<void> {
  const order = await Order.findById(orderId).select('dispatch status driverId');
  if (!order || !needsDriver(order)) return;

  const offered = (order.dispatch?.offeredDriverIds ?? []).map(String);
  if (!offered.includes(driverId)) return;

  await Order.updateOne(
    { _id: orderId },
    {
      $addToSet: { 'dispatch.declinedDriverIds': new Types.ObjectId(driverId) },
      $pull: { 'dispatch.offeredDriverIds': new Types.ObjectId(driverId) },
    }
  );

  // Si era el último de la ronda, no tiene sentido esperar al reloj.
  if (offered.length === 1) await offerNextRound(orderId);
}

/**
 * ¿Puede este domiciliario quedarse el pedido?
 *
 * Mientras la cascada está en las rondas estrechas, solo quienes tienen la
 * oferta delante. Sin esto la cascada sería decorativa: cualquiera podría
 * adelantarse desde la lista de disponibles y el orden por cercanía no
 * decidiría nada.
 *
 * Un pedido sin reparto en curso —los anteriores a esta función, o los que
 * agotaron la cascada— queda abierto a todos, que es como funcionaba ZIPP
 * hasta ahora.
 */
export function canClaim(order: IOrder, driverId: string): boolean {
  if (!enabled) return true;

  const dispatch = order.dispatch;
  if (!dispatch || !dispatch.round) return true;

  // La última ronda se lo ofrece a todo el mundo, así que no restringe.
  if (dispatch.round >= ROUNDS.length) return true;

  // Una oferta vencida tampoco retiene el pedido: entre que expira y que
  // el barrido pasa hay unos segundos, y en ese hueco es mejor que se lo
  // quede alguien a que no se lo quede nadie.
  if (dispatch.expiresAt && dispatch.expiresAt.getTime() < Date.now()) return true;

  return (dispatch.offeredDriverIds ?? []).map(String).includes(driverId);
}

/** Cierra el reparto. Se llama al asignar domiciliario y al cancelar. */
export async function stopDispatch(orderId: string): Promise<void> {
  await Order.updateOne({ _id: orderId }, { $unset: { dispatch: '' } });
}

/**
 * Avanza los repartos cuya ronda ya venció.
 *
 * Es un barrido y no un temporizador por pedido porque los temporizadores
 * viven en la memoria de un proceso: bastaría un reinicio para dejar
 * pedidos congelados en una ronda que nadie va a cerrar nunca. Preguntarle
 * a la base de datos qué ha vencido funciona igual con un servidor que con
 * cuatro, y sobrevive a los despliegues.
 */
export async function sweepExpiredOffers(): Promise<number> {
  const due = await Order.find({
    status: OrderStatus.READY,
    driverId: null,
    'dispatch.expiresAt': { $lte: new Date() },
  })
    .select('_id')
    .limit(50);

  let advanced = 0;
  for (const order of due) {
    try {
      await offerNextRound(order._id.toString());
      advanced++;
    } catch (err) {
      console.error('[Dispatch] Falló el avance de ronda:', err);
    }
  }

  return advanced;
}

/**
 * Cuánto puede tardar un domiciliario en recoger antes de perder el pedido.
 *
 * Aceptar y no ir es el fallo más caro de esta operación: el pedido deja de
 * ofrecerse a nadie más, el negocio tiene la comida hecha y el cliente no
 * ve avanzar nada. Quince minutos es holgado para llegar a cualquier punto
 * del pueblo y corto para que la comida no muera esperando.
 */
const PICKUP_GRACE_MS = 15 * 60 * 1000;

/**
 * Devuelve al reparto los pedidos que un domiciliario aceptó y no recogió.
 *
 * Se ejecuta con el mismo barrido que las ofertas vencidas, y por la misma
 * razón: un teléfono que se queda sin batería no avisa de que se quedó sin
 * batería. Alguien tiene que preguntar.
 */
export async function reassignStalledPickups(): Promise<number> {
  if (!enabled) return 0;

  const cutoff = new Date(Date.now() - PICKUP_GRACE_MS);

  const stalled = await Order.find({
    status: OrderStatus.READY,
    driverId: { $ne: null },
    assignedAt: { $lte: cutoff },
  })
    .select('_id')
    .limit(20);

  let reassigned = 0;
  for (const order of stalled) {
    try {
      const { orderService } = await import('./order.service');
      const released = await orderService.unassignDriver(
        order._id.toString(),
        'No recogió el pedido dentro del plazo'
      );

      if (released) {
        // Vuelve a la cascada desde la primera ronda, sin memoria: quien
        // lo dejó tirado puede volver a recibirlo si es el único cerca, y
        // eso es mejor que no repartirlo.
        await startDispatch(order._id.toString());
        reassigned++;
      }
    } catch (err) {
      console.error('[Dispatch] Falló la reasignación:', err);
    }
  }

  return reassigned;
}

let sweepTimer: NodeJS.Timeout | null = null;

/** Arranca el barrido periódico. Idempotente. */
export function startDispatchSweeper(intervalMs = 5_000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    // El interruptor se relee en cada vuelta: así, encenderlo desde el
    // panel surte efecto sin reiniciar, y apagarlo detiene el reparto en
    // los siguientes segundos en vez de en el siguiente despliegue.
    syncDispatchFlag()
      .then(async (on) => {
        if (!on) return;
        // Las tres revisiones del barrido: ofertas vencidas, pedidos que
        // alguien aceptó y no fue a recoger, y programados cuya hora llega.
        const { orderService } = await import('./order.service');
        await Promise.all([
          sweepExpiredOffers(),
          reassignStalledPickups(),
          orderService.activateScheduledOrders(),
        ]);
      })
      .catch((err) => console.error('[Dispatch] Falló el barrido:', err));
  }, intervalMs);

  // No debe mantener vivo el proceso: si Node no tiene nada más que hacer,
  // un intervalo de reparto no es razón para no dejarlo terminar.
  sweepTimer.unref?.();
}

export function stopDispatchSweeper(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}

/** Los domiciliarios a los que se está ofreciendo ahora mismo un pedido. */
export async function currentOffer(orderId: string): Promise<string[]> {
  const order = await Order.findById(orderId).select('dispatch');
  return (order?.dispatch?.offeredDriverIds ?? []).map(String);
}

export const dispatchService = {
  setDispatchEnabled,
  syncDispatchFlag,
  DISPATCH_FLAG,
  isDispatchEnabled,
  startDispatch,
  offerNextRound,
  declineOffer,
  canClaim,
  stopDispatch,
  sweepExpiredOffers,
  reassignStalledPickups,
  PICKUP_GRACE_MS,
  startDispatchSweeper,
  stopDispatchSweeper,
  currentOffer,
  ROUNDS,
  CYCLE_PAUSE_MS,
  CYCLES_BEFORE_ALERT,
};
