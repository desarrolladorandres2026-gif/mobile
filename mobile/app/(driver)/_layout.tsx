import { Stack } from 'expo-router';
import { Colors } from '../../constants';
import { DriverTrackingProvider } from '../../hooks/useDriverTracking';
import { OfferSheet } from '../../components/domain/OfferSheet';
import { VerificationSheet } from '../../components/domain/VerificationSheet';
import { SosButton } from '../../components/domain/SosButton';

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
        {/* Aspectos legales: mismo centro que ve el cliente, en el stack del repartidor. */}
        <Stack.Screen name="legal" />
        <Stack.Screen name="legal-document" />
        <Stack.Screen name="requests" />
      </Stack>

      {/*
        Fuera del navegador, igual que el GPS: una oferta llega cuando
        llega, y el domiciliario puede estar en cualquier pestaña. Perder
        el turno por no estar mirando la pantalla correcta sería perder
        dinero por un detalle de navegación.
      */}
      <OfferSheet />
      <VerificationSheet />

      {/* Fuera del navegador, como el GPS: una emergencia no espera a que
          el domiciliario esté en la pantalla correcta. */}
      <SosButton />
    </DriverTrackingProvider>
  );
}
