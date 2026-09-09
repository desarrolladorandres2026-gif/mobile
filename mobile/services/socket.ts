import { AppState, type NativeEventSubscription } from 'react-native';
import { io, Socket } from 'socket.io-client';
import { SOCKET_URL } from '../constants';
import { useAuthStore } from '../stores/authStore';

/** Oferta de un pedido, tal como la manda el reparto automático. */
export interface OrderOffer {
  orderId: string;
  orderNumber: string;
  businessName?: string;
  /** Ronda de la cascada. Cuanto más alta, más gente la está viendo. */
  round: number;
  /** Cuándo deja de ser suya. El contador de la pantalla sale de aquí. */
  expiresAt: string;
  etaSeconds: number;
}

export interface VerificationRequest {
  verificationId: string;
  type: string;
  dueAt: string;
}


class SocketService {
  private socket: Socket | null = null;
  private appStateSub: NativeEventSubscription | null = null;

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
      /**
       * Sin tope de reintentos.
       *
       * Antes eran 10, que con el retroceso exponencial se agotan en menos
       * de un minuto. Un túnel, un ascensor o un par de minutos en segundo
       * plano bastaban para que el socket **se rindiera para siempre**: la
       * pantalla de seguimiento se quedaba congelada mostrando "Sin señal"
       * con wifi perfecto, y solo se arreglaba cerrando la app.
       *
       * En una app de domicilios la conexión no es un lujo que se intenta
       * un rato: es cómo el cliente sabe dónde está su pedido. Se reintenta
       * mientras haga falta, con el retroceso acotado abajo para no castigar
       * la batería.
       */
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      /** Techo del retroceso: sin él crecería hasta minutos entre intentos. */
      reconnectionDelayMax: 15000,
      randomizationFactor: 0.5,
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

