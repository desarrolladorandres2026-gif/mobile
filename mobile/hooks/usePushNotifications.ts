import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useAuthStore } from '../stores/authStore';
import { notificationsApi } from '../services/endpoints';
import { registerForPush, pushPlatform, addPushListeners } from '../lib/push';
import { reportError } from '../lib/crashReporting';

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
      const orderId = data?.orderId ?? data?.order?._id;
      // El parametro se llama `id`, que es el que lee `order-tracking` con
      // `useLocalSearchParams`. Antes se mandaba `orderId` y la pantalla
      // abria sin pedido: tocar cualquier aviso terminaba en "No encontramos
      // este pedido", justo en el momento de mas intencion del usuario.
      if (orderId) {
        router.push({ pathname: '/(client)/order-tracking', params: { id: orderId } });
        return;
      }

      // La push de "respondimos tu solicitud" (support.service.ts) manda
      // pqrsId. No hay pantalla de detalle por ticket, asi que se abre el
      // listado -- que ya se refresca solo por el socket, y ahora tambien
      // por haber tocado la push.
      if (data?.pqrsId) router.push('/(client)/requests');
    };

    return addPushListeners({ onOpen: openFromData });
  }, []);
}
