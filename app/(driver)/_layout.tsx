import { Stack } from 'expo-router';
import { Colors } from '../../constants';

export default function DriverLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: Colors.background },
      }}
    >
      <Stack.Screen name="(tabs)" />
      {/* Recogida y entrega: evidencia, código de seguridad, chat y llamada. */}
      <Stack.Screen name="order/[id]" />
    </Stack>
  );
}
