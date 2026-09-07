import { useState, useEffect, useMemo, useRef } from 'react';
import {
  View, ScrollView, Pressable, StyleSheet, TextInput,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import Animated, { FadeIn, FadeOut, Layout } from 'react-native-reanimated';
import {
  Text, Icon, Button, Card, Chip, DetailRow, Notice, Screen, ScreenFooter, Header,
  Skeleton, EmptyState,
} from '../../components/ui';
import { AddressSheet, hasCoordinates, type Address } from '../../components/domain/AddressPicker';
import { useCartStore } from '../../stores/cartStore';
import { usePrefsStore } from '../../stores/prefsStore';
import {
  useAddresses, useOrderQuote, useCreateOrder, usePaymentMethods, usePayOrder,
} from '../../hooks/useApi';
import { useTheme } from '../../hooks/useTheme';
import { ContentIcon } from '../../components/illustrations';
import type { IconName } from '../../theme/icons';
import { Type } from '../../theme/typography';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { money, km } from '../../lib/format';
import { apiMessage } from '../../lib/errors';
import { tap } from '../../lib/haptics';

/** Propinas como porcentaje del subtotal. Van completas al domiciliario. */
const TIPS = [0, 0.05, 0.1, 0.15];

const MAX_NOTES = 120;

type PaymentMethod = 'cash_on_delivery' | 'online';

/**
 * Lo que impide confirmar, con la salida a la mano.
 *
 * No es un mensaje de error: es el siguiente paso. La pantalla nunca apaga su
 * botón principal —un botón gris es un callejón sin salida más silencioso que
 * un error—, así que cuando algo falta, el botón deja de decir "Confirmar
 * pedido" y pasa a hacer justo lo que falta.
 */
type Blocker = {
  label: string;
  icon: IconName;
  hint: string;
  onPress: () => void;
};

export default function CheckoutScreen() {
  const router = useRouter();
  const { c } = useTheme();

  const items = useCartStore((s) => s.items);
  const businessId = useCartStore((s) => s.businessId);
  const businessName = useCartStore((s) => s.businessName);
  const subtotal = useCartStore((s) => s.getSubtotal());
  const itemCount = useCartStore((s) => s.getItemCount());
  const getLineTotal = useCartStore((s) => s.getLineTotal);
  const clearCart = useCartStore((s) => s.clearCart);

  const { data: addresses = [] } = useAddresses() as { data: Address[] };
  const lastAddressId = usePrefsStore((s) => s.lastAddressId);
  const setLastAddress = usePrefsStore((s) => s.setLastAddress);

  const [addressId, setAddressId] = useState<string | null>(null);
  const [addressSheet, setAddressSheet] = useState(false);
  const { data: methods, refetch: refetchMethods } = usePaymentMethods();
  // Sin preselección: elegir cómo se paga es una decisión del cliente, no
  // un valor por defecto que se acepta por inercia. Antes venía marcado
  // "pago digital" y bastaba con no mirar esta sección para acabar en la
  // pasarela sin haberlo decidido.
  const [payment, setPayment] = useState<PaymentMethod | null>(null);
  const [tipRate, setTipRate] = useState(0);
  const [notes, setNotes] = useState('');

  const [showItems, setShowItems] = useState(false);

  const [couponInput, setCouponInput] = useState('');
  const [appliedCode, setAppliedCode] = useState<string | null>(null);
  const [couponError, setCouponError] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Para poder llevar al cliente hasta la sección de pago cuando es lo que
  // falta. La posición se mide sola: el checkout crece y encoge según haya
  // cupón, propina o avisos, así que una constante quedaría mal a la
  // primera edición.
  const scrollRef = useRef<ScrollView>(null);
  const paymentY = useRef(0);
  const [highlightPayment, setHighlightPayment] = useState(false);

  const scrollToPayment = () => {
    scrollRef.current?.scrollTo({ y: Math.max(0, paymentY.current - 12), animated: true });
    setHighlightPayment(true);
  };

  // El realce se apaga en cuanto elige: es una señal de "mira aquí", no un
  // estado de error que haya que quitarse de encima.
  useEffect(() => {
    if (payment) setHighlightPayment(false);
  }, [payment]);

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
    // Solo se retira lo que dejó de estar disponible; nunca se elige por
    // el cliente. Quedarse sin selección es un estado legítimo —el pie lo
    // dice y el botón lleva hasta aquí—, y es preferible a moverle el
    // método de pago por debajo entre el momento en que lo eligió y el
    // momento en que confirma.
    if (payment === 'online' && !methods.online) setPayment(null);
    if (payment === 'cash_on_delivery' && !methods.cashOnDelivery) setPayment(null);
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

  /**
   * Con qué método se cotiza mientras el cliente no ha elegido.
   *
   * El método de pago no entra en ninguna cifra del presupuesto —solo
   * decide si el pedido es *admisible* en efectivo—, así que el total que
   * se muestra es el mismo con cualquiera de los dos. Esperar a que elija
   * para enseñárselo sería esconderle el precio justo cuando lo necesita
   * para decidir. El tope del efectivo se comprueba aparte, en cuanto lo
   * elige, y por eso se cotiza en línea cuando está disponible: es el
   * método sin límite de monto.
   */
  const quoteMethod: PaymentMethod =
    payment ?? (methods?.online ? 'online' : 'cash_on_delivery');

  const quoteInput =
    businessId && deliverable && destination
      ? {
          businessId,
          items: orderItems,
          paymentMethod: quoteMethod,
          deliveryLatitude: destination[1],
          deliveryLongitude: destination[0],
          couponCode: appliedCode || undefined,
          tip: tipAmount,
        }
      : null;

  const {
    data: quote, isFetching: quoting, error: quoteError, refetch: refetchQuote,
  } = useOrderQuote(quoteInput);

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

  // ── Reglas que el servidor también aplica ──
  // Se comprueban aquí para poder resolverlas antes de gastar un intento y
  // recibir un rechazo que el cliente no sabe traducir.
  const noMethods = !!methods && !methods.online && !methods.cashOnDelivery;
  const cashMax = methods?.cashOnDeliveryMaxAmount ?? 0;
  const cashOverLimit =
    payment === 'cash_on_delivery' && cashMax > 0 && !!quote && quote.total > cashMax;
  const missingForMin =
    quote?.minOrder && quote.subtotal < quote.minOrder ? quote.minOrder - quote.subtotal : 0;

  const blocker: Blocker | null = !address
    ? {
        label: 'Elegir dirección',
        icon: 'ubicacion',
        hint: 'Falta decir dónde te lo dejamos.',
        onPress: () => setAddressSheet(true),
      }
    : !deliverable
    ? {
        label: 'Cambiar dirección',
        icon: 'ubicacion',
        hint: 'Esta dirección no tiene punto en el mapa.',
        onPress: () => setAddressSheet(true),
      }
    : noMethods
    ? {
        label: 'Reintentar',
        icon: 'reintentar',
        hint: 'No hay métodos de pago disponibles ahora mismo.',
        onPress: () => { refetchMethods(); },
      }
    : !payment
    ? {
        // El pedido no se confirma sin método, pero el botón no se apaga:
        // lleva hasta la sección que falta. Un botón gris no dice qué
        // falta ni dónde está, y aquí lo que falta es una decisión que
        // está tres pantallazos más arriba.
        label: 'Elegir cómo pagas',
        icon: 'tarjeta',
        hint: 'Falta elegir cómo vas a pagar.',
        onPress: () => scrollToPayment(),
      }
    : cashOverLimit
    ? methods?.online
      ? {
          label: 'Pagar desde la app',
          icon: 'tarjeta',
          hint: `En efectivo aceptamos hasta ${money(cashMax)}.`,
          onPress: () => setPayment('online'),
        }
      : {
          label: 'Revisar la bolsa',
          icon: 'bolsa',
          hint: `En efectivo aceptamos hasta ${money(cashMax)}.`,
          onPress: () => router.push('/(client)/cart'),
        }
    : missingForMin > 0
    ? {
        label: `Agregar ${money(missingForMin)} más`,
        icon: 'mas',
        hint: `Este negocio pide mínimo ${money(quote!.minOrder)}.`,
        onPress: () => {
          if (businessId) router.push(`/(client)/business/${businessId}`);
          else router.replace('/(client)/(tabs)/home');
        },
      }
    : quoteError
    ? {
        // El motivo completo va en la tarjeta del detalle: el pie es una
        // línea corta y un mensaje del servidor no cabe sin recortarse.
        label: 'Reintentar',
        icon: 'reintentar',
        hint: 'No pudimos calcular el total.',
        onPress: () => { refetchQuote(); },
      }
    : null;

  const busy = submitting || createOrder.isPending;
  /** Cotizando por primera vez: el botón espera en vez de no hacer nada al tocarlo. */
  const awaitingFirstQuote = !blocker && !quote && quoting;

  const placeOrder = () => {
    // `payment` entra en el guardia igual que la dirección: sin método no
    // hay pedido que crear, y el servidor lo rechazaría de todos modos.
    if (!businessId || !address || !destination || !quote || !payment || submitting) return;

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
        <EmptyState
          icon="bolsa"
          title="Tu bolsa quedó vacía"
          message="Se vació mientras confirmabas. Mira qué hay abierto cerca de ti."
          actionLabel="Ver negocios"
          onAction={() => router.replace('/(client)/(tabs)/home')}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header
        title="Confirmar pedido"
        subtitle={businessName ?? undefined}
        fallback="/(client)/cart"
      />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={60}
      >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          {/* ── Qué estás confirmando ──
              La pantalla se llama "Confirmar pedido" y hasta ahora no mostraba
              un solo producto. Va cerrada porque el usuario acaba de verlos en
              la bolsa; abrirla cuesta un toque y despeja la duda de siempre. */}
          <Card padded={false}>
            <Pressable
              onPress={() => { tap('light'); setShowItems((v) => !v); }}
              accessibilityRole="button"
              accessibilityState={{ expanded: showItems }}
              accessibilityLabel={`${itemCount} ${itemCount === 1 ? 'producto' : 'productos'} de ${businessName ?? 'el negocio'}. ${showItems ? 'Ocultar' : 'Ver'} el detalle`}
              style={({ pressed }) => [styles.summaryHead, pressed && styles.pressed]}
            >
              <View style={[styles.summaryIcon, { backgroundColor: c.primarySoft }]}>
                <Icon name="bolsa" size="md" color={c.primaryText} />
              </View>
              <View style={styles.flex}>
                <Text v="strongM" numberOfLines={1}>
                  {itemCount} {itemCount === 1 ? 'producto' : 'productos'}
                </Text>
                <Text v="bodyS" tone="textSecondary" numberOfLines={1}>
                  {businessName ?? 'Tu pedido'}
                </Text>
              </View>
              <Text v="dataM" tone="textSecondary">{money(subtotal)}</Text>
              <Icon name={showItems ? 'plegar' : 'desplegar'} size="md" color={c.textMuted} />
            </Pressable>

            {showItems ? (
              <Animated.View
                entering={FadeIn.duration(160)}
                exiting={FadeOut.duration(120)}
                layout={Layout.springify().damping(18)}
                style={[styles.summaryBody, { borderTopColor: c.border }]}
              >
                {items.map((item) => (
                  <View key={item.lineId} style={styles.line}>
                    <View style={[styles.lineQty, { backgroundColor: c.surfaceLight }]}>
                      <Text v="captionStrong" tone="textSecondary">{item.quantity}</Text>
                    </View>
                    <View style={styles.flex}>
                      <Text v="strongS" numberOfLines={1}>{item.productName}</Text>
                      {item.selectedExtras.length > 0 ? (
                        <Text v="caption" tone="textMuted" numberOfLines={2}>
                          {item.selectedExtras
                            .map((e) => (e.quantity > 1 ? `${e.name} x${e.quantity}` : e.name))
                            .join(' · ')}
                        </Text>
                      ) : null}
                      {item.notes ? (
                        <Text v="caption" tone="textMuted" numberOfLines={1}>“{item.notes}”</Text>
                      ) : null}
                    </View>
                    <Text v="dataS" tone="textSecondary">{money(getLineTotal(item))}</Text>
                  </View>
                ))}

                <Button
                  title="Editar la bolsa"
                  icon="editar"
                  variant="ghost"
                  size="sm"
                  onPress={() => router.push('/(client)/cart')}
                />
              </Animated.View>
            ) : null}
          </Card>

          {/* ── Dirección ── */}
          <View style={styles.section}>
            <Text v="label" tone="textMuted">Entregar en</Text>
            <Card
              onPress={() => { tap('light'); setAddressSheet(true); }}
              tone={address && deliverable ? 'flat' : 'accent'}
              style={styles.picker}
              accessibilityLabel={
                address
                  ? `Entregar en ${address.label}, ${address.address}`
                  : 'Elegir dirección de entrega'
              }
              accessibilityHint="Abre la lista de tus direcciones"
            >
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
                  <>
                    <Text v="strongM">Elige dónde te lo dejamos</Text>
                    <Text v="bodyS" tone="textSecondary">
                      El envío se calcula con la distancia real.
                    </Text>
                  </>
                )}
              </View>
              <Icon name="siguiente" size="md" color={c.textMuted} />
            </Card>

            {address && !deliverable ? (
              <Notice tone="warning">
                Esta dirección no tiene punto en el mapa, así que no podemos calcular el
                envío. Agrégala de nuevo y marca dónde queda: con el GPS o arrastrando el mapa.
              </Notice>
            ) : null}
          </View>

          {/* ── Pago ── */}
          <View
            style={styles.section}
            onLayout={(e) => { paymentY.current = e.nativeEvent.layout.y; }}
          >
            <Text v="label" tone="textMuted">Cómo pagas</Text>
            <View style={styles.payments} accessibilityRole="radiogroup">
              {methods?.cashOnDelivery ? (
                <PaymentOption
                  active={payment === 'cash_on_delivery'}
                  icon="efectivo"
                  title="Efectivo"
                  subtitle={cashMax > 0 ? `Hasta ${money(cashMax)}` : 'Le pagas al domiciliario'}
                  onPress={() => { tap('select'); setPayment('cash_on_delivery'); }}
                />
              ) : null}
              {methods?.online ? (
                <PaymentOption
                  active={payment === 'online'}
                  icon="tarjeta"
                  title="Pago digital"
                  subtitle="Se cobra desde la app"
                  onPress={() => { tap('select'); setPayment('online'); }}
                />
              ) : null}
            </View>

            {highlightPayment && !payment ? (
              <Notice tone="warning" icon="tarjeta">
                Elige cómo vas a pagar para confirmar el pedido.
              </Notice>
            ) : null}

            {/* El tope del efectivo lo define el servidor. Antes se ignoraba
                aquí y el rechazo llegaba al crear el pedido, cuando el
                cliente ya daba el pago por hecho. */}
            {cashOverLimit ? (
              <Notice tone="warning">
                En efectivo aceptamos hasta {money(cashMax)} por pedido, y este va en{' '}
                {money(quote!.total)}.
              </Notice>
            ) : null}

            {noMethods ? (
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

          {/* ── Propina ──
              El monto en pesos va en la etiqueta: "10%" no dice nada hasta que
              se traduce a plata, y traducirla es decisión del que paga. */}
          <View style={styles.section}>
            <Text v="label" tone="textMuted">Propina al domiciliario</Text>
            <View style={styles.tips}>
              {TIPS.map((rate) => (
                <Chip
                  key={rate}
                  label={
                    rate === 0
                      ? 'Sin propina'
                      : `${Math.round(rate * 100)}% · ${money(Math.round(subtotal * rate))}`
                  }
                  active={tipRate === rate}
                  onPress={() => { tap('select'); setTipRate(rate); }}
                />
              ))}
            </View>
            {tipAmount > 0 ? (
              <Text v="bodyS" tone="successText">
                {money(tipAmount)} van completos para quien te lo lleva.
              </Text>
            ) : null}
          </View>

          {/* ── Indicaciones ── */}
          <View style={styles.section}>
            <View style={styles.notesHead}>
              <Text v="label" tone="textMuted">Algo que deba saber</Text>
              {notes.length > 0 ? (
                <Text v="caption" tone="textMuted">{notes.length}/{MAX_NOTES}</Text>
              ) : null}
            </View>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder="Tocar el timbre, dejar en portería, llamar al llegar…"
              placeholderTextColor={c.textMuted}
              maxLength={MAX_NOTES}
              multiline
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

            {quote?.coupon?.totalDiscount ? (
              <Text v="strongS" tone="successText">
                Ahorras {money(quote.coupon.totalDiscount)} con {quote.coupon.code}.
              </Text>
            ) : null}
            {quote?.coupon ? (
              <Text v="caption" tone="textMuted">
                Condiciones: {quote.coupon.title}. Aplicación y vigencia verificadas por Zipp.
              </Text>
            ) : null}

            {missingForMin > 0 ? (
              <Notice tone="warning">
                Este negocio pide mínimo {money(quote!.minOrder)}. Te faltan{' '}
                {money(missingForMin)}.
              </Notice>
            ) : null}
          </Card>

          {quoteMessage && deliverable ? <Notice tone="error">{quoteMessage}</Notice> : null}
          {submitError ? <Notice tone="error">{submitError}</Notice> : null}
        </ScrollView>

        <ScreenFooter style={styles.footer}>
          {/* Una línea sola: o lo que falta, o qué va a pasar al confirmar.
              El total vive en el botón, así que repetirlo aquí sería ruido. */}
          <Text
            v="bodyS"
            tone={blocker ? 'warningText' : 'textSecondary'}
            numberOfLines={2}
            center
          >
            {blocker
              ? blocker.hint
              : payment === 'cash_on_delivery'
              ? 'Pagas en efectivo al recibir el pedido.'
              : 'El cobro se hace desde la app en el siguiente paso.'}

          </Text>

          <Button
            title={blocker ? blocker.label : 'Confirmar pedido'}
            icon={blocker?.icon}
            trailing={!blocker && quote ? money(quote.total) : undefined}
            variant={blocker ? 'secondary' : 'primary'}
            size="lg"
            full
            loading={busy || awaitingFirstQuote}
            onPress={blocker ? blocker.onPress : placeOrder}
            haptic={blocker ? 'light' : 'medium'}
            accessibilityHint={
              blocker
                ? blocker.hint
                : payment === 'cash_on_delivery'
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
      {/* El check ocupa un hueco reservado: sin él, elegir un método
          desplazaría el texto de las dos tarjetas medio pixel. */}
      <View style={styles.paymentCheck}>
        {active ? <Icon name="checkCirculo" size="sm" color={c.primaryText} /> : null}
      </View>
      <ContentIcon name={icon} size={32} />
      <Text v="strongS" tone={active ? 'text' : 'textSecondary'}>{title}</Text>
      <Text v="caption" tone="textMuted" center>{subtitle}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: Spacing.xl, gap: Spacing.xxl, paddingBottom: Spacing.huge },
  section: { gap: Spacing.sm },
  pressed: { opacity: 0.7 },

  summaryHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.lg,
  },
  summaryIcon: {
    width: 40, height: 40, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  summaryBody: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.md,
    paddingTop: Spacing.md,
    gap: Spacing.md,
  },
  line: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  lineQty: {
    minWidth: 24, height: 24, paddingHorizontal: 6,
    borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center',
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
    paddingBottom: Spacing.lg,
    paddingHorizontal: Spacing.sm,
    borderRadius: BorderRadius.lg,
  },
  paymentCheck: { height: 20, justifyContent: 'center', marginTop: Spacing.sm },

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

  notesHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  notes: {
    minHeight: 76,
    maxHeight: 130,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    textAlignVertical: 'top',
  },

  breakdown: { gap: Spacing.md },
  pendingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  divider: { height: StyleSheet.hairlineWidth },
  totalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

  footer: { gap: Spacing.md },
});
