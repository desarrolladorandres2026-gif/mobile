import { useMemo, useState } from 'react';
import { View, ScrollView, RefreshControl, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInDown } from 'react-native-reanimated';
import {
  Text, Icon, Button, Notice, Skeleton, ErrorState, ConfirmDialog,
} from '../../../components/ui';
import { useProStatus, useCancelPro, useResumePro } from '../../../hooks/useApi';
import { ContentIcon, type ContentIllustrationName } from '../../../components/illustrations';
import type { ProPlan, ProStatus } from '../../../services/endpoints';
import { useTheme } from '../../../hooks/useTheme';
import { useTabContentPadding, CLIENT_DOCK_CLEARANCE } from '../../../hooks/useBottomSpace';
import { money } from '../../../lib/format';
import { apiMessage } from '../../../lib/errors';
import { tap } from '../../../lib/haptics';
import { Spacing, BorderRadius, palette } from '../../../theme/tokens';

/**
 * Zipp Pro.
 *
 * Una pestaña con dos caras y ni una tercera: o se está vendiendo la
 * membresía, o se está enseñando la que ya se tiene. `member` decide, y
 * `member` lo calcula el servidor a partir de una fecha pagada —no de un
 * estado— para que cancelar no signifique perder lo que ya se compró.
 *
 * Los beneficios no están escritos aquí. Llegan en `plan.benefits`, que es
 * el mismo objeto que el motor de precios aplica al cotizar: la pantalla no
 * puede prometer un envío gratis que el checkout después no descuente,
 * porque los dos leen la misma línea.
 */
export default function ProScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const bottomSpace = useTabContentPadding(CLIENT_DOCK_CLEARANCE);

  const { data, isLoading, isError, refetch, isRefetching } = useProStatus();
  const cancel = useCancelPro();
  const resume = useResumePro();

  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const benefits = useMemo(() => describeBenefits(data?.plan), [data?.plan]);

  if (isLoading) {
    return (
      <View style={[styles.screen, { backgroundColor: c.background, paddingTop: insets.top + Spacing.xl }]}>
        <View style={styles.loading}>
          <Skeleton height={190} radius={BorderRadius.xl} />
          <Skeleton height={22} width="55%" radius={BorderRadius.sm} />
          <Skeleton height={64} radius={BorderRadius.lg} />
          <Skeleton height={64} radius={BorderRadius.lg} />
          <Skeleton height={60} radius={BorderRadius.full} />
        </View>
      </View>
    );
  }

  if (isError || !data) {
    return (
      <View style={[styles.screen, { backgroundColor: c.background, paddingTop: insets.top + Spacing.xl }]}>
        <ErrorState
          title="No pudimos cargar Zipp Pro"
          message="Revisa tu conexión e inténtalo de nuevo."
          onRetry={refetch}
        />
      </View>
    );
  }

  const { plan } = data;

  const act = async (run: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try {
      await run();
      tap('success');
    } catch (err) {
      tap('error');
      setError(apiMessage(err, fallback));
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: c.background }]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: bottomSpace }}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={c.primary}
            colors={[c.primary]}
            progressBackgroundColor={palette.ink700}
          />
        }
      >
        <ProHero status={data} topInset={insets.top} />

        <View style={styles.body}>
          <Text v="label" tone="textMuted">
            {data.member ? 'Lo que tienes' : 'Lo que incluye'}
          </Text>

          {benefits.map((benefit, index) => (
            <Animated.View key={benefit.id} entering={FadeInDown.delay(60 * index).duration(320)}>
              <BenefitRow {...benefit} live={data.member} />
            </Animated.View>
          ))}

          {error ? <Notice tone="error">{error}</Notice> : null}

          {data.member ? (
            <MemberActions
              status={data}
              busy={cancel.isPending || resume.isPending}
              onCancel={() => { tap('light'); setConfirmCancel(true); }}
              onResume={() => act(() => resume.mutateAsync(), 'No pudimos reactivar la renovación.')}
            />
          ) : (
            <View style={styles.cta}>
              <Button
                title={`Hazte Pro por ${money(plan.price)} al mes`}
                icon="corona"
                size="lg"
                full
                haptic="medium"
                onPress={() => router.push('/(client)/pro-checkout')}
              />
              <Text v="caption" tone="textMuted" center>
                Se renueva cada {plan.periodDays} días. Puedes cancelar cuando quieras y sigues
                siendo Pro hasta el final del periodo que ya pagaste.
              </Text>
            </View>
          )}
        </View>
      </ScrollView>

      <ConfirmDialog
        visible={confirmCancel}
        title="¿Cancelar la renovación?"
        message={
          data.currentPeriodEnd
            ? `Seguirás siendo Pro hasta el ${longDate(data.currentPeriodEnd)}. Después dejaremos de cobrarte.`
            : 'Dejaremos de cobrarte al terminar el periodo actual.'
        }
        confirmText="Sí, cancelar"
        cancelText="Seguir siendo Pro"
        onConfirm={() => {
          setConfirmCancel(false);
          act(() => cancel.mutateAsync(), 'No pudimos cancelar la renovación.');
        }}
        onCancel={() => setConfirmCancel(false)}
      />
    </View>
  );
}

