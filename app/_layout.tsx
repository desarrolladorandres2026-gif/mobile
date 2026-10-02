import { useEffect, useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';

import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
} from '@expo-google-fonts/inter';

import { useAuthStore } from '../stores/authStore';
import { useTheme } from '../hooks/useTheme';
import { usePushNotifications } from '../hooks/usePushNotifications';
import { useNotificationsRealtime } from '../hooks/useRealtime';
import { useSessionGuard } from '../hooks/useSessionGuard';
import { ZippSplashLoader } from '../components/brand/ZippSplashLoader';
import { UpdateBanner } from '../components/ui';
import { registerServiceWorker } from '../lib/pwa';

// Registra la tarea de ubicación en segundo plano.
//
// Tiene que estar aquí, en el módulo raíz, y no dentro del layout del
// repartidor: el sistema operativo puede lanzar la app *directamente en
// la tarea*, sin abrir ninguna pantalla, para entregarle posiciones
// acumuladas. En ese arranque el layout de `(driver)` no llega a montarse
// nunca, y si la tarea se definiera allí Expo la daría por desconocida y
// descartaría el lote entero de posiciones.
//
// El `import` sin nombre es intencional: el efecto de cargar el módulo
// —el `defineTask`— es exactamente lo que se busca.
import '../lib/locationTask';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 5 * 60 * 1000,
      // Al volver a la app, lo primero es saber si el pedido cambió de estado.
      refetchOnWindowFocus: true,
    },
  },
});

function RootLayoutContent() {
  const { isLoading, loadStoredAuth } = useAuthStore();
  const { c, isDark } = useTheme();
  const [updateReady, setUpdateReady] = useState(false);

  // Notificaciones: push del sistema (app cerrada) + campana en vivo (app abierta).
  usePushNotifications();
  useNotificationsRealtime();

  // Si la sesión muere estando dentro de la app, devuelve al login en vez
  // de dejar la pantalla montada reintentando peticiones que ya no pueden
  // funcionar. Vive aquí porque es el único punto que sobrevive a toda
  // navegación — el guardián tiene que seguir mirando esté donde esté el
  // usuario.
  useSessionGuard();

  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
  });

  useEffect(() => {
    loadStoredAuth();

    // PWA: si ya se descargó una versión nueva, avisamos con un banner en
    // vez de recargar solos, para no cortar un checkout a la mitad.
    registerServiceWorker(() => setUpdateReady(true));
  }, []);

  // Antes del return condicional de abajo: un hook no puede depender de si
  // ya cargaron fuentes/sesión, o el conteo de hooks cambia entre el primer
  // render (boot) y el siguiente (listo) y React lo rechaza.
  const screenOptions = useMemo(() => ({
    headerShown: false,
    contentStyle: { backgroundColor: c.background },
    animation: 'slide_from_right' as const,
  }), [c.background]);

  // Mientras cargan fuentes y sesión, mostramos la pantalla de carga limpia con fondo blanco.
  if (isLoading || !fontsLoaded) {
    return <ZippSplashLoader />;
  }

  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack screenOptions={screenOptions}>
        <Stack.Screen name="index" options={{ animation: 'fade' }} />
        <Stack.Screen name="(auth)" options={{ animation: 'fade' }} />
        <Stack.Screen name="(client)" options={{ animation: 'fade' }} />
        <Stack.Screen name="(driver)" options={{ animation: 'fade' }} />
      </Stack>
      <UpdateBanner
        visible={updateReady}
        onUpdate={() => window.location.reload()}
        onDismiss={() => setUpdateReady(false)}
      />
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <QueryClientProvider client={queryClient}>
        <RootLayoutContent />
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
