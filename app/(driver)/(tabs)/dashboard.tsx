import { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, FontSize, BorderRadius } from '../../../constants';
import { useAuthStore } from '../../../stores/authStore';
import { useDriverProfile, useDriverEarnings, useDriverDebts, useUpdateDriverStatus } from '../../../hooks/useApi';
import { useLocation } from '../../../hooks/useLocation';
import { socketService } from '../../../services/socket';
import { driverApi } from '../../../services/endpoints';

const getGreeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Buenos días';
  if (h < 18) return 'Buenas tardes';
  return 'Buenas noches';
};

export default function DriverDashboard() {
  const { user } = useAuthStore();
  const [isOnline, setIsOnline] = useState(false);

  const { data: profile, isLoading: loadingProfile, refetch: refetchProfile } = useDriverProfile();
  const { data: earnings, isLoading: loadingEarnings, refetch: refetchEarnings } = useDriverEarnings();
  const { data: debts, isLoading: loadingDebts, refetch: refetchDebts } = useDriverDebts();

  const updateStatusMutation = useUpdateDriverStatus();
  const { location } = useLocation(isOnline);

  useEffect(() => {
    socketService.connect();
    return () => { socketService.removeAllListeners(); };
  }, []);

  useEffect(() => {
    if (profile) setIsOnline(profile.status === 'available');
  }, [profile]);

  useEffect(() => {
    if (isOnline && location) {
      socketService.emitDriverLocation(location.latitude, location.longitude);
      driverApi.updateLocation(location.latitude, location.longitude).catch(console.error);
    }
  }, [isOnline, location]);

  const handleToggleOnline = (value: boolean) => {
    const nextStatus = value ? 'available' : 'offline';
    setIsOnline(value);
    updateStatusMutation.mutate(nextStatus, {
      onSuccess: () => {
        socketService.emitDriverStatus(nextStatus);
        refetchProfile();
      },
      onError: () => { setIsOnline(!value); }
    });
  };

  const handleRefresh = () => { refetchProfile(); refetchEarnings(); refetchDebts(); };

  const loading = loadingProfile || loadingEarnings || loadingDebts;

  const stats = {
    todayOrders: earnings?.totalOrders || 0,
    todayEarnings: earnings?.totalEarned || 0,
    completedOrders: profile?.totalDeliveries || 0,
    pendingDebt: debts?.totalDebt || 0,
    baseFund: profile?.baseFund || 50000,
    currentFund: profile?.currentFund || 50000,
  };

  const fundPct = Math.min(100, Math.max(0, (stats.currentFund / stats.baseFund) * 100));

  if (loading) {
    return (
      <View style={styles.loaderContainer}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.greeting}>{getGreeting()},</Text>
            <Text style={styles.driverName}>{user?.name?.split(' ')[0]} 🏍️</Text>
            <Text style={styles.dateText}>
              {new Date().toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' })}
            </Text>
          </View>
          <TouchableOpacity onPress={handleRefresh} style={styles.refreshBtn}>
            <Ionicons name="refresh" size={18} color={Colors.text} />
          </TouchableOpacity>
        </View>

        {/* Online Toggle — hero element */}
        <View style={styles.toggleSection}>
          <TouchableOpacity
            style={[styles.toggleCard, isOnline ? styles.toggleCardOnline : styles.toggleCardOffline]}
            onPress={() => !updateStatusMutation.isPending && handleToggleOnline(!isOnline)}
            activeOpacity={0.88}
          >
            <View style={styles.toggleLeft}>
              <View style={[styles.toggleIndicator, { backgroundColor: isOnline ? Colors.success : Colors.error }]} />
              <View>
                <Text style={styles.toggleTitle}>{isOnline ? 'En línea' : 'Desconectado'}</Text>
                <Text style={styles.toggleSub}>
                  {isOnline ? 'Recibirás pedidos cercanos' : 'Actívate para recibir pedidos'}
                </Text>
              </View>
            </View>
            <View style={[styles.toggleBtn, isOnline ? styles.toggleBtnOn : styles.toggleBtnOff]}>
              {updateStatusMutation.isPending ? (
                <ActivityIndicator size="small" color={Colors.white} />
              ) : (
                <View style={[styles.toggleThumb, isOnline ? styles.toggleThumbRight : styles.toggleThumbLeft]} />
              )}
            </View>
          </TouchableOpacity>
        </View>

        {/* Stats Grid */}
        <View style={styles.statsSection}>
          <View style={styles.statsGrid}>
            <View style={[styles.statCard, styles.statCardHighlight]}>
              <View style={[styles.statIconBg, { backgroundColor: `${Colors.success}15` }]}>
                <Ionicons name="cash-outline" size={20} color={Colors.success} />
              </View>
              <Text style={[styles.statValue, { color: Colors.success }]}>${stats.todayEarnings.toLocaleString()}</Text>
              <Text style={styles.statLabel}>Ganado hoy</Text>
            </View>
            <View style={styles.statCard}>
              <View style={[styles.statIconBg, { backgroundColor: `${Colors.primary}15` }]}>
                <Ionicons name="receipt-outline" size={20} color={Colors.primary} />
              </View>
              <Text style={styles.statValue}>{stats.todayOrders}</Text>
              <Text style={styles.statLabel}>Pedidos hoy</Text>
            </View>
            <View style={styles.statCard}>
              <View style={[styles.statIconBg, { backgroundColor: `${Colors.statusAccepted}15` }]}>
                <Ionicons name="checkmark-circle-outline" size={20} color={Colors.statusAccepted} />
              </View>
              <Text style={styles.statValue}>{stats.completedOrders}</Text>
              <Text style={styles.statLabel}>Completados</Text>
            </View>
            <View style={[styles.statCard, stats.pendingDebt > 0 && styles.statCardWarning]}>
              <View style={[styles.statIconBg, { backgroundColor: `${Colors.warning}15` }]}>
                <Ionicons name="alert-circle-outline" size={20} color={Colors.warning} />
              </View>
              <Text style={[styles.statValue, stats.pendingDebt > 0 && { color: Colors.warning }]}>
                ${stats.pendingDebt.toLocaleString()}
              </Text>
              <Text style={styles.statLabel}>Deuda comisión</Text>
            </View>
          </View>
        </View>

        {/* Fund Card */}
        <View style={styles.fundCard}>
          <View style={styles.fundHeader}>
            <View style={styles.fundIconBg}>
              <Ionicons name="wallet-outline" size={20} color={Colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.fundTitle}>Fondo Base</Text>
              <Text style={styles.fundSub}>Capital de trabajo disponible</Text>
            </View>
            <View style={styles.fundPctBadge}>
              <Text style={styles.fundPctText}>{Math.round(fundPct)}%</Text>
            </View>
          </View>

          <View style={styles.fundAmounts}>
            <View style={styles.fundAmount}>
              <Text style={styles.fundAmountLabel}>Disponible</Text>
              <Text style={[styles.fundAmountValue, { color: Colors.success }]}>
                ${stats.currentFund.toLocaleString()}
              </Text>
            </View>
            <View style={styles.fundDivider} />
            <View style={styles.fundAmount}>
              <Text style={styles.fundAmountLabel}>Total</Text>
              <Text style={styles.fundAmountValue}>${stats.baseFund.toLocaleString()}</Text>
            </View>
          </View>

          <View style={styles.fundBarTrack}>
            <View style={[styles.fundBarFill, { width: `${fundPct}%` }]} />
          </View>
          <Text style={styles.fundBarLabel}>
            {fundPct >= 80 ? 'Fondo en buen estado' : fundPct >= 40 ? 'Fondo moderado' : 'Fondo bajo — recarga pronto'}
          </Text>
        </View>

        <View style={{ height: 100 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  loaderContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background },

  // Header
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    paddingHorizontal: Spacing.xl, paddingTop: Spacing.lg, paddingBottom: Spacing.sm,
  },
  greeting: { fontSize: FontSize.sm, color: Colors.textMuted, fontWeight: '500' },
  driverName: { fontSize: FontSize.xxl, fontWeight: '800', color: Colors.text, letterSpacing: -0.5, marginTop: 2 },
  dateText: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 3, textTransform: 'capitalize', fontWeight: '500' },
  refreshBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: Colors.surface, justifyContent: 'center', alignItems: 'center',
    borderWidth: 1, borderColor: Colors.border, marginTop: 4,
  },

  // Toggle
  toggleSection: { paddingHorizontal: Spacing.xl, marginTop: Spacing.lg },
  toggleCard: {
    borderRadius: BorderRadius.xl, padding: Spacing.xl,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1.5,
  },
  toggleCardOnline: { backgroundColor: `${Colors.success}08`, borderColor: `${Colors.success}35` },
  toggleCardOffline: { backgroundColor: Colors.surface, borderColor: Colors.border },
  toggleLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, flex: 1 },
  toggleIndicator: { width: 10, height: 10, borderRadius: 5 },
  toggleTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  toggleSub: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2, fontWeight: '500' },
  toggleBtn: {
    width: 56, height: 30, borderRadius: 15, padding: 2,
    justifyContent: 'center',
  },
  toggleBtnOn: { backgroundColor: Colors.success },
  toggleBtnOff: { backgroundColor: Colors.border },
  toggleThumb: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: Colors.white,
  },
  toggleThumbLeft: { alignSelf: 'flex-start' },
  toggleThumbRight: { alignSelf: 'flex-end' },

  // Stats
  statsSection: { paddingHorizontal: Spacing.xl, marginTop: Spacing.xl },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  statCard: {
    width: '47.5%', backgroundColor: Colors.surface, borderRadius: BorderRadius.xl,
    padding: Spacing.lg, borderWidth: 1, borderColor: Colors.border,
    alignItems: 'center', gap: Spacing.sm,
  },
  statCardHighlight: { borderColor: `${Colors.success}30`, backgroundColor: `${Colors.success}05` },
  statCardWarning: { borderColor: `${Colors.warning}30`, backgroundColor: `${Colors.warning}05` },
  statIconBg: { width: 44, height: 44, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  statValue: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text },
  statLabel: { fontSize: 11, color: Colors.textMuted, fontWeight: '500', textAlign: 'center' },

  // Fund
  fundCard: {
    marginHorizontal: Spacing.xl, marginTop: Spacing.xl,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.xl,
    padding: Spacing.xl, borderWidth: 1, borderColor: Colors.border, gap: Spacing.md,
  },
  fundHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  fundIconBg: { width: 44, height: 44, borderRadius: 14, backgroundColor: `${Colors.primary}15`, justifyContent: 'center', alignItems: 'center' },
  fundTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  fundSub: { fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 2, fontWeight: '500' },
  fundPctBadge: {
    backgroundColor: `${Colors.primary}15`, borderRadius: BorderRadius.full,
    paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: `${Colors.primary}25`,
  },
  fundPctText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '800' },
  fundAmounts: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surfaceLight, borderRadius: BorderRadius.lg,
    padding: Spacing.lg, borderWidth: 1, borderColor: Colors.border,
  },
  fundAmount: { flex: 1, alignItems: 'center', gap: 3 },
  fundAmountLabel: { fontSize: FontSize.xs, color: Colors.textMuted, fontWeight: '500' },
  fundAmountValue: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text },
  fundDivider: { width: 1, height: 40, backgroundColor: Colors.border },
  fundBarTrack: {
    height: 8, backgroundColor: Colors.surfaceLight, borderRadius: 4,
    overflow: 'hidden', borderWidth: 1, borderColor: Colors.border,
  },
  fundBarFill: { height: '100%', backgroundColor: Colors.success, borderRadius: 4 },
  fundBarLabel: { fontSize: FontSize.xs, color: Colors.textMuted, textAlign: 'center', fontWeight: '500' },
  white: { color: Colors.white },
});
