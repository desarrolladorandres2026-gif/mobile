import { Stack } from 'expo-router';
import { Colors } from '../../constants';
import { DriverTrackingProvider } from '../../hooks/useDriverTracking';
import { OfferSheet } from '../../components/domain/OfferSheet';
import { VerificationSheet } from '../../components/domain/VerificationSheet';
import { LegalAcceptanceGate } from '../../components/domain/LegalAcceptanceGate';

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
        {/* Pantallas compartidas con la app de clientes (screens/shared), en
            el stack del repartidor para no perder el tracking, la hoja de
            ofertas ni el botón SOS mientras las lee. */}
        <Stack.Screen name="order-timeline" />
        <Stack.Screen name="help" />
        <Stack.Screen name="legal" />
        <Stack.Screen name="legal-document" />
        <Stack.Screen name="requests" />
        <Stack.Screen name="account" />
        <Stack.Screen name="account-password" />
        <Stack.Screen name="account-sessions" />
        <Stack.Screen name="account-2fa" />
        <Stack.Screen name="account-delete" />
      </Stack>

      {/*
        Fuera del navegador, igual que el GPS: una oferta llega cuando
        llega, y el domiciliario puede estar en cualquier pestaña. Perder
        el turno por no estar mirando la pantalla correcta sería perder
        dinero por un detalle de navegación.
      */}
      <OfferSheet />
      <VerificationSheet />
      {/* Encima de todo, pero sin desmontar el GPS ni la hoja de ofertas. */}
      <LegalAcceptanceGate />
    </DriverTrackingProvider>
  );
}
