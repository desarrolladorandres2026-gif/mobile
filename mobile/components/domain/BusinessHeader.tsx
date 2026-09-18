import { View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Text, Icon } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import { categoryIllustration } from '../illustrations';
import { BorderRadius, Shadow, Spacing } from '../../theme/tokens';
import { money, minutes } from '../../lib/format';

/**
 * La portada, la identidad y la promesa de entrega de un negocio.
 *
 * Es lo primero que ve quien entra a una tienda, y responde en un vistazo a
 * las tres preguntas con las que llega: qué es esto, cuánto tarda y cuánto
 * me cuesta que me lo traigan. Antes esas tres respuestas estaban repartidas
 * entre una fila de metadatos y un distintivo suelto; aquí ocupan el lugar
 * que les corresponde.
 *
 * Está fuera de la pantalla del negocio —que ya pasa de mil líneas— porque
 * el encabezado es una pieza con su propia lógica de respaldos: sin foto,
 * sin logo, sin tarifa y sin promoción tiene que seguir viéndose entero.
 */

export interface BusinessHeaderData {
  _id: string;
  name: string;
  description?: string;
  logo?: string | null;
  coverImage?: string | null;
  brandColor?: string | null;
  category: string;
  deliveryTime: number;
  minOrder?: number;
  freeDeliveryThreshold?: number;
  showPromoBanner?: boolean;
  /**
   * El piso real del domicilio de este negocio, que calcula el servidor con
   * la misma fórmula del checkout. Ausente cuando el negocio no tiene
   * ubicación válida o su zona está mal configurada.
   */
  deliveryFeeFrom?: number | null;
}

/** Alto de la portada. 16:9 sobre un teléfono estándar, sin comerse la carta. */
const COVER_HEIGHT = 232;
/** Lado del logo. Suficiente para leer una marca, no tanto como para tapar la foto. */
const LOGO_SIZE = 84;

interface Props {
  business: BusinessHeaderData;
  /** Color derivado del id, cuando el comercio no eligió el suyo. */
  fallbackAccent: string;
  /** Distancia hasta el cliente, ya formateada. Null si no se conoce. */
  distanceLabel?: string | null;
  /**
   * El distintivo de abierto/cerrado, que arma la pantalla.
   *
   * Llega como nodo en vez de como texto porque el horario lo resuelve el
   * cliente contra su propio reloj, y ese cálculo no tiene por qué mudarse
   * aquí solo para que los dos distintivos compartan fila.
   */
  statusBadge?: React.ReactNode;
}

