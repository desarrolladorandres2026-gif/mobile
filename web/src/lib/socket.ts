import { io, type Socket } from 'socket.io-client';
import { SOCKET_URL } from './config';
import { ensureFreshAccessToken } from './http';
import { getAccessToken, hasSession, subscribeSession } from './session';

let socket: Socket | null = null;

/**
 * Conexión de tiempo real del cliente.
 *
 * El servidor valida el access token en el handshake y corta la conexión
 * cuando ese token vence (15 min). `auth` es una función para que cada
 * reintento lea el token vigente en lugar del que había al crear el socket,
 * y antes de reconectar se renueva si hace falta.
 */
function create(): Socket {
  const s = io(SOCKET_URL, {
    transports: ['websocket'],
    autoConnect: false,
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 15_000,
    auth: (cb) => cb({ token: getAccessToken() }),
  });

  // Cortada por el servidor (token vencido): no reconecta sola. Se renueva y se reabre.
  s.on('disconnect', (reason) => {
    if (reason === 'io server disconnect' && hasSession()) {
      void ensureFreshAccessToken().then(() => s.connect());
    }
  });
  // Rechazada en el handshake: casi siempre un token vencido. El siguiente
  // reintento automático lee uno nuevo si se renueva ahora.
  s.on('connect_error', () => {
    if (hasSession()) void ensureFreshAccessToken();
  });

  return s;
}

/** Abre la conexión (si no está abierta) con un token vigente. */
export async function connectSocket(): Promise<Socket> {
  await ensureFreshAccessToken();
  socket ??= create();
  if (!socket.connected && !socket.active) socket.connect();
  return socket;
}

export function peekSocket(): Socket | null {
  return socket;
}

// Al cerrar sesión (aquí o en otra pestaña) el socket no puede seguir abierto con la identidad anterior.
subscribeSession(() => {
  if (!hasSession() && socket) {
    socket.disconnect();
    socket = null;
  }
});
