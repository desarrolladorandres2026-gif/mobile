import { useState, useEffect } from 'react';
import { View, ScrollView, StyleSheet, Pressable, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  Text, Icon, Card, Button, Badge, PulseDot, ErrorState, LoadingScreen,
} from '../../../components/ui';
import { useAuthStore } from '../../../stores/authStore';
import {
  useDriverProfile, useDriverEarnings, useDriverDebts, useUpdateDriverStatus,
} from '../../../hooks/useApi';
import { useLocation } from '../../../hooks/useLocation';
import { useTheme } from '../../../hooks/useTheme';
import { socketService } from '../../../services/socket';
import { driverApi } from '../../../services/endpoints';
import { BorderRadius, Shadow, Spacing } from '../../../theme/tokens';
import { money, greeting, firstName } from '../../../lib/format';
import { tap } from '../../../lib/haptics';

const BOTTOM_SPACE = 100;

export default function DriverDashboard() {
  const router = useRouter();
  const { c } = useTheme();
  const user = useAuthStore((s) => s.user);
  const [isOnline, setIsOnline] = useState(false);

  const {
    data: profile, isLoading: loadingProfile, isError: errorProfile, refetch: refetchProfile, isRefetching,
  } = useDriverProfile();
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
    tap(value ? 'success' : 'medium');
    const nextStatus = value ? 'available' : 'offline';
    setIsOnline(value);
    updateStatusMutation.mutate(nextStatus, {
      onSuccess: () => {
        socketService.emitDriverStatus(nextStatus);
        refetchProfile();
      },
      onError: () => {
        tap('error');
        setIsOnline(!value);
      },
    });
  };

  const handleRefresh = async () => {
    await Promise.all([refetchProfile(), refetchEarnings(), refetchDebts()]);
  };

  const loading = loadingProfile || loadingEarnings || loadingDebts;

  if (loading && !isRefetching) {
    return <LoadingScreen message="Cargando tu turno..." />;
  }

  if (errorProfile) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]} edges={['top']}>
        <ErrorState
          title="No pudimos cargar tu perfil de repartidor"
          message="Revisa tu conexión o intenta nuevamente."
          onRetry={handleRefresh}
        />
      </SafeAreaView>
    );
  }

  const todayOrders = earnings?.totalOrders || 0;
  const todayEarnings = earnings?.totalEarned || 0;
  const completedOrders = profile?.totalDeliveries || 0;
  const pendingDebt = debts?.outstanding || debts?.totalDebt || 0;
  const baseFund = profile?.baseFund || 50000;
  const currentFund = profile?.currentFund || 50000;
  const fundPct = Math.min(100, Math.max(0, Math.round((currentFund / baseFund) * 100)));

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]} edges={['top']}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={handleRefresh}
            tintColor={c.primary}
            colors={[c.primary]}
          />
        }
      >
        {/* ── Cabecera ── */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text v="bodyS" tone="textMuted">{greeting()},</Text>
            <Text v="displayM" numberOfLines={1}>
              {firstName(user?.name) || 'Repartidor'}
            </Text>
          </View>

          <Pressable
            onPress={() => { tap('light'); handleRefresh(); }}
            accessibilityRole="button"
            accessibilityLabel="Actualizar datos"
            hitSlop={8}
            style={[styles.refreshBtn, { backgroundColor: c.surface, borderColor: c.border }]}
          >
            <Icon name="reintentar" size="md" color={c.text} />
          </Pressable>
        </View>

        {/* ── Hero: Estado de Conexión (Disponible / Desconectado) ── */}
        <Animated.View entering={FadeIn.duration(280)}>
          <Card
            style={[
              styles.onlineCard,
              isOnline
                ? { backgroundColor: c.limeSoft, borderColor: c.lime }
                : { backgroundColor: c.surface, borderColor: c.border },
              Shadow.sm,
            ]}
          >
            <View style={styles.onlineHeader}>
              <View style={styles.onlineStatusRow}>
                {isOnline ? (
                  <PulseDot color={c.lime} size={10} />
                ) : (
                  <View style={[styles.offlineDot, { backgroundColor: c.textMuted }]} />
                )}
                <Text v="titleM" tone={isOnline ? 'limeText' : 'textSecondary'}>
                  {isOnline ? 'Estás disponible para pedidos' : 'Estás fuera de servicio'}
                </Text>
              </View>

              <Badge
                label={isOnline ? 'ACTIVO' : 'PAUSADO'}
                tone={isOnline ? 'lime' : 'neutral'}
              />
            </View>

            <Text v="bodyS" tone="textSecondary" style={styles.onlineMessage}>
              {isOnline
                ? 'Recibirás notificaciones de pedidos cercanos listos en restaurantes de Garzón.'
                : 'Conéctate para empezar a recibir pedidos y generar ganancias hoy.'}
            </Text>

            <Button
              title={isOnline ? 'Desconectarme' : 'Conectarme ahora'}
              icon={isOnline ? 'cerrar' : 'rayo'}
              variant={isOnline ? 'secondary' : 'primary'}
              full
              loading={updateStatusMutation.isPending}
              onPress={() => handleToggleOnline(!isOnline)}
            />
          </Card>
        </Animated.View>

        {/* ── Accesos Rápidos a Pedidos ── */}
        <View style={styles.section}>
          <Text v="label" tone="textMuted">Gestión de entregas</Text>
          <View style={styles.quickActions}>
            <Card
              onPress={() => { tap('select'); router.push('/(driver)/(tabs)/orders'); }}
              style={styles.actionCard}
            >
              <View style={[styles.actionIcon, { backgroundColor: c.primarySoft }]}>
                <Icon name="pedidos" size="md" color={c.primaryText} />
              </View>
              <View style={styles.flex}>
                <Text v="strongM">Ver pedidos disponibles</Text>
                <Text v="caption" tone="textMuted">Acepta y entrega pedidos en tu ruta</Text>
              </View>
              <Icon name="siguiente" size="sm" color={c.textMuted} />
            </Card>
          </View>
        </View>

        {/* ── Métricas del Día ── */}
        <View style={styles.section}>
          <Text v="label" tone="textMuted">Resumen de tu jornada</Text>
          <View style={styles.statsGrid}>
            <Card style={styles.statCard}>
              <View style={styles.statHeader}>
                <Text v="caption" tone="textMuted">GANANCIAS HOY</Text>
                <Icon name="billetera" size="sm" color={c.limeText} />
              </View>
              <Text v="displayM" tone="limeText">{money(todayEarnings)}</Text>
              <Text v="caption" tone="textMuted">{todayOrders} entregas completadas</Text>
            </Card>

            <Card style={styles.statCard}>
              <View style={styles.statHeader}>
                <Text v="caption" tone="textMuted">HISTORIAL TOTAL</Text>
                <Icon name="trofeo" size="sm" color={c.primaryText} />
              </View>
              <Text v="displayM">{completedOrders}</Text>
              <Text v="caption" tone="textMuted">Entregas de por vida</Text>
            </Card>
          </View>
        </View>

        {/* ── Base y Efectivo Pendiente ── */}
        <View style={styles.section}>
          <Text v="label" tone="textMuted">Caja y base de cambio</Text>
          <Card style={styles.fundCard}>
            <View style={styles.fundRow}>
              <View>
                <Text v="caption" tone="textMuted">BASE DE CAMBIO DISPONIBLE</Text>
                <Text v="titleL">{money(currentFund)}</Text>
              </View>
              <Badge
                label={`${fundPct}% disponible`}
                tone={fundPct >= 50 ? 'lime' : 'warning'}
              />
            </View>

            {/* Barra de progreso de base */}
            <View style={[styles.fundTrack, { backgroundColor: c.surfaceLight }]}>
              <View
                style={[
                  styles.fundFill,
                  {
                    width: `${fundPct}%`,
                    backgroundColor: fundPct >= 50 ? c.lime : c.warning,
                  },
                ]}
              />
            </View>

            {pendingDebt > 0 ? (
              <View style={[styles.debtNotice, { backgroundColor: c.warningSoft, borderColor: c.warning }]}>
                <Icon name="atencion" size="sm" color={c.warningText} />
                <View style={styles.flex}>
                  <Text v="strongS" tone="warningText">Efectivo por rendir: {money(pendingDebt)}</Text>
                  <Text v="caption" tone="warningText">Reporta tu consignación en la pestaña Ganancias</Text>
                </View>
              </View>
            ) : null}
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
    paddingBottom: BOTTOM_SPACE,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerLeft: { flex: 1, gap: 2 },
  refreshBtn: {
    width: 44, height: 44, borderRadius: BorderRadius.lg,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
  },

  onlineCard: { padding: Spacing.xl, gap: Spacing.lg },
  onlineHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  onlineStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    flex: 1,
  },
  offlineDot: { width: 10, height: 10, borderRadius: 5 },
  onlineMessage: { lineHeight: 18 },

  section: { gap: Spacing.sm },
  quickActions: { gap: Spacing.md },
  actionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
  },
  actionIcon: {
    width: 44, height: 44, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center',
  },

  statsGrid: { flexDirection: 'row', gap: Spacing.md },
  statCard: { flex: 1, gap: Spacing.xs, padding: Spacing.lg },
  statHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.xs,
  },

  fundCard: { padding: Spacing.xl, gap: Spacing.md },
  fundRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fundTrack: { height: 6, borderRadius: BorderRadius.full, overflow: 'hidden' },
  fundFill: { height: '100%', borderRadius: BorderRadius.full },
  debtNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    marginTop: Spacing.xs,
  },
});
