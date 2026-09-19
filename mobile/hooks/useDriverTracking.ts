import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, AppStateStatus, Linking, Platform } from 'react-native';
import * as Location from 'expo-location';
import { socketService } from '../services/socket';
import { getMapConfig } from '../lib/mapbox';
import { batteryLevelPercent, isCharging } from '../lib/battery';
import {
  startBackgroundTracking,
  stopBackgroundTracking,
  reportPosition,
} from '../lib/locationTask';
import {
  samplingPolicy,
  samePolicy,
  SamplingPolicy,
  TrackingContext,
} from '../lib/samplingPolicy';

export type TrackingPermission =
  | 'unknown'
  | 'granted_always'
  | 'granted_foreground'
  | 'denied'
  | 'blocked';

export interface DriverTrackingState {
  permission: TrackingPermission;
  /** El GPS está reportando ahora mismo. */
  active: boolean;
  /** Última posición conocida, para centrar el mapa del repartidor. */
  position: { lat: number; lng: number; heading: number | null } | null;
  /** Mensaje corto para la interfaz cuando algo impide seguir. */
  problem: string | null;
  /** Abre los ajustes del sistema. Solo tiene sentido si `blocked`. */
  openSettings: () => void;
  requestPermission: () => Promise<void>;
}

/**
 * Ubicación del repartidor mientras está en servicio.
 *
 * Se activa cuando el repartidor está disponible **o** tiene un pedido
 * encima, y se apaga sola en cuanto deja de cumplirse. Que dependa del
 * estado y no de que una pantalla esté abierta es todo el punto: el
 * repartidor cierra la app, se guarda el teléfono y conduce, y ahí es
 * cuando el cliente más quiere verlo moverse.
 *
 * Trabaja en dos canales a la vez, y no es redundancia:
 *
 * - **Primer plano** — `watchPositionAsync` por socket. Rápido y barato
 *   por punto.
 * - **Segundo plano** — la tarea de `expo-task-manager` por HTTP. Es lo
 *   único que sobrevive cuando el sistema congela la app.
 *
 * Los dos canales pasan por el mismo filtro del servidor, así que un
 * punto duplicado durante la transición se descarta solo.
 */
