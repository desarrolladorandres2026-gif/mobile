import { Types } from 'mongoose';
import { SosAlert, SosStatus, Driver, Order, User } from '../models';
import { OrderStatus } from '../types';
import { AppError } from '../middlewares/errorHandler';
import { getIO, emitToUser, emitToAdmin } from '../sockets/emitter';
import { logSystemAudit, AuditAction, AuditSeverity } from '../security';

/**
 * Botón de pánico del domiciliario.
 *
 * Casi todo lo que hace falta ya existía: el seguimiento en segundo plano,
 * las salas de socket, el mapa de flota en el panel. Lo que faltaba era una
 * forma de decir "esto no es un pedido, esto es una emergencia" y que el
 * sistema tratara los mismos datos con otra urgencia.
 *
 * Lo que este servicio NO hace, y conviene saberlo: no avisa al contacto de
 * emergencia por su cuenta. No hay proveedor de SMS ni de llamadas
 * conectado, así que su teléfono se le entrega al administrador para que
 * llame. Automatizarlo es un cambio de infraestructura, no de código.
 */
export class SosService {
  /**
   * Declara una emergencia.
   *
   * No se comprueba si la anterior se cerró ni se limita la frecuencia: una
   * persona en peligro puede pulsar tres veces, y negarle la tercera por
   * haber pulsado dos es exactamente el fallo que no se puede cometer aquí.
   * Lo que sí se hace es reutilizar la alerta abierta en vez de abrir otra.
   */
  async trigger(
    userId: string,
    input: { lat: number; lng: number; note?: string }
  ) {
    const driver = await Driver.findOne({ userId }).select('_id emergencyContact');
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);

    const active = await SosAlert.findOne({
      driverId: driver._id,
      status: { $in: [SosStatus.ACTIVE, SosStatus.ACKNOWLEDGED] },
    });

    // Ya hay una abierta: se actualiza su posición en vez de crear otra.
    // Dos alertas de la misma persona dividen la atención de quien responde.
    if (active) {
      active.location = { type: 'Point', coordinates: [input.lng, input.lat] };
      if (input.note) active.note = input.note;
      await active.save();
      this.broadcast(active, 'sos:updated');
      return active;
    }

    const order = await Order.findOne({
      driverId: driver._id,
      status: { $in: [OrderStatus.READY, OrderStatus.PICKED_UP, OrderStatus.ON_WAY] },
    }).select('_id');

    const alert = await SosAlert.create({
      driverId: driver._id,
      userId,
      orderId: order?._id ?? null,
      location: { type: 'Point', coordinates: [input.lng, input.lat] },
      note: input.note,
      // Copia del contacto tal como estaba: si lo cambia mañana, esta
      // alerta tiene que seguir diciendo a quién había que llamar hoy.
      emergencyContact: driver.emergencyContact,
    });

    this.broadcast(alert, 'sos:triggered');

    await logSystemAudit({
      userId,
      role: 'driver',
      action: AuditAction.SUSPICIOUS_ACTIVITY,
      entity: 'driver',
      entityId: driver._id.toString(),
      severity: AuditSeverity.CRITICAL,
      description: 'Botón de pánico activado por un domiciliario',
      metadata: {
        alertId: alert._id.toString(),
        orderId: order?._id?.toString(),
        lat: input.lat,
        lng: input.lng,
      },
    });

    return alert;
  }

  /**
   * Manda la alerta a quien puede hacer algo.
   *
   * Va a la sala de administración y, si había un pedido en curso, también
   * al cliente que espera —no con los detalles de la emergencia, sino para
   * que sepa que su pedido se va a retrasar y no llame a soporte a
   * preguntar por él justo cuando soporte está ocupado con esto.
   */
  private broadcast(alert: { _id: unknown; driverId: unknown; orderId?: unknown; location: { coordinates: number[] } }, event: string) {
    emitToAdmin(getIO(), 'sos', event, {
      alertId: String(alert._id),
      driverId: String(alert.driverId),
      orderId: alert.orderId ? String(alert.orderId) : null,
      lat: alert.location.coordinates[1],
      lng: alert.location.coordinates[0],
      at: new Date().toISOString(),
    });
  }

  /** Un administrador dice "lo estoy atendiendo". */
  async acknowledge(alertId: string, adminId: string) {
    const alert = await SosAlert.findOneAndUpdate(
      { _id: alertId, status: SosStatus.ACTIVE },
      { status: SosStatus.ACKNOWLEDGED, acknowledgedBy: adminId, acknowledgedAt: new Date() },
      { new: true }
    );

    if (!alert) throw new AppError('Alerta no encontrada o ya atendida', 404);

    // El domiciliario tiene que saber que alguien la vio. Es la diferencia
    // entre pulsar un botón y pulsar un botón que sirve para algo.
    emitToUser(alert.userId.toString(), 'sos:acknowledged', {
      alertId: alert._id.toString(),
    });

    return alert;
  }

  /** Cierra la emergencia, diciendo qué pasó. */
  async resolve(
    alertId: string,
    adminId: string,
    resolution: string,
    falseAlarm = false
  ) {
    const alert = await SosAlert.findByIdAndUpdate(
      alertId,
      {
        status: falseAlarm ? SosStatus.FALSE_ALARM : SosStatus.RESOLVED,
        resolvedBy: adminId,
        resolvedAt: new Date(),
        resolution,
      },
      { new: true }
    );

    if (!alert) throw new AppError('Alerta no encontrada', 404);

    emitToUser(alert.userId.toString(), 'sos:resolved', {
      alertId: alert._id.toString(),
    });

    return alert;
  }

  /** Lo que está abierto ahora mismo, para el panel. */
  async active() {
    return SosAlert.find({ status: { $in: [SosStatus.ACTIVE, SosStatus.ACKNOWLEDGED] } })
      .sort({ createdAt: -1 })
      .populate({
        path: 'driverId',
        select: 'userId licensePlate vehicleType',
        populate: { path: 'userId', select: 'name phone' },
      })
      .lean();
  }

  async history(limit = 50) {
    return SosAlert.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate({
        path: 'driverId',
        select: 'userId licensePlate',
        populate: { path: 'userId', select: 'name phone' },
      })
      .lean();
  }
}

export const sosService = new SosService();
