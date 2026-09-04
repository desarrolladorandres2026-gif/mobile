import { Stack } from 'expo-router';
import { Colors } from '../../constants';
import { DriverTrackingProvider } from '../../hooks/useDriverTracking';

export default function DriverLayout() {
  return (
    // El GPS se gobierna aquí y no en una pantalla concreta: el
    // repartidor navega entre el panel y sus pedidos constantemente, y el
    // seguimiento tiene que sobrevivir a esas transiciones sin reiniciar
    // el sensor en cada una. Ver `DriverTrackingProvider`.
    <DriverTrackingProvider>
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
    </DriverTrackingProvider>
  );
}
