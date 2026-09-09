import { View, StyleSheet, ScrollView } from 'react-native';
import { Text, Button } from '../ui';
import { ContentIcon } from '../illustrations';
import { useTheme } from '../../hooks/useTheme';
import { Spacing, BorderRadius } from '../../theme/tokens';
import { tap } from '../../lib/haptics';

/**
 * La pantalla de "algo se rompió".
 *
 * Va aparte del layout raíz porque tiene una regla que el resto de la app no
 * tiene: **no puede depender de casi nada**. Si el árbol acaba de reventar,
 * cualquier hook, provider o consulta que se use aquí puede reventar también
 * y dejar al usuario en el mismo blanco del que se intentaba salir. Por eso
 * solo usa el tema y componentes de presentación.
 *
 * El detalle técnico se muestra únicamente en desarrollo. En producción no
 * le dice nada a nadie y sí da la sensación de app rota; el reporte ya viajó
 * al servidor con el stack completo.
 */
export function AppErrorScreen({
  error,
  onRetry,
}: {
  error: Error;
  onRetry: () => void;
}) {
  const { c } = useTheme();

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <ContentIcon name="ayuda" size={72} />

      <Text v="titleL" center>Algo se rompió</Text>
      <Text v="bodyM" tone="textSecondary" center>
        No fue culpa tuya. Ya nos llegó el aviso con lo que pasó. Vuelve a
        intentarlo y, si sigue igual, cierra la app y ábrela de nuevo.
      </Text>

      {__DEV__ ? (
        <ScrollView style={[styles.detail, { backgroundColor: c.surface }]}>
          <Text v="code" tone="textMuted">{error?.message}</Text>
          {error?.stack ? (
            <Text v="code" tone="textMuted">{error.stack}</Text>
          ) : null}
        </ScrollView>
      ) : null}

      <Button
        title="Reintentar"
        icon="reintentar"
        full
        onPress={() => { tap('medium'); onRetry(); }}
        style={styles.action}
      />
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
  detail: {
    maxHeight: 180,
    alignSelf: 'stretch',
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
  },
  action: { marginTop: Spacing.md },
});