/**
 * La franja de arriba: obsidiana y oro.
 *
 * Es el único sitio de la pestaña donde aparece el fondo oscuro, por la
 * misma razón que en Descuentos: el dorado de la marca solo contrasta de
 * verdad sobre él, y usarlo dos veces lo gastaría.
 */
function ProHero({ status, topInset }: { status: ProStatus; topInset: number }) {
  const { plan, member } = status;

  return (
    <LinearGradient
      colors={[palette.ink900, palette.ink700]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.hero, { paddingTop: topInset + Spacing.xl }]}
    >
      <View style={styles.crown}>
        <LinearGradient
          colors={[palette.gold300, palette.gold500]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.crownFill}
        >
          <Icon name="corona" size={28} color={palette.ink900} strong />
        </LinearGradient>
      </View>

      <Text v="displayL" color={palette.paper0} center>{plan.name}</Text>

      {member ? (
        <>
          <Text v="bodyL" color={palette.ink100} center>
            Ya eres Pro. Tus pedidos salen más baratos desde hoy.
          </Text>
          {status.currentPeriodEnd ? (
            <View style={styles.heroPill}>
              <Icon name={status.autoRenew ? 'reintentar' : 'reloj'} size="sm" color={palette.gold300} />
              <Text v="caption" color={palette.gold300}>
                {status.autoRenew
                  ? `Se renueva el ${longDate(status.currentPeriodEnd)}`
                  : `Activa hasta el ${longDate(status.currentPeriodEnd)}`}
              </Text>
            </View>
          ) : null}
        </>
      ) : (
        <>
          <Text v="bodyL" color={palette.ink100} center>
            La cuota mensual que te quita el domicilio de encima.
          </Text>
          <View style={styles.price}>
            <Text v="displayL" color={palette.gold300}>{money(plan.price)}</Text>
            <Text v="bodyM" color={palette.ink100}>/ mes</Text>
          </View>
        </>
      )}
    </LinearGradient>
  );
}

/**
 * Un beneficio, sin caja.
 *
 * Antes cada renglón vivía dentro de una tarjeta con borde y un cuadro gris
 * detrás del icono: dos contenedores para decir una línea. Se quitaron los
 * dos. Queda la ilustración a tamaño completo y el texto al lado, que es lo
 * único que el ojo estaba leyendo.
 *
 * La ilustración no cambia de color al ser Pro —son SVG de paleta fija, no
 * glifos teñidos—, así que la diferencia entre "lo que tienes" y "lo que
 * tendrías" descansa entera en el check de la derecha.
 */
