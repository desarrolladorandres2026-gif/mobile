import { useState } from 'react';
import {
  View, ScrollView, StyleSheet, RefreshControl, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  Text, Icon, Card, Button, Input, Badge, Notice, DetailRow, LoadingScreen, ErrorState, SectionHeader,
} from '../../../components/ui';
import { useDriverEarnings, useDriverDebts, useReportCash } from '../../../hooks/useApi';
import { useTabContentPadding } from '../../../hooks/useBottomSpace';
import { useTheme } from '../../../hooks/useTheme';
import { BorderRadius, Spacing } from '../../../theme/tokens';
import { money } from '../../../lib/format';
import { tap } from '../../../lib/haptics';

export default function DriverEarningsScreen() {
  const { c } = useTheme();
  const bottomSpace = useTabContentPadding();
  const [referencia, setReferencia] = useState('');
  const [mostrarReporte, setMostrarReporte] = useState(false);

  const {
    data: earningsData, isLoading: loadingEarnings, refetch: refetchEarnings, isRefetching: refetchingEarnings,
  } = useDriverEarnings();
  const {
    data: debtsData, isLoading: loadingDebts, refetch: refetchDebts, isRefetching: refetchingDebts,
  } = useDriverDebts();
  const reportCash = useReportCash();

  const isRefetching = refetchingEarnings || refetchingDebts;

  const handleRefresh = async () => {
    await Promise.all([refetchEarnings(), refetchDebts()]);
  };

  const enviarReporte = () => {
    const pendiente = debtsData?.outstanding ?? 0;
    if (pendiente <= 0) {
      Alert.alert('Sin saldo', 'No tienes efectivo pendiente por rendir.');
      return;
    }
    if (referencia.trim().length < 4) {
      Alert.alert(
        'Falta la referencia',
        'Escribe el número de la consignación o transferencia (mínimo 4 caracteres).'
      );
      return;
    }

    tap('medium');
    reportCash.mutate(
      { reference: referencia.trim() },
      {
        onSuccess: (data: any) => {
          tap('success');
          Alert.alert(
            'Reporte enviado',
            `Reportaste ${money(data.totalReported)} en ${data.reportedCount} pedido(s). ZIPP verificará tu comprobante para actualizar tu saldo.`
          );
          setReferencia('');
          setMostrarReporte(false);
          handleRefresh();
        },
        onError: (error: any) => {
          tap('error');
          Alert.alert('Error', error.response?.data?.message || 'No se pudo enviar el reporte.');
        },
      }
    );
  };

  const loading = loadingEarnings || loadingDebts;

  if (loading && !isRefetching) {
    return <LoadingScreen message="Cargando balance de ganancias..." />;
  }

  const totalEarned = earningsData?.totalEarned || 0;
  const totalOrders = earningsData?.totalOrders || 0;
  const outstandingDebt = debtsData?.outstanding || 0;
  const reportedDebt = debtsData?.reported || 0;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]} edges={['top']}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, { paddingBottom: bottomSpace }]}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={handleRefresh}
            tintColor={c.primary}
            colors={[c.primary]}
          />
        }
      >
        <Text v="displayM">Ganancias y Balance</Text>

        {/* ── Tarjeta Principal de Ganancias ── */}
        <Animated.View entering={FadeIn.duration(280)}>
          <Card style={[styles.heroCard, { backgroundColor: c.limeSoft, borderColor: c.lime }]}>
            <Text v="caption" tone="textMuted">TUS GANANCIAS ACUMULADAS</Text>
            <Text v="displayL" tone="limeText">{money(totalEarned)}</Text>
            <Text v="bodyS" tone="textSecondary">{totalOrders} pedidos entregados con éxito</Text>
          </Card>
        </Animated.View>

        {/* ── Control de Efectivo y Rendición de Cuentas ── */}
        <View style={styles.section}>
          <SectionHeader title="Efectivo de pedidos por rendir" />

          <Card style={styles.debtCard}>
            <View style={styles.debtHeader}>
              <View>
                <Text v="caption" tone="textMuted">SALDO PENDIENTE POR ENTREGAR</Text>
                <Text v="displayM" tone={outstandingDebt > 0 ? 'warningText' : 'text'}>
                  {money(outstandingDebt)}
                </Text>
              </View>
              <Badge
                label={outstandingDebt > 0 ? 'Por rendir' : 'Al día'}
                tone={outstandingDebt > 0 ? 'warning' : 'lime'}
              />
            </View>

            {reportedDebt > 0 ? (
              <Notice tone="info" icon="reloj">
                Tienes {money(reportedDebt)} en verificación por el equipo de administración de ZIPP.
              </Notice>
            ) : null}

            {outstandingDebt > 0 && !mostrarReporte ? (
              <Button
                title="Reportar consignación"
                icon="billetera"
                variant="secondary"
                onPress={() => { tap('light'); setMostrarReporte(true); }}
              />
            ) : null}

            {mostrarReporte ? (
              <View style={styles.reportBox}>
                <Text v="strongS">Datos del comprobante</Text>
                <Text v="caption" tone="textMuted">
                  Ingresa el número de referencia de la transferencia o consignación bancaria efectuada a ZIPP:
                </Text>

                <Input
                  placeholder="Ej: Nequi / Daviplata #12345678"
                  value={referencia}
                  onChangeText={setReferencia}
                  icon="editar"
                />

                <View style={styles.reportButtons}>
                  <Button
                    title="Cancelar"
                    variant="ghost"
                    onPress={() => setMostrarReporte(false)}
                  />
                  <Button
                    title="Enviar reporte"
                    loading={reportCash.isPending}
                    onPress={enviarReporte}
                    style={styles.flex}
                  />
                </View>
              </View>
            ) : null}
          </Card>
        </View>

        {/* ── Desglose de Liquidación ── */}
        <View style={styles.section}>
          <SectionHeader title="Cuentas claras" />
          <Card style={styles.breakdownCard}>
            <DetailRow label="Total cobrado en efectivo" value={money(debtsData?.totalCollected || 0)} />
            <DetailRow label="Tus domicilios y propinas" value={`−${money(totalEarned)}`} tone="successText" />
            <View style={[styles.divider, { backgroundColor: c.border }]} />
            <DetailRow label="Saldo final a consignar a ZIPP" value={money(outstandingDebt)} strong />
          </Card>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  content: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    gap: Spacing.xl,
  },
  heroCard: { padding: Spacing.xl, gap: Spacing.xs },
  section: { gap: Spacing.sm },
  debtCard: { padding: Spacing.xl, gap: Spacing.md },
  debtHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  reportBox: {
    paddingTop: Spacing.sm,
    gap: Spacing.sm,
  },
  reportButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  breakdownCard: { gap: Spacing.md },
  divider: { height: StyleSheet.hairlineWidth },
});
