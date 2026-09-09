import { useState } from 'react';
import {
  View, ScrollView, StyleSheet, RefreshControl, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  Text, Icon, Card, Button, Input, Badge, Notice, DetailRow, LoadingScreen, ErrorState, SectionHeader,
} from '../../../components/ui';
import {
  useDriverEarnings, useDriverEarningsRange, useDriverDebts, useReportCash,
} from '../../../hooks/useApi';
import { useTabContentPadding } from '../../../hooks/useBottomSpace';
import { useTheme } from '../../../hooks/useTheme';
import { BorderRadius, Spacing } from '../../../theme/tokens';
import type { DriverEarningsDay } from '../../../services/endpoints';
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
  const { data: week, refetch: refetchWeek } = useDriverEarningsRange();
  const reportCash = useReportCash();

  const isRefetching = refetchingEarnings || refetchingDebts;

  const handleRefresh = async () => {
    await Promise.all([refetchEarnings(), refetchDebts(), refetchWeek()]);
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

  /**
   * Lo que el servidor lleva devolviendo desde siempre y esta pantalla
   * sumaba en un solo número.
   *
   * La tarifa y la propina se comportan distinto: la primera es lo que
   * Zipp debe y ninguna promoción puede bajarla; la segunda es dinero del
   * cliente que pasa de largo. Un domiciliario que solo ve el total no
   * puede saber si una semana floja fue por menos pedidos o por menos
   * propinas, que son dos problemas con dos soluciones distintas.
   */
  const guaranteedFees = earningsData?.guaranteedFees ?? 0;
  const tips = earningsData?.tips ?? 0;
  const pendingPayout = earningsData?.pendingPayout ?? 0;

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

        {/* ── De dónde salió ese número ──
            Tres filas que el servidor ya devolvía y esta pantalla tiraba a
            la basura: sin ellas, "ganaste 48.000" es un dato que hay que
            creerse. Con ellas es una cuenta que se puede revisar. */}
        <Card style={styles.splitCard}>
          <DetailRow label="Tarifas de domicilio" value={money(guaranteedFees)} />
          <DetailRow label="Propinas de clientes" value={money(tips)} tone="successText" />
          {pendingPayout > 0 ? (
            <>
              <View style={[styles.divider, { backgroundColor: c.border }]} />
              <DetailRow label="Pendiente de pagarte" value={money(pendingPayout)} strong />
            </>
          ) : null}
        </Card>

        {/* ── La semana ── */}
        {week ? (
          <View style={styles.section}>
            <SectionHeader title="Tus últimos 7 días" />
            <Card style={styles.weekCard}>
              <WeekBars series={week.series} />

              <View style={[styles.divider, { backgroundColor: c.border }]} />

              <DetailRow label="Total de la semana" value={money(week.totals.total)} strong />
              <DetailRow
                label={`Promedio por día trabajado (${week.totals.workedDays})`}
                value={money(week.totals.perDay)}
              />
              <DetailRow
                label={`Promedio por pedido (${week.totals.orders})`}
                value={money(week.totals.perOrder)}
              />
            </Card>
          </View>
        ) : null}

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

/**
 * Los siete días, en barras.
 *
 * Sin ejes ni cuadrícula: la pregunta que contesta no es "cuánto exactamente"
 * —para eso están las cifras de abajo— sino "¿qué días me rinden?". Un
 * domiciliario mira esto para decidir cuándo salir, y esa decisión se toma
 * comparando alturas, no leyendo números.
 *
 * Los días sin trabajar salen como una línea al ras y no como un hueco: un
 * lunes en blanco es información, y saltárselo haría que el domingo
 * pareciera pegado al martes.
 */
function WeekBars({ series }: { series: DriverEarningsDay[] }) {
  const { c } = useTheme();
  const max = Math.max(...series.map((d) => d.total), 1);
  const hoy = new Date().toISOString().slice(0, 10);

  return (
    <View style={styles.bars}>
      {series.map((day) => {
        const esHoy = day.date === hoy;
        const alto = day.total > 0 ? Math.max(6, (day.total / max) * 88) : 2;

        return (
          <View key={day.date} style={styles.barCol}>
            <View style={styles.barTrack}>
              <View
                style={[
                  styles.bar,
                  {
                    height: alto,
                    backgroundColor: day.total === 0
                      ? c.border
                      : esHoy ? c.lime : c.primary,
                  },
                ]}
              />
            </View>
            <Text v="caption" tone={esHoy ? 'limeText' : 'textMuted'}>
              {DIAS[new Date(`${day.date}T12:00:00`).getDay()]}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** Inicial del día. `T12:00:00` evita que la fecha se corra un día por UTC. */
const DIAS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

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
  splitCard: { gap: Spacing.sm, padding: Spacing.lg },
  weekCard: { gap: Spacing.md, padding: Spacing.lg },

  bars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: Spacing.xs,
  },
  barCol: { flex: 1, alignItems: 'center', gap: Spacing.xs },
  barTrack: { height: 88, justifyContent: 'flex-end' },
  bar: { width: 18, borderRadius: BorderRadius.sm },
  divider: { height: StyleSheet.hairlineWidth },
});
