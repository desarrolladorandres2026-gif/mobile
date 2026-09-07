import { useEffect, useMemo } from 'react';
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
import { useSessionGuard } from '../hooks/useSessionGuard';
import { ZippSplashLoader } from '../components/brand/ZippSplashLoader';
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

  // Notificaciones del sistema: llegan como push normal, con la app cerrada o abierta.
  usePushNotifications();

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

    // TODO(usuario): cuando hay una versión nueva del shell esperando, ¿qué
    // hace la PWA? Dos caminos válidos, con trade-offs distintos:
    //  a) Recargar sola (`window.location.reload()`) — el usuario siempre
    //     tiene la última versión, pero puede perder texto sin enviar o
    //     interrumpir un flujo (ej. a mitad del checkout).
    //  b) Mostrar un banner tipo "Hay una versión nueva, toca para
    //     actualizar" — más respetuoso del flujo en curso, pero exige que
    //     construyas ese componente y que el usuario note el aviso.
    // El proyecto ya tiene banners/toasts en components/? revisa ahí antes
    // de crear uno nuevo.
    registerServiceWorker(() => {
      // placeholder: hoy no hace nada, ver TODO arriba.
    });
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
