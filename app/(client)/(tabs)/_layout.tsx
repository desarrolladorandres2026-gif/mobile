import { View, StyleSheet } from 'react-native';
import { Tabs } from 'expo-router';
import { TabBar } from '../../../components/nav/TabBar';
import { Dock } from '../../../components/nav/Dock';
import { OfflineBanner } from '../../../components/ui';
import { useOrderRealtime } from '../../../hooks/useRealtime';
import { useTheme } from '../../../hooks/useTheme';

/**
 * Contenedor de las pestañas del cliente.
 *
 * El dock y la banda de conexión viven aquí, fuera del navegador, para que
 * sobrevivan al cambio de pestaña: la bolsa y el pedido en curso no deberían
 * desaparecer solo porque te moviste a Explorar.
 */
export default function ClientTabsLayout() {
  const { c } = useTheme();
  const { connected } = useOrderRealtime();

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <Tabs
        screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: c.background } }}
        tabBar={(props) => <TabBar {...props} />}
      >
        <Tabs.Screen name="home" options={{ title: 'Inicio' }} />
        <Tabs.Screen name="search" options={{ title: 'Explorar' }} />
        <Tabs.Screen name="orders" options={{ title: 'Pedidos' }} />
        <Tabs.Screen name="profile" options={{ title: 'Perfil' }} />
      </Tabs>

      <Dock />
      <OfflineBanner visible={!connected} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
