import { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import { useAuthStore } from '../../stores/authStore';
import { useTheme } from '../../hooks/useTheme';
import { useFavoritesMigration } from '../../hooks/useFavorites';
import { useCartAbandonment } from '../../hooks/useCartAbandonment';

export default function ClientLayout() {
  // Selectores y no el store entero: con `useAuthStore()` a secas, cada
  // refresco del token (cada 15 min) re-renderizaba toda la pila del cliente.
  const user = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const router = useRouter();
  const { c } = useTheme();

  // Sube una sola vez los favoritos que quedaron en el teléfono. Sin esto,
  // estrenar la sincronización empezaría vaciándole la lista al cliente.
  useFavoritesMigration();

  // Avisa al servidor cómo va la bolsa para el recordatorio de bolsa
  // abandonada. Vive aquí, no en cart.tsx, porque el carrito sigue "activo"
  // aunque el cliente esté navegando la carta en vez de mirando la bolsa.
  useCartAbandonment();

  useEffect(() => {
    if (isAuthenticated && user && !user.isVerified) {
      router.replace('/(auth)/otp');
    }
  }, [isAuthenticated, user]);

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: c.background },
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
      <Stack.Screen name="business/[id]" />

      {/* La compra sube desde abajo: es una tarea, no un lugar al que se navega. */}
      <Stack.Screen name="cart" options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="checkout" />

      {/* Un mandado no pasa por el carrito: no hay carta que recorrer. */}
      <Stack.Screen name="errand" />
      <Stack.Screen
        name="order-confirmed"
        options={{ animation: 'fade', gestureEnabled: false }}
      />
      {/* Sin gesto de volver: deslizar hacia atrás a mitad de un cobro
          dejaría el pago corriendo sin nadie mirando. La pantalla decide
          cuándo se puede salir. */}
      <Stack.Screen
        name="payment-result"
        options={{ animation: 'fade', gestureEnabled: false }}
      />
      <Stack.Screen name="order-tracking" />

      {/* Cuenta */}
      <Stack.Screen name="orders" />
      <Stack.Screen name="addresses" />
      <Stack.Screen name="favorites" />
      <Stack.Screen name="rewards" />
      <Stack.Screen name="help" />
      <Stack.Screen name="legal" />
      <Stack.Screen name="legal-document" />
      <Stack.Screen name="requests" />
    </Stack>
  );
}
