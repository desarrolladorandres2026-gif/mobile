import { useCallback, useState } from 'react';
import { View, StyleSheet, Pressable, Alert } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming, Easing } from 'react-native-reanimated';
import { Text, Button, Sheet, Icon, Input } from '../ui';
import { ContentIcon } from '../illustrations';
import { useTheme } from '../../hooks/useTheme';
import { useCreateReview } from '../../hooks/useApi';
import type { PendingRating } from '../../services/endpoints';
import { tap } from '../../lib/haptics';
import { Spacing, BorderRadius } from '../../theme/tokens';

/**
 * Calificar un pedido entregado.
 *
 * El servidor sabía recibir reseñas desde hacía tiempo —valida el pedido,
 * recalcula la media del negocio y la del domiciliario— pero la app no
 * tenía por dónde mandarlas. La consecuencia era silenciosa y grave: la
 * nota que aparece en cada tarjeta de negocio no era una nota, era el
 * número que dejó el sembrado inicial.
 *
 * El domiciliario se califica aparte y es opcional. Son dos servicios
 * distintos —la comida y el viaje— y juntarlos en una sola estrella hace
 * que una demora hunda al restaurante o que un buen plato tape una mala
 * entrega.
 */

const LABELS = ['', 'Muy mal', 'Mal', 'Regular', 'Bien', 'Excelente'];

function Stars({
  value,
  onChange,
  size = 36,
}: {
  value: number;
  onChange: (v: number) => void;
  size?: number;
}) {
  const { c } = useTheme();

  return (
    <View style={styles.stars}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Pressable
          key={star}
          onPress={() => { tap('select'); onChange(star); }}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`${star} de 5 estrellas`}
        >
          <Icon
            name="calificacion"
            size={size}
            color={star <= value ? c.warning : c.border}
            strong={star <= value}
          />
        </Pressable>
      ))}
    </View>
  );
}

