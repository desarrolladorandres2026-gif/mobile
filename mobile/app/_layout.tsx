import { useEffect, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';

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
import { reportError, installGlobalHandler } from '../lib/crashReporting';
import { installOnlineManager } from '../hooks/useNetwork';
import { checkForUpdate } from '../lib/appUpdates';
import { AppErrorScreen } from '../components/shared/AppErrorScreen';
import { VersionGate } from '../components/shared/VersionGate';

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

/**
 * Lo que se ve cuando una pantalla revienta al renderizar.
 *
 * expo-router usa este export si existe. Sin él, un error de render deja la
 * app **en blanco**, sin texto y sin camino de vuelta: el usuario solo puede
 * matarla desde el gestor de tareas, y nadie se entera de que pasó.
 *
 * Al estar en el layout raíz cubre toda la aplicación. Un boundary por
 * pantalla daría mensajes más finos, pero este es el que garantiza que nunca
 * quede una pantalla muerta.
 */
export function ErrorBoundary({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  // Se reporta como fatal: llegar aquí significa que el usuario perdió lo
  // que estuviera haciendo.
  reportError(error, { scope: 'render' }, true);
  return <AppErrorScreen error={error} onRetry={retry} />;
}

/**
 * El splash nativo se queda hasta que la app puede pintar de verdad.
 *
 * Sin esto, el sistema lo retira en cuanto monta el JS y aparecía el loader
 * de marca, que pinta blanco mientras `app.json` declara `#141A2E`. La
 * secuencia real en cada arranque en frío era **azul noche → blanco → app**,
 * con el status bar cambiando de estilo por el camino.
 *
 * Mantener el splash nativo evita el parpadeo sin tener que decidir qué
 * color "gana": durante el arranque en frío el loader JS ya no llega a
 * verse. Sigue existiendo para los casos en que sí hace falta —volver del
 * login, recargar en desarrollo— donde no hay splash nativo que mantener.
 */
void SplashScreen.preventAutoHideAsync().catch(() => {
  // Puede rechazar si el splash ya se ocultó (recarga en caliente). No es un
  // fallo: solo significa que no había nada que mantener.
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      /**
       * No se reintenta lo que no va a cambiar.
       *
       * Antes eran 2 reintentos para todo. Un 404, un 401 o un 422 dan
       * exactamente el mismo resultado las tres veces: lo único que se
       * consigue es que el usuario espere el triple para leer el mismo
       * error. Los 5xx y los fallos de red sí merecen otra oportunidad,
       * porque son los que se arreglan solos.
       */
      retry: (failureCount, error: any) => {
        const status = error?.response?.status;
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
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
    // Antes que nada: a partir de aquí, un fallo en un `setTimeout`, en un
    // listener del socket o en una promesa suelta deja rastro. `ErrorBoundary`
    // solo ve lo que revienta durante el render, que es la minoría.
    installGlobalHandler();

    // React Query asumia que siempre hay red: reintentaba contra un telefono
    // en modo avion y tardaba 45 s en decir que algo fallo. Enterado, pausa
    // al perder la red y reanuda solo al volver.
    installOnlineManager();

    // Se descarga en segundo plano y se aplica en el proximo arranque en
    // frio. No recarga la app sola: hacerlo a mitad de un checkout le
    // costaria el pedido a alguien.
    void checkForUpdate();

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

  const booted = !isLoading && fontsLoaded;

  useEffect(() => {
    // Se oculta solo cuando ya hay algo que enseñar debajo. Ocultarlo antes
    // es exactamente el parpadeo que se quería quitar.
    if (booted) void SplashScreen.hideAsync().catch(() => {});
  }, [booted]);

  if (!booted) {
    return <ZippSplashLoader />;
  }

  return (
    // La puerta va por dentro del arbol de tema y por fuera del Stack: tiene
    // que poder pintar con los colores de la app, y a la vez sustituir la
    // navegacion entera cuando bloquea.
    <VersionGate>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack screenOptions={screenOptions}>
        <Stack.Screen name="index" options={{ animation: 'fade' }} />
        <Stack.Screen name="(auth)" options={{ animation: 'fade' }} />
        <Stack.Screen name="(client)" options={{ animation: 'fade' }} />
        <Stack.Screen name="(driver)" options={{ animation: 'fade' }} />
      </Stack>
    </VersionGate>
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
