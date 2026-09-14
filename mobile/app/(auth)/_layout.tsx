import { Stack } from 'expo-router';
import { useTheme } from '../../hooks/useTheme';

/**
 * El flujo de auth ya no fuerza el modo oscuro: sigue el tema activo de la
 * app, que por defecto es 'auto' (sincronizado con el sistema operativo).
 */
export default function AuthLayout() {
  const { c } = useTheme();

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: c.background },
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="welcome" options={{ animation: 'fade' }} />
      <Stack.Screen name="login" options={{ animation: 'fade' }} />
      <Stack.Screen name="complete-profile" />
      <Stack.Screen name="otp" />
      <Stack.Screen name="forgot-password" />
    </Stack>
  );
}
