import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useAuthStore } from '../stores/authStore';
import { notificationsApi } from '../services/endpoints';
import { registerForPush, pushPlatform, addPushListeners } from '../lib/push';
import { offerFromPushData, publishOffer } from '../lib/offerInbox';
import { reportError } from '../lib/crashReporting';
import { IS_DRIVER_APP } from '../constants/variant';
import { ROUTES } from '../lib/routing';

const TOKEN_KEY = '@zipp_push_token';

/**
 * Da de baja este dispositivo en el backend. Se llama ANTES de `logout()`,
 * mientras el token de acceso aún es válido: después de cerrar sesión la
 * petición fallaría y el backend seguiría mandando push a un teléfono que
 * ya no tiene la sesión.
 */
export async function unregisterPush(): Promise<void> {
  try {
    const token = await AsyncStorage.getItem(TOKEN_KEY);
    if (token) {
      await notificationsApi.unregisterDevice(token).catch(() => {});
      await AsyncStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    /* el logout nunca debe romperse por esto */
  }
}

/**
 * Conecta las notificaciones push a la sesión. Se monta una sola vez, en
 * el layout raíz.
 *
 *  - Al autenticarse: pide permiso (si hace falta), obtiene el Expo push
 *    token y lo registra en el backend.
 *  - Al tocar una push de un pedido: navega directo a su seguimiento. El
 *    resto (promos, etc.) se queda como notificación normal del sistema,
 *    sin pantalla propia dentro de la app.
 */
export function usePushNotifications() {
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const registered = useRef(false);

  // ── Registro del token ──
  useEffect(() => {
    if (!isAuthenticated || registered.current) return;
    registered.current = true;

    (async () => {
      const token = await registerForPush();
      if (!token) {
        registered.current = false; // permitir reintento si el permiso cambia
        return;
      }
      try {
        await notificationsApi.registerDevice(token, pushPlatform());
        await AsyncStorage.setItem(TOKEN_KEY, token);
      } catch (err) {
        registered.current = false;
        // Antes esto se tragaba entero: el dispositivo quedaba sin registrar,
        // el usuario no recibia ni un aviso de su pedido, y nadie se enteraba
        // nunca. Es justo el fallo que hace falta ver desde fuera.
        reportError(err, { scope: 'push:registerDevice' });
      }
    })();
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) registered.current = false;
  }, [isAuthenticated]);

  // ── Reacción a las push ──
  useEffect(() => {
    const openFromData = (data: any) => {
      /**
       * A dónde abrir depende de quién la toca.
       *
       * Un domiciliario y un cliente reciben el mismo tipo de aviso de
       * pedido —"cambió de estado", "te asignaron uno nuevo"— y hasta
       * ahora las dos rutas caían siempre en las pantallas de cliente.
       * `(client)/order-tracking` no tiene sentido para una cuenta de
       * domiciliario: ni el pedido que ve ahí es el suyo en el mismo
       * sentido, ni los botones de esa pantalla (cancelar, "algo anda
       * mal") son los que le sirven a quien está entregando.
       *
       * Ya no se mira el rol de la sesión sino qué app es esta: en Zipp
       * Domiciliarios solo puede haber sesiones de domiciliario (el login
       * y el arranque rechazan cualquier otra), y las pantallas de cliente
       * ni siquiera existen en su bundle.
       */
      const isDriver = IS_DRIVER_APP;

      /**
       * Una oferta no es un pedido suyo. Todavía.
       *
       * Si esto cayera en la rama de abajo abriría `(driver)/order/[id]`
       * con un pedido que aún no tiene domiciliario, y esa pantalla
       * respondería "no encontramos este pedido: puede que ya no esté
       * asignado a ti" — un mensaje falso, en el segundo exacto en que
       * había que decidir si se acepta. La oferta va a su hoja, con su
       * reloj y sus dos botones.
       */
      const offer = offerFromPushData(data);
      if (offer) {
        publishOffer(offer);
        return;
      }

      const orderId = data?.orderId ?? data?.order?._id;
      // El parametro se llama `id`, que es el que lee `order-tracking` con
      // `useLocalSearchParams`. Antes se mandaba `orderId` y la pantalla
      // abria sin pedido: tocar cualquier aviso terminaba en "No encontramos
      // este pedido", justo en el momento de mas intencion del usuario.
      //
      // Y antes de eso, mas de fondo: ningun push de pedido llevaba
      // `orderId` en el `data` -- solo `orderNumber`, el numero legible.
      // La condicion de aqui nunca se cumplia, para nadie. Se corrigio en
      // `notification.service.ts`: los 13 avisos de pedido ahora llevan el
      // id de Mongo.
      if (orderId) {
        if (isDriver) {
          router.push(`/(driver)/order/${orderId}` as never);
        } else {
          router.push({ pathname: '/(client)/order-tracking', params: { id: orderId } });
        }
        return;
      }

      // La push de "respondimos tu solicitud" (support.service.ts) manda
      // pqrsId. No hay pantalla de detalle por ticket, asi que se abre el
      // listado -- que ya se refresca solo por el socket, y ahora tambien
      // por haber tocado la push. Cliente y domiciliario tienen cada uno
      // el suyo, en rutas distintas.
      if (data?.pqrsId) {
        router.push(ROUTES.requests as never);
      }
    };

    /**
     * Recibida, no tocada.
     *
     * Con la app en primer plano el socket normalmente ya entregó la
     * oferta y esto no aporta nada. Pero si el socket estaba reconectando
     * —al volver de segundo plano, al cambiar de wifi a datos— la push es
     * la única copia que llega, y esperar a que el domiciliario la toque
     * gastaría la mitad de la ventana.
     */
    const openOfferSilently = (data: unknown) => {
      const offer = offerFromPushData(data);
      if (offer) publishOffer(offer);
    };

    return addPushListeners({ onOpen: openFromData, onReceived: openOfferSilently });
  }, []);
}
