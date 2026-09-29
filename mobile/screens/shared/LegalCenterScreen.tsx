import { ScrollView, View, Pressable, StyleSheet, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Screen, Header, Text, Button, Icon } from '../../components/ui';
import { legalApi } from '../../services/endpoints';
import { useTheme } from '../../hooks/useTheme';
import { Spacing } from '../../theme/tokens';
import { IS_DRIVER_APP } from '../../constants/variant';
import { ROUTES } from '../../lib/routing';

/** Documentos que regulan datos personales: se presentan como un solo item. */
const PERSONAL_DATA_KINDS = ['privacy', 'habeas_data'];

export default function LegalCenter() {
  const { c, isDark } = useTheme();
  const router = useRouter();
  const { data: documents = [], isLoading } = useQuery({
    queryKey: ['legal-documents'],
    queryFn: legalApi.documents,
  });

  const hasPersonalData = documents.some((d: any) => PERSONAL_DATA_KINDS.includes(d.kind));
  const rows: { key: string; kind: string; title: string; note: string }[] = [];
  if (hasPersonalData) {
    rows.push({
      key: 'personal_data',
      kind: 'personal_data',
      title: 'Privacidad y datos personales',
      note: 'Política de privacidad, autorización de tratamiento y tus derechos',
    });
  }
  for (const d of documents as any[]) {
    if (PERSONAL_DATA_KINDS.includes(d.kind)) continue;
    rows.push({
      key: d._id,
      kind: d.kind,
      title: d.title,
      note: `Versión ${d.version} · vigente desde ${new Date(d.effectiveAt).toLocaleDateString('es-CO')}`,
    });
  }

  return (
    <Screen style={{ backgroundColor: isDark ? '#0C101C' : '#F1F3F7' }}>
      <Header title="Centro legal y datos" fallback={ROUTES.profile} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text v="bodyM" tone="textSecondary">
          Consulta los documentos vigentes, las condiciones {IS_DRIVER_APP ? 'del servicio' : 'de promociones'} y tus derechos sobre datos personales según la normativa colombiana.
        </Text>

        {isLoading ? (
          <Text v="bodyM" center>Cargando documentos…</Text>
        ) : (
          <View>
            {rows.map((r, i) => (
              <Pressable
                key={r.key}
                accessibilityRole="button"
                onPress={() => router.push(ROUTES.legalDocument(r.kind, r.title) as never)}
                style={[
                  styles.row,
                  i > 0 && { borderTopColor: c.border, borderTopWidth: StyleSheet.hairlineWidth },
                ]}
              >
                <View style={styles.flex}>
                  <Text v="strongL">{r.title}</Text>
                  <Text v="caption" tone="textMuted">{r.note}</Text>
                </View>
                <Icon name="siguiente" size="md" color={c.textMuted} />
              </Pressable>
            ))}
          </View>
        )}

        <View style={styles.sic}>
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

        <Text
          v="caption"
          tone="textMuted"
          center
          accessibilityRole="link"
          onPress={() => Linking.openURL('https://github.com/twitter/twemoji')}
        >
          Ilustraciones: Twemoji © Twitter, Inc. y colaboradores — CC-BY 4.0
        </Text>
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.lg,
  },
  sic: {
    gap: Spacing.md,
  },
});