    this.watchAppState();
  }

  /**
   * Reconecta al volver a primer plano.
   *
   * El sistema operativo congela los temporizadores de una app en segundo
   * plano, así que el reintento programado por socket.io puede no llegar a
   * dispararse nunca. Volver a la app es justo el momento en que el usuario
   * quiere ver su pedido al día, así que se fuerza el intento en vez de
   * esperar a que el retroceso decida.
   */
  private watchAppState() {
    if (this.appStateSub) return;

    this.appStateSub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (this.socket && !this.socket.connected) this.socket.connect();
    });
  }

  disconnect() {
    this.appStateSub?.remove();
    this.appStateSub = null;
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

  offOrderStatusChanged(callback: (data: any) => void) {
    this.socket?.off('order:status:changed', callback);
  }

  onOrderIncoming(callback: (data: any) => void) {
    this.socket?.on('order:incoming', callback);
  }

  offOrderIncoming(callback: (data: any) => void) {
    this.socket?.off('order:incoming', callback);
  }

  onOrderAvailable(callback: (data: any) => void) {
    this.socket?.on('order:available', callback);
  }

  offOrderAvailable(callback: (data: any) => void) {
    this.socket?.off('order:available', callback);
  }

  /**
   * El reparto lleva varias vueltas sin que nadie acepte.
   *
   * El servidor emitía esto solo a la sala `admin`: quien había pagado se
   * quedaba mirando una pantalla que no cambiaba, sin saber si su pedido
   * seguía vivo. Ahora también le llega a él.
   */
  onDispatchStalled(callback: (data: any) => void) {
    this.socket?.on('order:dispatch:stalled', callback);
  }

  offDispatchStalled(callback: (data: any) => void) {
    this.socket?.off('order:dispatch:stalled', callback);
  }

  /** Soporte respondió un PQRS. Backend: `support.service.ts:96`. */
  onSupportReplied(callback: (data: any) => void) {
    this.socket?.on('support:replied', callback);
  }

  offSupportReplied(callback: (data: any) => void) {
    this.socket?.off('support:replied', callback);
  }

  // ── Oferta de reparto ──
  //
  // El servidor ya no espera a que el domiciliario mire la lista: le ofrece
  // el pedido directamente, por rondas, y solo quien tiene la oferta puede
  // aceptarla mientras dura. Ver `dispatch.service.ts` en el backend.
  onOrderOffer(callback: (data: OrderOffer) => void) {
    this.socket?.on('order:offer', callback);
  }

  offOrderOffer(callback: (data: OrderOffer) => void) {
    this.socket?.off('order:offer', callback);
  }

  /** El servidor pide una selfie para comprobar quién está conduciendo. */
  onVerificationRequested(callback: (data: VerificationRequest) => void) {
    this.socket?.on('driver:verification:requested', callback);
  }

  offVerificationRequested(callback: (data: VerificationRequest) => void) {
    this.socket?.off('driver:verification:requested', callback);
  }

  emitNewOrder(orderData: any) {
    this.socket?.emit('order:new', orderData);
  }

  emitOrderStatusUpdate(data: any) {
    this.socket?.emit('order:status:update', data);
  }

  // ── Sala del pedido: chat en vivo y llegadas ──
  //
  // Entrar a la sala no es opcional ni automático: el servidor comprueba
  // la relación con el pedido antes de admitir el socket (ver
  // `resolveOrderAccess` en `sockets/index.ts`), así que unirse a la sala
  // de un pedido ajeno simplemente no tiene efecto — no llega nada por ahí.
  joinOrderRoom(orderId: string) {
    this.socket?.emit('order:join', orderId);
  }

  leaveOrderRoom(orderId: string) {
    this.socket?.emit('order:leave', orderId);
  }

  onDriverArrived(callback: (data: any) => void) {
    this.socket?.on('order:driver:arrived', callback);
  }
  offDriverArrived(callback: (data: any) => void) {
    this.socket?.off('order:driver:arrived', callback);
  }

  onChatMessage(callback: (data: any) => void) {
    this.socket?.on('order:chat:message', callback);
  }
  offChatMessage(callback: (data: any) => void) {
    this.socket?.off('order:chat:message', callback);
  }

  onChatRead(callback: (data: any) => void) {
    this.socket?.on('order:chat:read', callback);
  }
  offChatRead(callback: (data: any) => void) {
    this.socket?.off('order:chat:read', callback);
  }

  emitChatTyping(orderId: string, typing: boolean) {
    this.socket?.emit('order:chat:typing', { orderId, typing });
  }
  onChatTyping(callback: (data: any) => void) {
    this.socket?.on('order:chat:typing', callback);
  }
  offChatTyping(callback: (data: any) => void) {
    this.socket?.off('order:chat:typing', callback);
  }

  // ── Llamadas: notificación de estado ──
  //
  // El timbrado, la respuesta y el fin de la llamada son hechos que confirma
  // el backend (`OrderCall`), así que se avisan por aquí. La sala
  // `call:<id>` (unida con `joinCallRoom`) es aparte y solo transporta la
  // señalización WebRTC — nunca reemplaza esta confirmación de estado.
  onCallIncoming(callback: (data: any) => void) {
    this.socket?.on('order:call:incoming', callback);
  }
  offCallIncoming(callback: (data: any) => void) {
    this.socket?.off('order:call:incoming', callback);
  }

  onCallAnswered(callback: (data: any) => void) {
    this.socket?.on('order:call:answered', callback);
  }
  offCallAnswered(callback: (data: any) => void) {
    this.socket?.off('order:call:answered', callback);
  }

  onCallEnded(callback: (data: any) => void) {
    this.socket?.on('order:call:ended', callback);
  }
  offCallEnded(callback: (data: any) => void) {
    this.socket?.off('order:call:ended', callback);
  }

  joinCallRoom(orderId: string, callId: string) {
    this.socket?.emit('call:join', { orderId, callId });
  }
  leaveCallRoom(callId: string) {
    this.socket?.emit('call:leave', callId);
  }
  emitCallSignal(callId: string, signal: unknown) {
    this.socket?.emit('call:signal', { callId, signal });
  }
  onCallSignal(callback: (data: any) => void) {
    this.socket?.on('call:signal', callback);
  }
  offCallSignal(callback: (data: any) => void) {
    this.socket?.off('call:signal', callback);
  }
  onCallPeerJoined(callback: (data: any) => void) {
    this.socket?.on('call:peer:joined', callback);
  }
  offCallPeerJoined(callback: (data: any) => void) {
    this.socket?.off('call:peer:joined', callback);
  }

  // ── Seguimiento GPS ──
  //
  // El servidor filtra: descarta lo impreciso, lo demasiado frecuente y lo
  // que no se ha movido (ver `tracking.service.ts`). La app no recibe
  // confirmación de cada punto a propósito — responder a cada ping para
  // decir "descartado" gastaría los datos que el filtro ahorra.
  emitDriverLocation(payload: {
    lat: number;
    lng: number;
    accuracy?: number;
    heading?: number;
    speed?: number;
    batteryLevel?: number;
    isMocked?: boolean;
    recordedAt?: string;
  }) {
    this.socket?.emit('driver:location', payload);
  }

  emitDriverStatus(status: string) {
    this.socket?.emit('driver:status', status);
  }

  onDriverLocationUpdate(callback: (data: any) => void) {
    this.socket?.on('driver:location:update', callback);
  }

  offDriverLocationUpdate(callback: (data: any) => void) {
    this.socket?.off('driver:location:update', callback);
  }

  /**
   * Suscribe la pantalla a la posición de un repartidor.
   *
   * Pedirlo no basta: el servidor comprueba contra la base que quien pide
   * tiene un pedido activo con ese repartidor (ver `track:driver` en
   * `sockets/index.ts`). Suscribirse a un repartidor ajeno simplemente no
   * recibe nada.
   */
  trackDriver(driverUserId: string) {
    this.socket?.emit('track:driver', driverUserId);
  }

  untrackDriver(driverUserId: string) {
    this.socket?.emit('untrack:driver', driverUserId);
  }

  onTrackingDenied(callback: (data: any) => void) {
    this.socket?.on('driver:tracking:denied', callback);
  }
  offTrackingDenied(callback: (data: any) => void) {
    this.socket?.off('driver:tracking:denied', callback);
  }

  // ── Ruta del repartidor ──
  //
  // Va por socket porque el recálculo ocurre conduciendo: el canal ya está
  // abierto mandando posiciones y no hay que esperar un handshake nuevo
  // justo en el momento en que el repartidor está perdido.
  requestRoute(orderId: string, from?: { lat: number; lng: number }) {
    this.socket?.emit('driver:route', { orderId, ...(from ?? {}) });
  }

  onRouteUpdated(callback: (data: any) => void) {
    this.socket?.on('driver:route:updated', callback);
  }
  offRouteUpdated(callback: (data: any) => void) {
    this.socket?.off('driver:route:updated', callback);
  }

  onRouteError(callback: (data: any) => void) {
    this.socket?.on('driver:route:error', callback);
  }
  offRouteError(callback: (data: any) => void) {
    this.socket?.off('driver:route:error', callback);
  }

  // ── Cleanup ──
  // OJO: solo se usa al hacer logout (disconnect()). Nunca llamarlo desde el
  // cleanup de una pantalla: el socket es un singleton compartido y esto
  // borraría también los listeners registrados por otras pantallas activas.
  removeAllListeners() {
    this.socket?.removeAllListeners();
  }
}

export const socketService = new SocketService();
