import { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Alert, RefreshControl, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, FontSize, BorderRadius } from '../../../constants';
import { useDriverEarnings, useDriverDebts, useReportCash } from '../../../hooks/useApi';

const money = (value: number) => `$${(value ?? 0).toLocaleString('es-CO')}`;

/** Etiquetas de cada estado de la conciliación, en lenguaje del repartidor. */
const ESTADO: Record<string, { texto: string; color: string }> = {
  pending: { texto: 'Por rendir', color: Colors.warning },
  reported: { texto: 'Reportado · en verificación', color: Colors.primary },
  verified: { texto: 'Verificado por ZIPP', color: Colors.success },
  overdue: { texto: 'Vencido', color: Colors.error },
  settled: { texto: 'Cerrado', color: Colors.textMuted },
};

export default function EarningsScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const [referencia, setReferencia] = useState('');
  const [mostrarReporte, setMostrarReporte] = useState(false);

  const { data: earningsData, isLoading: loadingEarnings, refetch: refetchEarnings } = useDriverEarnings();
  const { data: debtsData, isLoading: loadingDebts, refetch: refetchDebts } = useDriverDebts();
  const reportCash = useReportCash();

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refetchEarnings(), refetchDebts()]);
    setRefreshing(false);
  };

  /**
   * Reportar no es pagar.
   *
   * La pantalla anterior decía "Liquidar saldo pendiente" y marcaba la deuda
   * como pagada sin que se moviera un peso. Ahora el repartidor declara la
   * consignación y ZIPP la verifica; el texto lo dice con todas las letras
   * para que nadie crea que ya quedó a paz y salvo.
   */
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

    reportCash.mutate(
      { reference: referencia.trim() },
      {
        onSuccess: (data: any) => {
          Alert.alert(
            'Reporte enviado',
            `Reportaste ${money(data.totalReported)} en ${data.reportedCount} pedido(s). ` +
              'ZIPP lo verificará y luego se cerrará el saldo.'
          );
          setReferencia('');
          setMostrarReporte(false);
          refetchEarnings();
          refetchDebts();
        },
        onError: (error: any) => {
          Alert.alert('Error', error.response?.data?.message || 'No se pudo enviar el reporte.');
        },
      }
    );
  };

  const loading = loadingEarnings || loadingDebts;

  const tarifas = earningsData?.guaranteedFees ?? 0;
  const propinas = earningsData?.tips ?? 0;
  const pedidosHoy = earningsData?.totalOrders ?? 0;
  const porCobrar = earningsData?.pendingPayout ?? 0;

  const porRendir = debtsData?.outstanding ?? 0;
  const reportado = debtsData?.reported ?? 0;
  const vencido = debtsData?.overdue ?? 0;
  const registros = debtsData?.records ?? [];

  if (loading && !refreshing) {
    return (
      <View style={styles.loaderContainer}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={Colors.primary} />
        }
      >
        <Text style={styles.title}>Mis Finanzas</Text>

        {/* ── Lo que ganaste hoy ── */}
        <View style={styles.summaryRow}>
          <View style={[styles.summaryCard, styles.primaryCard]}>
            <Text style={styles.summaryLabel}>Hoy</Text>
            <Text style={styles.summaryValue}>{money(tarifas + propinas)}</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabelMuted}>Pedidos de hoy</Text>
            <Text style={styles.summaryValueSmall}>{pedidosHoy} serv.</Text>
          </View>
        </View>

        {/* La tarifa y la propina van separadas a propósito: la tarifa es lo
            que ZIPP te garantiza y no baja por promociones; la propina es del
            cliente y va completa para ti. */}
        <View style={styles.breakdownCard}>
          <View style={styles.breakdownRow}>
            <View style={styles.breakdownLabelRow}>
              <Ionicons name="bicycle" size={16} color={Colors.textMuted} />
              <Text style={styles.breakdownLabel}>Tarifa garantizada</Text>
            </View>
            <Text style={styles.breakdownValue}>{money(tarifas)}</Text>
          </View>
          <View style={styles.breakdownRow}>
            <View style={styles.breakdownLabelRow}>
              <Ionicons name="heart" size={16} color={Colors.textMuted} />
              <Text style={styles.breakdownLabel}>Propinas</Text>
            </View>
            <Text style={styles.breakdownValue}>{money(propinas)}</Text>
          </View>
          <View style={styles.breakdownDivider} />
          <View style={styles.breakdownRow}>
            <View style={styles.breakdownLabelRow}>
              <Ionicons name="time-outline" size={16} color={Colors.primary} />
              <Text style={[styles.breakdownLabel, { color: Colors.text }]}>
                Pendiente de pago
              </Text>
            </View>
            <Text style={[styles.breakdownValue, { color: Colors.primary }]}>
              {money(porCobrar)}
            </Text>
          </View>
          <Text style={styles.breakdownNote}>
            ZIPP te lo consigna en la próxima liquidación.
          </Text>
        </View>

        {/* ── Efectivo que tienes que rendir ── */}
        {porRendir > 0 || reportado > 0 ? (
          <View style={styles.debtCard}>
            <View style={styles.debtHeader}>
              <Ionicons name="cash-outline" size={24} color={Colors.warning} />
              <Text style={styles.debtTitle}>Efectivo por rendir</Text>
            </View>
            <Text style={styles.debtAmount}>{money(porRendir)}</Text>
            <Text style={styles.debtNote}>
              Es la parte de ZIPP en los pedidos que cobraste en efectivo.
              Tu tarifa y tus propinas no están aquí: ese dinero ya es tuyo.
            </Text>

            {reportado > 0 ? (
              <Text style={styles.reportedNote}>
                {money(reportado)} reportado, esperando verificación de ZIPP.
              </Text>
            ) : null}
            {vencido > 0 ? (
              <Text style={styles.overdueNote}>
                {money(vencido)} está vencido. Repórtalo cuanto antes.
              </Text>
            ) : null}

            {porRendir > 0 && !mostrarReporte ? (
              <TouchableOpacity style={styles.payBtn} onPress={() => setMostrarReporte(true)}>
                <Text style={styles.payBtnText}>Reportar consignación</Text>
              </TouchableOpacity>
            ) : null}

            {mostrarReporte ? (
              <View style={styles.reportBox}>
                <Text style={styles.reportLabel}>Número de consignación o transferencia</Text>
                <TextInput
                  style={styles.input}
                  value={referencia}
                  onChangeText={setReferencia}
                  placeholder="Ej. 998877"
                  placeholderTextColor={Colors.textMuted}
                  autoCapitalize="characters"
                />
                <Text style={styles.reportHint}>
                  Al enviarlo queda en verificación. El saldo se cierra cuando ZIPP
                  confirma que recibió el dinero.
                </Text>
                <View style={styles.reportActions}>
                  <TouchableOpacity
                    style={styles.cancelBtn}
                    onPress={() => { setMostrarReporte(false); setReferencia(''); }}
                  >
                    <Text style={styles.cancelBtnText}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.payBtn, styles.reportSubmit]}
                    onPress={enviarReporte}
                    disabled={reportCash.isPending}
                  >
                    {reportCash.isPending ? (
                      <ActivityIndicator color={Colors.white} />
                    ) : (
                      <Text style={styles.payBtnText}>Enviar reporte</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}
          </View>
        ) : null}

        {/* ── Detalle ── */}
        <Text style={styles.historyTitle}>Detalle del efectivo</Text>
        {registros.map((item: any) => {
          const estado = ESTADO[item.status] ?? ESTADO.pending;
          return (
            <View key={item._id} style={styles.historyItem}>
              <View style={[styles.historyIcon, { backgroundColor: estado.color }]}>
                <Ionicons name="cash" size={16} color={Colors.white} />
              </View>
              <View style={styles.historyInfo}>
                <Text style={styles.historyOrder}>
                  Pedido #{item.orderId?.orderNumber || item.orderId?._id?.slice(-8).toUpperCase()}
                </Text>
                <Text style={[styles.historyDate, { color: estado.color }]}>{estado.texto}</Text>
              </View>
              <Text style={[styles.debtAmount2, { color: estado.color }]}>
                {money(item.amount)}
              </Text>
            </View>
          );
        })}

        {registros.length === 0 && (
          <View style={styles.emptyState}>
            <Ionicons name="checkmark-circle-outline" size={48} color={Colors.border} />
            <Text style={styles.emptyText}>No tienes efectivo pendiente</Text>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background, paddingHorizontal: Spacing.xl },
  loaderContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background },
  title: { fontSize: FontSize.xxxl, fontWeight: '800', color: Colors.text, marginTop: Spacing.md },
  summaryRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.xl },
  summaryCard: { flex: 1, backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.md, borderWidth: 1, borderColor: Colors.border, alignItems: 'center', justifyContent: 'center' },
  primaryCard: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  summaryLabel: { fontSize: FontSize.xs, color: 'rgba(255,255,255,0.7)' },
  summaryLabelMuted: { fontSize: FontSize.xs, color: Colors.textMuted },
  summaryValue: { fontSize: FontSize.xxl, fontWeight: '800', color: Colors.white, marginTop: 4 },
  summaryValueSmall: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginTop: 4 },

  breakdownCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.lg, marginTop: Spacing.lg, borderWidth: 1, borderColor: Colors.border,
  },
  breakdownRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6 },
  breakdownLabelRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  breakdownLabel: { fontSize: FontSize.sm, color: Colors.textMuted },
  breakdownValue: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  breakdownDivider: { height: 1, backgroundColor: Colors.border, marginVertical: Spacing.sm },
  breakdownNote: { fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 4 },

  debtCard: {
    backgroundColor: `${Colors.warning}10`, borderRadius: BorderRadius.lg,
    padding: Spacing.xl, marginTop: Spacing.xl, borderWidth: 1, borderColor: `${Colors.warning}30`,
  },
  debtHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  debtTitle: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  debtAmount: { fontSize: FontSize.xxxl, fontWeight: '800', color: Colors.warning, marginTop: Spacing.sm },
  debtNote: { fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 4, lineHeight: 16 },
  reportedNote: { fontSize: FontSize.xs, color: Colors.primary, marginTop: Spacing.sm, fontWeight: '600' },
  overdueNote: { fontSize: FontSize.xs, color: Colors.error, marginTop: 4, fontWeight: '600' },

  payBtn: { backgroundColor: Colors.warning, borderRadius: BorderRadius.md, height: 44, justifyContent: 'center', alignItems: 'center', marginTop: Spacing.lg },
  payBtnText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.sm },

  reportBox: { marginTop: Spacing.lg },
  reportLabel: { fontSize: FontSize.xs, color: Colors.textMuted, marginBottom: Spacing.sm },
  input: {
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
    borderRadius: BorderRadius.md, height: 44, paddingHorizontal: Spacing.md,
    color: Colors.text, fontSize: FontSize.sm,
  },
  reportHint: { fontSize: FontSize.xs, color: Colors.textMuted, marginTop: Spacing.sm, lineHeight: 15 },
  reportActions: { flexDirection: 'row', gap: Spacing.sm, alignItems: 'center' },
  reportSubmit: { flex: 1 },
  cancelBtn: { flex: 1, height: 44, justifyContent: 'center', alignItems: 'center', marginTop: Spacing.lg },
  cancelBtnText: { color: Colors.textMuted, fontWeight: '600', fontSize: FontSize.sm },

  historyTitle: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, marginTop: Spacing.xxl, marginBottom: Spacing.lg },
  historyItem: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.sm,
    borderWidth: 1, borderColor: Colors.border,
  },
  historyIcon: { width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center' },
  historyInfo: { flex: 1, marginLeft: Spacing.md },
  historyOrder: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  historyDate: { fontSize: FontSize.xs, marginTop: 2, fontWeight: '600' },
  debtAmount2: { fontSize: FontSize.md, fontWeight: '700' },
  emptyState: { alignItems: 'center', paddingVertical: Spacing.xl },
  emptyText: { color: Colors.textMuted, fontSize: FontSize.sm, marginTop: Spacing.sm },
});
