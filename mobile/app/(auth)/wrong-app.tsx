import { useEffect } from 'react';
import { View, StyleSheet, Linking } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Text, Button, Screen } from '../../components/ui';
import { ContentIcon } from '../../components/illustrations';
import { useAuthStore } from '../../stores/authStore';
import { APP_DISPLAY_NAME, OTHER_APP, OTHER_APP_STORE_URL } from '../../constants/variant';
import { Spacing } from '../../theme/tokens';
import { tap } from '../../lib/haptics';

type Role = 'client' | 'driver' | 'admin' | 'business';

const COPY: Record<Role, { title: string; body: string }> = {
  client: {
    title: 'Esta cuenta es de cliente',
    body: `Para pedir a domicilio usa ${OTHER_APP.name}. ${APP_DISPLAY_NAME} es solo para quienes reparten.`,
  },
  driver: {
    title: 'Esta cuenta es de domiciliario',
    body: `Para repartir usa ${OTHER_APP.name}. ${APP_DISPLAY_NAME} es la app para pedir a domicilio.`,
  },
  admin: {
    title: 'Esta cuenta es de administrador',
    body: 'Las cuentas de administrador entran por la consola web, no por la app.',
  },
  business: {
    title: 'Esta cuenta es de comercio',
    body: 'Las cuentas de comercio entran por el portal de negocios, no por la app.',
  },
};

/**
 * Cuenta válida, app equivocada.
 *
 * Zipp y Zipp Domiciliarios son dos apps, y un cliente puede instalar la de
 * domiciliarios por error (o al revés). En vez de un login que "no
 * funciona", se le dice cuál es la suya y se le lleva a la tienda.
 *
 * Es una pantalla y no un `Alert` porque tiene que servir también cuando la
 * sesión ya estaba guardada de antes: el arranque (`app/index.tsx`) manda
 * aquí y necesita un destino que sobreviva al cierre de sesión.
 *
 * El `logout()` se hace AQUÍ, ya montada la pantalla, y no antes de navegar:
 * `useSessionGuard` reacciona a la sesión que se cae con un
 * `router.replace('/(auth)/login')` salvo que ya esté dentro de `(auth)`.
 * Cerrarla antes de llegar haría que el guardián pisara esta pantalla.
 */
export default function WrongAppScreen() {
  const router = useRouter();
  const { role: rawRole } = useLocalSearchParams<{ role?: string }>();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const logout = useAuthStore((s) => s.logout);

  const role: Role = (['client', 'driver', 'admin', 'business'] as const).includes(rawRole as Role)
    ? (rawRole as Role)
    : OTHER_APP.variant;
  const copy = COPY[role];
  const hasOtherApp = role === 'client' || role === 'driver';

  useEffect(() => {
    if (isAuthenticated) logout();
  }, [isAuthenticated, logout]);

  const openOtherApp = () => {
    tap('light');
    // `market://` abre Play Store directamente; si no está (tablet sin
    // Google, iOS) cae a la ficha web.
    Linking.openURL(OTHER_APP.marketUrl).catch(() => {
      Linking.openURL(OTHER_APP_STORE_URL).catch(() => {});
    });
  };

  return (
    <Screen>
      <View style={styles.body}>
        <ContentIcon name={role === 'driver' ? 'domiciliario' : 'ayuda'} size={72} />
        <Text v="titleL" center>{copy.title}</Text>
        <Text v="bodyM" tone="textSecondary" center>{copy.body}</Text>

        <View style={styles.actions}>
          {hasOtherApp ? (
            <Button
              title={`Abrir ${OTHER_APP.name} en la tienda`}
              icon="adelante"
              full
              pill
              onPress={openOtherApp}
            />
          ) : null}
          <Button
            title="Entrar con otra cuenta"
            variant="secondary"
            full
            pill
            onPress={() => { tap('light'); router.replace('/(auth)/login'); }}
          />
        </View>
      </View>
    </Screen>
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
  actions: {
    alignSelf: 'stretch',
    gap: Spacing.sm,
    marginTop: Spacing.lg,
  },
});
