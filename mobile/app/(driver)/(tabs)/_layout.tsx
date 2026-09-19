import { View, StyleSheet } from 'react-native';
import { Tabs } from 'expo-router';
import { TabBar } from '../../../components/nav/TabBar';
import { OfflineBanner } from '../../../components/ui';
import { useNetworkStatus } from '../../../hooks/useNetwork';
import { useOrderRealtime } from '../../../hooks/useRealtime';
import { useTheme } from '../../../hooks/useTheme';

export default function DriverTabsLayout() {
  const { c } = useTheme();
  const { connected } = useOrderRealtime();
  const { online } = useNetworkStatus();

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <Tabs
        // `freezeOnBlur`: una pestaña oculta deja de re-renderizarse hasta
        // que se vuelve a ella. Sin esto, el Inicio seguía reaccionando a cada
        // cambio de caché mientras se miraba otra pestaña.
        screenOptions={{ headerShown: false, freezeOnBlur: true, sceneStyle: { backgroundColor: c.background } }}
        tabBar={(props) => <TabBar {...props} />}
      >
        <Tabs.Screen name="dashboard" options={{ title: 'Turno' }} />
        <Tabs.Screen name="orders" options={{ title: 'Pedidos' }} />
        <Tabs.Screen name="earnings" options={{ title: 'Ganancias' }} />
        <Tabs.Screen name="profile" options={{ title: 'Perfil' }} />
      </Tabs>

      {/* La red manda sobre el socket.
          Antes esto era `!connected` del socket, que es otra cosa: decia
          "sin conexion" mientras negociaba con wifi perfecto, y se callaba
          cuando de verdad no habia red. Ahora el aviso sale cuando falta la
          red, o cuando hay red pero el canal en vivo lleva caido lo
          suficiente como para que el pedido ya no se actualice solo --
          que para el usuario es el mismo problema. */}
      <OfflineBanner visible={!online || !connected} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