export function RatingSheet({
  order,
  visible,
  onClose,
}: {
  order: PendingRating | null;
  visible: boolean;
  onClose: () => void;
}) {
  const { c } = useTheme();
  const createReview = useCreateReview();

  const [businessRating, setBusinessRating] = useState(0);
  const [driverRating, setDriverRating] = useState(0);
  const [comment, setComment] = useState('');

  /**
   * Pulgar por plato. Solo entra en el envío lo que el cliente tocó: no
   * responder no es lo mismo que decir que no, y contar los silencios como
   * pulgares abajo hundiría cualquier carta.
   */
  const [productLikes, setProductLikes] = useState<Record<string, boolean>>({});

  const shake = useSharedValue(0);
  const shakeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));

  const reset = useCallback(() => {
    setBusinessRating(0);
    setDriverRating(0);
    setComment('');
    setProductLikes({});
  }, []);

  const handleSubmit = useCallback(() => {
    if (!order) return;

    // La estrella del negocio es lo único obligatorio. En vez de deshabilitar
    // el botón —un botón gris no explica nada—, se señala qué falta.
    if (businessRating === 0) {
      tap('warning');
      shake.value = withSequence(
        withTiming(-6, { duration: 60, easing: Easing.linear }),
        withTiming(6, { duration: 60, easing: Easing.linear }),
        withTiming(0, { duration: 60, easing: Easing.linear })
      );
      return;
    }

    const businessId =
      typeof order.businessId === 'string' ? order.businessId : order.businessId._id;

    createReview.mutate(
      {
        orderId: order._id,
        businessId,
        driverId: order.driverId ?? undefined,
        businessRating,
        driverRating: driverRating || undefined,
        comment: comment.trim() || undefined,
        productFeedback: Object.entries(productLikes).map(([productId, liked]) => ({
          productId,
          liked,
        })),
      },
      {
        onSuccess: () => {
          tap('success');
          reset();
          onClose();
        },
        onError: (err: any) => {
          Alert.alert(
            'No pudimos guardar tu calificación',
            err?.response?.data?.message ?? 'Inténtalo de nuevo.'
          );
        },
      }
    );
  }, [order, businessRating, driverRating, comment, productLikes, createReview, onClose, reset, shake]);

  if (!order) return null;

  const businessName =
    typeof order.businessId === 'string' ? 'tu pedido' : order.businessId.name;

  return (
    <Sheet
      visible={visible}
      onClose={() => { reset(); onClose(); }}
      title="¿Cómo te fue?"
      height={0.82}
      footer={
        <Button
          title={createReview.isPending ? 'Enviando…' : 'Enviar calificación'}
          onPress={handleSubmit}
          style={styles.action}
        />
      }
    >
      <View style={styles.body}>
        <View style={styles.art}>
          <ContentIcon name="calificacion" size={72} />
        </View>

        <Animated.View style={[styles.block, shakeStyle]}>
          <Text v="titleM" center>{businessName}</Text>
          <Text v="bodyS" tone="textSecondary" center>
            Pedido {order.orderNumber}
          </Text>
          <Stars value={businessRating} onChange={setBusinessRating} />
          <Text v="captionStrong" center tone={businessRating ? 'text' : 'textMuted'}>
            {businessRating ? LABELS[businessRating] : 'Toca una estrella'}
          </Text>
        </Animated.View>

        {order.items?.length ? (
          <View style={[styles.block, styles.driverBlock, { borderColor: c.border }]}>
            <Text v="strongS" center>¿Qué tal cada plato?</Text>
            <Text v="caption" tone="textMuted" center>
              Opcional. Ayuda a los demás a elegir.
            </Text>

            {order.items.map((item) => {
              const liked = productLikes[item.productId];
              return (
                <View key={item.productId} style={styles.dish}>
                  <Text v="bodyS" numberOfLines={1} style={styles.dishName}>
                    {item.productName}
                  </Text>

                  <View style={styles.thumbs}>
                    <Pressable
                      onPress={() => {
                        tap('select');
                        // Volver a tocar el mismo pulgar lo retira: sin esto,
                        // un toque por error no se puede deshacer.
                        setProductLikes((prev) => {
                          const next = { ...prev };
                          if (next[item.productId] === true) delete next[item.productId];
                          else next[item.productId] = true;
                          return next;
                        });
                      }}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`Me gustó ${item.productName}`}
                    >
                      <Icon
                        name="check"
                        size={22}
                        color={liked === true ? c.lime : c.border}
                        strong={liked === true}
                      />
                    </Pressable>

                    <Pressable
                      onPress={() => {
                        tap('select');
                        setProductLikes((prev) => {
                          const next = { ...prev };
                          if (next[item.productId] === false) delete next[item.productId];
                          else next[item.productId] = false;
                          return next;
                        });
                      }}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`No me gustó ${item.productName}`}
                    >
                      <Icon
                        name="cerrar"
                        size={22}
                        color={liked === false ? c.error : c.border}
                        strong={liked === false}
                      />
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        ) : null}

        {order.driverId ? (
          <View style={[styles.block, styles.driverBlock, { borderColor: c.border }]}>
            <Text v="strongS" center>¿Y el domiciliario?</Text>
            <Text v="caption" tone="textMuted" center>
              Opcional. La comida y el viaje son dos cosas distintas.
            </Text>
            <Stars value={driverRating} onChange={setDriverRating} size={30} />
          </View>
        ) : null}

        <Input
          value={comment}
          onChangeText={setComment}
          placeholder="Cuéntanos algo más (opcional)"
          multiline
          maxLength={300}
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: Spacing.lg, paddingTop: Spacing.sm },
  art: { alignItems: 'center' },
  block: { gap: Spacing.sm, alignItems: 'center' },
  driverBlock: {
    borderTopWidth: 1,
    paddingTop: Spacing.lg,
    gap: Spacing.xs,
  },
  stars: { flexDirection: 'row', gap: Spacing.sm, paddingVertical: Spacing.xs },
  dish: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
    width: '100%',
    paddingVertical: Spacing.xs,
  },
  dishName: { flex: 1 },
  thumbs: { flexDirection: 'row', gap: Spacing.lg },
  action: { width: '100%' },
});
