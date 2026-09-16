import { View, StyleSheet } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { Text, Button, Screen } from '../components/ui';
import { ContentIcon } from '../components/illustrations';
import { useTheme } from '../hooks/useTheme';
import { HOME_ROUTE } from '../constants/variant';
import { Spacing } from '../theme/tokens';
import { tap } from '../lib/haptics';

/**
 * Ruta que no existe.
 *
 * Hasta ahora no había ninguna: expo-router caía en su pantalla de
 * desarrollo, y en una build de release eso es una pantalla en blanco sin
 * camino de vuelta. Pasaba de verdad — cinco navegaciones apuntaban a
 * `(client)/(tabs)/orders`, que no existe, incluida "Ver mis pedidos"
 * después de pagar.
 *
 * La salida es el inicio de esta app: en Zipp el Home del cliente, en Zipp
 * Domiciliarios el panel del repartidor.
 */
export default function NotFoundScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const home = HOME_ROUTE;

  return (
    <>
      <Stack.Screen options={{ title: 'No encontrado' }} />
      <Screen>
        <View style={styles.body}>
          <ContentIcon name="ayuda" size={72} />
          <Text v="titleL" center>Esta pantalla no existe</Text>
          <Text v="bodyM" tone="textSecondary" center>
            El enlace que seguiste no lleva a ninguna parte. No es culpa tuya.
          </Text>
          <Button
            title="Volver al inicio"
            full
            onPress={() => { tap('light'); router.replace(home); }}
            style={{ marginTop: Spacing.md }}
          />
        </View>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.md,
    padding: Spacing.xl,
  },
});
