import { memo } from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Text, Icon, Card } from '../ui';
import { ContentIcon } from '../illustrations';
import { ExploreCollections } from './ExploreCollections';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing } from '../../theme/tokens';

/**
 * El feed de descubrimiento de Explorar, sin nada escrito ni categoría
 * puesta.
 *
 * Se lee en dos bandas: arriba las colecciones que arma el servidor solas y
 * rotan por día y franja horaria, y abajo la salida para lo que no está en
 * ninguna carta. El grid de antojos que abría la pantalla se quitó
 * (2026-09-22): repetía las categorías que el Inicio ya enseña.
 *
 * `docs/EXPLORAR.md` §4 documenta las trece bandas completas; esto cubre
 * las que ya tienen datos reales del lado del cliente (Fase 3 parcial, ver
 * §13 del documento).
 */
export const ExploreFeed = memo(function ExploreFeed({
  coords,
  coordsReady,
  bottomSpace,
  onErrand,
}: {
  coords?: { lat: number; lng: number } | null;
  coordsReady: boolean;
  bottomSpace: number;
  onErrand: () => void;
}) {
  const { c } = useTheme();

  return (
    <ScrollView
      contentContainerStyle={[styles.list, { paddingBottom: bottomSpace }]}
      showsVerticalScrollIndicator={false}
      keyboardDismissMode="on-drag"
    >
      <Animated.View entering={FadeIn.duration(250)} style={styles.discovery}>
        {/* ── Las colecciones ──
            Lo único que responde a quien entró sin saber qué quiere. */}
        <ExploreCollections coords={coords} ready={coordsReady} />

        {/* ── Mandados ── */}
        {/* Cierra la lista a propósito: si nada de lo de arriba es lo que
            buscas, esto es la salida. No lleva a ninguna lista de negocios,
            es para lo que no está en ninguna carta. */}
        <Card
          tone="outline"
          style={styles.errand}
          onPress={onErrand}
          accessibilityLabel="Pedir un mandado"
          accessibilityHint="Encargar algo que no está en ninguna carta"
        >
          <View style={[styles.errandIcon, { backgroundColor: c.surfaceLight }]}>
            <ContentIcon name="paquete" size={30} />
          </View>
          <View style={styles.errandCopy}>
            <Text v="titleS">¿No está en ninguna carta?</Text>
            <Text v="bodyM" tone="textSecondary">
              Pide un mandado y te lo recogemos donde sea.
            </Text>
          </View>
          <Icon name="siguiente" size="md" color={c.textMuted} />
        </Card>
      </Animated.View>
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: Spacing.xs,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.lg,
    gap: Spacing.md,
  },
  discovery: { gap: Spacing.xxl },

  errand: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  errandIcon: {
    width: 44, height: 44, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  errandCopy: { flex: 1, gap: 2 },
});
