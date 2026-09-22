import { useEffect, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
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
import { useVariantGuard } from '../hooks/useVariantGuard';
import { IS_DRIVER_APP, IS_CLIENT_APP } from '../constants/variant';
import {
  queryPersister, shouldPersistQuery, persistBuster, PERSIST_MAX_AGE_MS,
} from '../lib/queryPersistence';
import { ZippSplashLoader } from '../components/brand/ZippSplashLoader';
import { registerServiceWorker } from '../lib/pwa';
import { reportError, installGlobalHandler } from '../lib/crashReporting';
import { installOnlineManager } from '../hooks/useNetwork';
import { installAppFocusManager } from '../lib/appFocus';
import { useRealtimeOwner } from '../hooks/useRealtime';
import { checkForUpdate } from '../lib/appUpdates';
import { AppErrorScreen } from '../components/shared/AppErrorScreen';
import { VersionGate } from '../components/shared/VersionGate';

// La tarea de ubicación en segundo plano (`lib/locationTask`) se registra
// en `index.js`, el entry del bundle, y no aquí: expo-router carga este
// layout de forma perezosa en release, y un arranque headless por la tarea
// no lo evalúa nunca. Ver el comentario en index.js.

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
      // En la app cliente lo que se guarda entre aperturas tiene que seguir
      // en memoria el mismo tiempo que en disco, o se descartaría antes de
      // poder restaurarse (ver lib/queryPersistence).
      ...(IS_CLIENT_APP ? { gcTime: PERSIST_MAX_AGE_MS } : {}),
      // Al volver a la app, lo primero es saber si el pedido cambió de estado.
      refetchOnWindowFocus: true,
    },
  },
});

/** Rutas que pintan su propia cabecera oscura bajo la barra de estado. */
const DARK_HEADER_ROUTES = ['/offers'];

function RootLayoutContent() {
  const isLoading = useAuthStore((s) => s.isLoading);
  const loadStoredAuth = useAuthStore((s) => s.loadStoredAuth);
  // Solo el rol de esta app abre el canal: una sesión de la otra app (que
  // acabará en `wrong-app`) no tiene nada que escuchar aquí.
  const realtimeEnabled = useAuthStore(
    (s) => s.isAuthenticated && s.user?.role === (IS_DRIVER_APP ? 'driver' : 'client')
  );
  const { c, isDark } = useTheme();

  // Notificaciones del sistema: llegan como push normal, con la app cerrada o abierta.
  usePushNotifications();

  // Si la sesión muere estando dentro de la app, devuelve al login en vez
  // de dejar la pantalla montada reintentando peticiones que ya no pueden
  // funcionar. Vive aquí porque es el único punto que sobrevive a toda
  // navegación — el guardián tiene que seguir mirando esté donde esté el
  // usuario.
  useSessionGuard();

  // Y si la sesión es de la otra app (cliente en Zipp Domiciliarios o al
  // revés), la saca a `wrong-app`. Cubre las entradas que no pasan por el
  // splash: deep links y pushes con la app cerrada.
  useVariantGuard();

  // El socket, una sola vez para toda la app (ver `useRealtimeOwner`).
  useRealtimeOwner(realtimeEnabled);

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

    // Y cuándo está en primer plano: sin esto los pedidos se seguían
    // sondeando con la app en segundo plano.
    installAppFocusManager();

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

  /**
   * Pantallas cuya cabecera es oscura hasta arriba.
   *
   * Descuentos y Explorar: las dos abren con una franja obsidiana que pasa
   * por debajo de la barra de estado. Se escribe como lista y no como
   * comparación suelta para que añadir la siguiente sea una línea y no otro
   * `endsWith` repartido por el árbol.
   */
  const pathname = usePathname();
  const onDarkHeader = DARK_HEADER_ROUTES.some((route) => pathname.endsWith(route));

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
      {/* Descuentos y Explorar llevan una franja obsidiana que pasa por
          debajo de la barra de estado: ahí la hora va en claro o desaparece.
          La decisión vive aquí, en el único sitio que nunca se desmonta.
          Dentro de la pestaña no serviría —`freezeOnBlur` congela la
          pantalla al perder el foco y podría quedarse sin devolver el
          estilo—, y en el layout de pestañas dejaría la hora en blanco al
          cerrar sesión desde esa pantalla. */}
      <StatusBar style={isDark || onDarkHeader ? 'light' : 'dark'} />
      <Stack screenOptions={screenOptions}>
        <Stack.Screen name="index" options={{ animation: 'fade' }} />
        <Stack.Screen name="(auth)" options={{ animation: 'fade' }} />
        {/* Solo existe el grupo de esta app: metro.config.js deja el otro
            fuera del bundle, y declararlo aquí sería un warning en cada arranque. */}
        {IS_DRIVER_APP
          ? <Stack.Screen name="(driver)" options={{ animation: 'fade' }} />
          : <Stack.Screen name="(client)" options={{ animation: 'fade' }} />}
      </Stack>
    </VersionGate>
  );
}

/** Solo la app cliente guarda caché entre aperturas; el domiciliario siempre pide fresco. */
const persistOptions = {
  persister: queryPersister,
  maxAge: PERSIST_MAX_AGE_MS,
  buster: persistBuster,
  dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
};

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.root}>
      {IS_CLIENT_APP ? (
        <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
          <RootLayoutContent />
        </PersistQueryClientProvider>
      ) : (
        <QueryClientProvider client={queryClient}>
          <RootLayoutContent />
        </QueryClientProvider>
      )}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
