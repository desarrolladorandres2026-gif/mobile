import { ScrollView, View, StyleSheet, Linking } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Screen, Header, Text, Button, Icon } from '../../components/ui';
import { legalApi } from '../../services/endpoints';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { IS_DRIVER_APP } from '../../constants/variant';
import { ROUTES } from '../../lib/routing';

export default function LegalCenter() {
  const { c, isDark } = useTheme();
  const { data: documents = [], isLoading } = useQuery({
    queryKey: ['legal-documents'],
    queryFn: legalApi.documents,
  });

  return (
    <Screen style={{ backgroundColor: isDark ? '#0C101C' : '#F1F3F7' }}>
      <Header title="Centro legal y datos" fallback={ROUTES.profile} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View
          style={[
            styles.infoCard,
            {
              backgroundColor: c.surface,
              borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
            },
          ]}
        >
          <Text v="bodyM" tone="textSecondary">
            Consulta los documentos vigentes, las condiciones {IS_DRIVER_APP ? 'del servicio' : 'de promociones'} y tus derechos sobre datos personales según la normativa colombiana.
          </Text>
        </View>

        {isLoading ? (
          <Text v="bodyM" center>Cargando documentos…</Text>
        ) : (
          documents.map((d: any) => (
            <View
              key={d._id}
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
                  <Icon name="seguridad" size="lg" color="#6268A0" />
                </View>
                <View style={styles.flex}>
                  <Text v="strongL">{d.title}</Text>
                  <Text v="caption" tone="textMuted">
                    Versión {d.version} · vigente desde {new Date(d.effectiveAt).toLocaleDateString('es-CO')}
                  </Text>
                </View>
              </View>

              <Text v="bodyS" tone="textSecondary" style={styles.docContent}>
                {d.content}
              </Text>
            </View>
          ))
        )}

        <View
          style={[
            styles.sicCard,
            {
              backgroundColor: c.surface,
              borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
            },
          ]}
        >
          <Text v="strongL">Atención y protección al consumidor</Text>
          <Text v="bodyS" tone="textSecondary">
            Para peticiones, quejas, reclamos, sugerencias o derechos de datos usa el canal de PQRS. También puedes acudir directamente a la Superintendencia de Industria y Comercio (SIC).
          </Text>
          <Button
            title="Abrir portal de la SIC"
            variant="secondary"
            onPress={() => Linking.openURL('https://www.sic.gov.co/')}
          />
        </View>
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
  infoCard: {
    padding: Spacing.lg,
    borderRadius: 22,
    borderWidth: 1,
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
  sicCard: {
    padding: Spacing.lg,
    borderRadius: 24,
    borderWidth: 1,
    gap: Spacing.md,
  },
});
