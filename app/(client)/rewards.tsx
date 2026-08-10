import { View, ScrollView, StyleSheet, Share } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import {
  Text, Icon, Card, Button, Badge, Notice, Screen, Header, EmptyState,
} from '../../components/ui';
import { TrazoDivider } from '../../components/brand/Trazo';
import { useZippStats } from '../../hooks/useUsual';
import { usePublicCoupons } from '../../hooks/useApi';
import { useAuthStore } from '../../stores/authStore';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { money, firstName } from '../../lib/format';
import { tap } from '../../lib/haptics';

/**
 * Puntos Zipp.
 *
 * Dos partes, las dos reales. Arriba, tu actividad calculada del historial de
 * pedidos. Abajo, los cupones vigentes que de verdad puedes usar hoy al
 * confirmar un pedido.
 *
 * Se evita a propósito la mecánica de "junta 500 puntos y canjea": no hay
 * canje en el servidor todavía, y una recompensa que no se puede reclamar
 * hace más daño que no tener programa.
 */
export default function RewardsScreen() {
  const { c } = useTheme();
  const user = useAuthStore((s) => s.user);
  const stats = useZippStats();
  const { data: coupons = [] } = usePublicCoupons();

  const invite = async () => {
    tap('light');
    try {
      await Share.share({
        message:
          `Pide a domicilio en Garzón con Zipp. Usa el código BIENVENIDO en tu primer pedido ` +
          `y te descuentan el 20%. Yo ya llevo ${stats.orderCount} ${stats.orderCount === 1 ? 'pedido' : 'pedidos'}.`,
      });
    } catch {
      // Cancelar la hoja de compartir no es un error.
    }
  };

  return (
    <Screen>
      <Header title="Puntos Zipp" fallback="/(client)/(tabs)/profile" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* ── Tu actividad ── */}
        <Animated.View entering={FadeInDown.duration(360)}>
          <Card tone="accent" style={styles.hero}>
            <Text v="label" tone="textMuted">TUS PUNTOS</Text>
            <Text v="displayXL" tone="primaryText">{stats.points}</Text>
            <Text v="bodyM" tone="textSecondary" center>
              Ganas un punto por cada $1.000 que pides en Zipp.
            </Text>

            <TrazoDivider />

            <View style={styles.heroStats}>
              <View style={styles.heroStat}>
                <View style={styles.streakRow}>
                  <Icon name="racha" size="md" color={c.limeText} />
                  <Text v="dataL">{stats.streak}</Text>
                </View>
                <Text v="caption" tone="textMuted" center>
                  {stats.streak === 1 ? 'semana seguida' : 'semanas seguidas'}
                </Text>
              </View>

              <View style={[styles.heroLine, { backgroundColor: c.primarySoftBorder }]} />

              <View style={styles.heroStat}>
                <Text v="dataL">{stats.orderCount}</Text>
                <Text v="caption" tone="textMuted" center>pedidos</Text>
              </View>

              <View style={[styles.heroLine, { backgroundColor: c.primarySoftBorder }]} />

              <View style={styles.heroStat}>
                <Text v="dataL">{money(stats.totalSpent)}</Text>
                <Text v="caption" tone="textMuted" center>en total</Text>
              </View>
            </View>
          </Card>
        </Animated.View>

        {stats.streak >= 2 ? (
          <Notice tone="lime" icon="racha">
            {`Llevas ${stats.streak} semanas seguidas pidiendo. Eso te pone entre los clientes más fieles de Garzón.`}
          </Notice>
        ) : null}

        {stats.favoriteBusiness ? (
          <Card style={styles.favorite}>
            <View style={[styles.favoriteIcon, { backgroundColor: c.limeSoft }]}>
              <Icon name="medalla" size="md" color={c.limeText} />
            </View>
            <View style={styles.flex}>
              <Text v="caption" tone="textMuted">TU LUGAR DE CABECERA</Text>
              <Text v="titleM" numberOfLines={1}>{stats.favoriteBusiness}</Text>
            </View>
          </Card>
        ) : null}

        {/* ── Cupones que puedes usar ── */}
        <View style={styles.section}>
          <Text v="titleL">Para usar ya</Text>
          <Text v="bodyM" tone="textSecondary">
            Escribe el código al confirmar tu pedido. El descuento se aplica sobre el total.
          </Text>

          {coupons.length === 0 ? (
            <EmptyState
              icon="cupon"
              title="Sin cupones activos"
              message="Cuando haya promociones nuevas te avisamos por notificación."
              compact
            />
          ) : (
            coupons.map((coupon: any) => (
              <Card key={coupon._id} style={styles.coupon}>
                <View style={styles.couponTop}>
                  <View style={[styles.couponIcon, { backgroundColor: c.limeSoft }]}>
                    <Icon name="cupon" size="md" color={c.limeText} />
                  </View>
                  <View style={styles.flex}>
                    <Text v="titleS" numberOfLines={2}>{coupon.title}</Text>
                    <Text v="bodyS" tone="textSecondary">{describe(coupon)}</Text>
                  </View>
                </View>

                <View style={[styles.couponCode, { borderColor: c.limeSoftBorder, backgroundColor: c.limeSoft }]}>
                  <Text v="code" tone="limeText">{coupon.code}</Text>
                </View>

                {coupon.minOrder ? (
                  <Badge label={`Desde ${money(coupon.minOrder)}`} tone="neutral" icon="bolsa" />
                ) : null}
              </Card>
            ))
          )}
        </View>

        {/* ── Invitar ── */}
        <View style={styles.section}>
          <Text v="titleL">Trae a un parcero</Text>
          <Card style={styles.invite}>
            <View style={[styles.inviteIcon, { backgroundColor: c.primary }]}>
              <Icon name="amigos" size="lg" color={c.textOnPrimary} />
            </View>
            <Text v="titleM" center>
              {firstName(user?.name)
                ? `${firstName(user?.name)}, comparte Zipp`
                : 'Comparte Zipp'}
            </Text>
            <Text v="bodyM" tone="textSecondary" center>
              Quien todavía no ha pedido tiene 20% de descuento en su primer pedido con el
              código BIENVENIDO. Pásaselo por WhatsApp.
            </Text>
            <Button title="Compartir invitación" icon="compartir" full onPress={invite} />
          </Card>
        </View>
      </ScrollView>
    </Screen>
  );
}

function describe(coupon: any): string {
  if (coupon.type === 'free_delivery') return 'Envío gratis';
  if (coupon.type === 'percentage') {
    return coupon.maxDiscount > 0
      ? `${coupon.value}% de descuento, hasta ${money(coupon.maxDiscount)}`
      : `${coupon.value}% de descuento`;
  }
  return `${money(coupon.value)} de descuento`;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: Spacing.xl, gap: Spacing.xl, paddingBottom: Spacing.huge },

  hero: { alignItems: 'center', gap: Spacing.sm },
  heroStats: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch' },
  heroStat: { flex: 1, alignItems: 'center', gap: 2 },
  heroLine: { width: 1, height: 34 },
  streakRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },

  favorite: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  favoriteIcon: {
    width: 42, height: 42, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center',
  },

  section: { gap: Spacing.md },
  coupon: { gap: Spacing.md },
  couponTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  couponIcon: {
    width: 42, height: 42, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  couponCode: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
  },

  invite: { alignItems: 'center', gap: Spacing.md },
  inviteIcon: {
    width: 56, height: 56, borderRadius: BorderRadius.lg,
    alignItems: 'center', justifyContent: 'center',
  },
});
