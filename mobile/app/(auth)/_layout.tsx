import { Stack } from 'expo-router';
import { useTheme } from '../../hooks/useTheme';
import { IS_CLIENT_APP, IS_DRIVER_APP } from '../../constants/variant';

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
      <Stack.Screen name="login" options={{ animation: 'fade' }} />
      {/* Perfil a medias (login social) solo existe en la app de clientes;
          su archivo ni siquiera va en el bundle del driver. */}
      {IS_CLIENT_APP ? <Stack.Screen name="complete-profile" /> : null}
      <Stack.Screen name="otp" />
      {/* Celular nuevo en `pendingPhone`: completar perfil o Mi cuenta. */}
      <Stack.Screen name="verify-phone" />
      {/* Segundo paso de cualquier login con 2FA. */}
      <Stack.Screen name="two-factor" />
      <Stack.Screen name="forgot-password" />
      {/* Cuenta de la otra app: explica cuál es la suya y la enlaza. */}
      <Stack.Screen name="wrong-app" options={{ animation: 'fade', gestureEnabled: false }} />
      {IS_DRIVER_APP ? <Stack.Screen name="become-driver" /> : null}
    </Stack>
  );
}
