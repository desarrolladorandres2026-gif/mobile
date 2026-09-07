import { Types } from 'mongoose';
import { config } from '../config';
import { AppError } from '../middlewares';
import { IOrder, OrderEvidence } from '../models';
import {
  OrderSecurity,
  IOrderSecurity,
  IOrderCodeState,
  generateOrderCode,
  hashOrderCode,
  normalizeOrderCode,
} from '../security/orderSecurity';
import { encrypt, decrypt } from '../security/encryption';
import { OrderCodeKind, OrderCodeStatus, OrderEvidenceType, OrderStatus } from '../types';
import { OrderAccess, assertParticipant } from './orderAccess.service';

/** Etiquetas de error que la app usa para decidir qué pantalla mostrar. */
export const CODE_ERROR = {
  NOT_ISSUED: 'CODE_NOT_ISSUED',
  INVALID: 'CODE_INVALID',
  ALREADY_USED: 'CODE_ALREADY_USED',
  EXPIRED: 'CODE_EXPIRED',
  BLOCKED: 'CODE_BLOCKED',
  VOID: 'CODE_VOID',
  WRONG_STAGE: 'ORDER_WRONG_STAGE',
  EVIDENCE_REQUIRED: 'EVIDENCE_REQUIRED',
  NOT_ARRIVED: 'DRIVER_NOT_ARRIVED',
} as const;

/** Resumen sin secretos: lo que puede ver un administrador o un panel. */
export interface CodeStatusView {
  status: OrderCodeStatus;
  attempts: number;
  issuedAt: Date;
  expiresAt: Date | null;
  usedAt: Date | null;
  verifiedBy: string | null;
  verifiedRole: string | null;
  lockedUntil: Date | null;
  arrivedAt: Date | null;
}

export interface OrderSecurityView {
  orderId: string;
  pickup: CodeStatusView;
  delivery: CodeStatusView;
  /** El secreto, solo si quien pregunta es la parte que debe enseñarlo. */
  pickupCode?: string;
  deliveryCode?: string;
}

export interface VerifyResult {
  kind: OrderCodeKind;
  verifiedAt: Date;
  orderStatus: OrderStatus;
}

function toStatusView(state: IOrderCodeState): CodeStatusView {
  return {
    status: state.status,
    attempts: state.attempts,
    issuedAt: state.issuedAt,
    expiresAt: state.expiresAt,
    usedAt: state.usedAt,
    verifiedBy: state.verifiedBy ? state.verifiedBy.toString() : null,
    verifiedRole: state.verifiedRole,
    lockedUntil: state.lockedUntil,
    arrivedAt: state.arrivedAt,
  };
}

/** Estados en los que el pedido sigue vivo y sus códigos tienen sentido. */
const CODE_ACTIVE_STATUSES: OrderStatus[] = [
  OrderStatus.ACCEPTED,
  OrderStatus.PREPARING,
  OrderStatus.READY,
  OrderStatus.PICKED_UP,
  OrderStatus.ON_WAY,
];

