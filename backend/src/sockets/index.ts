import { Server as SocketServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { config } from '../config';
import { sessionManager } from '../security';
import { verifyAccessToken, isLegacyTokenAcceptable, DecodedToken } from '../utils/token';
import { Business, Driver, Order, OrderCall, User } from '../models';
import { OrderCallStatus, OrderStatus } from '../types';
import { resolveOrderAccess } from '../services/orderAccess.service';
import {
  ingestPing,
  forgetDriver,
  getDriverRoute,
  LocationPing,
} from '../services/tracking.service';
import { emitDriverLocation } from './emitter';

export interface SocketIdentity {
  userId: string;
  role: string;
  /** Sesión del token; el socket se une a `session:<id>` para cerrarse si se revoca. */
  sessionId?: string;
}

/**
 * Autentica el handshake de un socket con los mismos criterios que
 * `authenticate` aplica a las peticiones REST.
 *
 * Vive fuera de `initializeSocket` para poder probarse: es código de
 * seguridad, y enterrado dentro de `io.use` no había forma de escribirle
 * una prueba sin levantar un servidor entero.
 *
 * Una firma válida solo prueba que el token se emitió alguna vez, no que la
 * cuenta siga existiendo ni teniendo permiso. Antes esto se quedaba en
 * `jwt.verify`, y la diferencia no era teórica: un usuario borrado seguía
 * conectándose —se vio en los logs tras un seed— y lo mismo valía para uno
 * bloqueado por fraude, que conservaba el socket hasta que caducara su
 * access token. En esa ventana seguía recibiendo eventos de pedidos y,
 * desde que hay seguimiento GPS, emitiendo su ubicación al mapa de flota.
 *
 * Cuesta una lectura a la base por conexión, no por mensaje: un socket se
 * abre una vez y dura horas.
 */
export async function authenticateSocket(token: unknown): Promise<SocketIdentity> {
  if (!token || typeof token !== 'string') throw new Error('Token requerido');

  let decoded: DecodedToken;
  try {
    decoded = verifyAccessToken(token);
  } catch {
    throw new Error('Token inválido o expirado');
  }

  // Igual que `authenticate`: la sesión del token tiene que seguir viva.
  if (decoded.sid) {
    if (!(await sessionManager.isSessionActive(decoded.sid, decoded.id))) {
      throw new Error('Sesión cerrada');
    }
  } else if (!isLegacyTokenAcceptable(decoded)) {
    throw new Error('Token inválido o expirado');
  }

  const user = await User.findById(decoded.id).select('role isActive isBlocked passwordChangedAt');
  if (!user) throw new Error('Usuario no encontrado o desactivado');
  if (user.isBlocked) throw new Error('Cuenta bloqueada');
  if (!user.isActive) throw new Error('Usuario no encontrado o desactivado');

  // Cambiar la contraseña cierra las sesiones abiertas — es la reacción de
  // alguien que cree que le robaron la cuenta, y sería inútil si el socket
  // del atacante sobreviviera. Se truncan los dos lados a segundos porque
  // `iat` no lleva milisegundos: sin eso, todo token recién emitido
  // parecería anterior al cambio que acaba de ocurrir.
  if (user.passwordChangedAt && typeof decoded.iat === 'number') {
    const changedAt = Math.floor(user.passwordChangedAt.getTime() / 1000);
    if (changedAt > decoded.iat) throw new Error('Contraseña cambiada recientemente');
  }

  // El rol sale de la base, no del token: a quien le cambien el rol, su
  // token viejo seguiría afirmando el anterior y lo metería en salas que ya
  // no le corresponden — `admin`, por ejemplo.
  return { userId: decoded.id, role: user.role, sessionId: decoded.sid };
}

export const initializeSocket = (httpServer: HttpServer): SocketServer => {
  const io = new SocketServer(httpServer, {
    cors: {
      origin: config.nodeEnv === 'development' ? '*' : (config.cors.origins as string[]),
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    try {
      const identity = await authenticateSocket(token);
      (socket as any).userId = identity.userId;
      (socket as any).userRole = identity.role;
      (socket as any).sessionId = identity.sessionId;
      next();
    } catch (error) {
      next(error as Error);
    }
  });

  io.on('connection', async (socket) => {
    const userId = (socket as any).userId as string;
    const userRole = (socket as any).userRole as string;

    // Join personal room (always first)
    socket.join(`user:${userId}`);

    // Sala de la sesión: revocarla (logout, "cerrar en otros dispositivos",
    // cambio de contraseña) desconecta este socket al instante.
    const sessionId = (socket as any).sessionId as string | undefined;
    if (sessionId) socket.join(`session:${sessionId}`);

    // Join role-based rooms
    if (userRole === 'admin') {
      socket.join('admin');
    }

    if (userRole === 'driver') {
      socket.join('drivers');

      // ── Posición del repartidor ──
      //
      // El handler ya no escribe en la base directamente: delega en
      // `ingestPing`, que filtra (coordenadas válidas, precisión aceptable,
      // frecuencia, movimiento mínimo) y decide si el punto merece una
      // escritura. Antes, cada fix del GPS provocaba un `findOneAndUpdate`
      // sin filtro ninguno; con un repartidor reportando cada dos segundos
      // eso son ~14.000 escrituras por turno, la mayoría repitiendo que
      // sigue en el mismo semáforo.
      //
      // El reparto lo hace `emitDriverLocation` y no este archivo, porque
      // una posición también entra por `POST /tracking/ping` y las dos
      // puertas tienen que producir el mismo evento.
      socket.on('driver:location', async (data: LocationPing) => {
        try {
          const result = await ingestPing(userId, data);
          if (result.accepted) emitDriverLocation(userId, result, data);
          // Un ping descartado no se responde ni se registra: es el caso
          // normal y avisarlo gastaría más datos de los que ahorra el
          // filtro.
        } catch (err) {
          console.error('[Socket] Error actualizando ubicación del conductor:', err);
        }
      });

      /**
       * El repartidor pide su ruta, o la vuelve a pedir tras desviarse.
       *
       * Va por socket y no solo por REST porque el recálculo ocurre justo
       * cuando el repartidor está conduciendo: es el momento en el que
       * menos conviene abrir una conexión nueva y esperar un handshake.
       * El socket ya está abierto mandando posiciones.
       */
      socket.on('driver:route', async (data: { orderId: string; lat?: number; lng?: number }) => {
        try {
          if (!data?.orderId) return;
          const current =
            typeof data.lat === 'number' && typeof data.lng === 'number'
              ? { lat: data.lat, lng: data.lng }
              : undefined;
          const route = await getDriverRoute(data.orderId, { _id: userId, role: userRole }, current);
          socket.emit('driver:route:updated', route);
        } catch (err) {
          socket.emit('driver:route:error', {
            orderId: data?.orderId,
            message: err instanceof Error ? err.message : 'No pudimos calcular la ruta',
          });
        }
      });

      socket.on('driver:status', async (status: string) => {
        try {
          const validStatuses = ['available', 'busy', 'offline'];
          if (!validStatuses.includes(status)) return;
          await Driver.findOneAndUpdate({ userId }, { status });
          io.to('admin').emit('driver:status:update', { driverId: userId, status });
        } catch (err) {
          console.error('[Socket] Error actualizando estado del conductor:', err);
        }
      });

      // Offline cuando se desconecta
      socket.on('disconnect', async () => {
        try {
          await Driver.findOneAndUpdate({ userId }, { status: 'offline' });
          // El estado en memoria del filtro de pings muere con la sesión.
          // Si no, un repartidor que vuelve tras horas sería comparado
          // contra su última posición de esta mañana y su primer ping se
          // descartaría por "no se ha movido lo suficiente".
          forgetDriver(userId);
        } catch (_) {}
      });
    }

    if (userRole === 'business') {
      // Business users join their own business rooms for real-time order events
      try {
        const businesses = await Business.find({ ownerId: userId }).select('_id');
        for (const biz of businesses) {
          socket.join(`business:${biz._id.toString()}`);
        }
      } catch (err) {
        console.error('[Socket] Error cargando negocios del usuario:', err);
      }
    }

    // Client: track a specific driver (for order tracking)
    socket.on('track:driver', async (driverId: string) => {
      // A driver location is personal data. A socket may subscribe only when
      // the viewer is participating in an active delivery, owns its commerce,
      // or is an administrator — never merely because it knows a driver id.
      const activeStatuses = [OrderStatus.READY, OrderStatus.PICKED_UP, OrderStatus.ON_WAY];
      const driver = await Driver.findOne({ userId: driverId }).select('_id');
      if (!driver) return socket.emit('driver:tracking:denied', { message: 'Domiciliario no encontrado' });
      let allowed = userRole === 'admin';
      if (!allowed && userRole === 'client') {
        allowed = !!(await Order.exists({ driverId: driver._id, clientId: userId, status: { $in: activeStatuses } }));
      }
      if (!allowed && userRole === 'business') {
        const businesses = await Business.find({ ownerId: userId }).select('_id');
        allowed = !!(await Order.exists({ driverId: driver._id, businessId: { $in: businesses.map((b) => b._id) }, status: { $in: activeStatuses } }));
      }
      if (allowed) socket.join(`driver:tracking:${driverId}`);
      else socket.emit('driver:tracking:denied', { message: 'No tienes un pedido activo asociado a este domiciliario' });
    });

    socket.on('untrack:driver', (driverId: string) => {
      socket.leave(`driver:tracking:${driverId}`);
    });

    // ── Sala del pedido: chat en vivo y señalización de llamadas ──
    //
    // Un socket no entra en la sala de un pedido por pedirlo: se resuelve
    // su relación con ese pedido exactamente igual que en la API REST, con
    // la misma función. Si la autorización cambia algún día, cambia en un
    // solo sitio y el canal en tiempo real no se queda atrás — que es como
    // acaban las aplicaciones con una API blindada y un WebSocket abierto.
    socket.on('order:join', async (orderId: string) => {
      try {
        await resolveOrderAccess(orderId, { _id: userId, role: userRole });
        socket.join(`order:${orderId}`);
        socket.emit('order:joined', { orderId });
      } catch {
        socket.emit('order:join:denied', { orderId });
      }
    });

    socket.on('order:leave', (orderId: string) => {
      socket.leave(`order:${orderId}`);
    });

    // "Escribiendo…" es efímero y no se persiste: se retransmite a la sala
    // del pedido y muere ahí.
    socket.on('order:chat:typing', async (data: { orderId: string; typing: boolean }) => {
      if (!data?.orderId) return;
      if (!socket.rooms.has(`order:${data.orderId}`)) return;
      socket.to(`order:${data.orderId}`).emit('order:chat:typing', {
        orderId: data.orderId,
        userId,
        typing: !!data.typing,
      });
    });

    // ── Señalización WebRTC de la llamada ──
    //
    // El servidor no oye nada: solo pasa ofertas, respuestas y candidatos
    // ICE entre dos teléfonos. La autorización se hace al entrar en la
    // sala de la llamada —comprobando contra la base que quien pide es una
    // de las dos partes y que la llamada sigue viva— y no en cada
    // candidato, que llegan a decenas por llamada.
    socket.on('call:join', async (data: { orderId: string; callId: string }) => {
      try {
        if (!data?.orderId || !data?.callId) return;
        const access = await resolveOrderAccess(data.orderId, { _id: userId, role: userRole });
        const call = await OrderCall.findOne({
          _id: data.callId,
          orderId: access.order._id,
          status: { $in: [OrderCallStatus.RINGING, OrderCallStatus.ACTIVE] },
        });
        if (!call) return socket.emit('call:denied', { callId: data.callId });

        const isParty =
          call.callerId.toString() === userId || call.receiverId.toString() === userId;
        if (!isParty) return socket.emit('call:denied', { callId: data.callId });

        socket.join(`call:${data.callId}`);
        socket.to(`call:${data.callId}`).emit('call:peer:joined', { callId: data.callId, userId });
      } catch {
        socket.emit('call:denied', { callId: data?.callId });
      }
    });

    socket.on('call:signal', (data: { callId: string; signal: unknown }) => {
      if (!data?.callId) return;
      // La pertenencia ya se comprobó al unirse; si no está en la sala, el
      // mensaje no va a ninguna parte.
      if (!socket.rooms.has(`call:${data.callId}`)) return;
      socket.to(`call:${data.callId}`).emit('call:signal', {
        callId: data.callId,
        from: userId,
        signal: data.signal,
      });
    });

    socket.on('call:leave', (callId: string) => {
      if (!callId) return;
      socket.to(`call:${callId}`).emit('call:peer:left', { callId, userId });
      socket.leave(`call:${callId}`);
    });

    socket.on('disconnect', () => {
      // Log only in dev
      if (config.nodeEnv === 'development') {
        console.log(`[Socket] Desconectado: ${userId} (${userRole})`);
      }
    });

    if (config.nodeEnv === 'development') {
      console.log(`[Socket] Conectado: ${userId} (${userRole})`);
    }
  });

  return io;
};
