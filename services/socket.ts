import { io, Socket } from 'socket.io-client';
import { SOCKET_URL } from '../constants';
import { useAuthStore } from '../stores/authStore';

class SocketService {
  private socket: Socket | null = null;

  connect() {
    if (!useAuthStore.getState().accessToken) return;

    // Un socket ya existente se reutiliza siempre. Comprobar `connected` no
    // basta: durante el handshake es false, así que una segunda llamada creaba
    // un socket nuevo y abandonaba el anterior, que seguía vivo reintentando
    // y registrando errores por su cuenta.
    if (this.socket) {
      if (!this.socket.connected) this.socket.connect();
      return;
    }

    this.socket = io(SOCKET_URL, {
      // El token se lee en cada intento, no una sola vez al arrancar.
      //
      // Los tokens de acceso duran 15 minutos, así que al abrir la app el que
      // está guardado casi siempre está vencido. Con un objeto fijo aquí, los
      // diez reintentos mandaban el mismo token muerto y nunca entraban. Como
      // función, el reintento que ocurre después de que axios refresca la
      // sesión ya viaja con el token bueno.
      auth: (cb) => cb({ token: useAuthStore.getState().accessToken }),
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
    });

    this.socket.on('connect', () => {
      if (__DEV__) console.log('Socket conectado');
    });

    this.socket.on('disconnect', (reason) => {
      if (__DEV__) console.log('Socket desconectado:', reason);
    });

    this.socket.on('connect_error', (error) => {
      // Un rechazo por token vencido es esperable al abrir la app y se
      // resuelve solo en el siguiente intento, así que no se reporta como
      // error: solo ensuciaba la consola con algo que no requiere acción.
      if (__DEV__) console.log('Socket reintentando:', error.message);
    });
  }

  disconnect() {
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
  }

  /** Si hay canal abierto ahora mismo. Alimenta la banda de "sin conexión". */
  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  getSocket(): Socket | null {
    return this.socket;
  }

  // ── Order Events ──
  onOrderStatusChanged(callback: (data: any) => void) {
    this.socket?.on('order:status:changed', callback);
  }

  onOrderIncoming(callback: (data: any) => void) {
    this.socket?.on('order:incoming', callback);
  }

  onOrderAvailable(callback: (data: any) => void) {
    this.socket?.on('order:available', callback);
  }

  emitNewOrder(orderData: any) {
    this.socket?.emit('order:new', orderData);
  }

  emitOrderStatusUpdate(data: any) {
    this.socket?.emit('order:status:update', data);
  }

  // ── Driver Events ──
  emitDriverLocation(lat: number, lng: number) {
    this.socket?.emit('driver:location', { lat, lng });
  }

  emitDriverStatus(status: string) {
    this.socket?.emit('driver:status', status);
  }

  onDriverLocationUpdate(callback: (data: any) => void) {
    this.socket?.on('driver:location:update', callback);
  }

  // ── Cleanup ──
  removeAllListeners() {
    this.socket?.removeAllListeners();
  }
}

export const socketService = new SocketService();
