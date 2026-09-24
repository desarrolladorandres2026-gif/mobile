import type { Server as SocketServer } from 'socket.io';

/**
 * Registro del `io` a nivel de módulo.
 *
 * Los controladores ya reciben `io` con `req.app.get('io')`, pero las
 * notificaciones se disparan desde dentro de la capa de servicios
 * (`order.service.ts` → `notification.service.ts`), donde no hay `req`.
 * Importar `io` desde `app.ts` crearía un ciclo (app → routes →
 * controllers → services → app), así que `app.ts` lo inyecta aquí una
 * sola vez tras `initializeSocket`.
 */
let io: SocketServer | null = null;

export const setIO = (server: SocketServer): void => {
  io = server;
};

export const getIO = (): SocketServer | null => io;

/**
 * La sala `admin` única se dividió por permiso (Fase 1): quien la recibe lo
 * decide `sockets/index.ts` al conectar (`orders:view_all`, `drivers:track`,
 * `sos:view`). Los NOMBRES de evento no cambian.
 */
export type AdminScope = 'orders' | 'fleet' | 'sos';
export const adminRoom = (scope: AdminScope): string => `admin:${scope}`;

/** Emite a la sala de admin de ese ámbito. `target` puede ser el `io` de `req.app.get('io')`. */
export const emitToAdmin = (
  target: { to: SocketServer['to'] } | null | undefined,
  scope: AdminScope,
  event: string,
  payload: unknown
): void => {
  target?.to(adminRoom(scope)).emit(event, payload);
};

/** Emite un evento a la sala personal de un usuario (`user:<id>`). */
export const emitToUser = (
  userId: string,
  event: string,
  payload: unknown
): void => {
  io?.to(`user:${userId}`).emit(event, payload);
};

interface AcceptedPing {
  driverId?: string;
  orderId?: string | null;
  location?: { lat: number; lng: number };
  recordedAt?: Date;
}

interface PingDetail {
  heading?: number;
  speed?: number;
  accuracy?: number;
  batteryLevel?: number;
}

/**
 * Reparte una posición aceptada a quien tiene derecho a verla.
 *
 * Está aquí, y no dentro del handler del socket, porque una posición entra
 * por dos puertas: el WebSocket (el camino normal) y `POST /tracking/ping`
 * (el respaldo, y el que usa la tarea en segundo plano de Android cuando
 * el sistema ya cerró el socket). Si cada puerta armara su propio evento,
 * el cliente recibiría dos formas distintas del mismo hecho y la pantalla
 * de seguimiento tendría que saber por dónde entró — que es exactamente lo
 * que no debe saber.
 *
 * Las tres salas son tres audiencias con permisos distintos, ya resueltos
 * en otra parte:
 *
 * - `admin` — el mapa de flota. Ve a todo el mundo.
 * - `driver:tracking:<userId>` — quien se suscribió y pasó la comprobación
 *   de `track:driver`, que exige un pedido activo con ese repartidor.
 * - `order:<orderId>` — la sala del pedido, cuya pertenencia ya validó
 *   `resolveOrderAccess`.
 */
export const emitDriverLocation = (
  userId: string,
  ping: AcceptedPing,
  detail: PingDetail = {}
): void => {
  if (!io || !ping.location) return;

  const payload = {
    driverId: userId,
    driverProfileId: ping.driverId ?? null,
    orderId: ping.orderId ?? null,
    location: ping.location,
    heading: detail.heading ?? null,
    speed: detail.speed ?? null,
    accuracy: detail.accuracy ?? null,
    batteryLevel: detail.batteryLevel ?? null,
    recordedAt: (ping.recordedAt ?? new Date()).toISOString(),
  };

  io.to(adminRoom('fleet')).emit('driver:location:update', payload);
  io.to(`driver:tracking:${userId}`).emit('driver:location:update', payload);
  if (ping.orderId) io.to(`order:${ping.orderId}`).emit('driver:location:update', payload);
};
