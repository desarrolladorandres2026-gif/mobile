import mongoose, { Types } from 'mongoose';
import { config } from '../config';
import { AppError } from '../middlewares';
import { OrderCall, IOrderCall, User } from '../models';
import { OrderCallStatus, OrderStatus, UserRole } from '../types';
import { OrderAccess, assertParticipant, getOrderParticipants } from './orderAccess.service';

export const CALL_ERROR = {
  UNAVAILABLE: 'CALL_UNAVAILABLE',
  NO_DRIVER: 'CALL_NO_DRIVER',
  BUSY: 'CALL_BUSY',
  NOT_FOUND: 'CALL_NOT_FOUND',
  NOT_YOURS: 'CALL_NOT_YOURS',
} as const;

/** El pedido tiene que estar en la calle para que llamar tenga sentido. */
const CALL_OPEN_STATUSES: OrderStatus[] = [
  OrderStatus.READY,
  OrderStatus.PICKED_UP,
  OrderStatus.ON_WAY,
];

/** Lo que la app necesita para pintar la llamada. Sin teléfonos. */
export interface CallPartyView {
  userId: string;
  name: string;
  avatar: string | null;
  role: UserRole;
}

export interface CallView {
  id: string;
  orderId: string;
  status: OrderCallStatus;
  caller: CallPartyView;
  receiver: CallPartyView;
  startedAt: Date;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number;
  /** Sala de señalización: solo las dos partes pueden entrar. */
  channel: string;
}

const ACTIVE_CALL_STATUSES = [OrderCallStatus.RINGING, OrderCallStatus.ACTIVE];

/**
 * Llamadas de voz entre cliente y domiciliario.
 *
 * ZIPP **no** enseña el número de nadie ni monta un puente telefónico con
 * un proveedor externo: la voz viaja por WebRTC entre los dos teléfonos y
 * el servidor solo hace de portero y de notario. Esto resuelve el
 * requisito de "no exponer el número personal" sin depender de Twilio ni
 * de un DID enmascarado, y deja el registro que hace falta para auditar
 * — quién llamó a quién, cuándo y cuánto duró.
 *
 * Lo que el servidor garantiza:
 *
 *   · solo las dos partes de un pedido activo pueden abrir un canal;
 *   · el canal se identifica con el id de la llamada, que no es adivinable
 *     y que se comprueba contra la base en cada mensaje de señalización;
 *   · no hay una sola llamada viva por pedido más de una vez;
 *   · no se guarda audio, porque grabar exige base legal y aviso a ambas
 *     partes, y ninguna de las dos cosas existe hoy.
 */
export class OrderCallService {
  /** Si ahora mismo se puede llamar en este pedido. */
  isAvailable(access: OrderAccess): boolean {
    return !!access.assignedDriverId && CALL_OPEN_STATUSES.includes(access.order.status);
  }

  /**
   * Abre una llamada. Devuelve el canal de señalización.
   *
   * Una llamada que lleva sonando más que `ringSeconds` se da por perdida
   * al vuelo: sin esto, un teléfono que se quedó sin batería mientras
   * sonaba dejaría el pedido incapaz de volver a llamar para siempre.
   */
  async start(access: OrderAccess): Promise<CallView> {
    assertParticipant(access, ['client', 'driver'], 'llamar');

    if (!access.assignedDriverId) {
      throw new AppError(
        'Todavía no hay domiciliario asignado a este pedido',
        409,
        CALL_ERROR.NO_DRIVER
      );
    }
    if (!this.isAvailable(access)) {
      throw new AppError(
        'Las llamadas solo están disponibles mientras el pedido está en reparto',
        409,
        CALL_ERROR.UNAVAILABLE
      );
    }

    await this.expireStale(access.order._id.toString());

    const ongoing = await OrderCall.findOne({
      orderId: access.order._id,
      status: { $in: ACTIVE_CALL_STATUSES },
    });
    if (ongoing) {
      throw new AppError('Ya hay una llamada en curso para este pedido', 409, CALL_ERROR.BUSY);
    }

    const participants = await getOrderParticipants(access.order);
    const counterpartId =
      access.participant === 'client' ? participants.driverUserId : participants.clientUserId;

    if (!counterpartId) {
      throw new AppError('No se pudo identificar al destinatario', 409, CALL_ERROR.NO_DRIVER);
    }

    const call = await OrderCall.create({
      orderId: access.order._id,
      callerId: new Types.ObjectId(access.userId),
      callerRole: access.participant === 'driver' ? UserRole.DRIVER : UserRole.CLIENT,
      receiverId: new Types.ObjectId(counterpartId),
      receiverRole: access.participant === 'driver' ? UserRole.CLIENT : UserRole.DRIVER,
      status: OrderCallStatus.RINGING,
    });

    return this.toView(call);
  }

  /** El destinatario descuelga. */
  async answer(callId: string, access: OrderAccess): Promise<CallView> {
    const call = await this.findParticipating(callId, access);

    if (call.receiverId.toString() !== access.userId) {
      throw new AppError('No puedes contestar tu propia llamada', 403, CALL_ERROR.NOT_YOURS);
    }

    // Condicional a RINGING: si la llamada ya se colgó, contestar no la
    // resucita.
    const answered = await OrderCall.findOneAndUpdate(
      { _id: call._id, status: OrderCallStatus.RINGING },
      { $set: { status: OrderCallStatus.ACTIVE, answeredAt: new Date() } },
      { new: true }
    );

    if (!answered) {
      throw new AppError('La llamada ya terminó', 409, CALL_ERROR.NOT_FOUND);
    }

    return this.toView(answered);
  }