export class OrderSecurityService {
  /**
   * Emite los dos códigos de un pedido. Idempotente.
   *
   * Se llama cuando el comercio acepta: a partir de ahí el pedido va a
   * existir físicamente y las dos entregas de custodia están garantizadas.
   * Emitirlos antes (al crear) gastaría códigos en pedidos que el comercio
   * rechaza; emitirlos más tarde obligaría a coordinar dos momentos
   * distintos con dos aplicaciones distintas.
   *
   * El `upsert` con `$setOnInsert` es lo que la hace idempotente frente a
   * dos aceptaciones simultáneas: el índice único sobre `orderId` deja
   * pasar una sola inserción y la otra recupera la existente en vez de
   * pisar unos códigos que quizá ya se enseñaron.
   */
  async ensureIssued(orderId: string): Promise<IOrderSecurity> {
    const existing = await OrderSecurity.findOne({ orderId });
    if (existing) return existing;

    const ttlHours = config.orderFlow.code.ttlHours;
    const expiresAt = ttlHours > 0 ? new Date(Date.now() + ttlHours * 3600_000) : null;

    const build = (kind: OrderCodeKind): IOrderCodeState => {
      const code = generateOrderCode();
      return {
        hash: hashOrderCode(orderId, kind, code),
        secret: encrypt(code),
        status: OrderCodeStatus.PENDING,
        attempts: 0,
        issuedAt: new Date(),
        expiresAt,
        usedAt: null,
        verifiedBy: null,
        verifiedRole: null,
        lockedUntil: null,
        arrivedAt: null,
      } as IOrderCodeState;
    };

    try {
      return await OrderSecurity.create({
        orderId,
        pickup: build(OrderCodeKind.PICKUP),
        delivery: build(OrderCodeKind.DELIVERY),
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        const raced = await OrderSecurity.findOne({ orderId });
        if (raced) return raced;
      }
      throw error;
    }
  }

  /** Estado bruto, sin decidir quién puede verlo. Uso interno. */
  async getState(orderId: string): Promise<IOrderSecurity | null> {
    return OrderSecurity.findOne({ orderId });
  }

  /**
   * Anula los códigos de un pedido cancelado.
   *
   * Un código sigue siendo válido hasta que algo lo invalida, y un pedido
   * cancelado no debe poder cerrarse "por entregado" un rato después.
   */
  async voidCodes(orderId: string): Promise<void> {
    // `$ne: USED` protege un hecho histórico: un código ya validado guarda
    // quién y cuándo recogió el pedido. Anularlo borraría la prueba de que
    // la recogida ocurrió antes de la cancelación.
    await Promise.all(
      [OrderCodeKind.PICKUP, OrderCodeKind.DELIVERY].map((kind) =>
        OrderSecurity.updateOne(
          { orderId, [`${kind}.status`]: { $ne: OrderCodeStatus.USED } },
          { $set: { [`${kind}.status`]: OrderCodeStatus.VOID } }
        )
      )
    );
  }

  /**
   * Devuelve un código consumido al estado PENDING.
   *
   * Compensación para el único hueco que deja no tener transacciones:
   * entre consumir el código y mover el pedido hay dos escrituras, y si la
   * segunda falla (una cancelación que se cuela justo en medio) el código
   * quedaría gastado sin que la entrega se registrara. Reabrirlo permite
   * reintentar; el intento anulado queda en la auditoría.
   *
   * Condicionado a `USED` para no reabrir jamás un código anulado ni
   * pisar el resultado de otra validación posterior.
   */
  async releaseCode(orderId: string, kind: OrderCodeKind): Promise<void> {
    await OrderSecurity.updateOne(
      { orderId, [`${kind}.status`]: OrderCodeStatus.USED },
      {
        $set: {
          [`${kind}.status`]: OrderCodeStatus.PENDING,
          [`${kind}.usedAt`]: null,
          [`${kind}.verifiedBy`]: null,
          [`${kind}.verifiedRole`]: null,
        },
      }
    );
  }

  /**
   * Lo que cada parte puede ver de los códigos de un pedido.
   *
   * El secreto se revela a **una sola** parte y solo en la etapa en la que
   * le toca enseñarlo:
   *
   *   · el comercio ve el de recogida mientras el pedido esté listo y sin
   *     recoger — es quien se lo dicta al domiciliario en el mostrador;
   *   · el cliente ve el de entrega solo cuando el pedido ya va en camino,
   *     porque antes no tiene a quién dárselo y enseñarlo antes solo
   *     multiplica las ocasiones de que se filtre.
   *
   * El domiciliario nunca ve ninguno de los dos: si los viera, teclearlos
   * no probaría nada. El administrador tampoco: le basta el estado, y un
   * panel de soporte que muestra secretos es un panel del que se filtran
   * secretos.
   */
  async viewFor(access: OrderAccess): Promise<OrderSecurityView> {
    const orderId = access.order._id.toString();
    const security = await this.ensureIssuedIfActive(access.order);

    if (!security) {
      throw new AppError(
        'Este pedido todavía no tiene códigos de seguridad',
        409,
        CODE_ERROR.NOT_ISSUED
      );
    }

    const view: OrderSecurityView = {
      orderId,
      pickup: toStatusView(security.pickup),
      delivery: toStatusView(security.delivery),
    };

    const status = access.order.status;

    const canSeePickup =
      access.participant === 'business' &&
      security.pickup.status === OrderCodeStatus.PENDING &&
      status === OrderStatus.READY;

    const canSeeDelivery =
      access.participant === 'client' &&
      security.delivery.status === OrderCodeStatus.PENDING &&
      (status === OrderStatus.PICKED_UP || status === OrderStatus.ON_WAY);

    if (canSeePickup) view.pickupCode = decrypt(security.pickup.secret);
    if (canSeeDelivery) view.deliveryCode = decrypt(security.delivery.secret);

    return view;
  }

  /** Emite los códigos al vuelo para pedidos vivos anteriores a esta versión. */
  private async ensureIssuedIfActive(order: IOrder): Promise<IOrderSecurity | null> {
    const orderId = order._id.toString();
    const existing = await OrderSecurity.findOne({ orderId });
    if (existing) return existing;
    if (!CODE_ACTIVE_STATUSES.includes(order.status)) return null;
    return this.ensureIssued(orderId);
  }

  /**
   * El domiciliario declara que llegó al comercio o al destino.
   *
   * Es un hecho declarado, no verificado: sirve para avisar a la otra
   * parte y para ordenar la interfaz, nunca para autorizar nada. Lo que
   * autoriza es el código.
   */
  async markArrival(access: OrderAccess, kind: OrderCodeKind): Promise<Date> {
    assertParticipant(access, ['driver'], 'declarar la llegada');

    const expected =
      kind === OrderCodeKind.PICKUP ? OrderStatus.READY : OrderStatus.ON_WAY;

    if (access.order.status !== expected) {
      throw new AppError(
        kind === OrderCodeKind.PICKUP
          ? 'El pedido todavía no está listo para recoger'
          : 'Marca primero que vas en camino',
        409,
        CODE_ERROR.WRONG_STAGE
      );
    }

    const security = await this.ensureIssued(access.order._id.toString());
    const now = new Date();

    // Solo la primera llegada cuenta: si el domiciliario pulsa dos veces,
    // la hora registrada sigue siendo aquella en la que llegó de verdad.
    if (!security[kind].arrivedAt) {
      await OrderSecurity.updateOne(
        { orderId: access.order._id, [`${kind}.arrivedAt`]: null },
        { $set: { [`${kind}.arrivedAt`]: now } }
      );
      return now;
    }

    return security[kind].arrivedAt as Date;
  }

  /**
   * Valida y **consume** un código.
   *
   * El corazón del asunto es una única escritura condicional: el filtro
   * exige a la vez el pedido, la huella del código, el estado PENDING, que
   * no esté caducado y que no esté castigado. MongoDB garantiza que ese
   * `findOneAndUpdate` se aplica de forma atómica sobre el documento, así
   * que si dos dispositivos envían el código correcto en el mismo
   * milisegundo, exactamente uno encuentra el documento en PENDING y lo
   * deja en USED; el otro no encuentra nada y recibe "código ya utilizado".
   *
   * Esto es lo que hace innecesaria una transacción —que además no existe
   * en un MongoDB de un solo nodo—: la carrera se resuelve donde de verdad
   * ocurre, en el documento que se está consumiendo.
   */
  async verify(params: {
    access: OrderAccess;
    kind: OrderCodeKind;
    code: string;
  }): Promise<{ security: IOrderSecurity; verifiedAt: Date }> {
    const { access, kind } = params;
    assertParticipant(access, ['driver'], 'validar el código');

    const order = access.order;
    const orderId = order._id.toString();

    // ── Etapa correcta ──
    const expectedStatus =
      kind === OrderCodeKind.PICKUP ? OrderStatus.READY : OrderStatus.ON_WAY;
    if (order.status !== expectedStatus) {
      throw new AppError(
        kind === OrderCodeKind.PICKUP
          ? 'Este pedido no está listo para recoger'
          : 'Este pedido no está en reparto',
        409,
        CODE_ERROR.WRONG_STAGE
      );
    }

    const security = await this.ensureIssued(orderId);
    const state = security[kind];

    // ── Llegada declarada ──
    // La cadena es LLEGADA → FOTO → CÓDIGO. La llegada no autoriza nada por
    // sí sola —es un hecho declarado, no verificado—, pero sin esta guarda
    // un domiciliario podía subir la foto y validar el código sin haber
    // declarado nunca que llegó: el cliente no recibía el aviso de
    // "domiciliario en la puerta" y la línea de tiempo quedaba con el
    // traspaso pero sin el hito que lo antecede.
    if (!state.arrivedAt) {
      throw new AppError(
        kind === OrderCodeKind.PICKUP
          ? 'Registra primero tu llegada al comercio'
          : 'Registra primero tu llegada al destino',
        409,
        CODE_ERROR.NOT_ARRIVED
      );
    }

    // ── Evidencia obligatoria ──
    // La foto va antes que el código a propósito: si el código fuera lo
    // último que falta, un domiciliario apurado cerraría la entrega y
    // "ya subiría la foto luego", que en la práctica es nunca.
    const evidenceType =
      kind === OrderCodeKind.PICKUP
        ? OrderEvidenceType.PICKUP
        : OrderEvidenceType.DELIVERY;
    const hasEvidence = await OrderEvidence.exists({ orderId: order._id, type: evidenceType });
    if (!hasEvidence) {
      throw new AppError(
        kind === OrderCodeKind.PICKUP
          ? 'Toma primero la foto del pedido que recibes'
          : 'Toma primero la foto de la entrega',
        409,
        CODE_ERROR.EVIDENCE_REQUIRED
      );
    }

    // ── Rechazos que no gastan intento ──
    // Un código ya usado o anulado no admite "otro intento": no hay nada
    // que adivinar, así que contarlo solo serviría para que un rival
    // bloqueara la operación agotando los intentos de un código muerto.
    if (state.status === OrderCodeStatus.USED) {
      throw new AppError('Código inválido o ya utilizado', 409, CODE_ERROR.ALREADY_USED);
    }
    if (state.status === OrderCodeStatus.VOID) {
      throw new AppError('Este pedido ya no admite validaciones', 409, CODE_ERROR.VOID);
    }

    const now = new Date();
    if (state.lockedUntil && state.lockedUntil > now) {
      const minutes = Math.max(1, Math.ceil((state.lockedUntil.getTime() - now.getTime()) / 60_000));
      throw new AppError(
        `Demasiados intentos fallidos. Intenta de nuevo en ${minutes} minuto(s).`,
        429,
        CODE_ERROR.BLOCKED
      );
    }
    if (state.expiresAt && state.expiresAt <= now) {
      await OrderSecurity.updateOne(
        { orderId: order._id, [`${kind}.status`]: OrderCodeStatus.PENDING },
        { $set: { [`${kind}.status`]: OrderCodeStatus.EXPIRED } }
      );
      throw new AppError('El código caducó. Contacta con soporte.', 409, CODE_ERROR.EXPIRED);
    }

    const normalized = normalizeOrderCode(params.code);
    const hash = hashOrderCode(orderId, kind, normalized);

    // ── Consumo atómico ──
    const consumed = await OrderSecurity.findOneAndUpdate(
      {
        orderId: order._id,
        [`${kind}.hash`]: hash,
        [`${kind}.status`]: OrderCodeStatus.PENDING,
        $and: [
          { $or: [{ [`${kind}.expiresAt`]: null }, { [`${kind}.expiresAt`]: { $gt: now } }] },
          { $or: [{ [`${kind}.lockedUntil`]: null }, { [`${kind}.lockedUntil`]: { $lte: now } }] },
        ],
      },
      {
        $set: {
          [`${kind}.status`]: OrderCodeStatus.USED,
          [`${kind}.usedAt`]: now,
          [`${kind}.verifiedBy`]: new Types.ObjectId(access.userId),
          [`${kind}.verifiedRole`]: access.participant,
          [`${kind}.lockedUntil`]: null,
        },
      },
      { new: true }
    );

    if (consumed) return { security: consumed, verifiedAt: now };

    // ── Intento fallido ──
    return this.registerFailure(order._id.toString(), kind);
  }

  /**
   * Contabiliza un intento fallido y castiga si se pasa del límite.
   *
   * El `$inc` va en la misma escritura que la lectura del nuevo valor, así
   * que dos intentos simultáneos suman dos y no uno: un atacante no puede
   * paralelizar para gastar menos presupuesto de intentos del que gasta.
   */
  private async registerFailure(orderId: string, kind: OrderCodeKind): Promise<never> {
    const { maxAttempts, lockMinutes } = config.orderFlow.code;

    const updated = await OrderSecurity.findOneAndUpdate(
      { orderId },
      { $inc: { [`${kind}.attempts`]: 1 } },
      { new: true }
    );

    if (!updated) {
      throw new AppError('Código inválido o ya utilizado', 409, CODE_ERROR.INVALID);
    }

    const state = updated[kind];

    // El código correcto llegó tarde: alguien ya lo consumió.
    if (state.status === OrderCodeStatus.USED) {
      throw new AppError('Código inválido o ya utilizado', 409, CODE_ERROR.ALREADY_USED);
    }

    if (state.attempts >= maxAttempts) {
      const lockedUntil = new Date(Date.now() + lockMinutes * 60_000);
      await OrderSecurity.updateOne(
        { orderId, [`${kind}.status`]: OrderCodeStatus.PENDING },
        { $set: { [`${kind}.lockedUntil`]: lockedUntil, [`${kind}.attempts`]: 0 } }
      );
      throw new AppError(
        `Demasiados intentos fallidos. Intenta de nuevo en ${lockMinutes} minutos.`,
        429,
        CODE_ERROR.BLOCKED
      );
    }

    const remaining = maxAttempts - state.attempts;
    throw new AppError(
      `Código incorrecto. Te quedan ${remaining} intento(s).`,
      400,
      CODE_ERROR.INVALID
    );
  }
}

export const orderSecurityService = new OrderSecurityService();
