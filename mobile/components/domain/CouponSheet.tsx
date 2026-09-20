import { View, StyleSheet } from 'react-native';
import { Text, Button, Sheet, Notice } from '../ui';
import { LiveCountdown } from './LiveCountdown';
import { BorderRadius, Spacing, palette } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { money } from '../../lib/format';
import {
  couponMagnitude, couponBenefit, usageProgress, windowLabel, type CouponStatus,
} from '../../lib/offers';
import type { OfferCoupon } from '../../services/endpoints';

/**
 * Todo lo que hay que saber de un cupón, y qué hacer con él.
 *
 * Hasta hace poco las tarjetas de Descuentos eran `View` planas: enseñaban
 * un código y ahí se acababa la historia. Quien quisiera usarlo tenía que
 * memorizarlo, entrar al negocio por su cuenta y volver a teclearlo en el
 * pago. Esta hoja es el eslabón que faltaba.
 *
 * La acción principal nunca se apaga. Un cupón fuera de horario ofrece
 * guardarlo para cuando abra; uno ya gastado lleva de vuelta a los demás.
 * Un botón gris no explica nada y deja a la persona sin salida, que es peor
 * que un error: al menos un error dice algo.
 */
export function CouponSheet({
  coupon, status, visible, onClose, onUse,
}: {
  coupon: OfferCoupon | null;
  status: CouponStatus;
  visible: boolean;
  onClose: () => void;
  /** Guardar el cupón y llevar a donde se pueda gastar. Lo decide la pantalla. */
  onUse: (coupon: OfferCoupon) => void;
}) {
  const { c } = useTheme();
  if (!coupon) return null;

  const { value, qualifier } = couponMagnitude(coupon);
  const progress = usageProgress(coupon);
  const remaining = coupon.usageLimit
    ? Math.max(0, coupon.usageLimit - (coupon.usedCount ?? 0))
    : null;

  const action = primaryAction(status);

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Cupón"
      height={0.72}
      footer={
        <Button
          title={action.label}
          full
          size="lg"
          icon={action.icon}
          onPress={() => {
            if (action.use) onUse(coupon);
            else onClose();
          }}
        />
      }
    >
      <View style={styles.body}>
        {/* El mismo tiquete que en el riel, ampliado: la magnitud primero,
            el código en el talón. Repetir aquí la jerarquía de la tarjeta
            evita ese salto de "¿es este el cupón que toqué?". */}
        <View style={[styles.head, { backgroundColor: palette.ink900 }]}>
          <Text v="displayXL" color={palette.gold400}>{value}</Text>
          {qualifier ? (
            <Text v="bodyM" color={palette.ink100}>{qualifier}</Text>
          ) : null}
          <Text v="titleM" color={palette.paper0} style={styles.headTitle}>{coupon.title}</Text>

          <View style={[styles.code, { borderColor: palette.ink400 }]}>
            <Text v="code" color={palette.gold400}>{coupon.code}</Text>
          </View>
        </View>

        {/* El estado, contado con las palabras que le tocan a cada caso.
            "No disponible" a secas obliga a adivinar si es cosa del cupón o
            de uno mismo. */}
        {status.kind === 'scheduled' ? (
          <Notice tone="info" icon="reloj">
            {status.window
              ? `Sirve de ${windowLabel(status.window)}. Guárdalo y te espera en el pago.`
              : 'Todavía no empieza. Guárdalo y te espera en el pago.'}
          </Notice>
        ) : null}

        {status.kind === 'used' ? (
          <Notice tone="info">Ya usaste este cupón. Cada uno se puede aprovechar una vez.</Notice>
        ) : null}

        {status.kind === 'not_first_order' ? (
          <Notice tone="info">
            Este era para estrenar Zipp y tú ya pediste. Abajo hay otros que sí son para ti.
          </Notice>
        ) : null}

        {status.kind === 'unavailable' ? (
          <Notice tone="warning">Este cupón ya no está disponible.</Notice>
        ) : null}

        {status.kind === 'scheduled' && status.opensAt ? (
          <View style={styles.countdownRow}>
            <Text v="bodyS" tone="textSecondary">Abre en</Text>
            <LiveCountdown target={status.opensAt} variant="large" />
          </View>
        ) : null}

        {status.kind === 'active' && status.closesAt ? (
          <View style={styles.countdownRow}>
            <Text v="bodyS" tone="textSecondary">La franja cierra en</Text>
            <LiveCountdown target={status.closesAt} variant="large" />
          </View>
        ) : null}

        {/* Sin etiqueta "CONDICIONES" encima: la lista de pares ya se lee
            como lo que es, y una fila de mayúsculas espaciadas sobre cada
            bloque era el mismo adorno repetido por toda la pantalla. */}
        <View style={styles.rules}>
          {status.window ? <Rule label="Horario" value={windowLabel(status.window)} /> : null}

          <Rule
            label="Vence"
            value={new Date(coupon.validUntil).toLocaleDateString('es-CO', {
              day: 'numeric', month: 'long',
            })}
          />

          {coupon.minOrderAmount ? (
            <Rule label="Pedido mínimo" value={money(coupon.minOrderAmount)} />
          ) : (
            <Rule label="Pedido mínimo" value="Ninguno" />
          )}

          {remaining !== null ? (
            <Rule
              label="Quedan"
              value={remaining <= 0 ? 'Se agotó' : `${remaining} de ${coupon.usageLimit}`}
            />
          ) : null}

          <Rule
            label="Dónde"
            value={coupon.businessId ? 'Solo en este negocio' : 'En cualquier negocio'}
          />

          {coupon.firstOrderOnly ? <Rule label="Para quién" value="Tu primer pedido" /> : null}
        </View>

        {progress !== null && progress > 0 ? (
          <View style={styles.progressBlock}>
            <View style={[styles.progressTrack, { backgroundColor: c.surfaceLight }]}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${progress * 100}%`, backgroundColor: c.primary },
                ]}
              />
            </View>
            <Text v="caption" tone="textMuted">
              {progress >= 1 ? 'Se agotó por hoy' : `${Math.round(progress * 100)}% ya canjeado`}
            </Text>
          </View>
        ) : null}

        {/* El descuento exacto no se promete aquí a propósito: depende del
            carrito y lo calcula el servidor al cotizar. Escribir una cifra
            en esta hoja sería adelantarse a un número que puede no salir. */}
        <Text v="caption" tone="textMuted">
          {`Descuento de ${couponBenefit(coupon)}. El ahorro exacto se calcula con tu pedido, al pagar.`}
        </Text>
      </View>
    </Sheet>
  );
}

/** Una condición del cupón: lo que limita a la izquierda, el límite a la derecha. */
function Rule({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.rule}>
      <Text v="bodyM" tone="textSecondary">{label}</Text>
      <Text v="strongM" tone="text">{value}</Text>
    </View>
  );
}

/** Qué ofrece el botón del pie según en qué punto esté el cupón. */
function primaryAction(status: CouponStatus): {
  label: string;
  icon?: 'bolsa' | 'reloj' | 'descuento';
  /** Si el botón guarda el cupón, o solo cierra la hoja. */
  use: boolean;
} {
  switch (status.kind) {
    case 'active':
      return { label: 'Usar este cupón', icon: 'bolsa', use: true };
    case 'scheduled':
      // Guardarlo es una acción de verdad: queda esperando en el pago para
      // cuando la franja abra, sin tener que volver a buscarlo.
      return { label: 'Guardarlo para esa hora', icon: 'reloj', use: true };
    default:
      return { label: 'Ver otros descuentos', icon: 'descuento', use: false };
  }
}

const styles = StyleSheet.create({
  body: { gap: Spacing.lg, paddingBottom: Spacing.xl },

  head: {
    borderRadius: BorderRadius.lg,
    padding: Spacing.xl,
    gap: 2,
  },
  headTitle: { marginTop: Spacing.sm },
  code: {
    alignSelf: 'flex-start',
    marginTop: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
  },

  countdownRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },

  rules: { gap: Spacing.md },
  rule: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: Spacing.md },

  progressBlock: { gap: 4 },
  progressTrack: { height: 6, borderRadius: BorderRadius.full, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: BorderRadius.full },
});
