import { useState, useEffect, useMemo, useRef } from 'react';
import {
  View, ScrollView, Pressable, StyleSheet, TextInput,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import * as Linking from 'expo-linking';
import Animated, { FadeIn, FadeOut, Layout } from 'react-native-reanimated';
import {
  Text, Icon, Button, Chip, DetailRow, Notice, Screen, ScreenFooter, Header,
  Skeleton, EmptyState, Input,
} from '../../components/ui';
import { AddressSheet, hasCoordinates, type Address } from '../../components/domain/AddressPicker';
import { PaymentMethodSheet } from '../../components/domain/PaymentMethodSheet';
import { useCartStore } from '../../stores/cartStore';
import { usePrefsStore } from '../../stores/prefsStore';
import { usePendingPaymentStore } from '../../stores/pendingPaymentStore';
import {
  isExpiredSelection,
  acceptsInstallments,
  installmentsOf,
  withInstallments,
  INSTALLMENT_OPTIONS,
  type SelectedInstrument,
} from '../../lib/paymentInstrument';
import {
  useAddresses, useOrderQuote, useCreateOrder, usePaymentMethods, usePayOrder, useBusiness,
  useLoyalty, useMyCoupons, useRedeemPoints,
} from '../../hooks/useApi';
import { planRedemption } from '../../lib/loyalty';
import { scheduleDays, slotLabel, type ScheduleDay } from '../../lib/schedule';
import type { DaySchedule } from '../../lib/business';
import { useTheme } from '../../hooks/useTheme';
import { ContentIcon } from '../../components/illustrations';
import type { IconName } from '../../theme/icons';
import { Type } from '../../theme/typography';
import { BorderRadius, Spacing, Motion } from '../../theme/tokens';
import { money, km, groupThousands } from '../../lib/format';
import { describeExtras } from '../../lib/modifiers';
import { apiMessage } from '../../lib/errors';
import { tipFromParam } from '../../lib/tip';
import { tap } from '../../lib/haptics';

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

  // Cada negocio tiene su propia bolsa. Se llega aquí siempre con el
  // `businessId` en la URL (lo manda la pantalla de la bolsa); sin él, y con
  // una sola bolsa abierta, esa es la que se confirma.
  const { businessId: paramBusinessId, tip: tipParam } = useLocalSearchParams<{
    businessId?: string;
    tip?: string;
  }>();
  const carts = useCartStore((s) => s.carts);
  const businessId = paramBusinessId ?? (carts.length === 1 ? carts[0].businessId : undefined);
  const cart = businessId ? carts.find((entry) => entry.businessId === businessId) : undefined;

  const items = cart?.items ?? [];
  const businessName = cart?.businessName ?? null;
  const businessLogo = cart?.businessLogo ?? null;
  const itemCount = items.reduce((sum, i) => sum + i.quantity, 0);
  const subtotal = useCartStore((s) => (businessId ? s.getSubtotal(businessId) : 0));
  const getLineTotal = useCartStore((s) => s.getLineTotal);
  const clearCart = useCartStore((s) => s.clearCart);

  // El pedido mínimo se pregunta al negocio, no al presupuesto: cuando el
  // carrito no llega, el servidor rechaza la cotización con un 400 en vez de
  // devolver cifras, así que esperar al quote para saberlo es esperar a algo
  // que nunca llega. Viene cacheado de la ficha del negocio.
  const { data: business } = useBusiness(businessId ?? '') as {
    data?: { minOrder?: number; schedule?: Record<string, DaySchedule> };
  };
  const minOrder = business?.minOrder ?? 0;

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
  /**
   * Con qué se paga en línea, cuando se cobra dentro de la app. `null`
   * hasta que la persona lo elige en la hoja; con el Web Checkout de antes
   * no se usa.
   */
  const [instrument, setInstrument] = useState<SelectedInstrument | null>(null);
  const [methodSheet, setMethodSheet] = useState(false);
  const putPendingPayment = usePendingPaymentStore((s) => s.put);

  // ── Cambio en efectivo ──
  //
  // Como en Rappi: en efectivo hay que decir si se paga con el valor exacto
  // o si hace falta vuelto, y de qué billete. Sin esto el domiciliario se
  // enteraba de que faltaba cambio parado en la puerta, con el cliente
  // delante. `null` es "todavía no ha dicho" — no se asume "exacto" por
  // defecto, porque eso es justo lo que el domiciliario no puede dar por
  // hecho.
  const [needsChange, setNeedsChange] = useState<boolean | null>(null);
  const [payingWithDigits, setPayingWithDigits] = useState('');

  // La propina se decidió en su propia pantalla y llega por la URL; aquí solo
  // se muestra en el resumen. Sin parámetro (o con uno ilegible) es cero.
  const tipAmount = tipFromParam(tipParam);
  const [notes, setNotes] = useState('');

  const [showItems, setShowItems] = useState(false);

  const [couponInput, setCouponInput] = useState('');
  const [appliedCode, setAppliedCode] = useState<string | null>(null);
  const [couponError, setCouponError] = useState('');

  const { data: loyalty } = useLoyalty();
  const { data: myCoupons = [] } = useMyCoupons();
  const redeemPoints = useRedeemPoints();

  const applyCode = (code: string) => {
    tap('light');
    setCouponError('');
    setCouponInput('');
    setAppliedCode(code);
  };

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

  // ── Para otra persona ──
  //
  // Sin esto, mandarle almuerzo a alguien significaba que el domiciliario
  // llamara al número de quien pagó, que podía estar en otra ciudad, y el
  // pedido se quedaba en la puerta.
  const [forOther, setForOther] = useState(false);
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [recipientNote, setRecipientNote] = useState('');

  /**
   * Hora de entrega, o null para "cuanto antes".
   *
   * El servidor exige media hora de margen y valida contra su propio reloj:
   * un teléfono con la hora mal puesta podría programar algo que ya pasó.
   */
  const [scheduledFor, setScheduledFor] = useState<Date | null>(null);
  const payOrder = usePayOrder();

  // Día y franja en vez de tres horas fijas, y solo las horas en que el
  // negocio atiende: antes se podía programar para cuando estaba cerrado.
  const scheduleOptions = useMemo(() => scheduleDays(business?.schedule), [business?.schedule]);
  const [scheduleDayKey, setScheduleDayKey] = useState<string | null>(null);
  const scheduleDay = scheduledFor
    ? scheduleOptions.find((day) => day.key === scheduleDayKey) ?? null
    : null;

  const pickScheduleDay = (day: ScheduleDay) => {
    tap('select');
    setScheduleDayKey(day.key);
    setScheduledFor(day.slots[0]);
  };

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

  // La decisión de cambio es propia de efectivo: si el cliente se pasa a
  // pago digital, no debe arrastrarla en silencio hasta que vuelva a elegir
  // efectivo, ni bloquear la confirmación con una pregunta que ya no aplica.
  useEffect(() => {
    if (payment !== 'cash_on_delivery') {
      setNeedsChange(null);
      setPayingWithDigits('');
    }
  }, [payment]);

  const payingWithAmount = payingWithDigits ? Number(payingWithDigits) : 0;

  const address = addresses.find((a) => a._id === addressId);
  const destination = address?.location?.coordinates;
  const deliverable = hasCoordinates(address);

  const orderItems = useMemo(
    () =>
      items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        // Solo identificadores y cantidades: los precios los pone el
        // servidor. Una opción de grupo viaja por sus ids; un extra plano,
        // por su nombre.
        selectedExtras: item.selectedExtras.map((e) => ({
          name: e.name,
          quantity: e.quantity || 1,
          ...(e.optionId ? { groupId: e.groupId, optionId: e.optionId } : {}),
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

  // El envío que regala el negocio al superar su umbral. El servidor ya lo
  // descontó del total y lo manda aparte (`deliveryPayable`); sin esta línea,
  // el desglose enseña el envío bruto y no cuadra con lo que se va a cobrar.
  const freeDeliverySaved = quote?.freeDeliveryApplied
    ? quote.deliveryFee - (quote.coupon?.deliveryDiscount ?? 0) - quote.deliveryPayable
    : 0;

  const loyaltyBalance = loyalty?.balance ?? 0;
  const redeemPlan = planRedemption({
    balance: loyaltyBalance,
    minRedeem: loyalty?.minRedeem ?? 0,
    maxPerOrder: loyalty?.maxPerOrder ?? 0,
    subtotal: quote?.subtotal ?? subtotal,
  });

  // Los de puntos valen en cualquier negocio; uno atado a otro negocio aquí
  // solo produciría un error al cotizar.
  const ownCoupons = myCoupons.filter((own) => !own.businessId || own.businessId === businessId);

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
  /** El backend puede cobrar sin salir de la app (si no, Web Checkout). */
  const nativeCheckout = !!methods?.online && !!methods?.inApp?.native;
  const inAppCapabilities = {
    pse: !!methods?.inApp?.pse,
    savedCards: !!methods?.inApp?.savedCards,
  };
  const instrumentExpired = !!instrument && isExpiredSelection(instrument);
  const needsInstrument =
    payment === 'online' && nativeCheckout && (!instrument || instrumentExpired);
  const cashOverLimit =
    payment === 'cash_on_delivery' && cashMax > 0 && !!quote && quote.total > cashMax;
  const missingForMin = minOrder > 0 && subtotal < minOrder ? minOrder - subtotal : 0;

  // Falta decidir si paga exacto o con vuelto.
  const cashChangeUndecided = payment === 'cash_on_delivery' && needsChange === null;
  // Dijo que necesita vuelto pero el billete no alcanza a cubrir el total
  // (o todavía no escribió ninguno). El servidor aplica la misma regla al
  // crear el pedido; se repite aquí para no gastar el intento en un
  // rechazo que el cliente no sabe traducir.
  const cashChangeInvalid =
    payment === 'cash_on_delivery' &&
    needsChange === true &&
    !!quote &&
    (payingWithAmount <= 0 || payingWithAmount <= quote.total);
  const cashChangeAmount =
    payment === 'cash_on_delivery' && needsChange === true && !!quote && payingWithAmount > quote.total
      ? payingWithAmount - quote.total
      : 0;

  const blocker: Blocker | null = missingForMin > 0
    ? {
        // Va el primero de la cadena: es lo único que se sabe sin preguntarle
        // nada al servidor, y mandar a alguien a elegir dirección y método de
        // pago para un pedido que el negocio no va a aceptar es hacerle
        // perder el viaje entero.
        label: `Agregar ${money(missingForMin)} más`,
        icon: 'mas',
        hint: `Este negocio pide mínimo ${money(minOrder)}.`,
        onPress: () => {
          if (businessId) router.push(`/(client)/business/${businessId}`);
          else router.replace('/(client)/(tabs)/home');
        },
      }
    : !address
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
    : needsInstrument
    ? {
        // Pago digital elegido, pero falta con qué: el botón abre la hoja
        // en vez de apagarse.
        label: 'Elegir tarjeta, Nequi o PSE',
        icon: 'tarjeta',
        hint: instrumentExpired
          ? 'Por seguridad, vuelve a ingresar la tarjeta.'
          : 'Falta elegir con qué pagas.',
        onPress: () => setMethodSheet(true),
      }
    : cashChangeUndecided
    ? {
        label: 'Decir si necesitas cambio',
        icon: 'efectivo',
        hint: 'Falta decir si pagas con el valor exacto o necesitas vuelto.',
        onPress: () => scrollToPayment(),
      }
    : cashChangeInvalid
    ? {
        label: 'Revisar el billete',
        icon: 'efectivo',
        hint: quote
          ? `El billete debe ser mayor al total (${money(quote.total)}).`
          : 'Escribe con cuánto vas a pagar.',
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
          onPress: () => router.push({ pathname: '/(client)/cart', params: { businessId } }),
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

    // Un token de tarjeta caduca. Si la selección envejeció mientras la
    // pantalla seguía abierta, se pide otra vez antes de crear nada.
    if (payment === 'online' && nativeCheckout && (!instrument || isExpiredSelection(instrument))) {
      setInstrument(null);
      setMethodSheet(true);
      return;
    }

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
        cashPayment:
          payment === 'cash_on_delivery'
            ? { needsChange: !!needsChange, payingWith: needsChange ? payingWithAmount : undefined }
            : undefined,
        // Solo viajan si el usuario los eligió. Mandar un destinatario
        // vacío haría que el domiciliario llamara a un número en blanco.
        recipient: forOther && recipientName.trim() && recipientPhone.trim()
          ? {
              name: recipientName.trim(),
              phone: recipientPhone.trim(),
              note: recipientNote.trim() || undefined,
            }
          : undefined,
        scheduledFor: scheduledFor ? scheduledFor.toISOString() : undefined,
        idempotencyKey,
      },
      {
        onSuccess: async (order: any) => {
          setLastAddress(address._id);
          clearCart(businessId);

          // El pedido existe, pero en digital todavía no está pagado: se
          // inicia el cobro aquí. Si la pasarela falla, el pedido queda
          // pendiente de pago en vez de darse por cobrado —
          // exactamente lo que antes se asumía sin cobrar nada.
          if (payment === 'online' && nativeCheckout && instrument) {
            // El cobro lo hace la pantalla de pago, que es la que sabe
            // esperar, abrir el banco y ofrecer otro método si falla. El
            // método viaja en memoria, nunca en los parámetros de la ruta.
            putPendingPayment(order._id, instrument);
            // Una tarjeta nueva es de un solo uso: no se queda a mano.
            setInstrument(null);
            setSubmitting(false);
            router.replace({
              pathname: '/(client)/payment-result',
              params: { id: order._id, code: order.orderNumber ?? '', mode: 'native' },
            });
            return;
          }

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
              // Sin enlace de pago solo es un éxito si el cobro ya quedó
              // aprobado (el sandbox de desarrollo con aprobación
              // automática). Cualquier otra cosa es un pedido sin cobrar, y
              // mandarlo a "pedido confirmado" era mentirle a la persona.
              if (intent?.status !== 'approved') {
                setSubmitting(false);
                setSubmitError(
                  'Creamos tu pedido, pero no pudimos iniciar el cobro. Puedes pagarlo desde Mis pedidos.'
                );
                tap('error');
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
          {/* ── Dirección ── */}
          <View style={styles.section}>
            <Text v="titleS">Entregar en</Text>
            <Pressable
              onPress={() => { tap('light'); setAddressSheet(true); }}
              accessibilityRole="button"
              style={({ pressed }) => [styles.picker, pressed && styles.pressed]}
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
            </Pressable>

            {address && !deliverable ? (
              <Notice tone="warning">
                Esta dirección no tiene punto en el mapa, así que no podemos calcular el
                envío. Agrégala de nuevo y marca dónde queda: con el GPS o arrastrando el mapa.
              </Notice>
            ) : null}
          </View>

          <View style={[styles.rule, { backgroundColor: c.border }]} />

          {/* ── Cuándo llega ──
              Hasta ahora el checkout no decía ningún tiempo: se pagaba sin
              saber cuándo llegaba la comida. Va justo bajo la dirección,
              arriba de todo — es lo que más pesa en la decisión, así que
              se ve antes que el pago y el total. */}
          <View style={styles.eta}>
            <View style={styles.etaIcon}>
              <Icon name="minutos" size="md" color={c.primaryText} />
            </View>
            <View style={styles.flex}>
              <Text v="label">
                {scheduledFor ? 'Programado para' : 'Llega en'}
              </Text>
              {quote ? (
                <Text v="titleM">
                  {scheduledFor
                    ? `${scheduleDay?.label ?? ''} · ${slotLabel(scheduledFor)}`
                    : `${quote.etaMinutesMin}–${quote.etaMinutesMax} min`}
                </Text>
              ) : quoting ? (
                <Skeleton width={96} height={18} />
              ) : (
                <Text v="titleS" tone="textMuted">—</Text>
              )}
            </View>
          </View>

          <View style={[styles.rule, { backgroundColor: c.border }]} />

          {/* ── Para quién y para cuándo ── */}
          <View style={styles.section}>
            <Text v="titleS">Para quién y cuándo</Text>

            <View style={styles.optionsCard}>
              <Pressable
                onPress={() => { tap('select'); setForOther((v) => !v); }}
                style={styles.optionRow}
                accessibilityRole="switch"
                accessibilityState={{ checked: forOther }}
                accessibilityLabel="El pedido es para otra persona"
              >
                <View style={styles.flex}>
                  <Text v="strongS">Es para otra persona</Text>
                  <Text v="caption" tone="textMuted">
                    Llamaremos a quien lo recibe, no a ti
                  </Text>
                </View>
                <Icon
                  name={forOther ? 'checkCirculo' : 'mas'}
                  size="md"
                  color={forOther ? c.lime : c.textMuted}
                />
              </Pressable>

              {forOther ? (
                <Animated.View entering={FadeIn.duration(Motion.fast)} style={styles.optionBody}>
                  <Input
                    value={recipientName}
                    onChangeText={setRecipientName}
                    placeholder="¿Quién lo recibe?"
                    maxLength={80}
                  />
                  <Input
                    value={recipientPhone}
                    onChangeText={setRecipientPhone}
                    placeholder="Su teléfono"
                    keyboardType="phone-pad"
                    maxLength={20}
                  />
                  <Input
                    value={recipientNote}
                    onChangeText={setRecipientNote}
                    placeholder="Algo que deba saber (opcional)"
                    maxLength={200}
                  />
                </Animated.View>
              ) : null}
            </View>

            <View style={styles.optionsCard}>
              <View style={styles.optionRow}>
                <View style={styles.flex}>
                  <Text v="strongS">
                    {scheduledFor ? 'Programado' : 'Lo antes posible'}
                  </Text>
                  <Text v="caption" tone="textMuted">
                    {scheduledFor
                      ? `${scheduleDay?.label ?? ''} · ${slotLabel(scheduledFor)}`
                      : 'Sale en cuanto el negocio lo prepare'}
                  </Text>
                </View>
              </View>

              {/* Chips y no un calendario: casi todo lo que se programa es
                  para hoy o mañana, y elegir eso con un selector de fecha
                  cuesta cinco toques. */}
              <View style={styles.slots}>
                <Chip
                  label="Ahora"
                  bare
                  active={!scheduledFor}
                  onPress={() => {
                    tap('select');
                    setScheduledFor(null);
                    setScheduleDayKey(null);
                  }}
                />
                {scheduleOptions.length > 0 ? (
                  <Chip
                    label="Programar"
                    bare
                    active={!!scheduledFor}
                    onPress={() => { if (!scheduledFor) pickScheduleDay(scheduleOptions[0]); }}
                  />
                ) : null}
              </View>

              {scheduleDay ? (
                <Animated.View entering={FadeIn.duration(Motion.fast)} style={styles.optionBody}>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.slotRow}
                  >
                    {scheduleOptions.map((day) => (
                      <Chip
                        key={day.key}
                        label={day.label}
                        active={day.key === scheduleDay.key}
                        onPress={() => pickScheduleDay(day)}
                      />
                    ))}
                  </ScrollView>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.slotRow}
                  >
                    {scheduleDay.slots.map((slot) => (
                      <Chip
                        key={slot.getTime()}
                        label={slotLabel(slot)}
                        active={scheduledFor?.getTime() === slot.getTime()}
                        onPress={() => { tap('select'); setScheduledFor(slot); }}
                      />
                    ))}
                  </ScrollView>
                </Animated.View>
              ) : null}
            </View>
          </View>

          <View style={[styles.rule, { backgroundColor: c.border }]} />

          {/* ── Pago ── */}
          <View
            style={styles.section}
            onLayout={(e) => { paymentY.current = e.nativeEvent.layout.y; }}
          >
            <Text v="titleS">Cómo pagas</Text>
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
                  subtitle={nativeCheckout ? 'Tarjeta, Nequi o PSE' : 'Se cobra desde la app'}
                  onPress={() => {
                    tap('select');
                    setPayment('online');
                    // Elegir "digital" sin decir con qué deja el pedido a
                    // medias: se abre la hoja en el mismo gesto.
                    if (nativeCheckout && !instrument) setMethodSheet(true);
                  }}
                />
              ) : null}
            </View>

            {/* ── Con qué se paga en línea ──
                La tarjeta, el Nequi o el banco elegido, con un toque para
                cambiarlo. Es lo que hace que el segundo pedido se sienta de
                un toque: la tarjeta guardada aparece aquí sola. */}
            {payment === 'online' && nativeCheckout ? (
              <Animated.View entering={FadeIn.duration(Motion.fast)}>
                <Pressable
                  onPress={() => { tap('light'); setMethodSheet(true); }}
                  accessibilityRole="button"
                  accessibilityLabel={
                    instrument && !instrumentExpired
                      ? `Pagas con ${instrument.label}. Toca para cambiar`
                      : 'Elegir tarjeta, Nequi o PSE'
                  }
                  style={styles.instrumentRow}
                >
                  <Icon
                    name={instrument && !instrumentExpired ? instrument.icon : 'tarjeta'}
                    size="md"
                    color={instrument && !instrumentExpired ? c.text : c.primaryText}
                  />
                  <View style={styles.instrumentText}>
                    <Text v="strongS">
                      {instrument && !instrumentExpired ? instrument.label : 'Elige con qué pagas'}
                    </Text>
                    <Text v="caption" tone="textMuted" numberOfLines={1}>
                      {instrument && !instrumentExpired
                        ? instrument.detail ?? 'Toca para cambiar'
                        : instrumentExpired
                          ? 'Por seguridad, vuelve a ingresar la tarjeta'
                          : 'Tarjeta, Nequi o PSE, sin salir de Zipp'}
                    </Text>
                  </View>
                  <Text v="caption" tone="primaryText">
                    {instrument && !instrumentExpired ? 'Cambiar' : 'Elegir'}
                  </Text>
                </Pressable>

                {/* ── Cuotas ──
                    Solo con tarjeta. No se puede saber desde aquí si es de
                    crédito o débito (Wompi no lo dice al tokenizar), así que
                    se ofrece siempre y se avisa: en débito el banco lo
                    cobra a una sola cuota. */}
                {instrument && !instrumentExpired && acceptsInstallments(instrument) ? (
                  <View style={styles.installments}>
                    <Text v="label" tone="textMuted">Cuotas</Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.slotRow}
                    >
                      {INSTALLMENT_OPTIONS.map((count) => (
                        <Chip
                          key={count}
                          label={count === 1 ? '1 cuota' : `${count}`}
                          active={installmentsOf(instrument) === count}
                          onPress={() => {
                            tap('select');
                            setInstrument((current) => (current ? withInstallments(current, count) : current));
                          }}
                        />
                      ))}
                    </ScrollView>
                    <Text v="caption" tone="textMuted">
                      {installmentsOf(instrument) > 1
                        ? `${installmentsOf(instrument)} cuotas de unos ${money(Math.ceil((quote?.total ?? 0) / installmentsOf(instrument)))}, más los intereses de tu banco. Solo tarjetas de crédito.`
                        : 'Con tarjeta de crédito puedes diferir el pago; tu banco define los intereses.'}
                    </Text>
                  </View>
                ) : null}
              </Animated.View>
            ) : null}

            {/* ── Cambio en efectivo ──
                Como en Rappi: elegir efectivo no basta, hace falta decir si
                se paga exacto o con un billete que exige vuelto. Es la
                pregunta que antes nadie hacía y que el domiciliario
                terminaba resolviendo parado en la puerta. */}
            {payment === 'cash_on_delivery' ? (
              <Animated.View entering={FadeIn.duration(Motion.fast)} style={styles.cashChangeCard}>
                <Text v="strongS">¿Pagas con el valor exacto?</Text>
                <View style={styles.cashChangeOptions}>
                  <Chip
                    label="Exacto, sin cambio"
                    active={needsChange === false}
                    onPress={() => {
                      tap('select');
                      setNeedsChange(false);
                      setPayingWithDigits('');
                    }}
                  />
                  <Chip
                    label="Necesito cambio"
                    active={needsChange === true}
                    onPress={() => { tap('select'); setNeedsChange(true); }}
                  />
                </View>

                {needsChange ? (
                  <Animated.View entering={FadeIn.duration(Motion.fast)} style={styles.cashChangeInput}>
                    <Input
                      label="¿Con qué billete pagas?"
                      prefix="$"
                      numeric
                      keyboardType="number-pad"
                      placeholder="50.000"
                      value={payingWithDigits ? groupThousands(payingWithAmount) : ''}
                      onChangeText={(t) => setPayingWithDigits(t.replace(/\D/g, '').slice(0, 7))}
                      error={
                        payingWithDigits && cashChangeInvalid && quote
                          ? `Debe ser mayor al total (${money(quote.total)})`
                          : undefined
                      }
                    />
                    {cashChangeAmount > 0 ? (
                      <Text v="bodyS" tone="successText">
                        Te llevamos {money(cashChangeAmount)} de vuelto.
                      </Text>
                    ) : null}
                  </Animated.View>
                ) : null}
              </Animated.View>
            ) : null}

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

          <View style={[styles.rule, { backgroundColor: c.border }]} />

          {/* ── Qué estás confirmando ──
              La pantalla se llama "Confirmar pedido" y hasta ahora no mostraba
              un solo producto. Va cerrada porque el usuario acaba de verlos en
              la bolsa; abrirla cuesta un toque y despeja la duda de siempre. */}
          <View>
            <Text v="titleS">Resumen del pedido</Text>
            <Pressable
              onPress={() => { tap('light'); setShowItems((v) => !v); }}
              accessibilityRole="button"
              accessibilityState={{ expanded: showItems }}
              accessibilityLabel={`${itemCount} ${itemCount === 1 ? 'producto' : 'productos'} de ${businessName ?? 'el negocio'}. ${showItems ? 'Ocultar' : 'Ver'} el detalle`}
              style={({ pressed }) => [styles.summaryHead, pressed && styles.pressed]}
            >
              {businessLogo ? (
                <Image
                  source={{ uri: businessLogo }}
                  style={styles.summaryIcon}
                  contentFit="cover"
                  transition={150}
                />
              ) : (
                <View style={[styles.summaryIcon, { backgroundColor: c.primarySoft }]}>
                  <Icon name="bolsa" size="md" color={c.primaryText} />
                </View>
              )}
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
                style={styles.summaryBody}
              >
                {items.map((item) => (
                  <View key={item.lineId} style={styles.line}>
                    <View style={styles.lineImageWrap}>
                      {item.image ? (
                        <Image
                          source={{ uri: item.image }}
                          style={[styles.lineImage, { backgroundColor: c.surfaceLight }]}
                          contentFit="cover"
                          transition={150}
                        />
                      ) : (
                        <View style={[styles.lineImage, styles.lineImageFallback, { backgroundColor: c.surfaceLight }]}>
                          <Icon name="bolsa" size="sm" color={c.textMuted} />
                        </View>
                      )}
                      <View style={[styles.lineQty, { backgroundColor: c.textSecondary }]}>
                        <Text v="captionStrong" color={c.surface}>{item.quantity}</Text>
                      </View>
                    </View>
                    <View style={styles.flex}>
                      <Text v="strongS" numberOfLines={1}>{item.productName}</Text>
                      {item.selectedExtras.length > 0 ? (
                        <Text v="caption" tone="textMuted" numberOfLines={2}>
                          {describeExtras(item.selectedExtras)}
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
                  onPress={() => router.push({ pathname: '/(client)/cart', params: { businessId } })}
                />
              </Animated.View>
            ) : null}
          </View>

          <View style={[styles.rule, { backgroundColor: c.border }]} />

          {/* ── Descuentos: puntos, cupones propios y código ──
              Un pedido admite un solo descuento (el servidor guarda un solo
              cupón por pedido), y los puntos se canjean como cupón. Por eso
              viven juntos: son tres formas de ocupar el mismo hueco. */}
          <View style={styles.section}>
            <Text v="titleS">Descuentos</Text>

            {quote?.coupon ? (
              <View style={styles.couponApplied}>
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
              </View>
            ) : (
              <>
                {/* Primero lo que ya es del cliente: un cupón de un canje que
                    no llegó a usarse vale lo mismo que canjear de nuevo, y no
                    gasta más puntos. */}
                {ownCoupons.length > 0 ? (
                  <View style={styles.ownCoupons}>
                    {ownCoupons.map((own) => (
                      <Chip
                        key={own._id}
                        label={`${own.title} · ${money(own.value)}`}
                        active={false}
                        onPress={() => applyCode(own.code)}
                      />
                    ))}
                  </View>
                ) : null}

                {redeemPlan.kind === 'redeem' ? (
                  <View style={styles.pointsCard}>
                    <View style={styles.flex}>
                      <Text v="strongS">Tienes {groupThousands(loyaltyBalance)} puntos</Text>
                      <Text v="caption" tone="textMuted">
                        {redeemPlan.points < loyaltyBalance
                          ? `Usas ${groupThousands(redeemPlan.points)} aquí y te quedan ${groupThousands(loyaltyBalance - redeemPlan.points)} para otro pedido.`
                          : 'Cada punto vale un peso.'}
                      </Text>
                    </View>
                    <Button
                      title={`Usar ${money(redeemPlan.points)}`}
                      variant="secondary"
                      size="sm"
                      loading={redeemPoints.isPending}
                      onPress={() => {
                        tap('light');
                        setCouponError('');
                        redeemPoints.mutate(redeemPlan.points, {
                          onSuccess: ({ coupon }) => applyCode(coupon.code),
                          onError: (error) => {
                            setCouponError(apiMessage(error, 'No pudimos canjear tus puntos.'));
                            tap('error');
                          },
                        });
                      }}
                    />
                  </View>
                ) : redeemPlan.kind === 'below-minimum' ? (
                  <Text v="caption" tone="textMuted">
                    Tienes {groupThousands(loyaltyBalance)} puntos. Te faltan{' '}
                    {groupThousands(redeemPlan.missing)} para poder usarlos.
                  </Text>
                ) : redeemPlan.kind === 'order-too-small' ? (
                  <Text v="caption" tone="textMuted">
                    Tus puntos se usan desde {money(redeemPlan.minRedeem)} y este pedido no
                    alcanza a absorberlos.
                  </Text>
                ) : null}

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
                {redeemPlan.kind === 'redeem' || ownCoupons.length > 0 ? (
                  <Text v="caption" tone="textMuted">
                    Un pedido admite un solo descuento: puntos o cupón.
                  </Text>
                ) : null}
              </>
            )}
          </View>

          <View style={[styles.rule, { backgroundColor: c.border }]} />

          {/* ── Indicaciones ── */}
          <View style={styles.section}>
            <View style={styles.notesHead}>
              <Text v="titleS">Algo que deba saber</Text>
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

          <View style={[styles.rule, { backgroundColor: c.border }]} />

          {/* ── Desglose del servidor ── */}
          <View style={styles.breakdown}>
            <Text v="titleS">El detalle</Text>

            <DetailRow label="Productos" value={money(quote?.subtotal ?? subtotal)} />

            {!quote ? (
              <View style={styles.pendingRow}>
                <Text v="bodyM" tone="textSecondary">Envío</Text>
                {quoting ? <Skeleton width={64} height={16} /> : <Text v="dataM" tone="textMuted">—</Text>}
              </View>
            ) : (
              <>
                <DetailRow
                  label={quote.deliveryDistanceKm ? `Envío · ${km(quote.deliveryDistanceKm)}` : 'Envío'}
                  value={money(quote.deliveryFee)}
                />
                {quote.coupon?.deliveryDiscount ? (
                  <DetailRow
                    label="Descuento de envío"
                    value={`−${money(quote.coupon.deliveryDiscount)}`}
                    tone="successText"
                  />
                ) : null}
                {freeDeliverySaved > 0 ? (
                  <DetailRow
                    label="Envío gratis"
                    value={`−${money(freeDeliverySaved)}`}
                    tone="successText"
                  />
                ) : null}
              </>
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
                Este negocio pide mínimo {money(minOrder)}. Te faltan{' '}
                {money(missingForMin)}.
              </Notice>
            ) : null}
          </View>

          {/* Por debajo del mínimo el servidor rechaza la cotización con ese
              mismo motivo; el aviso de arriba ya lo dice mejor y con el
              faltante exacto, así que aquí sobra repetirlo. */}
          {quoteMessage && deliverable && missingForMin === 0 ? (
            <Notice tone="error">{quoteMessage}</Notice>
          ) : null}
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
              ? cashChangeAmount > 0
                ? `Pagas en efectivo al recibir: pides ${money(cashChangeAmount)} de vuelto.`
                : 'Pagas en efectivo al recibir, con el valor exacto.'
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
      <PaymentMethodSheet
        visible={methodSheet}
        onClose={() => setMethodSheet(false)}
        capabilities={inAppCapabilities}
        onSelect={(next) => {
          setInstrument(next);
          setPayment('online');
        }}
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
      style={styles.payment}
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
  eta: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  etaIcon: {
    width: 40, height: 40, borderRadius: BorderRadius.full,
    alignItems: 'center', justifyContent: 'center',
  },
  optionsCard: { gap: Spacing.md },
  optionRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  optionBody: { gap: Spacing.sm },
  slots: { flexDirection: 'row', gap: Spacing.sm, flexWrap: 'wrap' },
  slotRow: { flexDirection: 'row', gap: Spacing.sm, paddingRight: Spacing.md },

  flex: { flex: 1 },
  content: { padding: Spacing.xl, gap: Spacing.xl, paddingBottom: Spacing.huge },
  rule: { height: StyleSheet.hairlineWidth },
  section: { gap: Spacing.sm },
  pressed: { opacity: 0.7 },

  summaryHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
  },
  summaryIcon: {
    width: 40, height: 40, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  summaryBody: {
    paddingBottom: Spacing.md,
    gap: Spacing.md,
  },
  line: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  lineImageWrap: { width: 40, height: 40 },
  lineImage: { width: 40, height: 40, borderRadius: BorderRadius.sm },
  lineImageFallback: { alignItems: 'center', justifyContent: 'center' },
  lineQty: {
    position: 'absolute',
    right: -6,
    bottom: -6,
    minWidth: 18, height: 18, paddingHorizontal: 4,
    borderRadius: BorderRadius.full,
    alignItems: 'center', justifyContent: 'center',
  },

  picker: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  pickerIcon: {
    width: 40, height: 40, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center',
  },

  payments: { flexDirection: 'row', gap: Spacing.md },
  instrumentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginTop: Spacing.md,
    paddingVertical: Spacing.md,
    minHeight: 60,
  },
  instrumentText: { flex: 1, gap: 2 },
  installments: { gap: Spacing.sm, marginTop: Spacing.md },
  payment: {
    flex: 1,
    alignItems: 'center',
    gap: Spacing.xs,
    paddingBottom: Spacing.lg,
    paddingHorizontal: Spacing.sm,
  },
  paymentCheck: { height: 20, justifyContent: 'center', marginTop: Spacing.sm },

  cashChangeCard: { gap: Spacing.sm },
  cashChangeOptions: { flexDirection: 'row', gap: Spacing.sm, flexWrap: 'wrap' },
  cashChangeInput: { gap: Spacing.xs },

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
  ownCoupons: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  pointsCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },


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
