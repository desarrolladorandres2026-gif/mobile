import { useState, useEffect, useMemo } from 'react';
import {
  View, ScrollView, Pressable, StyleSheet, TextInput,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import {
  Text, Icon, Button, Card, Chip, DetailRow, Notice, Screen, ScreenFooter, Header, Skeleton,
} from '../../components/ui';
import { AddressSheet, hasCoordinates, type Address } from '../../components/domain/AddressPicker';
import { useCartStore } from '../../stores/cartStore';
import { usePrefsStore } from '../../stores/prefsStore';
import {
  useAddresses, useOrderQuote, useCreateOrder, usePaymentMethods, usePayOrder,
} from '../../hooks/useApi';
import { useTheme } from '../../hooks/useTheme';
import { ContentIcon } from '../../components/illustrations';
import { Type } from '../../theme/typography';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { money, km } from '../../lib/format';
import { apiMessage } from '../../lib/errors';
import { tap } from '../../lib/haptics';

/** Propinas como porcentaje del subtotal. Van completas al domiciliario. */
const TIPS = [0, 0.05, 0.1, 0.15];

type PaymentMethod = 'cash_on_delivery' | 'online';

export default function CheckoutScreen() {
  const router = useRouter();
  const { c } = useTheme();

  const items = useCartStore((s) => s.items);
  const businessId = useCartStore((s) => s.businessId);
  const businessName = useCartStore((s) => s.businessName);
  const subtotal = useCartStore((s) => s.getSubtotal());
  const clearCart = useCartStore((s) => s.clearCart);

  const { data: addresses = [] } = useAddresses() as { data: Address[] };
  const lastAddressId = usePrefsStore((s) => s.lastAddressId);
  const setLastAddress = usePrefsStore((s) => s.setLastAddress);

  const [addressId, setAddressId] = useState<string | null>(null);
  const [addressSheet, setAddressSheet] = useState(false);
  const { data: methods } = usePaymentMethods();
  const [payment, setPayment] = useState<PaymentMethod>('online');
  const [tipRate, setTipRate] = useState(0);
  const [notes, setNotes] = useState('');

  const [couponInput, setCouponInput] = useState('');
  const [appliedCode, setAppliedCode] = useState<string | null>(null);
  const [couponError, setCouponError] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Una clave por visita al checkout. Si el usuario toca dos veces o la red
  // reintenta, el servidor reconoce el duplicado y no crea dos pedidos.
  const [idempotencyKey] = useState(
    () => `zipp-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
  );

  const createOrder = useCreateOrder();
  const payOrder = usePayOrder();

  // Se preselecciona la última dirección usada, luego la principal.
  useEffect(() => {
    if (addressId || addresses.length === 0) return;
    const remembered = addresses.find((a) => a._id === lastAddressId);
    const preferred = remembered ?? addresses.find((a) => a.isDefault) ?? addresses[0];
    setAddressId(preferred._id);
  }, [addresses, addressId, lastAddressId]);

  // Si el método elegido deja de estar disponible, se corrige solo. Cotizar
  // con un método que el servidor rechaza sólo produce un error confuso.
  useEffect(() => {
    if (!methods) return;
    if (payment === 'online' && !methods.online && methods.cashOnDelivery) {
      setPayment('cash_on_delivery');
    } else if (payment === 'cash_on_delivery' && !methods.cashOnDelivery && methods.online) {
      setPayment('online');
    }
  }, [methods]);

  const address = addresses.find((a) => a._id === addressId);
  const destination = address?.location?.coordinates;
  const deliverable = hasCoordinates(address);
  const tipAmount = Math.round(subtotal * tipRate);

  const orderItems = useMemo(
    () =>
      items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        // Solo nombres y cantidades: los precios los pone el servidor.
        selectedExtras: item.selectedExtras.map((e) => ({
          name: e.name,
          quantity: e.quantity || 1,
        })),
        notes: item.notes || '',
      })),
    [items]
  );

  const quoteInput =
    businessId && deliverable && destination
      ? {
          businessId,
          items: orderItems,
          paymentMethod: payment,
          deliveryLatitude: destination[1],
          deliveryLongitude: destination[0],
          couponCode: appliedCode || undefined,
          tip: tipAmount,
        }
      : null;

  const { data: quote, isFetching: quoting, error: quoteError } = useOrderQuote(quoteInput);

  const quoteMessage = quoteError
    ? apiMessage(quoteError, 'No pudimos calcular el total de tu pedido.')
    : '';

  // El servidor es quien acepta o rechaza un cupón. Si la cotización falla
  // con un código puesto, el código es el sospechoso: se retira y se explica.
  useEffect(() => {
    if (quoteError && appliedCode) {
      setCouponError(quoteMessage);
      setAppliedCode(null);
      tap('error');
    }
  }, [quoteError]);

  const canSubmit =
    !!businessId && !!quote && !quoteError && !submitting && !createOrder.isPending;

  const placeOrder = () => {
    if (!businessId || !address || !destination || !quote || submitting) return;

    setSubmitting(true);
    setSubmitError('');

    createOrder.mutate(
      {
        businessId,
        items: orderItems,
        paymentMethod: payment,
        deliveryAddress: address.address,
        deliveryDetails: address.details || '',
        deliveryLatitude: destination[1],
        deliveryLongitude: destination[0],
        notes: notes.trim() || undefined,
        couponCode: appliedCode || undefined,
        tip: tipAmount,
        idempotencyKey,
      },
      {
        onSuccess: async (order: any) => {
          setLastAddress(address._id);
          clearCart();

          // El pedido existe, pero en digital todavía no está pagado: se
          // inicia el cobro aquí. Si la pasarela falla, el pedido queda
          // pendiente de pago en vez de darse por cobrado —
          // exactamente lo que antes se asumía sin cobrar nada.
          if (payment === 'online') {
            try {
              // Los grupos de rutas entre paréntesis, como (client), no
              // existen en la URL real: el deep link es solo /payment-result.
              const redirectUrl = Linking.createURL('payment-result');
              const intent = await payOrder.mutateAsync({ orderId: order._id, redirectUrl });
              if (intent?.checkoutUrl) {
                router.replace({
                  pathname: '/(client)/payment-result',
                  params: {
                    id: order._id,
                    code: order.orderNumber ?? '',
                    checkoutUrl: intent.checkoutUrl,
                    transactionId: intent.transactionId ?? '',
                    redirectUrl,
                  },
                });
                setSubmitting(false);
                return;
              }
            } catch (error) {
              setSubmitting(false);
              setSubmitError(
                apiMessage(error, 'Creamos tu pedido, pero no pudimos iniciar el cobro.')
              );
              tap('error');
              return;
            }
          }

          setSubmitting(false);
          tap('success');
          router.replace({
            pathname: '/(client)/order-confirmed',
            params: { id: order._id, code: order.orderNumber ?? '' },
          });
        },
        onError: (error) => {
          setSubmitting(false);
          setSubmitError(apiMessage(error, 'No pudimos crear tu pedido.'));
          tap('error');
        },
      }
    );
  };

  if (items.length === 0) {
    return (
      <Screen>
        <Header title="Confirmar pedido" fallback="/(client)/(tabs)/home" />
        <View style={styles.center}>
          <Text v="titleL" center>Tu bolsa quedó vacía</Text>
          <Button
            title="Ver negocios"
            onPress={() => router.replace('/(client)/(tabs)/home')}
          />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title="Confirmar pedido" subtitle={businessName ?? undefined} fallback="/(client)/cart" />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={60}
      >
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {/* ── Progreso del Checkout ── */}
          <View style={[styles.stepperContainer, { backgroundColor: c.surface, borderColor: c.border }]}>
            <View style={styles.stepItem}>
              <View style={[styles.stepDot, { backgroundColor: address ? c.primary : c.border }]}>
                <Icon name={address ? 'check' : 'ubicacion'} size={12} color={address ? c.textOnPrimary : c.textMuted} />
              </View>
              <Text v="captionStrong" tone={address ? 'text' : 'textMuted'}>Entrega</Text>
            </View>

            <View style={[styles.stepLine, { backgroundColor: address ? c.primary : c.border }]} />

            <View style={styles.stepItem}>
              <View style={[styles.stepDot, { backgroundColor: payment ? c.primary : c.border }]}>
                <Icon name={payment ? 'check' : 'tarjeta'} size={12} color={payment ? c.textOnPrimary : c.textMuted} />
              </View>
              <Text v="captionStrong" tone={payment ? 'text' : 'textMuted'}>Pago</Text>
            </View>

            <View style={[styles.stepLine, { backgroundColor: canSubmit ? c.primary : c.border }]} />

            <View style={styles.stepItem}>
              <View style={[styles.stepDot, { backgroundColor: canSubmit ? c.primary : c.border }]}>
                <Icon name="bolsa" size={12} color={canSubmit ? c.textOnPrimary : c.textMuted} />
              </View>
              <Text v="captionStrong" tone={canSubmit ? 'text' : 'textMuted'}>Listo</Text>
            </View>
          </View>

          {/* ── Dirección ── */}
          <View style={styles.section}>
            <Text v="label" tone="textMuted">Entregar en</Text>
            <Card onPress={() => { tap('light'); setAddressSheet(true); }} style={styles.picker}>
              <View style={[styles.pickerIcon, { backgroundColor: c.primarySoft }]}>
                <ContentIcon name="ubicacion" size={26} />
              </View>
              <View style={styles.flex}>
                {address ? (
                  <>
                    <Text v="strongM">{address.label}</Text>
                    <Text v="bodyS" tone="textSecondary" numberOfLines={1}>
                      {address.address}{address.details ? ` · ${address.details}` : ''}
                    </Text>
                  </>
                ) : (
                  <Text v="strongM" tone="textMuted">Elige dónde te lo dejamos</Text>
                )}
              </View>
              <Icon name="siguiente" size="md" color={c.textMuted} />
            </Card>

            {address && !deliverable ? (
              <Notice tone="warning">
                Esta dirección no tiene punto en el mapa, así que no podemos calcular el
                envío. Agrégala de nuevo usando "Usar mi ubicación actual".
              </Notice>
            ) : null}
            {!address ? (
              <Notice tone="info">Elige una dirección para ver el costo del envío.</Notice>
            ) : null}
          </View>

          {/* ── Pago ── */}
          <View style={styles.section}>
            <Text v="label" tone="textMuted">Cómo pagas</Text>
            <View style={styles.payments}>
              {methods?.cashOnDelivery ? (
                <PaymentOption
                  active={payment === 'cash_on_delivery'}
                  icon="efectivo"
                  title="Efectivo"
                  subtitle="Le pagas al domiciliario"
                  onPress={() => { tap('select'); setPayment('cash_on_delivery'); }}
                />
              ) : null}
              {methods?.online ? (
                <PaymentOption
                  active={payment === 'online'}
                  icon="tarjeta"
                  title="Pago digital"
                  subtitle="Desde la app"
                  onPress={() => { tap('select'); setPayment('online'); }}
                />
              ) : null}
            </View>

            {methods && !methods.online && !methods.cashOnDelivery ? (
              <Notice tone="error">
                No hay métodos de pago disponibles en este momento. Inténtalo más tarde.
              </Notice>
            ) : null}
          </View>

          {/* ── Cupón ── */}
          <View style={styles.section}>
            <Text v="label" tone="textMuted">¿Tienes un cupón?</Text>

            {quote?.coupon ? (
              <Card tone="flat" style={styles.couponApplied}>
                <Icon name="checkCirculo" size="md" color={c.successText} />
                <View style={styles.flex}>
                  <Text v="strongS" tone="successText">{quote.coupon.code}</Text>
                  <Text v="bodyS" tone="textSecondary">{quote.coupon.title}</Text>
                </View>
                <Button
                  title="Quitar"
                  variant="ghost"
                  size="sm"
                  onPress={() => {
                    tap('light');
                    setAppliedCode(null);
                    setCouponInput('');
                    setCouponError('');
                  }}
                />
              </Card>
            ) : (
              <>
                <View style={styles.couponRow}>
                  <View
                    style={[
                      styles.couponField,
                      { backgroundColor: c.surface, borderColor: couponError ? c.error : c.border },
                    ]}
                  >
                    <ContentIcon name="cupon" size={24} />
                    <TextInput
                      value={couponInput}
                      onChangeText={(t) => { setCouponInput(t.toUpperCase()); setCouponError(''); }}
                      placeholder="BIENVENIDO"
                      placeholderTextColor={c.textMuted}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      accessibilityLabel="Código del cupón"
                      style={[styles.couponInput, Type.code, { color: c.text }]}
                    />
                  </View>
                  <Button
                    title="Aplicar"
                    variant="secondary"
                    disabled={!couponInput.trim() || !deliverable}
                    loading={quoting && !!appliedCode}
                    onPress={() => {
                      tap('light');
                      setCouponError('');
                      setAppliedCode(couponInput.trim().toUpperCase());
                    }}
                  />
                </View>
                {couponError ? <Notice tone="error">{couponError}</Notice> : null}
              </>
            )}
          </View>

          {/* ── Propina ── */}
          <View style={styles.section}>
            <Text v="label" tone="textMuted">Propina al domiciliario</Text>
            <View style={styles.tips}>
              {TIPS.map((rate) => {
                const label =
                  rate === 0
                    ? 'Sin propina'
                    : rate === 0.05
                    ? '5% (Un café)'
                    : rate === 0.1
                    ? '10% (Gran servicio)'
                    : '15% (Extraordinario)';
                return (
                  <Chip
                    key={rate}
                    label={label}
                    active={tipRate === rate}
                    onPress={() => { tap('select'); setTipRate(rate); }}
                  />
                );
              })}
            </View>
            {tipAmount > 0 ? (
              <Text v="bodyS" tone="successText">
                {money(tipAmount)} van completos para quien te lo lleva.
              </Text>
            ) : null}
          </View>

          {/* ── Indicaciones ── */}
          <View style={styles.section}>
            <Text v="label" tone="textMuted">Algo que deba saber</Text>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder="Tocar el timbre, dejar en portería, llamar al llegar…"
              placeholderTextColor={c.textMuted}
              maxLength={120}
              accessibilityLabel="Indicaciones para el domiciliario"
              style={[
                styles.notes,
                Type.bodyM,
                { backgroundColor: c.surface, borderColor: c.border, color: c.text },
              ]}
            />
          </View>

          {/* ── Desglose del servidor ── */}
          <Card style={styles.breakdown}>
            <Text v="label" tone="textMuted">El detalle</Text>

            <DetailRow label="Productos" value={money(quote?.subtotal ?? subtotal)} />

            {!quote ? (
              <View style={styles.pendingRow}>
                <Text v="bodyM" tone="textSecondary">Envío</Text>
                {quoting ? <Skeleton width={64} height={16} /> : <Text v="dataM" tone="textMuted">—</Text>}
              </View>
            ) : quote.coupon?.deliveryDiscount ? (
              <>
                <DetailRow label="Envío" value={money(quote.deliveryFee)} />
                <DetailRow label="Descuento de envío" value={`−${money(quote.coupon.deliveryDiscount)}`} tone="successText" />
              </>
            ) : (
              <DetailRow
                label={quote.deliveryDistanceKm ? `Envío · ${km(quote.deliveryDistanceKm)}` : 'Envío'}
                value={money(quote.deliveryFee)}
              />
            )}

            {quote?.coupon?.productDiscount ? (
              <DetailRow
                label="Descuento"
                value={`−${money(quote.coupon.productDiscount)}`}
                tone="successText"
              />
            ) : null}

            {quote?.coupon ? <Text v="bodyS" tone="textSecondary">Condiciones: {quote.coupon.title}. Aplicación y vigencia verificadas por ZIPP.</Text> : null}

            {quote?.customerServiceFee ? (
              <DetailRow label="Tarifa de servicio" value={money(quote.customerServiceFee)} />
            ) : null}

            {quote?.tax ? <DetailRow label="Impuestos" value={money(quote.tax)} /> : null}
            {quote?.tip ? <DetailRow label="Propina" value={money(quote.tip)} /> : null}

            <View style={[styles.divider, { backgroundColor: c.border }]} />

            <View style={styles.totalRow}>
              <Text v="titleM">Total final</Text>
              {quote ? (
                <Text v="dataXL" tone="primaryText">{money(quote.total)}</Text>
              ) : quoting ? (
                <Skeleton width={110} height={32} />
              ) : (
                <Text v="dataL" tone="textMuted">—</Text>
              )}
            </View>

            {quote?.minOrder && quote.subtotal < quote.minOrder ? (
              <Notice tone="warning">
                Este negocio pide mínimo {money(quote.minOrder)}. Te faltan{' '}
                {money(quote.minOrder - quote.subtotal)}.
              </Notice>
            ) : null}
          </Card>

          {quoteMessage && deliverable ? <Notice tone="error">{quoteMessage}</Notice> : null}
          {submitError ? <Notice tone="error">{submitError}</Notice> : null}
        </ScrollView>

        <ScreenFooter>
          <Button
            title="Confirmar pedido"
            trailing={quote ? money(quote.total) : undefined}
            size="lg"
            full
            disabled={!canSubmit}
            loading={submitting || createOrder.isPending}
            onPress={placeOrder}
            haptic="medium"
            accessibilityHint={
              payment === 'cash_on_delivery'
                ? 'Pagarás en efectivo al recibir'
                : 'El cobro se hace desde la app'
            }
          />
        </ScreenFooter>
      </KeyboardAvoidingView>

      <AddressSheet
        visible={addressSheet}
        onClose={() => setAddressSheet(false)}
        selectedId={addressId}
        onSelect={(next) => setAddressId(next._id)}
      />
    </Screen>
  );
}

function PaymentOption({
  active, icon, title, subtitle, onPress,
}: {
  active: boolean;
  icon: 'efectivo' | 'tarjeta';
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  const { c } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${title}. ${subtitle}`}
      style={[
        styles.payment,
        {
          backgroundColor: active ? c.primarySoft : c.surface,
          borderColor: active ? c.primary : c.border,
          borderWidth: active ? 2 : 1,
        },
      ]}
    >
      <ContentIcon name={icon} size={32} />
      <Text v="strongS" tone={active ? 'text' : 'textSecondary'}>{title}</Text>
      <Text v="caption" tone="textMuted" center>{subtitle}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg, padding: Spacing.xxl },
  content: { padding: Spacing.xl, gap: Spacing.xxl, paddingBottom: Spacing.huge },
  section: { gap: Spacing.sm },

  stepperContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.xl,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
  },
  stepItem: {
    alignItems: 'center',
    gap: 4,
  },
  stepDot: {
    width: 22,
    height: 22,
    borderRadius: BorderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepLine: {
    flex: 1,
    height: 2,
    marginHorizontal: Spacing.sm,
    marginBottom: 16,
  },

  picker: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  pickerIcon: {
    width: 40, height: 40, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center',
  },

  payments: { flexDirection: 'row', gap: Spacing.md },
  payment: {
    flex: 1,
    alignItems: 'center',
    gap: Spacing.xs,
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.sm,
    borderRadius: BorderRadius.lg,
  },

  couponRow: { flexDirection: 'row', gap: Spacing.sm },
  couponField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    height: 52,
    paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
  },
  couponInput: { flex: 1, paddingVertical: 0 },
  couponApplied: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },

  tips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },

  notes: {
    minHeight: 52,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },

  breakdown: { gap: Spacing.md },
  pendingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  divider: { height: StyleSheet.hairlineWidth },
  totalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
