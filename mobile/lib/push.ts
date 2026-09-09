import { Platform } from 'react-native';
import * as Device from 'expo-device';
import Constants, { ExecutionEnvironment } from 'expo-constants';

/**
 * Registro del dispositivo para notificaciones push (Expo).
 *
 * Flujo:
 *  1. Al iniciar sesión, `usePushNotifications` llama a `registerForPush()`.
 *  2. Se pide el permiso del sistema (una sola vez; si el usuario ya
 *     decidió, `getPermissionsAsync` devuelve su respuesta sin volver a
 *     preguntar).
 *  3. Con permiso concedido se obtiene el "Expo push token" y se manda al
 *     backend (`notificationsApi.registerDevice`), que lo guarda en
 *     `User.pushTokens`.
 *  4. A partir de ahí el backend puede notificar aunque la app esté
 *     cerrada — ver `backend/src/services/push.service.ts`.
 *
 * En emulador/simulador sin servicios de Google/Apple no hay token: la
 * función devuelve `null` y no es un error.
 *
 * ── Expo Go ──
 * Desde el SDK 53, Expo Go NO incluye el push remoto: `expo-notifications`
 * lanza una excepción con solo importarlo (corre un side-effect al cargar).
 * Por eso este módulo nunca hace `import` estático de `expo-notifications`:
 * lo carga con `require()` solo cuando el entorno lo soporta. En Expo Go
 * todo el sistema de push queda en no-op y la app arranca igual; el push
 * real se prueba en un development build.
 */

/** `true` cuando la app corre dentro de la app Expo Go (sin push remoto). */
const isExpoGo =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

type NotificationsModule = typeof import('expo-notifications');

let cached: NotificationsModule | null | undefined;

/**
 * Devuelve `expo-notifications` o `null` si el entorno no lo soporta.
 * El `require()` perezoso es lo que evita el crash en Expo Go: Metro solo
 * evalúa el módulo (y su side-effect) cuando esta línea se ejecuta.
 */
function getNotifications(): NotificationsModule | null {
  if (cached !== undefined) return cached;

  if (isExpoGo) {
    cached = null;
    if (__DEV__) {
      console.log(
        '[Push] Expo Go no soporta push remoto (SDK 53+). El registro de ' +
          'notificaciones push se omite; pruébalo en un development build.'
      );
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  cached = require('expo-notifications') as NotificationsModule;

  /** Cómo se comporta una push recibida con la app en primer plano. */
  cached.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });

  return cached;
}

/**
 * Canal de Android. Sin esto, Android agrupa todo en un canal por defecto
 * sin sonido ni prioridad alta. El `id` ('default') es el que envía el
 * backend en cada mensaje.
 */
export async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const N = getNotifications();
  if (!N) return;
  await N.setNotificationChannelAsync('default', {
    name: 'Avisos de Zipp',
    importance: N.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#C6A15B',
    sound: 'default',
  });
}

/**
 * Un projectId que todavía es el marcador de posición de la plantilla.
 *
 * Importa distinguirlo de "no hay ninguno": el placeholder **es truthy**, así
 * que pasaba el `if (!projectId)` de abajo y llegaba hasta
 * `getExpoPushTokenAsync`, que lanzaba; el `catch` devolvía `null` y nadie se
 * enteraba. Resultado: ningún dispositivo se registró jamás y ninguna push
 * salió nunca, en desarrollo y en producción por igual.
 *
 * Un guard que comprueba existencia pero no validez es peor que no tener
 * guard: da sensación de estar cubierto.
 */
function isPlaceholder(value: string): boolean {
  return /^(REEMPLAZAR|YOUR_|TU_|<)/i.test(value.trim());
}

function resolveProjectId(): string | undefined {
  const raw =
    Constants.expoConfig?.extra?.eas?.projectId ??
    // easConfig no está en los tipos de todas las versiones de expo-constants
    (Constants as any).easConfig?.projectId;

  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value || isPlaceholder(value)) return undefined;
  return value;
}

/**
 * Pide permiso (si hace falta) y devuelve el Expo push token, o `null` si
 * no se concedió, el dispositivo no puede recibir push o el entorno (Expo
 * Go, emulador) no lo soporta.
 */
/**
 * Si el usuario dejó entrar los avisos.
 *
 * Hace falta para poder **decírselo**. Antes, denegar el permiso devolvía
 * `null` y la app salía en silencio: en ninguna pantalla se avisaba de que
 * no iban a llegar avisos del pedido. En una app de domicilios, donde el
 * push es el canal por el que se sabe que la comida está en la puerta, ese
 * silencio es el fallo más caro que se puede tener.
 *
 * Devuelve `null` donde la pregunta no aplica (web, emulador, Expo Go).
 */
export async function pushPermissionGranted(): Promise<boolean | null> {
  const N = getNotifications();
  if (!N || !Device.isDevice) return null;
  try {
    const { status } = await N.getPermissionsAsync();
    return status === 'granted';
  } catch {
    return null;
  }
}

export async function registerForPush(): Promise<string | null> {
  const N = getNotifications();
  if (!N) return null;
  if (!Device.isDevice) return null;

  await ensureAndroidChannel();

  const existing = await N.getPermissionsAsync();
  let status = existing.status;

  // Solo se muestra el diálogo del sistema si el usuario aún no respondió.
  if (status !== 'granted' && existing.canAskAgain) {
    const asked = await N.requestPermissionsAsync();
    status = asked.status;
  }
  if (status !== 'granted') return null;

  const projectId = resolveProjectId();
  if (!projectId) {
    // Ruidoso a propósito, y también fuera de __DEV__. Este fallo deja la app
    // entera sin avisos de pedido; si solo se ve en desarrollo, una build de
    // release sale al mundo muda y nadie lo nota hasta que un cliente se queja
    // de que "no le llega nada".
    console.error(
      '[Push] No hay projectId de EAS válido (falta o sigue siendo el ' +
        'marcador de la plantilla). Ningún dispositivo podrá recibir ' +
        'notificaciones. Corre `eas init` y pon el valor real en ' +
        'extra.eas.projectId de app.json.'
    );
    return null;
  }

  try {
    const { data } = await N.getExpoPushTokenAsync({ projectId });
    return data;
  } catch (err) {
    if (__DEV__) console.warn('[Push] No se pudo obtener el token:', err);
    return null;
  }
}

export const pushPlatform = (): string => Platform.OS;

/** Handlers para las push que llegan con la app abierta o al tocarlas. */
export type PushListeners = {
  /** Una push entró con la app en primer plano. */
  onReceived?: () => void;
  /** El usuario tocó una push; `data` es el `content.data` del mensaje. */
  onOpen: (data: unknown) => void;
};

/**
 * Registra los listeners de push y devuelve una función de limpieza.
 * En Expo Go / entornos sin soporte no hace nada y devuelve un no-op, así
 * el hook que la usa no necesita saber nada de `expo-notifications`.
 */
export function addPushListeners({ onReceived, onOpen }: PushListeners): () => void {
  const N = getNotifications();
  if (!N) return () => {};

  const received = N.addNotificationReceivedListener(() => onReceived?.());
  const responded = N.addNotificationResponseReceivedListener((response) => {
    onOpen(response.notification.request.content.data);
  });

  // App abierta desde estado cerrado por tocar una push.
  N.getLastNotificationResponseAsync().then((response) => {
    if (response) onOpen(response.notification.request.content.data);
  });

  return () => {
    received.remove();
    responded.remove();
  };
}
