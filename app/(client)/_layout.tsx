import { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import { useAuthStore } from '../../stores/authStore';
import { useTheme } from '../../hooks/useTheme';

export default function ClientLayout() {
  const { user, isAuthenticated } = useAuthStore();
  const router = useRouter();
  const { c } = useTheme();

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
      <Stack.Screen
        name="order-confirmed"
        options={{ animation: 'fade', gestureEnabled: false }}
      />
      <Stack.Screen name="order-tracking" />

      {/* Cuenta */}
      <Stack.Screen name="addresses" />
      <Stack.Screen name="favorites" />
      <Stack.Screen name="rewards" />
      <Stack.Screen name="notifications" />
      <Stack.Screen name="help" />
      <Stack.Screen name="legal" />
      <Stack.Screen name="legal-document" />
      <Stack.Screen name="requests" />
    </Stack>
  );
}
