import { useMemo, useState } from 'react';
import { View, ScrollView, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { useMutation } from '@tanstack/react-query';
import {
  Text, Icon, Button, Card, Notice, Screen, ScreenFooter, Header, Input,
} from '../../components/ui';
import { ZippMap } from '../../components/domain/ZippMap';
import { AddressSheet, hasCoordinates, type Address } from '../../components/domain/AddressPicker';
import { useAddresses, usePayOrder, usePaymentMethods } from '../../hooks/useApi';
import { errandsApi } from '../../services/endpoints';
import { useTheme } from '../../hooks/useTheme';
import { Spacing, BorderRadius } from '../../theme/tokens';
import { money } from '../../lib/format';
import { apiMessage } from '../../lib/errors';
import { tap } from '../../lib/haptics';

/**
 * Pedir un mandado.
 *
 * Un pedido sin comercio detrás: recoger algo de un sitio cualquiera y
 * llevarlo a otro. La pantalla existe porque el checkout normal no sirve —
 * no hay carta, ni carrito, ni negocio que acepte— pero todo lo de después
 * sí es lo mismo: el mismo reparto, el mismo seguimiento, los mismos
 * códigos de entrega.
 *
 * Lo que de verdad cambia es el dinero. El domiciliario adelanta la compra
 * de su bolsillo, así que el tope no es un campo más del formulario: es lo
 * que una persona real va a poner por ti, y por eso se explica en vez de
 * pedirse a secas.
 */

/** Margen sugerido sobre el estimado, por si el mercado sale más caro. */
const SUGGESTED_MARGIN = 0.25;

/** Lo mínimo para que la descripción sirva de algo en la calle. */
const MIN_DESCRIPTION = 10;

const MAX_COST = 2_000_000;

/** Solo dígitos: un monto no admite puntos, comas ni signos. */
function toAmount(text: string): number {
  const digits = text.replace(/[^\d]/g, '');
  return digits ? Number(digits) : 0;
}

export default function ErrandScreen() {
  const router = useRouter();
  const { c, isDark } = useTheme();
  const payOrder = usePayOrder();
  const { data: methods } = usePaymentMethods();

  const { data: addresses } = useAddresses();
  const [address, setAddress] = useState<Address | null>(null);
  const [pickingAddress, setPickingAddress] = useState(false);

  const [description, setDescription] = useState('');
  const [pickupAddress, setPickupAddress] = useState('');
  const [pickup, setPickup] = useState<{ lat: number; lng: number } | null>(null);
  const [estimatedText, setEstimatedText] = useState('');
  const [maxText, setMaxText] = useState('');
  const [maxEdited, setMaxEdited] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  const estimated = toAmount(estimatedText);
  const max = toAmount(maxText);

  const destination = useMemo(() => {
    const chosen = address ?? (addresses ?? []).find((a: Address) => a.isDefault) ?? null;
    return hasCoordinates(chosen ?? undefined) ? chosen : null;
  }, [address, addresses]);

  /** Dónde abrir el mapa: cerca de su casa, no en el centro del pueblo. */
  const deliveryPoint = useMemo(
    () =>
      destination
        ? {
            lat: destination.location.coordinates[1],
            lng: destination.location.coordinates[0],
          }
        : null,
    [destination]
  );

  const create = useMutation({ mutationFn: errandsApi.create });

  /**
   * Sugerir el tope en cuanto hay estimado.
   *
   * Dejarlo vacío empuja a copiar el estimado, y un tope igual al estimado
   * es el peor de los dos mundos: el domiciliario se queda a medias en la
   * caja por doscientos pesos de diferencia. Se sugiere, no se impone —
   * en cuanto lo tocan a mano, manda lo que escribieron.
   */
  const onEstimatedChange = (text: string) => {
    setEstimatedText(text);
    setError('');
    if (maxEdited) return;
    const value = toAmount(text);
    if (!value) return setMaxText('');
    setMaxText(String(Math.ceil((value * (1 + SUGGESTED_MARGIN)) / 1000) * 1000));
  };

  const validate = (): string | null => {
    if (description.trim().length < MIN_DESCRIPTION) {
      return 'Cuéntanos qué hay que hacer, con detalle suficiente para que otra persona pueda hacerlo.';
    }
    if (pickupAddress.trim().length < 5) return '¿De dónde hay que recogerlo?';
    if (!pickup) return 'Marca en el mapa dónde queda el sitio de recogida.';
    if (!destination) return 'Elige a dónde te lo llevamos.';
    if (estimated <= 0) return '¿Cuánto calculas que va a costar?';
    if (max < estimated) return 'El tope no puede ser menor de lo que calculas que costará.';
    if (max > MAX_COST) return `Por ahora el tope máximo de un mandado es ${money(MAX_COST)}.`;
    return null;
  };

  const submit = () => {
    const problem = validate();
    if (problem) {
      setError(problem);
      tap('error');
      return;
    }

    setError('');
    create.mutate(
      {
        description: description.trim(),
        pickupAddress: pickupAddress.trim(),
        pickupLatitude: pickup!.lat,
        pickupLongitude: pickup!.lng,
        deliveryAddress: destination!.address,
        deliveryLatitude: destination!.location.coordinates[1],
        deliveryLongitude: destination!.location.coordinates[0],
        estimatedCost: estimated,
        maxCost: max,
        notes: notes.trim() || undefined,
      },
      {
        onSuccess: async (order: any) => {
          // Un mandado se paga siempre en línea, y no por comodidad: en
          // efectivo el cliente le pagaría al domiciliario lo que el
          // domiciliario ya adelantó, y nadie podría comprobar cuánto
          // costó de verdad. Además nadie sale a la calle a poner su
          // dinero hasta que el cobro está confirmado.
          if (methods?.inApp?.native) {
            // Cobro dentro de la app: el método se elige en la pantalla de
            // pago, que es la misma que usa el checkout.
            tap('success');
            router.replace({
              pathname: '/(client)/payment-result',
              params: { id: order._id, code: order.orderNumber ?? '', mode: 'native' },
            });
            return;
          }
          try {
            const redirectUrl = Linking.createURL('payment-result');
            const intent = await payOrder.mutateAsync({ orderId: order._id, redirectUrl });
            if (intent?.checkoutUrl) {
              tap('success');
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
              return;
            }
            // Sin enlace solo es éxito si ya quedó aprobado (sandbox con
            // aprobación automática); si no, es un mandado sin cobrar.
            if (intent?.status !== 'approved') {
              setError('Creamos tu mandado, pero no pudimos iniciar el cobro. Puedes pagarlo desde Mis pedidos.');
              tap('error');
              return;
            }
          } catch (err) {
            setError(apiMessage(err, 'Creamos tu mandado, pero no pudimos iniciar el cobro.'));
            tap('error');
            return;
          }

          tap('success');
          router.replace({
            pathname: '/(client)/order-confirmed',
            params: { id: order._id, code: order.orderNumber ?? '' },
          });
        },
        onError: (err) => {
          setError(apiMessage(err, 'No pudimos crear tu mandado.'));
          tap('error');
        },
      }
    );
  };

  const busy = create.isPending || payOrder.isPending;

  return (
    <Screen>
      <Header title="Pedir un mandado" fallback="/(client)/(tabs)/home" />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <Card style={styles.card}>
            <View style={styles.sectionHead}>
              <Icon name="paquete" size="md" color={c.textSecondary} />
              <Text v="titleS">¿Qué necesitas?</Text>
            </View>
            <Input
              placeholder="Recoger una fórmula en la droguería de la 5 y llevarla a mi casa"
              value={description}
              onChangeText={(t) => { setDescription(t); setError(''); }}
              multiline
              numberOfLines={3}
              maxLength={500}
              hint="Cuanto más claro, menos llamadas después."
            />
          </Card>

          <Card style={styles.card}>
            <View style={styles.sectionHead}>
              <Icon name="ubicacion" size="md" color={c.textSecondary} />
              <Text v="titleS">¿De dónde lo recogemos?</Text>
            </View>

            <Input
              placeholder="Droguería La Rebaja, calle 5 con carrera 8"
              value={pickupAddress}
              onChangeText={(t) => { setPickupAddress(t); setError(''); }}
              maxLength={300}
            />

            {/*
              El mapa reclama el gesto antes que el ScrollView. Sin esto,
              arrastrar en vertical sobre el mapa desplaza el formulario y
              el punto solo se puede corregir de lado.
            */}
            <View
              style={styles.mapFrame}
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
            >
              <ZippMap
                pick
                height={200}
                zoom={16}
                center={pickup ?? deliveryPoint}
                onPick={(point) => { setPickup(point); setError(''); }}
              />
            </View>
            <Text v="caption" tone={pickup ? 'limeText' : 'textMuted'}>
              {pickup
                ? 'Ahí es. El domiciliario va a llegar exactamente a este punto.'
                : 'Arrastra el mapa hasta que el objetivo quede sobre el sitio.'}
            </Text>
          </Card>

          <Card style={styles.card}>
            <View style={styles.sectionHead}>
              <Icon name="ruta" size="md" color={c.textSecondary} />
              <Text v="titleS">¿A dónde lo llevamos?</Text>
            </View>
            <Button
              title={destination ? destination.address : 'Elegir dirección'}
              icon="ubicacion"
              variant="secondary"
              full
              onPress={() => { tap('light'); setPickingAddress(true); }}
            />
            {destination?.details ? (
              <Text v="caption" tone="textMuted">{destination.details}</Text>
            ) : null}
          </Card>

          <Card style={styles.card}>
            <View style={styles.sectionHead}>
              <Icon name="efectivo" size="md" color={c.textSecondary} />
              <Text v="titleS">¿Cuánto va a costar?</Text>
            </View>

            <Input
              label="Lo que calculas"
              placeholder="40000"
              value={estimatedText}
              onChangeText={onEstimatedChange}
              keyboardType="number-pad"
              numeric
              prefix="$"
            />

            <Input
              label="Tope que autorizas"
              placeholder="50000"
              value={maxText}
              onChangeText={(t) => { setMaxEdited(true); setMaxText(t); setError(''); }}
              keyboardType="number-pad"
              numeric
              prefix="$"
              hint="Si el precio sube, el domiciliario puede pagar hasta aquí. Ni un peso más."
            />

            <View
              style={[
                styles.explainer,
                {
                  backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
                  borderColor: c.border,
                },
              ]}
            >
              <Icon name="info" size="sm" color={c.textMuted} />
              <Text v="caption" tone="textSecondary" style={styles.flex}>
                El domiciliario adelanta esta compra con su propio dinero y te enseña el
                recibo. Al final pagas lo que costó de verdad más el domicilio, no el tope.
              </Text>
            </View>
          </Card>

          <Card style={styles.card}>
            <Input
              label="Algo más que debamos saber"
              placeholder="Si no hay de esa marca, cualquier genérico sirve"
              value={notes}
              onChangeText={setNotes}
              multiline
              maxLength={500}
            />
          </Card>

          {error ? <Notice tone="error">{error}</Notice> : null}
        </ScrollView>
      </KeyboardAvoidingView>

      <ScreenFooter>
        <Button
          title="Pedir mandado"
          icon="paquete"
          full
          loading={busy}
          onPress={submit}
        />
        <Text v="caption" tone="textMuted" center>
          El domicilio se calcula por la distancia y se suma al final.
        </Text>
      </ScreenFooter>

      <AddressSheet
        visible={pickingAddress}
        onClose={() => setPickingAddress(false)}
        selectedId={destination?._id ?? null}
        onSelect={(picked) => { setAddress(picked); setError(''); }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { gap: Spacing.md },
  content: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.huge },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  mapFrame: { borderRadius: BorderRadius.lg, overflow: 'hidden' },
  explainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
  },
});
