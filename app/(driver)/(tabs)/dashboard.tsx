import { useState, useEffect } from 'react';
import {
  View, ScrollView, StyleSheet, Pressable, RefreshControl, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  Text, Icon, Card, Button, Badge, PulseDot, ErrorState, LoadingScreen, SectionHeader,
} from '../../../components/ui';
import { ContentIcon } from '../../../components/illustrations';
import { useAuthStore } from '../../../stores/authStore';
import {
  useDriverProfile, useDriverEarnings, useDriverDebts, useUpdateDriverStatus,
} from '../../../hooks/useApi';
import { useDriverTrackingContext } from '../../../hooks/useDriverTracking';
import { useTabContentPadding } from '../../../hooks/useBottomSpace';
import { useTheme } from '../../../hooks/useTheme';
import { socketService } from '../../../services/socket';
import { BorderRadius, Shadow, Spacing } from '../../../theme/tokens';
import { money, greeting, firstName } from '../../../lib/format';
import { apiMessage } from '../../../lib/errors';
import { tap } from '../../../lib/haptics';

export default function DriverDashboard() {
  const router = useRouter();
  const { c } = useTheme();
  const bottomSpace = useTabContentPadding();
  const user = useAuthStore((s) => s.user);
  const [isOnline, setIsOnline] = useState(false);

  const {
    data: profile, isLoading: loadingProfile, isError: errorProfile, refetch: refetchProfile, isRefetching,
  } = useDriverProfile();
  const { data: earnings, isLoading: loadingEarnings, refetch: refetchEarnings } = useDriverEarnings();
  const { data: debts, isLoading: loadingDebts, refetch: refetchDebts } = useDriverDebts();

  const updateStatusMutation = useUpdateDriverStatus();

  /**
   * El GPS lo gobierna el estado de servicio, no esta pantalla.
   *
   * Antes, cada posición se mandaba dos veces —por socket y por REST— y
   * solo mientras el dashboard estuviera montado y en primer plano. Ahora
   * el seguimiento vive en el layout de `(driver)` y sigue con la app
   * cerrada: el repartidor deja de desaparecer del mapa en cuanto bloquea
   * el teléfono, que es precisamente cuando está conduciendo.
   */
  const tracking = useDriverTrackingContext();

  useEffect(() => {
    socketService.connect();
  }, []);

  // El servidor manda sobre el interruptor: si el repartidor cerró sesión
  // en otro teléfono o un admin lo desconectó, el estado real es el del
  // perfil, no el que quedó pintado en esta pantalla.
  useEffect(() => {
    if (!profile) return;
    const online = profile.status === 'available';
    setIsOnline(online);
    tracking.setOnDuty(online);
  }, [profile]);

  const handleToggleOnline = async (value: boolean) => {
    tap(value ? 'success' : 'medium');

    // El permiso se pide justo al conectarse, no al abrir la app.
    //
    // Un diálogo de ubicación sin contexto se rechaza casi siempre, y en
    // Android ese rechazo puede ser definitivo — el sistema deja de
    // mostrar el diálogo para siempre. Aquí el repartidor acaba de tocar
    // "Conectarme": el permiso tiene una razón evidente en ese instante.
    if (value && tracking.permission !== 'granted_always') {
      await tracking.requestPermission();
    }

    const nextStatus = value ? 'available' : 'offline';
    setIsOnline(value);
    tracking.setOnDuty(value);
    updateStatusMutation.mutate(nextStatus, {
      onSuccess: () => {
        socketService.emitDriverStatus(nextStatus);
        refetchProfile();
      },
      onError: (error) => {
        tap('error');
        setIsOnline(!value);
        // El GPS vuelve atrás con el interruptor. Si no, un fallo al
        // conectarse dejaría el teléfono reportando posición para un turno
        // que el servidor nunca llegó a abrir.
        tracking.setOnDuty(!value);
        Alert.alert(
          'No pudimos conectarte',
          apiMessage(error, 'Inténtalo de nuevo en un momento.'),
        );
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
                ? 'Recibirás notificaciones de pedidos cercanos listos en los restaurantes.'
                : 'Conéctate para empezar a recibir pedidos y generar ganancias hoy.'}
            </Text>

            {/*
              El estado del GPS se muestra donde se decide estar en
              servicio, no escondido en ajustes. Un repartidor conectado
              cuyo GPS no reporta no recibe pedidos cercanos y no tiene
              forma de saber por qué: para él la app dice "ACTIVO" y no
              pasa nada. Este bloque es esa explicación.
            */}
            {isOnline ? (
              <View style={[styles.gpsRow, { borderColor: c.border }]}>
                <Icon
                  name={tracking.active ? 'ubicacion' : 'atencion'}
                  size="sm"
                  color={tracking.active ? c.limeText : c.warningText}
                />
                <View style={styles.flex}>
                  <Text v="captionStrong" tone={tracking.active ? 'limeText' : 'warningText'}>
                    {tracking.active ? 'Ubicación activa' : 'Ubicación inactiva'}
                  </Text>
                  {tracking.problem ? (
                    <Text v="caption" tone="textMuted">{tracking.problem}</Text>
                  ) : tracking.permission === 'granted_foreground' ? (
                    <Text v="caption" tone="textMuted">
                      Solo mientras la app esté abierta.
                    </Text>
                  ) : null}
                </View>
                {tracking.permission === 'blocked' ? (
                  <Button title="Ajustes" size="sm" variant="secondary" onPress={tracking.openSettings} />
                ) : tracking.permission !== 'granted_always' ? (
                  <Button
                    title="Permitir"
                    size="sm"
                    variant="secondary"
                    onPress={tracking.requestPermission}
                  />
                ) : null}
              </View>
            ) : null}

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
          <SectionHeader title="Gestión de entregas" />
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
          <SectionHeader title="Resumen de tu jornada" />
          <View style={styles.statsGrid}>
            <Card style={styles.statCard}>
              <View style={styles.statHeader}>
                <Text v="caption" tone="textMuted">GANANCIAS HOY</Text>
                <ContentIcon name="billetera" size={22} />
              </View>
              <Text v="displayM" tone="limeText">{money(todayEarnings)}</Text>
              <Text v="caption" tone="textMuted">{todayOrders} entregas completadas</Text>
            </Card>

            <Card style={styles.statCard}>
              <View style={styles.statHeader}>
                <Text v="caption" tone="textMuted">HISTORIAL TOTAL</Text>
                <ContentIcon name="trofeo" size={22} />
              </View>
              <Text v="displayM">{completedOrders}</Text>
              <Text v="caption" tone="textMuted">Entregas de por vida</Text>
            </Card>
          </View>
        </View>

        {/* ── Base y Efectivo Pendiente ── */}
        <View style={styles.section}>
          <SectionHeader title="Caja y base de cambio" />
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
  gpsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },

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
