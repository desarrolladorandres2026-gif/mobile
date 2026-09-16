import { ScrollView, View, StyleSheet, Linking } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import {
  Text, Icon, Button, Screen, Header, EmptyState, ErrorState, Skeleton,
} from '../../components/ui';
import { legalApi } from '../../services/endpoints';
import { useTheme } from '../../hooks/useTheme';
import type { IconName } from '../../theme/icons';
import { Spacing } from '../../theme/tokens';
import { tap } from '../../lib/haptics';
import { SUPPORT_PHONE, supportWhatsAppUrl } from '../../constants/config';
import { ROUTES } from '../../lib/routing';

/**
 * Lector de un solo documento legal.
 *
 * El perfil enlaza aquí con `?kind=`; la pantalla busca ese documento entre los
 * vigentes y muestra su texto tal cual lo publicó Zipp. Si todavía no está
 * publicado se dice así, con el canal para pedirlo: nunca se inventa contenido
 * legal ni se muestra un texto de relleno.
 */

interface LegalDocument {
  _id: string;
  kind: string;
  version: string;
  title: string;
  content: string;
  effectiveAt: string;
}

/** Icono con el que se anuncia cada documento, igual al que usa el perfil. */
const KIND_ICON: Record<string, IconName> = {
  terms: 'documento',
  privacy: 'privacidad',
  habeas_data: 'consentimiento',
};

export default function LegalDocumentScreen() {
  const { kind = '', title = 'Documento legal' } = useLocalSearchParams<{
    kind: string;
    title: string;
  }>();
  const router = useRouter();
  const { c, isDark } = useTheme();

  const { data: documents = [], isLoading, isError, refetch } = useQuery<LegalDocument[]>({
    // Misma clave que el Centro legal: un solo fetch alimenta las dos pantallas.
    queryKey: ['legal-documents'],
    queryFn: legalApi.documents,
  });

  const document = documents.find((d) => d.kind === kind);
  const showsDataRights = kind === 'privacy' || kind === 'habeas_data';

  const askForDocument = () => {
    tap('light');
    const text = `Hola, quiero consultar el documento "${title}" de Zipp.`;
    const url = supportWhatsAppUrl(text);

    Linking.openURL(url).catch(() => {
      Linking.openURL(`tel:${SUPPORT_PHONE}`).catch(() => {});
    });
  };

  return (
    <Screen style={{ backgroundColor: isDark ? '#0C101C' : '#F1F3F7' }}>
      <Header title={title} fallback={ROUTES.profile} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={styles.skeletonBlock}>
            <Skeleton height={22} width="70%" />
            <Skeleton height={14} width="45%" />
            <Skeleton height={220} />
          </View>
        ) : isError ? (
          <ErrorState
            title="No pudimos cargar el documento"
            message="Revisa tu conexión e inténtalo de nuevo."
            onRetry={() => { void refetch(); }}
          />
        ) : document ? (
          <View
            style={[
              styles.docCard,
              {
                backgroundColor: c.surface,
                borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
              },
            ]}
          >
            <View style={styles.docHeader}>
              <View style={styles.cleanIcon}>
                <Icon name={KIND_ICON[kind] ?? 'documento'} size="lg" color="#6268A0" />
              </View>
              <View style={styles.flex}>
                <Text v="strongL">{document.title}</Text>
                <Text v="caption" tone="textMuted">
                  Versión {document.version} · vigente desde{' '}
                  {new Date(document.effectiveAt).toLocaleDateString('es-CO')}
                </Text>
              </View>
            </View>

            <Text v="bodyS" tone="textSecondary" style={styles.docContent}>
              {document.content}
            </Text>
          </View>
        ) : (
          <EmptyState
            icon={KIND_ICON[kind] ?? 'documento'}
            title="Este documento aún no está publicado"
            message="Todavía no hay una versión vigente en la app. Escríbenos y te la hacemos llegar."
            actionLabel="Pedirlo por WhatsApp"
            onAction={askForDocument}
          />
        )}

        {/*
          Solo en los documentos de datos: en los términos del servicio este
          aviso no viene al caso. Los derechos se ejercen por PQRS, no por chat.
        */}
        {showsDataRights ? (
          <View
            style={[
              styles.rightsCard,
              {
                backgroundColor: c.surface,
                borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
              },
            ]}
          >
            <Text v="strongM">Tus derechos como titular</Text>
            <Text v="bodyS" tone="textSecondary">
              Puedes conocer, actualizar, rectificar o suprimir tus datos, y revocar esta
              autorización, radicando una solicitud desde el canal de PQRS.
            </Text>
            <Button
              title="Radicar una solicitud"
              variant="secondary"
              onPress={() => {
                tap('light');
                router.push(ROUTES.requests as never);
              }}
            />
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.huge,
    gap: Spacing.lg,
  },
  skeletonBlock: {
    gap: Spacing.md,
  },
  docCard: {
    padding: Spacing.lg,
    borderRadius: 24,
    borderWidth: 1,
    gap: Spacing.md,
  },
  docHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  cleanIcon: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  docContent: {
    lineHeight: 20,
  },
  rightsCard: {
    padding: Spacing.lg,
    borderRadius: 24,
    borderWidth: 1,
    gap: Spacing.md,
  },
});
