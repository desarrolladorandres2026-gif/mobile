import { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Tabs } from 'expo-router';
import { TabBar } from '../../../components/nav/TabBar';
import { Dock } from '../../../components/nav/Dock';
import { OfflineBanner } from '../../../components/ui';
import { useNetworkStatus } from '../../../hooks/useNetwork';
import { DockHeightContext } from '../../../hooks/useDockHeight';
import { useOrderRealtime } from '../../../hooks/useRealtime';
import { useTheme } from '../../../hooks/useTheme';

/**
 * Contenedor de las pestañas del cliente.
 *
 * El dock y la banda de conexión viven aquí, fuera del navegador, para que
 * sobrevivan al cambio de pestaña: la bolsa y el pedido en curso no deberían
 * desaparecer solo porque te moviste a Explorar.
 *
 * El dock además publica su altura real por contexto, para que cada pantalla
 * reserve exactamente ese espacio al final de su scroll —ni de más ni de menos.
 */
export default function ClientTabsLayout() {
  const { c } = useTheme();
  const { connected } = useOrderRealtime();
  const { online } = useNetworkStatus();
  const [dockHeight, setDockHeight] = useState(0);

  return (
    <DockHeightContext.Provider value={dockHeight}>
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <Tabs
          // `freezeOnBlur`: una pestaña oculta deja de re-renderizarse hasta
          // que se vuelve a ella. Sin esto, el Inicio seguía reaccionando a cada
          // cambio de caché mientras se miraba otra pestaña.
          screenOptions={{ headerShown: false, freezeOnBlur: true, sceneStyle: { backgroundColor: c.background } }}
          tabBar={(props) => <TabBar {...props} />}
        >
          <Tabs.Screen name="home" options={{ title: 'Inicio' }} />
          <Tabs.Screen name="search" options={{ title: 'Explorar' }} />
          <Tabs.Screen name="offers" options={{ title: 'Descuentos' }} />
          <Tabs.Screen name="profile" options={{ title: 'Perfil' }} />
        </Tabs>

        <Dock onHeightChange={setDockHeight} />
        {/* La red manda sobre el socket.
            Antes esto era `!connected` del socket, que es otra cosa: decia
            "sin conexion" mientras negociaba con wifi perfecto, y se callaba
            cuando de verdad no habia red. Ahora el aviso sale cuando falta la
            red, o cuando hay red pero el canal en vivo lleva caido lo
            suficiente como para que el pedido ya no se actualice solo --
            que para el usuario es el mismo problema. */}
        <OfflineBanner visible={!online || !connected} />
      </View>
    </DockHeightContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
