import { Types } from 'mongoose';
import { config } from '../config';
import { AppError } from '../middlewares';
import { OrderMessage, IOrderMessage } from '../models';
import { OrderStatus, UserRole } from '../types';
import { OrderAccess, assertParticipant } from './orderAccess.service';

export const CHAT_ERROR = {
  CLOSED: 'CHAT_CLOSED',
  EMPTY: 'CHAT_EMPTY_MESSAGE',
  TOO_LONG: 'CHAT_MESSAGE_TOO_LONG',
  RATE_LIMITED: 'CHAT_RATE_LIMITED',
  NO_DRIVER: 'CHAT_NO_DRIVER',
} as const;

/**
 * Estados en los que cliente y domiciliario tienen algo que decirse.
 *
 * Antes de `ready` no hay repartidor con quien hablar; después de
 * `delivered` la conversación queda como historial pero cerrada — un hilo
 * que sigue abierto sobre un pedido terminado es un canal de mensajería
 * gratuito entre dos desconocidos, no una función de reparto.
 */
const CHAT_OPEN_STATUSES: OrderStatus[] = [
  OrderStatus.READY,
  OrderStatus.PICKED_UP,
  OrderStatus.ON_WAY,
];

export interface ChatMessageView {
  id: string;
  orderId: string;
  senderId: string;
  senderRole: UserRole;
  message: string;
  mine: boolean;
  readAt: Date | null;
  createdAt: Date;
}

// ── Anti-spam por remitente y pedido ─────────────────────────────────
//
// El limitador global de Express cuenta por IP, que en móvil es una NAT
// compartida por medio barrio: no sirve para "este usuario está
// inundando este pedido". Esta ventana deslizante cuenta lo que de verdad
// importa —usuario + pedido— y vive en memoria porque es información
// efímera que no merece un viaje a la base de datos por mensaje.
const sendWindows = new Map<string, number[]>();

function hitRateLimit(key: string): boolean {
  const { maxPerWindow, windowMs } = config.orderFlow.chat;
  const now = Date.now();
  const recent = (sendWindows.get(key) ?? []).filter((at) => now - at < windowMs);

  if (recent.length >= maxPerWindow) {
    sendWindows.set(key, recent);
    return true;
  }

  recent.push(now);
  sendWindows.set(key, recent);

  // Limpieza oportunista: sin esto el mapa crece con cada pedido servido
  // y no baja nunca, que es una fuga de memoria a fuego lento.
  if (sendWindows.size > 5000) {
    for (const [k, stamps] of sendWindows) {
      if (stamps.every((at) => now - at >= windowMs)) sendWindows.delete(k);
    }
  }

  return false;
}

/** Para las pruebas: reinicia los contadores entre casos. */
export function resetChatRateLimit(): void {
  sendWindows.clear();
}

/**
 * Limpia el texto de un mensaje.
 *
 * Se quitan los caracteres de control y los invisibles (que sirven para
 * suplantar remitentes, romper el renderizado o esconder texto), se
 * normaliza Unicode para que dos formas de la misma letra no cuenten
 * distinto y se acotan los saltos de línea.
 *
 * No se escapan `<` ni `>`: el hilo se pinta como texto plano en la app y
 * React escapa por su cuenta en los paneles. Convertir "2 < 3" en
 * "2 &lt; 3" sería corromper el mensaje para protegerse de un renderizado
 * que nadie hace.
 */
export function sanitizeMessage(raw: string): string {
  const cleaned = (raw ?? '')
    .normalize('NFC')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    // Espacios horizontales repetidos a uno. Quitar un carácter invisible
    // deja un hueco doble donde antes había uno, y una tanda de cien
    // espacios es una forma barata de descuadrar el hilo en pantalla.
    .replace(/[^\S\n]{2,}/g, ' ')
    .trim();

  return cleaned;
}

export class OrderChatService {
  /** Si el pedido admite mensajes nuevos ahora mismo. */
  isOpen(access: OrderAccess): boolean {
    return (
      !!access.assignedDriverId && CHAT_OPEN_STATUSES.includes(access.order.status)
    );
  }