  /**
   * Cierra la llamada. La puede cerrar cualquiera de las dos partes.
   *
   * El estado final distingue lo que pasó —contestada, rechazada o
   * perdida— porque es lo que después explica una disputa: "te llamé y no
   * contestaste" tiene que poder comprobarse.
   */
  async end(callId: string, access: OrderAccess, reason?: string): Promise<CallView> {
    const call = await this.findParticipating(callId, access);

    if (!ACTIVE_CALL_STATUSES.includes(call.status)) return this.toView(call);

    const endedAt = new Date();
    const wasAnswered = !!call.answeredAt;
    const rejectedByReceiver =
      !wasAnswered && call.receiverId.toString() === access.userId;

    const status = wasAnswered
      ? OrderCallStatus.ENDED
      : rejectedByReceiver
        ? OrderCallStatus.REJECTED
        : OrderCallStatus.MISSED;

    const durationSeconds = wasAnswered
      ? Math.max(0, Math.round((endedAt.getTime() - call.answeredAt!.getTime()) / 1000))
      : 0;

    const ended = await OrderCall.findOneAndUpdate(
      { _id: call._id, status: { $in: ACTIVE_CALL_STATUSES } },
      {
        $set: {
          status,
          endedAt,
          endedBy: new Types.ObjectId(access.userId),
          durationSeconds,
          endReason: reason ?? null,
        },
      },
      { new: true }
    );

    return this.toView(ended ?? call);
  }

  /** Historial de llamadas del pedido, para las partes y para soporte. */
  async listForOrder(access: OrderAccess): Promise<CallView[]> {
    await this.expireStale(access.order._id.toString());
    const calls = await OrderCall.find({ orderId: access.order._id }).sort({ startedAt: -1 });
    return Promise.all(calls.map((call) => this.toView(call)));
  }

  /** La llamada viva del pedido, si la hay. */
  async current(access: OrderAccess): Promise<CallView | null> {
    await this.expireStale(access.order._id.toString());
    const call = await OrderCall.findOne({
      orderId: access.order._id,
      status: { $in: ACTIVE_CALL_STATUSES },
    });
    return call ? this.toView(call) : null;
  }

  /**
   * Cierra llamadas que se quedaron colgadas.
   *
   * Una app que se cierra de golpe no manda el "colgué". Sin esta barrida
   * el pedido se quedaría con una llamada eternamente "en curso" y ni
   * cliente ni domiciliario podrían volver a llamarse.
   */
  private async expireStale(orderId: string): Promise<void> {
    const now = Date.now();
    const ringDeadline = new Date(now - config.orderFlow.call.ringSeconds * 1000);
    const callDeadline = new Date(now - config.orderFlow.call.maxDurationMinutes * 60_000);

    await OrderCall.updateMany(
      { orderId, status: OrderCallStatus.RINGING, startedAt: { $lt: ringDeadline } },
      { $set: { status: OrderCallStatus.MISSED, endedAt: new Date(), endReason: 'sin respuesta' } }
    );

    await OrderCall.updateMany(
      { orderId, status: OrderCallStatus.ACTIVE, answeredAt: { $lt: callDeadline } },
      { $set: { status: OrderCallStatus.ENDED, endedAt: new Date(), endReason: 'tiempo máximo alcanzado' } }
    );
  }

  /**
   * Carga una llamada comprobando que quien pregunta es una de sus dos
   * partes — y que además pertenece al pedido que dice.
   *
   * Las dos comprobaciones son necesarias: la de pedido evita que alguien
   * pase el id de una llamada ajena a un pedido suyo, y la de partes evita
   * que el cliente cuelgue la llamada de otro dentro del mismo pedido.
   */
  private async findParticipating(callId: string, access: OrderAccess): Promise<IOrderCall> {
    if (!mongoose.isValidObjectId(callId)) {
      throw new AppError('Llamada no encontrada', 404, CALL_ERROR.NOT_FOUND);
    }

    const call = await OrderCall.findOne({ _id: callId, orderId: access.order._id });
    if (!call) throw new AppError('Llamada no encontrada', 404, CALL_ERROR.NOT_FOUND);

    const isParty =
      call.callerId.toString() === access.userId ||
      call.receiverId.toString() === access.userId;

    if (!isParty) {
      throw new AppError('Llamada no encontrada', 404, CALL_ERROR.NOT_FOUND);
    }

    return call;
  }

  /**
   * Vista de una llamada.
   *
   * Se sirven nombre y avatar, nunca el teléfono: es lo justo para saber
   * con quién se habla sin dejar un dato de contacto permanente en manos
   * de un desconocido.
   */
  private async toView(call: IOrderCall): Promise<CallView> {
    const [caller, receiver] = await Promise.all([
      User.findById(call.callerId).select('name avatar'),
      User.findById(call.receiverId).select('name avatar'),
    ]);

    const party = (
      user: any,
      id: Types.ObjectId,
      role: UserRole
    ): CallPartyView => ({
      userId: id.toString(),
      name: user?.name ?? 'Usuario',
      avatar: user?.avatar ?? null,
      role,
    });

    return {
      id: call._id.toString(),
      orderId: call.orderId.toString(),
      status: call.status,
      caller: party(caller, call.callerId, call.callerRole),
      receiver: party(receiver, call.receiverId, call.receiverRole),
      startedAt: call.startedAt,
      answeredAt: call.answeredAt,
      endedAt: call.endedAt,
      durationSeconds: call.durationSeconds,
      channel: `call:${call._id.toString()}`,
    };
  }
}

export const orderCallService = new OrderCallService();
