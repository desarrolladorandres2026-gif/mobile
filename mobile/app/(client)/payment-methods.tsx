import { useState } from 'react';
import { View, ScrollView, StyleSheet, Pressable } from 'react-native';
import { Text, Icon, Notice, Screen, Header, ConfirmDialog, Skeleton, EmptyState } from '../../components/ui';
import { usePaymentMethods, useSavedCards, useDeleteSavedCard, type SavedCardSummary } from '../../hooks/useApi';
import { useTheme } from '../../hooks/useTheme';
import { useBottomInset } from '../../hooks/useBottomSpace';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { cardLabel } from '../../lib/paymentInstrument';
import { apiMessage } from '../../lib/errors';
import { tap } from '../../lib/haptics';
import { ROUTES } from '../../lib/routing';

/**
 * Las tarjetas guardadas, fuera del checkout.
 *
 * Antes solo se veían al pagar: quien quería borrar una tarjeta tenía que
 * armar un pedido para llegar hasta ella. Aquí no se agregan tarjetas —se
 * guardan al pagar con una, que es cuando Wompi la tokeniza—; solo se ven y
 * se borran.
 */
export default function PaymentMethodsScreen() {
  const { c, isDark } = useTheme();
  const bottomInset = useBottomInset();
  const { data: methods, isPending: methodsPending } = usePaymentMethods();
  const enabled = !!methods?.inApp?.savedCards;
  const cards = useSavedCards(enabled);
  const deleteCard = useDeleteSavedCard();

  const [target, setTarget] = useState<SavedCardSummary | null>(null);
  const [message, setMessage] = useState<{ tone: 'lime' | 'error'; text: string } | null>(null);

  const remove = () => {
    const card = target;
    setTarget(null);
    if (!card) return;
    setMessage(null);
    deleteCard.mutate(card.id, {
      onSuccess: () => { tap('success'); setMessage({ tone: 'lime', text: `Eliminamos ${cardLabel(card.brand, card.lastFour)}.` }); },
      onError: (err) => { tap('error'); setMessage({ tone: 'error', text: apiMessage(err, 'No pudimos eliminar la tarjeta.') }); },
    });
  };

  const list = cards.data ?? [];
  const loading = methodsPending || (enabled && cards.isPending);

  return (
    <Screen>
      <Header title="Métodos de pago" fallback={ROUTES.profile} />

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset + Spacing.xxl }]}>
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

        {loading ? (
          <View style={styles.list}>
            <Skeleton height={60} radius={BorderRadius.md} />
            <Skeleton height={60} radius={BorderRadius.md} />
          </View>
        ) : !enabled ? (
          <EmptyState
            icon="tarjeta"
            title="Todavía no guardamos tarjetas"
            message="Por ahora pagas en efectivo o con tarjeta en cada pedido. Cuando se puedan guardar, aparecerán aquí."
          />
        ) : cards.isError ? (
          <Notice tone="error">{apiMessage(cards.error, 'No pudimos cargar tus tarjetas.')}</Notice>
        ) : list.length === 0 ? (
          <EmptyState
            icon="tarjeta"
            title="No tienes tarjetas guardadas"
            message="Cuando pagues con tarjeta en el checkout, podrás guardarla para el siguiente pedido."
          />
        ) : (
          <View style={styles.list}>
            {list.map((card, idx) => (
              <View
                key={card.id}
                style={[
                  styles.row,
                  idx < list.length - 1 && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)',
                  },
                ]}
              >
                <Icon name="tarjeta" size="md" color={c.text} />
                <View style={styles.flex}>
                  <Text v="strongM">{cardLabel(card.brand, card.lastFour)}</Text>
                  <Text v="caption" tone="textMuted">Vence {card.expMonth}/{card.expYear}</Text>
                </View>
                <Pressable
                  onPress={() => { tap('warning'); setTarget(card); }}
                  accessibilityRole="button"
                  accessibilityLabel={`Eliminar ${cardLabel(card.brand, card.lastFour)}`}
                  hitSlop={10}
                  style={styles.trash}
                >
                  <Icon name="eliminar" size="sm" color={c.textMuted} />
                </Pressable>
              </View>
            ))}
            <Text v="caption" tone="textMuted" style={styles.note}>
              Guardamos solo una referencia segura de tu tarjeta, nunca el número completo ni el código de seguridad.
            </Text>
          </View>
        )}
      </ScrollView>

      <ConfirmDialog
        visible={!!target}
        onCancel={() => setTarget(null)}
        onConfirm={remove}
        icon="eliminar"
        title="Eliminar tarjeta"
        message={target ? `¿Eliminar ${cardLabel(target.brand, target.lastFour)}? Tendrás que escribirla de nuevo para usarla.` : ''}
        confirmText="Eliminar"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg, gap: Spacing.lg },
  list: { gap: Spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: 12 },
  trash: { padding: 6 },
  note: { marginTop: Spacing.sm },
});
