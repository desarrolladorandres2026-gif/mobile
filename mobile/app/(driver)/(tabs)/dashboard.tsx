import { useState, useEffect, useRef } from 'react';
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

  /**
   * Mientras el servidor no conteste, manda el interruptor.
   *
   * `refetchOnWindowFocus` está activo para toda la app, y pedir el permiso
   * de ubicación manda la app a segundo plano: al volver del diálogo el
   * perfil llega todavía en `offline`, el efecto de abajo revertía el botón
   * y —lo grave— llamaba a `setOnDuty(false)`, apagando el GPS justo en el
   * turno que el repartidor acababa de abrir. Durante el vuelo de la
   * mutación, el perfil no toca el interruptor.
   */
  const toggling = useRef(false);

  const {
    data: profile, isLoading: loadingProfile, isError: errorProfile, refetch: refetchProfile, isRefetching,
  } = useDriverProfile();
  const { data: earnings, refetch: refetchEarnings } = useDriverEarnings();
  const { data: debts, refetch: refetchDebts } = useDriverDebts();

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
    if (!profile || toggling.current) return;
    // 'busy' cuenta como en línea: el servidor lo pone así mientras el
    // repartidor reparte un pedido (para que la cascada deje de ofrecerle
    // otros), pero el GPS y el interruptor tienen que seguir encendidos —
    // apagarlos aquí dejaría de rastrear a alguien que está en la calle.
    const online = profile.status === 'available' || profile.status === 'busy';
    setIsOnline(online);
    tracking.setOnDuty(online);
  }, [profile]);

  const handleToggleOnline = async (value: boolean) => {
    tap(value ? 'success' : 'medium');
    toggling.current = true;

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
        toggling.current = false;
        socketService.emitDriverStatus(nextStatus);
        refetchProfile();
      },
      onError: (error) => {
        toggling.current = false;
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

  // Solo el perfil bloquea la pantalla: ganancias y deudas corren en paralelo
  // y ya tienen su propio valor por defecto (0) mientras llegan, así que
  // esperarlas aquí solo alargaba el spinner sin ganar nada — el repartidor
  // veía "Cargando tu turno..." de más por la más lenta de las tres.
  if (loadingProfile && !isRefetching) {
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

  /**
   * Una línea para las dos cosas que el repartidor necesita saber de un
   * vistazo: si está en servicio y si su ubicación está saliendo del
   * teléfono. Lo segundo era antes un bloque aparte que, con todo en orden,
   * solo repetía lo que el punto que late ya decía.
   */
  const dutyHint = !isOnline
    ? 'Conéctate y recibe pedidos'
    : tracking.active
      ? 'Ubicación activa'
      : 'Buscando ubicación...';

  /** Solo lo que el repartidor puede arreglar. `null` = nada que avisar. */
  const gpsWarning = !isOnline
    ? null
    : tracking.problem
      ?? (tracking.permission === 'blocked' || tracking.permission === 'denied'
        ? 'Sin permiso de ubicación no te llegan pedidos cercanos.'
        : tracking.permission === 'granted_foreground'
          ? 'Solo te ubicamos con la app abierta.'
          : null);

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

        {/* ── Estado de servicio ── */}
        <Animated.View entering={FadeIn.duration(280)}>
          <Card
            style={[
              styles.dutyCard,
              isOnline
                ? { backgroundColor: c.successSoft, borderColor: c.successSoftBorder }
                : { backgroundColor: c.surface, borderColor: c.border },
              Shadow.sm,
            ]}
          >
            <View style={styles.dutyRow}>
              {isOnline ? (
                <PulseDot color={c.successText} size={9} />
              ) : (
                <View style={[styles.dutyDot, { backgroundColor: c.textMuted }]} />
              )}

              <View style={styles.flex}>
                <Text
                  v="titleS"
                  tone={isOnline ? 'successText' : 'textSecondary'}
                  numberOfLines={1}
                >
                  {isOnline ? 'Disponible' : 'Fuera de servicio'}
                </Text>
                <Text v="caption" tone="textMuted" numberOfLines={1}>
                  {dutyHint}
                </Text>
              </View>

              <Button
                title={isOnline ? 'Desconectar' : 'Conectarme'}
                icon={isOnline ? undefined : 'rayo'}
                variant={isOnline ? 'secondary' : 'primary'}
                size="sm"
                loading={updateStatusMutation.isPending}
                onPress={() => handleToggleOnline(!isOnline)}
                style={styles.dutyBtn}
              />
            </View>

            {/*
              El aviso de GPS solo aparece cuando hay algo que arreglar.

              Antes ocupaba una fila fija que, con el permiso concedido y el
              GPS reportando, solo repetía "todo bien" — información que el
              punto que late ya daba. Lo que sí es invisible sin este bloque
              es lo contrario: un repartidor "ACTIVO" al que no le entran
              pedidos porque su ubicación no sale del teléfono. Ese caso, y
              solo ese, se gana el espacio.
            */}
            {gpsWarning ? (
              <View style={[styles.gpsRow, { borderTopColor: c.border }]}>
                <Icon name="atencion" size="sm" color={c.warningText} />
                <Text v="caption" tone="warningText" style={styles.flex}>
                  {gpsWarning}
                </Text>
                {tracking.permission === 'blocked' ? (
                  <Button
                    title="Ajustes"
                    size="sm"
                    variant="secondary"
                    onPress={tracking.openSettings}
                  />
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
                <Text v="caption" color="#000000">GANANCIAS HOY</Text>
                <ContentIcon name="billetera" size={22} />
              </View>
              <Text v="displayM" color="#000000">{money(todayEarnings)}</Text>
              <Text v="caption" color="#000000">{todayOrders} entregas completadas</Text>
            </Card>

            <Card style={styles.statCard}>
              <View style={styles.statHeader}>
                <Text v="caption" color="#000000">HISTORIAL TOTAL</Text>
                <ContentIcon name="trofeo" size={22} />
              </View>
              <Text v="displayM" color="#000000">{completedOrders}</Text>
              <Text v="caption" color="#000000">Entregas de por vida</Text>
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

  /**
   * El interruptor de turno es una fila, no un póster.
   *
   * Antes eran cuatro bloques apilados —punto, título, badge, párrafo, fila
   * de GPS y botón a lo ancho— para expresar un booleano: ~282dp, casi un
   * tercio de la primera pantalla. Ahora punto, estado y botón comparten
   * una sola línea de 40dp y la tarjeta cabe en ~72dp sin perder ninguna
   * de las decisiones que ofrecía.
   */
  dutyCard: { padding: Spacing.lg, gap: Spacing.md },
  dutyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  dutyDot: { width: 9, height: 9, borderRadius: 4.5 },
  /**
   * Ancho mínimo: al cargar, `Button` cambia el título por el loader. Sin
   * esto el botón se encogería a la mitad en cada toque.
   */
  dutyBtn: { minWidth: 120 },
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
