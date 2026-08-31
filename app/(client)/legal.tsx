import { ScrollView, View, StyleSheet, Linking } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Screen, Header, Card, Text, Button } from '../../components/ui';
import { legalApi } from '../../services/endpoints';
import { Spacing } from '../../theme/tokens';

export default function LegalCenter() {
  const { data: documents = [], isLoading } = useQuery({ queryKey: ['legal-documents'], queryFn: legalApi.documents });
  return <Screen><Header title="Centro legal" fallback="/(client)/settings" /><ScrollView contentContainerStyle={styles.content}>
    <Text v="bodyM" tone="textSecondary">Consulta los documentos vigentes, las condiciones de promociones y tus derechos sobre datos personales.</Text>
    {isLoading ? <Text v="bodyM">Cargando…</Text> : documents.map((d: any) => <Card key={d._id} style={styles.card}><Text v="titleM">{d.title}</Text><Text v="caption" tone="textMuted">Versión {d.version} · vigente desde {new Date(d.effectiveAt).toLocaleDateString('es-CO')}</Text><Text v="bodyS" tone="textSecondary">{d.content}</Text></Card>)}
    <Card style={styles.card}><Text v="titleM">Atención y protección al consumidor</Text><Text v="bodyS" tone="textSecondary">Para peticiones, quejas, reclamos, sugerencias o derechos de datos usa el centro de ayuda. También puedes acudir a la SIC.</Text><Button title="Abrir SIC" variant="secondary" onPress={() => Linking.openURL('https://www.sic.gov.co/')} /></Card>
  </ScrollView></Screen>;
}
const styles = StyleSheet.create({ content: { padding: Spacing.xl, gap: Spacing.lg, paddingBottom: Spacing.huge }, card: { gap: Spacing.sm } });