export function BusinessHeader({ business, fallbackAccent, distanceLabel, statusBadge }: Props) {
  const { c } = useTheme();

  const Illustration = categoryIllustration(business.category);
  const backdrop = business.brandColor || fallbackAccent;
  const hasCover = !!business.coverImage;

  return (
    <View>
      <View style={[styles.cover, { backgroundColor: backdrop }]}>
        {hasCover ? (
          <Image
            source={{ uri: business.coverImage! }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={220}
            accessible={false}
          />
        ) : null}

        <LinearGradient
          colors={['rgba(8,11,17,0.15)', 'rgba(8,11,17,0.72)']}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />

        <View style={styles.identity}>
          <View style={[styles.logo, { backgroundColor: c.surface, borderColor: c.white }]}>
            {business.logo ? (
              <Image
                source={{ uri: business.logo }}
                style={styles.logoImage}
                contentFit="cover"
                transition={200}
                accessible={false}
              />
            ) : (
              <Illustration size={48} />
            )}
          </View>

          <Text v="displayM" color={c.white} center numberOfLines={2}>
            {business.name}
          </Text>

          {business.description ? (
            <Text v="bodyS" color="rgba(255,255,255,0.88)" center numberOfLines={2}>
              {business.description}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={styles.body}>
        {statusBadge || business.minOrder ? (
          <View style={styles.chips}>
            {statusBadge}
            {business.minOrder ? (
              <View style={[styles.minOrder, { borderColor: c.border, backgroundColor: c.surface }]}>
                <Icon name="bolsa" size="sm" color={c.textSecondary} />
                <Text v="strongS" tone="textSecondary">
                  Mínimo de compra {money(business.minOrder)}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={[styles.promise, { backgroundColor: c.surface, borderColor: c.border }]}>
          <PromiseCell
            icon="minutos"
            label="Entrega"
            value={minutes(business.deliveryTime)}
            hint={distanceLabel ?? undefined}
          />
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <PromiseCell
            icon="domiciliario"
            label="Envío"
            // "Desde" y no un precio a secas: el domicilio se cobra por
            // distancia, así que cualquier número exacto aquí sería una
            // promesa que el carrito no puede cumplir.
            value={business.deliveryFeeFrom ? `Desde ${money(business.deliveryFeeFrom)}` : '—'}
            hint={business.deliveryFeeFrom ? 'según tu dirección' : 'se calcula al pedir'}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * La franja de promoción del encabezado.
 *
 * Va suelta y no dentro de `BusinessHeader` porque su sitio es el final del
 * bloque de información, debajo de las reseñas y la dirección: es lo último
 * que se lee antes de entrar a la carta, que es justo cuando una razón para
 * pedir aquí pesa más.
 *
 * Devuelve `null` cuando no hay nada real que anunciar. Una franja vacía
 * con un texto de relleno es peor que ninguna franja.
 */
export function BusinessPromoBanner({ business }: { business: BusinessHeaderData }) {
  const { c } = useTheme();
  const promo = promoMessage(business);
  if (!promo) return null;

  return (
    <View style={[styles.promo, { backgroundColor: c.primarySoft, borderColor: c.primarySoftBorder }]}>
      <Icon name="descuento" size="lg" color={c.primaryText} />
      <View style={styles.promoText}>
        <Text v="strongM" tone="primaryText">{promo.title}</Text>
        <Text v="bodyS" tone="textSecondary">{promo.detail}</Text>
      </View>
    </View>
  );
}

function PromiseCell({
  icon, label, value, hint,
}: {
  icon: 'minutos' | 'domiciliario';
  label: string;
  value: string;
  hint?: string;
}) {
  const { c } = useTheme();

  return (
    <View style={styles.cell}>
      <View style={styles.cellLabel}>
        <Icon name={icon} size="sm" color={c.textMuted} />
        <Text v="caption" tone="textMuted">{label}</Text>
      </View>
      <Text v="dataM" tone="text">{value}</Text>
      {hint ? <Text v="caption" tone="textMuted">{hint}</Text> : null}
    </View>
  );
}

/**
 * Lo que dice la franja de promoción, si hay algo que decir.
 *
 * El texto lo arma Zipp y no el comercio, a propósito: la franja solo puede
 * anunciar cosas que el sistema sabe cumplir, así que nunca puede quedarse
 * prometiendo un 2x1 que terminó el mes pasado. Lo único que decide el
 * negocio es si quiere mostrarla.
 */
function promoMessage(business: BusinessHeaderData): { title: string; detail: string } | null {
  if (business.showPromoBanner === false) return null;

  const threshold = business.freeDeliveryThreshold ?? 0;
  if (threshold > 0) {
    return {
      title: 'Envío gratis en tu pedido',
      detail: `Pide ${money(threshold)} o más en esta tienda y no pagas domicilio.`,
    };
  }

  return null;
}

const styles = StyleSheet.create({
  cover: {
    height: COVER_HEIGHT,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  identity: {
    alignItems: 'center',
    gap: Spacing.xs,
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.xl,
  },
  logo: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
    borderRadius: LOGO_SIZE / 2,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginBottom: Spacing.sm,
    ...Shadow.md,
  },
  logoImage: { width: '100%', height: '100%' },

  body: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    gap: Spacing.md,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: Spacing.sm },
  minOrder: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: BorderRadius.full,
  },
  promise: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: BorderRadius.lg,
    paddingVertical: Spacing.lg,
  },
  cell: { flex: 1, alignItems: 'center', gap: 2 },
  cellLabel: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  divider: { width: StyleSheet.hairlineWidth },

  promo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: BorderRadius.lg,
  },
  promoText: { flex: 1, gap: 2 },
});