  /**
   * Historial del pedido.
   *
   * Cualquier parte del pedido puede leerlo —incluido un administrador,
   * que para eso existe el soporte— pero nadie más: el filtro es siempre
   * `orderId`, que ya viene resuelto y autorizado.
   */
  async list(
    access: OrderAccess,
    options: { page?: number; limit?: number } = {}
  ): Promise<{ messages: ChatMessageView[]; meta: any; isOpen: boolean }> {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(100, Math.max(1, options.limit ?? 50));

    const filter = { orderId: access.order._id };
    const [messages, total] = await Promise.all([
      OrderMessage.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      OrderMessage.countDocuments(filter),
    ]);

    return {
      // Se consultan del más nuevo al más viejo para paginar bien, y se
      // devuelven en orden de lectura.
      messages: messages.reverse().map((message) => this.toView(message, access.userId)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      isOpen: this.isOpen(access),
    };
  }

  /**
   * Publica un mensaje en el hilo del pedido.
   *
   * Solo cliente y domiciliario escriben. Un administrador puede leer para
   * resolver una disputa, pero no hablar: un mensaje de soporte disfrazado
   * de mensaje del cliente envenenaría la única prueba de lo que se
   * acordó entre las partes.
   */
  async send(access: OrderAccess, rawMessage: string): Promise<ChatMessageView> {
    assertParticipant(access, ['client', 'driver'], 'escribir');

    if (!access.assignedDriverId) {
      throw new AppError(
        'Todavía no hay domiciliario asignado a este pedido',
        409,
        CHAT_ERROR.NO_DRIVER
      );
    }

    if (!this.isOpen(access)) {
      throw new AppError(
        'El chat de este pedido está cerrado',
        409,
        CHAT_ERROR.CLOSED
      );
    }

    const message = sanitizeMessage(rawMessage);
    if (!message) {
      throw new AppError('El mensaje está vacío', 400, CHAT_ERROR.EMPTY);
    }
    if (message.length > config.orderFlow.chat.maxLength) {
      throw new AppError(
        `El mensaje supera los ${config.orderFlow.chat.maxLength} caracteres`,
        400,
        CHAT_ERROR.TOO_LONG
      );
    }

    if (hitRateLimit(`${access.order._id}:${access.userId}`)) {
      throw new AppError(
        'Estás enviando mensajes demasiado rápido',
        429,
        CHAT_ERROR.RATE_LIMITED
      );
    }

    const created = await OrderMessage.create({
      orderId: access.order._id,
      senderId: new Types.ObjectId(access.userId),
      // El rol se toma de la relación con el pedido, jamás del cuerpo de la
      // petición: si el cliente pudiera declararse "driver", el hilo dejaría
      // de probar quién dijo qué.
      senderRole: access.participant === 'driver' ? UserRole.DRIVER : UserRole.CLIENT,
      message,
    });

    return this.toView(created, access.userId);
  }

  /**
   * Marca como leídos los mensajes que le escribieron a quien consulta.
   *
   * El filtro `senderId: { $ne }` es lo que impide marcar como leídos los
   * propios: el acuse de recibo debe significar "el otro lo vio".
   */
  async markRead(access: OrderAccess): Promise<number> {
    assertParticipant(access, ['client', 'driver'], 'marcar como leído');

    const result = await OrderMessage.updateMany(
      {
        orderId: access.order._id,
        senderId: { $ne: new Types.ObjectId(access.userId) },
        readAt: null,
      },
      { $set: { readAt: new Date() } }
    );

    return result.modifiedCount;
  }

  async unreadCount(access: OrderAccess): Promise<number> {
    return OrderMessage.countDocuments({
      orderId: access.order._id,
      senderId: { $ne: new Types.ObjectId(access.userId) },
      readAt: null,
    });
  }

  private toView(message: IOrderMessage, viewerId: string): ChatMessageView {
    return {
      id: message._id.toString(),
      orderId: message.orderId.toString(),
      senderId: message.senderId.toString(),
      senderRole: message.senderRole,
      message: message.message,
      mine: message.senderId.toString() === viewerId,
      readAt: message.readAt,
      createdAt: message.createdAt,
    };
  }
}

export const orderChatService = new OrderChatService();
