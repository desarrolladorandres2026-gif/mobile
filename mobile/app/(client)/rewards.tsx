import { View, ScrollView, StyleSheet, Share } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Text, Button, Notice, Screen, Header } from '../../components/ui';
import { ContentIcon } from '../../components/illustrations';
import { useZippStats } from '../../hooks/useUsual';
import { useLoyalty, useReferrals } from '../../hooks/useApi';
import { useAuthStore } from '../../stores/authStore';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing, FontSize } from '../../theme/tokens';
import { money, firstName } from '../../lib/format';
import { tap } from '../../lib/haptics';

export default function RewardsScreen() {
  const router = useRouter();
  const { c, isDark } = useTheme();
  const user = useAuthStore((s) => s.user);
  const stats = useZippStats();

  // Los puntos vienen del servidor. `useZippStats` sigue dando la racha y
  // el conteo de pedidos, que sí son del historial local y no son deuda de
  // nadie.
  const { data: loyalty } = useLoyalty();
  const points = loyalty?.balance ?? 0;

  const referrals = useReferrals();

  /**
   * Comparte el código **propio**, no uno fijo.
   *
   * Antes se mandaba `BIENVENIDO`, escrito a mano en esta pantalla: nadie
   * sabía quién había traído a quién, y quien invitaba no cobraba nunca. El
   * backend lleva desde el Bloque 7 con código por usuario y recompensa
   * pagada cuando el invitado **compra** — todo eso estaba y no llegaba aquí.
   */
  const invite = async () => {
    if (!referrals.data?.code) return;
    tap('light');
    try {
      await Share.share({
        message:
          `Pide a domicilio con Zipp. Entra con mi código ${referrals.data.code} ` +
          `y los dos ganamos.`,
      });
    } catch {
      // Cancelar la hoja de compartir no es un error.
    }
  };

  return (
    <Screen style={{ backgroundColor: isDark ? '#0C101C' : '#F1F3F7' }}>
      <Header title="Puntos Zipp" fallback="/(client)/(tabs)/profile" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* ── Samsung One UI Big Hero Points Card ── */}
        <Animated.View entering={FadeInDown.duration(360)}>
          <View
            style={[
              styles.pointsHeroCard,
              {
                backgroundColor: c.surface,
                borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
              },
            ]}
          >
            <View style={[styles.pointsBadge, { backgroundColor: isDark ? 'rgba(245, 158, 11, 0.16)' : '#FEF3C7' }]}>
              <ContentIcon name="trofeo" size={20} />
              <Text v="captionStrong" color={isDark ? '#FBBF24' : '#D97706'}>
                PROGRAMA DE RECOMPENSAS
              </Text>
            </View>

            <Text v="displayXL" tone="primaryText" style={styles.pointsNumber}>
              {points.toLocaleString('es-CO')}
            </Text>
            <Text v="bodyM" tone="textSecondary" center>
              {points > 0
                ? `Valen ${money(points)} en tu próximo pedido`
                : 'Ganas puntos con cada pedido entregado'}
            </Text>

            {/* Un punto vale un peso: la equivalencia se dice en voz alta.
                Los programas donde "1000 puntos son 12.500 pesos" existen
                para que el cliente no sepa cuánto tiene. */}
            {/* El canje se mudó a la billetera de Descuentos, que es donde
                la gente entra a buscar con qué ahorrar. Aquí se quedó el
                saldo y su historia; tener el mismo botón en dos pantallas
                era la forma segura de que un día dijeran cosas distintas. */}
            {points > 0 ? (
              <Button
                title="Canjear mis puntos"
                icon="cupon"
                variant="secondary"
                style={styles.redeemBtn}
                onPress={() => {
                  tap('light');
                  router.push('/(client)/(tabs)/offers');
                }}
              />
            ) : null}

            <View style={[styles.cardDivider, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]} />

            {/* Widget de Métricas One UI */}
            <View style={styles.metricsRow}>
              <View style={styles.metricCol}>
                <View style={styles.streakRow}>
                  <ContentIcon name="racha" size={20} />
                  <Text v="titleL" color={isDark ? '#34D399' : '#059669'}>
                    {stats.streak}
                  </Text>
                </View>
                <Text v="caption" tone="textMuted" center>
                  {stats.streak === 1 ? 'semana' : 'semanas racha'}
                </Text>
              </View>

              <View style={[styles.metricDivider, { backgroundColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)' }]} />

              <View style={styles.metricCol}>
                <Text v="titleL" color={c.text}>{stats.orderCount}</Text>
                <Text v="caption" tone="textMuted" center>pedidos</Text>
              </View>

              <View style={[styles.metricDivider, { backgroundColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)' }]} />

              <View style={styles.metricCol}>
                <Text v="titleL" color={c.text}>{money(stats.totalSpent)}</Text>
                <Text v="caption" tone="textMuted" center>invertidos</Text>
              </View>
            </View>
          </View>
        </Animated.View>

        {stats.streak >= 2 ? (
          <Notice tone="lime" icon="racha">
            {`Llevas ${stats.streak} semanas seguidas pidiendo. Eres de nuestros clientes más fieles.`}
          </Notice>
        ) : null}

        {stats.favoriteBusiness ? (
          <View
            style={[
              styles.favoriteCard,
              {
                backgroundColor: c.surface,
                borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
              },
            ]}
          >
            <View style={styles.cleanIcon}>
              <ContentIcon name="favorito" size={30} />
            </View>
            <View style={styles.flex}>
              <Text v="captionStrong" tone="textMuted">TU NEGOCIO DE CABECERA</Text>
              <Text v="strongL" numberOfLines={1}>{stats.favoriteBusiness}</Text>
            </View>
          </View>
        ) : null}

        {/* Los cupones —los propios y los públicos— viven en la pestaña
            de Descuentos. Esta pantalla los pintaba otra vez, con otro
            endpoint y otro diseño: dos sitios contando lo mismo con
            distintas palabras. */}

        {/* ── Invitar a un amigo ── */}
        <View style={styles.sectionBlock}>
          <Text v="captionStrong" tone="textMuted" style={styles.sectionTitle}>
            COMPARTE Y GANA
          </Text>

          <View
            style={[
              styles.inviteCard,
              {
                backgroundColor: c.surface,
                borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
              },
            ]}
          >
            <View style={styles.inviteCleanIcon}>
              <ContentIcon name="regalo" size={40} />
            </View>
            <Text v="titleM" center>
              {firstName(user?.name)
                ? `${firstName(user?.name)}, comparte Zipp`
                : 'Comparte Zipp con amigos'}
            </Text>
            <Text v="bodyM" tone="textSecondary" center>
              {referrals.data
                ? `Cuando quien invitas hace su primer pedido, te damos ${referrals.data.pointsPerReferral.toLocaleString('es-CO')} puntos.`
                : 'Invita a alguien y gana puntos cuando haga su primer pedido.'}
            </Text>

            {referrals.data ? (
              <>
                {/* El código a la vista y en mono: mucha gente lo dicta por
                    teléfono en vez de compartir el enlace. */}
                <View
                  style={[
                    styles.codeBox,
                    { backgroundColor: c.primarySoft, borderColor: c.primary },
                  ]}
                >
                  <Text v="code" color={c.primaryText}>{referrals.data.code}</Text>
                </View>

                {referrals.data.invited > 0 ? (
                  <Text v="caption" tone="textMuted" center>
                    {referrals.data.invited}{' '}
                    {referrals.data.invited === 1 ? 'persona ha entrado' : 'personas han entrado'}{' '}
                    con tu código
                    {referrals.data.rewarded > 0
                      ? ` · ${referrals.data.rewarded} ya ${referrals.data.rewarded === 1 ? 'pidió' : 'pidieron'}`
                      : ''}
                  </Text>
                ) : null}
              </>
            ) : null}

            <Button
              title="Compartir mi código"
              icon="compartir"
              full
              onPress={invite}
              style={{ marginTop: Spacing.sm }}
            />
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  codeBox: {
    alignSelf: 'center',
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  redeemBtn: { marginTop: Spacing.md, alignSelf: 'stretch' },
  flex: { flex: 1 },
  content: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.huge,
    gap: Spacing.lg,
  },

  // Points Hero Card
  pointsHeroCard: {
    borderRadius: 26,
    padding: Spacing.xl,
    alignItems: 'center',
    borderWidth: 1,
    gap: Spacing.sm,
  },
  pointsBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: BorderRadius.full,
    marginBottom: Spacing.xs,
  },
  pointsNumber: {
    fontSize: 44,
    fontWeight: '900',
    lineHeight: 50,
  },
  cardDivider: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
    marginVertical: Spacing.sm,
  },

  // Metrics Row
  metricsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  metricCol: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  metricDivider: {
    width: 1,
    height: 34,
  },
  streakRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },

  // Favorite Card
  favoriteCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.lg,
    borderRadius: 22,
    borderWidth: 1,
  },
  cleanIcon: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Section
  sectionBlock: {
    gap: 8,
  },
  sectionTitle: {
    marginLeft: Spacing.md,
    letterSpacing: 0.8,
    fontSize: 11,
  },

  // Coupon Card

  // Invite Card
  inviteCard: {
    borderRadius: 24,
    padding: Spacing.xl,
    alignItems: 'center',
    borderWidth: 1,
    gap: Spacing.sm,
  },
  inviteCleanIcon: {
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.xs,
  },
});
