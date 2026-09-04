import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useAuthStore } from '../stores/authStore';
import { notificationsApi } from '../services/endpoints';
import { registerForPush, pushPlatform, addPushListeners } from '../lib/push';

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
 *  - App en primer plano: cuando entra una push, refresca la campana.
 *  - Al tocar una push: navega al pedido si el `data` la trae, o a la
 *    lista de avisos.
 */
export function usePushNotifications() {
  const router = useRouter();
  const queryClient = useQueryClient();
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
      } catch {
        registered.current = false;
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
      if (orderId) router.push(`/(client)/order-tracking?orderId=${orderId}`);
      else router.push('/(client)/notifications');
    };

    return addPushListeners({
      onReceived: () => {
        queryClient.invalidateQueries({ queryKey: ['notifications'] });
      },
      onOpen: openFromData,
    });
  }, []);
}
