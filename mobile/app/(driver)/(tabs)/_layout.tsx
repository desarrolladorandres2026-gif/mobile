import { View, StyleSheet } from 'react-native';
import { Tabs } from 'expo-router';
import { TabBar } from '../../../components/nav/TabBar';
import { OfflineBanner } from '../../../components/ui';
import { useOrderRealtime } from '../../../hooks/useRealtime';
import { useTheme } from '../../../hooks/useTheme';

export default function DriverTabsLayout() {
  const { c } = useTheme();
  const { connected } = useOrderRealtime();

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <Tabs
        screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: c.background } }}
        tabBar={(props) => <TabBar {...props} />}
      >
        <Tabs.Screen name="dashboard" options={{ title: 'Turno' }} />
        <Tabs.Screen name="orders" options={{ title: 'Pedidos' }} />
        <Tabs.Screen name="earnings" options={{ title: 'Ganancias' }} />
        <Tabs.Screen name="profile" options={{ title: 'Perfil' }} />
      </Tabs>

      <OfflineBanner visible={!connected} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
