import { User } from '../models';
import { config } from '../config';

/**
 * Envío de notificaciones push mediante el servicio de Expo.
 *
 * El teléfono registra un "Expo push token" al conceder el permiso de
 * notificaciones (ver `mobile/lib/push.ts`) y lo guarda en
 * `User.pushTokens`. Aquí solo se hace un POST al endpoint público de
 * Expo — no hace falta ninguna credencial de Firebase/APNs en el
 * servidor: Expo se encarga del reparto a FCM y APNs.
 *
 * Referencia: https://docs.expo.dev/push-notifications/sending-notifications/
 */
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** Un token de Expo siempre tiene esta forma. Filtra basura antes de enviar. */
const isExpoToken = (t: string): boolean =>
  typeof t === 'string' && /^ExponentPushToken\[.+\]$/.test(t.trim());

interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /**
   * Canal de Android. Cada canal lleva su propio sonido, su vibración y su
   * importancia, y el usuario los gobierna por separado desde los ajustes
   * del sistema: quien silencia los avisos de promociones no debería
   * silenciar con ellos la oferta de un pedido. Ver `ensureAndroidChannel`
   * en `mobile/lib/push.ts`, que es donde se declaran.
   */
  channelId?: string;
  /**
   * Cuánto vale este mensaje, en segundos.
   *
   * Expo —y FCM debajo— guardan una push que no se pudo entregar y la
   * sueltan cuando el teléfono vuelve. Para un aviso de estado eso está
   * bien. Para la oferta de un pedido es un fallo: la ventana dura
   * cuarenta y cinco segundos, y una oferta que suena cinco minutos tarde
   * manda al domiciliario a una pantalla vacía. Vencido el plazo, el
   * mensaje se descarta en vez de entregarse.
   */
  ttlSeconds?: number;
  /**
   * Prioridad en iOS. `time-sensitive` atraviesa el modo Concentración,
   * que es donde acaban los avisos de quien conduce con el teléfono en el
   * soporte.
   */
  interruptionLevel?: 'passive' | 'active' | 'time-sensitive' | 'critical';
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

export class PushService {
  /**
   * Envía a todos los dispositivos de un usuario. Nunca lanza: una push
   * que falla no debe tumbar el flujo del pedido que la originó. Los
   * tokens que Expo marca como muertos se limpian de la base.
   */
  async sendToUser(userId: string, message: PushMessage): Promise<void> {
    // En tests no se hace red: los flujos de pedido crean notificaciones y
    // esto colgaría de exp.host en cada caso.
    if (config.isTest) return;

    const user = await User.findById(userId).select('+pushTokens').lean();
    const tokens = (user?.pushTokens ?? [])
      .map((d) => d.token)
      .filter(isExpoToken);

    if (tokens.length === 0) return;

    const payload = tokens.map((to) => ({
      to,
      sound: 'default',
      title: message.title,
      body: message.body,
      data: message.data ?? {},
      priority: 'high',
      channelId: message.channelId ?? 'default',
      ...(message.ttlSeconds !== undefined ? { ttl: message.ttlSeconds } : {}),
      ...(message.interruptionLevel
        ? { interruptionLevel: message.interruptionLevel }
        : {}),
    }));

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        console.error('[Push] Expo respondió', res.status, await res.text());
        return;
      }

      const json = (await res.json()) as { data?: ExpoTicket[] };
      const tickets = json.data ?? [];

      // Un token "DeviceNotRegistered" ya no sirve: el usuario desinstaló
      // o revocó el permiso. Se quita para no reintentar en cada pedido.
      const dead = tickets
        .map((ticket, i) => ({ ticket, token: tokens[i] }))
        .filter(({ ticket }) => ticket.details?.error === 'DeviceNotRegistered')
        .map(({ token }) => token);

      if (dead.length > 0) await this.removeTokens(userId, dead);
    } catch (err) {
      console.error('[Push] Error enviando a Expo:', err);
    }
  }

  /** Alta o refresco de un token para un dispositivo. */
  async registerToken(
    userId: string,
    token: string,
    platform = 'unknown'
  ): Promise<void> {
    if (!isExpoToken(token)) throw new Error('Token de push inválido');

    // El mismo token puede migrar de cuenta (un teléfono prestado, un
    // logout/login): se despega de cualquier otro usuario antes de fijarlo.
    await User.updateMany(
      { _id: { $ne: userId }, 'pushTokens.token': token },
      { $pull: { pushTokens: { token } } }
    );
    await User.updateOne(
      { _id: userId, 'pushTokens.token': token },
      { $set: { 'pushTokens.$.updatedAt': new Date(), 'pushTokens.$.platform': platform } }
    );
    await User.updateOne(
      { _id: userId, 'pushTokens.token': { $ne: token } },
      { $push: { pushTokens: { token, platform, updatedAt: new Date() } } }
    );
  }

  async removeToken(userId: string, token: string): Promise<void> {
    await User.updateOne({ _id: userId }, { $pull: { pushTokens: { token } } });
  }

  private async removeTokens(userId: string, tokens: string[]): Promise<void> {
    await User.updateOne(
      { _id: userId },
      { $pull: { pushTokens: { token: { $in: tokens } } } }
    );
  }
}

export const pushService = new PushService();