function BenefitRow({
  illustration, title, detail, live,
}: {
  illustration: ContentIllustrationName;
  title: string;
  detail: string;
  live: boolean;
}) {
  const { c } = useTheme();
  return (
    <View style={styles.benefit}>
      <ContentIcon name={illustration} size={52} />
      <View style={styles.flex}>
        <Text v="strongS">{title}</Text>
        <Text v="caption" tone="textMuted">{detail}</Text>
      </View>
      {/* El check no es decoración: distingue "esto es lo que tienes" de
          "esto es lo que tendrías", que es la diferencia entre un carnet y
          un folleto. */}
      {live ? <Icon name="checkCirculo" size="sm" color={c.primaryText} /> : null}
    </View>
  );
}

function MemberActions({
  status, busy, onCancel, onResume,
}: {
  status: ProStatus;
  busy: boolean;
  onCancel: () => void;
  onResume: () => void;
}) {
  const { c } = useTheme();

  return (
    <View style={styles.cta}>
      {status.card ? (
        <View style={[styles.card, { backgroundColor: c.surfaceLight }]}>
          <Icon name="tarjeta" size="sm" color={c.textMuted} />
          <Text v="caption" tone="textMuted" style={styles.flex}>
            Se cobra a tu {status.card.brand} ···· {status.card.lastFour}
          </Text>
        </View>
      ) : null}

      {status.autoRenew ? (
        <Button
          title="Cancelar la renovación"
          variant="ghost"
          full
          loading={busy}
          onPress={onCancel}
        />
      ) : (
        <Button
          title="Volver a renovar cada mes"
          icon="reintentar"
          variant="secondary"
          size="lg"
          full
          loading={busy}
          onPress={onResume}
        />
      )}
    </View>
  );
}

/**
 * De la configuración del plan a renglones legibles.
 *
 * Solo entra lo que está encendido en el servidor. Un beneficio apagado no
 * se pinta en gris ni se anuncia como "próximamente": desaparece, porque
 * un folleto que promete lo que el cobro no aplica es lo único que esta
 * pantalla no se puede permitir.
 */
function describeBenefits(plan?: ProPlan) {
  if (!plan) return [];

  const rows: Array<{
    id: string;
    illustration: ContentIllustrationName;
    title: string;
    detail: string;
  }> = [];

  if (plan.benefits.freeDelivery.enabled) {
    const min = plan.benefits.freeDelivery.minSubtotal;
    rows.push({
      id: 'free-delivery',
      illustration: 'domiciliario',
      title: 'Envío gratis',
      detail: min > 0
        ? `En todos tus pedidos desde ${money(min)} en productos`
        : 'En todos tus pedidos, sin compra mínima',
    });
  }

  if (plan.benefits.serviceFeeWaived.enabled) {
    rows.push({
      id: 'service-fee',
      illustration: 'billetera',
      title: 'Sin tarifa de servicio',
      detail: 'La tarifa que cobra Zipp en cada pedido queda en cero',
    });
  }

  rows.push({
    id: 'cancel',
    illustration: 'seguridad',
    title: 'Sin permanencia',
    detail: 'Cancelas cuando quieras y sigues siendo Pro hasta el final del mes pagado',
  });

  return rows;
}

/** "14 de marzo de 2026". Fecha larga: es una promesa, no un registro. */
function longDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  loading: { paddingHorizontal: Spacing.xl, gap: Spacing.lg },
  hero: {
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.xxl,
    paddingBottom: Spacing.xxl,
    borderBottomLeftRadius: BorderRadius.xl,
    borderBottomRightRadius: BorderRadius.xl,
  },
  crown: { marginBottom: Spacing.xs },
  crownFill: {
    width: 64,
    height: 64,
    borderRadius: BorderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  price: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.xs, marginTop: Spacing.xs },
  heroPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    marginTop: Spacing.xs,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full,
    backgroundColor: 'rgba(213,158,38,0.14)',
  },
  body: { padding: Spacing.xl, gap: Spacing.md },
  benefit: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  cta: { gap: Spacing.md, marginTop: Spacing.md },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
  },
});
