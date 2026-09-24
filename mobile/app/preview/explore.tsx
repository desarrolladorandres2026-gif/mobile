import { useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { Redirect } from 'expo-router';
import { Text } from '../../components/ui';
import { ExploreSections } from '../../components/domain/explore/ExploreSections';
import { PreviewProvider } from '../../components/domain/explore/PreviewContext';
import { useTheme } from '../../hooks/useTheme';
import { PREVIEW_ADMIN_ORIGINS } from '../../constants/config';
import {
  PREVIEW_MESSAGE, isAllowedPreviewOrigin, parsePreviewMessage,
} from '../../lib/exploreSections';
import type { ExploreSection } from '../../services/endpoints';
import { Spacing } from '../../theme/tokens';

/**
 * La vista previa del constructor de Explorar, dentro de un iframe del panel.
 *
 * Es la misma pantalla de la app (`ExploreSections`) compilada a web, así
 * que lo que el admin ve es exactamente lo que se va a publicar — sin un
 * segundo renderizador que se desincronice.
 *
 * No habla con la API: el panel resuelve el borrador con su sesión y le
 * manda aquí las secciones ya resueltas. Solo se aceptan mensajes del
 * panel configurado (`PREVIEW_ADMIN_ORIGINS`) y de la ventana que la
 * contiene. Todo corre en `useEffect`: el export estático pre-renderiza
 * este archivo en Node, donde `window` no existe.
 *
 * Fuera de la web no tiene sentido (un enlace `zipp://preview/explore`
 * abriría una pantalla vacía): se redirige al inicio.
 */
export default function ExplorePreviewScreen() {
  const { c } = useTheme();
  const [sections, setSections] = useState<ExploreSection[] | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || window.parent === window) return;

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      if (!isAllowedPreviewOrigin(event.origin, PREVIEW_ADMIN_ORIGINS)) return;
      const parsed = parsePreviewMessage(event.data);
      if (parsed) setSections(parsed);
    };

    window.addEventListener('message', onMessage);
    for (const origin of PREVIEW_ADMIN_ORIGINS) {
      window.parent.postMessage({ type: PREVIEW_MESSAGE.ready }, origin);
    }
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (Platform.OS !== 'web') return <Redirect href="/" />;

  return (
    <PreviewProvider>
      <ScrollView
        style={{ backgroundColor: c.background }}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {sections === null ? (
          <View style={styles.waiting}>
            <Text v="bodyM" tone="textMuted">Esperando el borrador del panel…</Text>
          </View>
        ) : sections.length === 0 ? (
          <View style={styles.waiting}>
            <Text v="bodyM" tone="textMuted">Con este borrador Explorar queda vacío.</Text>
          </View>
        ) : (
          <ExploreSections sections={sections} />
        )}
      </ScrollView>
    </PreviewProvider>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: Spacing.xs, paddingTop: Spacing.lg, paddingBottom: Spacing.xxxl },
  waiting: { paddingVertical: Spacing.xxxl, alignItems: 'center' },
});