export function useDriverTracking(options: {
  /** El repartidor está disponible para recibir pedidos. */
  onDuty: boolean;
  /** Tiene una entrega en curso. Sube la precisión. */
  hasActiveOrder?: boolean;
}): DriverTrackingState {
  const { onDuty, hasActiveOrder = false } = options;
  const shouldTrack = onDuty || hasActiveOrder;

  const [permission, setPermission] = useState<TrackingPermission>('unknown');
  const [active, setActive] = useState(false);
  const [position, setPosition] = useState<DriverTrackingState['position']>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const policyRef = useRef<SamplingPolicy | null>(null);

  /**
   * Último punto que se envió, y cuándo.
   *
   * Es la memoria del latido: si el GPS lleva rato callado, esto es lo que
   * se reenvía para seguir apareciendo en el mapa.
   */
  const lastSentRef = useRef<{ lat: number; lng: number; heading: number | null; at: number } | null>(
    null
  );
  const heartbeatMsRef = useRef<number>(35_000);
  /** Umbral de precisión del servidor. Se sobreescribe con el valor real al arrancar. */
  const maxAccuracyRef = useRef<number>(100);
  const contextRef = useRef<TrackingContext>({
    hasActiveOrder,
    speedMps: null,
    batteryLevel: null,
    charging: null,
    foreground: true,
  });

  /**
   * Pide los permisos en el orden que exigen Android e iOS.
   *
   * Primero "mientras uso la app", y solo después "siempre". Pedir el
   * permiso de fondo primero es un rechazo automático en Android 11+ e
   * iOS: el sistema ni siquiera muestra el diálogo. Es la causa más común
   * de "el seguimiento en segundo plano no funciona y no da ningún error".
   */
  const requestPermission = useCallback(async () => {
    const foreground = await Location.requestForegroundPermissionsAsync();

    if (foreground.status !== 'granted') {
      // `canAskAgain: false` significa que el usuario marcó "no volver a
      // preguntar". Seguir mostrando el botón de permitir sería mentirle:
      // ese diálogo ya no va a aparecer nunca más y el único camino son
      // los ajustes del sistema.
      setPermission(foreground.canAskAgain ? 'denied' : 'blocked');
      setProblem(
        foreground.canAskAgain
          ? 'Necesitamos tu ubicación para asignarte pedidos cercanos.'
          : 'Activa el permiso de ubicación en los ajustes del teléfono.'
      );
      return;
    }

    const background = await Location.requestBackgroundPermissionsAsync();

    if (background.status === 'granted') {
      setPermission('granted_always');
      setProblem(null);
      return;
    }

    // Solo primer plano es un estado degradado pero funcional: mientras la
    // app esté abierta el seguimiento va perfecto. Merece un aviso claro,
    // no un bloqueo — obligar al permiso "siempre" para poder trabajar
    // sería peor producto y además más difícil de aprobar en las tiendas.
    setPermission('granted_foreground');
    setProblem(
      Platform.OS === 'ios'
        ? 'Con el permiso "Siempre" seguirías apareciendo en el mapa al bloquear el teléfono.'
        : 'Permite la ubicación "Todo el tiempo" para seguir apareciendo con la app cerrada.'
    );
  }, []);

  const openSettings = useCallback(() => {
    Linking.openSettings().catch(() => {
      setProblem('No pudimos abrir los ajustes. Búscalos manualmente en el teléfono.');
    });
  }, []);

  // Estado inicial del permiso, sin pedir nada. Un diálogo del sistema al
  // abrir una pantalla, sin contexto, se rechaza casi siempre — y en
  // Android ese rechazo puede ser definitivo.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [foreground, background] = await Promise.all([
        Location.getForegroundPermissionsAsync(),
        Location.getBackgroundPermissionsAsync(),
      ]);
      if (!alive) return;

      if (foreground.status !== 'granted') {
        setPermission(foreground.canAskAgain ? 'unknown' : 'blocked');
        return;
      }
      setPermission(background.status === 'granted' ? 'granted_always' : 'granted_foreground');
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Mantiene el contexto al día para que la política pueda decidir.
  useEffect(() => {
    contextRef.current.hasActiveOrder = hasActiveOrder;
  }, [hasActiveOrder]);

  useEffect(() => {
    const onChange = (state: AppStateStatus) => {
      contextRef.current.foreground = state === 'active';
    };
    const subscription = AppState.addEventListener('change', onChange);
    return () => subscription.remove();
  }, []);

  // La batería se consulta cada pocos minutos, no en cada fix: leerla es
  // barato pero no gratis, y su valor no cambia entre dos posiciones.
  useEffect(() => {
    if (!shouldTrack) return;

    const refresh = async () => {
      contextRef.current.batteryLevel = await batteryLevelPercent();
      contextRef.current.charging = await isCharging();
    };

    refresh();
    const timer = setInterval(refresh, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [shouldTrack]);

  /**
   * Conecta el GPS con la política dada, reemplazando lo que hubiera.
   *
   * Está extraída porque la usan dos caminos —el arranque y el reajuste
   * adaptativo— y son exactamente el mismo trabajo. Cuando estaban
   * duplicadas, cualquier arreglo en el manejo de un fix había que
   * escribirlo dos veces, que es la forma habitual de que el segundo se
   * quede sin él.
   */
  const attachWatch = useCallback(async (policy: SamplingPolicy, always: boolean) => {
    const subscription = await Location.watchPositionAsync(
      {
        accuracy: policy.accuracy,
        timeInterval: policy.timeInterval,
        distanceInterval: policy.distanceInterval,
      },
      (fix) => {
        contextRef.current.speedMps =
          fix.coords.speed != null && fix.coords.speed >= 0 ? fix.coords.speed : null;

        // Mismo filtro de precisión que aplica el servidor, aplicado aquí.
        //
        // No es duplicación por descuido: si el fix se manda y el servidor
        // lo descarta, el teléfono no se entera (el socket no responde a
        // cada ping) y da por hecho que reportó — con lo que el latido no
        // salta y el repartidor desaparece igual. Filtrando antes, la
        // última posición *buena* sigue siendo la que late.
        //
        // La excepción es no tener ninguna: un fix impreciso vale
        // infinitamente más que ninguno, así que el primero pasa siempre.
        const accuracy = fix.coords.accuracy ?? null;
        const tooCoarse =
          accuracy != null &&
          accuracy > maxAccuracyRef.current &&
          lastSentRef.current !== null;
        if (tooCoarse) return;

        setPosition({
          lat: fix.coords.latitude,
          lng: fix.coords.longitude,
          heading: fix.coords.heading ?? null,
        });

        lastSentRef.current = {
          lat: fix.coords.latitude,
          lng: fix.coords.longitude,
          heading: fix.coords.heading ?? null,
          at: Date.now(),
        };

        reportPosition({
          lat: fix.coords.latitude,
          lng: fix.coords.longitude,
          accuracy: fix.coords.accuracy ?? undefined,
          heading: fix.coords.heading ?? undefined,
          speed: contextRef.current.speedMps ?? undefined,
          batteryLevel: contextRef.current.batteryLevel ?? undefined,
          isMocked: (fix as { mocked?: boolean }).mocked ?? undefined,
          recordedAt: new Date(fix.timestamp).toISOString(),
        });
      }
    );

    // El suscriptor anterior se retira *después* de que el nuevo esté
    // escuchando. Al revés quedaría un hueco sin GPS en medio de cada
    // reajuste, y el reajuste ocurre precisamente cuando el repartidor
    // está cambiando de ritmo.
    watchRef.current?.remove();
    watchRef.current = subscription;
    policyRef.current = policy;

    // El seguimiento con la app cerrada solo se pide con el permiso
    // "siempre". Intentarlo con permiso de primer plano lanza, y ese
    // fallo apagaría también el canal de primer plano que sí funciona.
    if (always) await startBackgroundTracking(policy);
  }, []);

  // ── Arranque y parada del seguimiento ──
  useEffect(() => {
    let alive = true;

    const stop = async () => {
      watchRef.current?.remove();
      watchRef.current = null;
      policyRef.current = null;
      await stopBackgroundTracking();
      if (alive) setActive(false);
    };

    const canTrack =
      shouldTrack && (permission === 'granted_always' || permission === 'granted_foreground');

    if (!canTrack) {
      stop();
      return;
    }

    attachWatch(samplingPolicy(contextRef.current), permission === 'granted_always')
      .then(() => {
        if (!alive) return;
        setActive(true);
        setProblem(null);
        socketService.connect();
      })
      .catch(() => {
        if (alive) setProblem('No pudimos acceder al GPS. Revisa que esté encendido.');
      });

    return () => {
      alive = false;
      stop();
    };
  }, [shouldTrack, permission, attachWatch]);

  /**
   * Latido: reenvía la última posición cuando el GPS se queda callado.
   *
   * Sin esto, un repartidor quieto desaparece del mapa. `distanceInterval`
   * no es "avísame antes si me muevo": **bloquea la entrega del fix** hasta
   * que el desplazamiento supere ese umbral. Un repartidor esperando en la
   * puerta de un restaurante no recorre 80 metros, así que el GPS no
   * entrega nada, no sale ningún ping, y a los 90 segundos el servidor lo
   * da por perdido — estando su teléfono perfectamente vivo y conectado.
   *
   * Reenviar la última posición conocida con la hora **actual** no es
   * mentir: si el GPS calla por `distanceInterval`, es precisamente porque
   * el repartidor sigue donde estaba. Se está afirmando "sigue aquí", que
   * es cierto y es justo lo que el mapa necesita saber.
   *
   * Cuesta un mensaje de socket cada 35 s. El ahorro de batería vive en no
   * *pedirle* fixes al GPS, no en callarse — así que el muestreo puede
   * seguir siendo todo lo económico que quiera.
   */
  useEffect(() => {
    if (!active) return;

    let cancelled = false;

    // El ritmo lo fija el servidor (`getMapConfig`), no una constante local:
    // si mañana se sube el umbral de "perdido", el latido lo sigue solo.
    getMapConfig().then((mapConfig) => {
      if (cancelled || !mapConfig?.tracking) return;
      if (mapConfig.tracking.heartbeatMs) {
        heartbeatMsRef.current = mapConfig.tracking.heartbeatMs;
      }
      if (mapConfig.tracking.maxAccuracyMeters) {
        maxAccuracyRef.current = mapConfig.tracking.maxAccuracyMeters;
      }
    });

    const timer = setInterval(() => {
      const last = lastSentRef.current;
      if (!last) return;

      const silentFor = Date.now() - last.at;
      if (silentFor < heartbeatMsRef.current) return;

      lastSentRef.current = { ...last, at: Date.now() };
      reportPosition({
        lat: last.lat,
        lng: last.lng,
        heading: last.heading ?? undefined,
        batteryLevel: contextRef.current.batteryLevel ?? undefined,
        // Sin `accuracy`: el valor del fix original ya no describe este
        // instante, y mandarlo caducado podría hacer que el servidor
        // descartara el latido por impreciso justo cuando es lo único que
        // mantiene vivo al repartidor en el mapa.
        recordedAt: new Date().toISOString(),
      });
    }, 5_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active]);

  /**
   * Reajusta el muestreo cuando el contexto cambia de verdad.
   *
   * Se revisa cada 30 s en vez de en cada fix porque reconfigurar el GPS
   * implica pararlo y arrancarlo, y ese ciclo cuesta una lectura. Un
   * repartidor que acelera y frena en el tráfico cambiaría de política
   * cada pocos segundos y pasaría el turno reiniciando el sensor.
   */
  useEffect(() => {
    if (!active) return;

    const timer = setInterval(() => {
      const next = samplingPolicy(contextRef.current);
      if (samePolicy(policyRef.current, next)) return;
      attachWatch(next, permission === 'granted_always').catch(() => {
        // Si el reajuste falla, el suscriptor anterior sigue vivo: se
        // mantiene la frecuencia antigua en lugar de quedarse sin GPS.
      });
    }, 30_000);

    return () => clearInterval(timer);
  }, [active, permission, attachWatch]);

  return { permission, active, position, problem, openSettings, requestPermission };
}

// ── Un solo GPS para toda la sesión del repartidor ────────────────────

/**
 * Todo lo del seguimiento **menos la posición**, que va en su propio
 * contexto (ver `useDriverPosition`).
 */
interface DriverTrackingContextValue extends Omit<DriverTrackingState, 'position'> {
  /** Lo llama el panel al conectarse o desconectarse. */
  setOnDuty: (value: boolean) => void;
  /** Lo llama la pantalla de un pedido al montarse y al salir. */
  setActiveOrder: (orderId: string | null) => void;
  activeOrderId: string | null;
}

const DriverTrackingContext = createContext<DriverTrackingContextValue | null>(null);

/**
 * La posición, aparte.
 *
 * Cambia con cada fix del GPS —cada 5 a 8 s con un pedido encima— y antes
 * viajaba en el mismo valor que el permiso o el estado: como además ese
 * valor se recreaba en cada render, el tablero y la pantalla del pedido
 * (casi 800 líneas) se re-renderizaban enteros en cada fix sin usar la
 * posición para nada. Ahora solo se entera quien la pide.
 */
const DriverPositionContext = createContext<DriverTrackingState['position']>(null);

/**
 * El seguimiento GPS del repartidor, una sola vez para toda la sesión.
 *
 * Es un proveedor y no un hook suelto por una razón concreta: dos
 * pantallas llamando a `useDriverTracking` abrirían **dos**
 * `watchPositionAsync` y arrancarían la tarea de fondo dos veces. El
 * segundo arranque detiene el primero (`startLocationUpdatesAsync` no
 * acumula tareas), así que al navegar entre el panel y un pedido el GPS
 * se reiniciaría en cada transición — perdiendo un fix cada vez y
 * gastando el doble de batería mientras ambos conviven.
 *
 * Vive en el layout de `(driver)`, que es el ancestro común de todas las
 * pantallas del repartidor y sobrevive a la navegación entre ellas.
 */
export function DriverTrackingProvider({ children }: { children: ReactNode }) {
  const [onDuty, setOnDuty] = useState(false);
  const [activeOrderId, setActiveOrder] = useState<string | null>(null);

  const { permission, active, position, problem, openSettings, requestPermission } =
    useDriverTracking({ onDuty, hasActiveOrder: !!activeOrderId });

  const value = useMemo<DriverTrackingContextValue>(
    () => ({ permission, active, problem, openSettings, requestPermission, setOnDuty, setActiveOrder, activeOrderId }),
    [permission, active, problem, openSettings, requestPermission, activeOrderId]
  );

  return createElement(
    DriverTrackingContext.Provider,
    { value },
    createElement(DriverPositionContext.Provider, { value: position }, children)
  );
}

/**
 * Acceso al seguimiento compartido.
 *
 * Lanza si se usa fuera del proveedor en vez de devolver algo vacío: un
 * `null` silencioso aquí significaría una pantalla de repartidor que cree
 * estar reportando su posición y no lo está haciendo, y eso no se nota
 * hasta que un cliente llama preguntando dónde está su pedido.
 */
export function useDriverTrackingContext(): DriverTrackingContextValue {
  const context = useContext(DriverTrackingContext);
  if (!context) {
    throw new Error('useDriverTrackingContext debe usarse dentro de <DriverTrackingProvider>');
  }
  return context;
}

/** La última posición del repartidor. Solo para quien la pinta (el mapa de la ruta). */
export function useDriverPosition(): DriverTrackingState['position'] {
  return useContext(DriverPositionContext);
}
