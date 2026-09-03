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
import { ZippMarkDrawing } from '../components/brand/ZippLogo';
import { registerServiceWorker } from '../lib/pwa';
import { AdModal } from '../components/domain/AdModal';

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

  // Mientras cargan fuentes y sesión, la marca se dibuja sola. Es la misma
  // animación del splash, así que la transición no se percibe como una espera.
  if (isLoading || !fontsLoaded) {
    return (
      <View style={[styles.boot, { backgroundColor: c.background }]}>
        <ZippMarkDrawing size={80} />
      </View>
    );
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
      <AdModal />
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
