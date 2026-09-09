import { useEffect, useState } from 'react';
import { View, StyleSheet, Linking, Platform } from 'react-native';
import Constants from 'expo-constants';
import { Text, Button } from '../ui';
import { ContentIcon } from '../illustrations';
import { useTheme } from '../../hooks/useTheme';
import { API_URL } from '../../constants';
import { isOlder } from '../../lib/versionCompare';
import { Spacing } from '../../theme/tokens';
import { tap } from '../../lib/haptics';

/**
 * Bloquea las versiones que ya no se pueden soportar.
 *
 * No existía nada parecido: una versión vieja con un fallo en el flujo de
 * dinero seguía viva en los teléfonos indefinidamente, y no había forma de
 * sacarla del aire ni sabiendo que estaba mal. Las actualizaciones por aire
 * cubren el JavaScript; esto cubre el caso en que hace falta una build nueva.
 *
 * Es deliberadamente **la única pantalla sin salida de toda la app**. La
 * regla del proyecto es no dejar callejones sin salida, y aquí se rompe a
 * propósito: dejar seguir a alguien con una versión que cobra mal es peor
 * que pedirle que actualice.
 */

// La comparación de versiones vive en `lib/versionCompare.ts`, sin
// dependencias de UI, para poder probarla sin arrastrar Reanimated. Se
// reexporta porque este archivo ya era donde el resto del código la
// buscaba.
export { isOlder } from '../../lib/versionCompare';

interface Gate {
  blocked: boolean;
  storeUrl: string | null;
}

export function VersionGate({ children }: { children: React.ReactNode }) {
  const { c } = useTheme();
  const [gate, setGate] = useState<Gate>({ blocked: false, storeUrl: null });

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        // `fetch` pelado y no el cliente `api`: esta comprobación tiene que
        // funcionar aunque la sesión esté rota, que es justo lo que le puede
        // pasar a una versión demasiado vieja.
        const response = await fetch(`${API_URL}/app/version`);
        if (!response.ok) return;

        const { data } = await response.json();
        const current = Constants.expoConfig?.version;
        if (!alive || !current || !data?.minSupported) return;

        setGate({
          blocked: isOlder(current, data.minSupported),
          storeUrl: Platform.OS === 'ios' ? data.iosUrl : data.androidUrl,
        });
      } catch {
        // Sin red o con el servidor caído **no se bloquea nunca**. Un fallo
        // de comprobación no puede dejar a nadie fuera de la app: el error
        // de dejar entrar a una versión vieja es reversible; el de bloquear
        // a todo el mundo por un timeout, no.
      }
    })();

    return () => { alive = false; };
  }, []);

  if (!gate.blocked) return <>{children}</>;

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <ContentIcon name="seguridad" size={72} />
      <Text v="titleL" center>Actualiza Zipp</Text>
      <Text v="bodyM" tone="textSecondary" center>
        Esta versión ya no se puede usar. Actualízala para seguir pidiendo:
        es rápido y no pierdes nada de tu cuenta.
      </Text>
      {gate.storeUrl ? (
        <Button
          title="Actualizar ahora"
          full
          onPress={() => {
            tap('medium');
            Linking.openURL(gate.storeUrl!).catch(() => {});
          }}
          style={styles.action}
        />
      ) : (
        <Text v="caption" tone="textMuted" center>
          Búscala como "Zipp" en tu tienda de aplicaciones.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.md,
    padding: Spacing.xl,
  },
  action: { marginTop: Spacing.md },
});
