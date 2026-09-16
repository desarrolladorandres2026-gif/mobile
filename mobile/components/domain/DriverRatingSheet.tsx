import { useCallback, useState } from 'react';
import { View, StyleSheet, Pressable, Alert } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Text, Button, Sheet, Icon, Chip } from '../ui';
import { ContentIcon } from '../illustrations';
import { useTheme } from '../../hooks/useTheme';
import { useRateBusinessByDriver, useRateClientByDriver } from '../../hooks/useApi';
import type { ReviewReasonDriverToBusiness, ReviewReasonDriverToClient } from '../../services/endpoints';
import { tap } from '../../lib/haptics';
import { Spacing } from '../../theme/tokens';

/**
 * El domiciliario califica al comercio (al recoger) y al cliente (al
 * entregar), después de que el pedido quedó marcado como entregado.
 *
 * Ninguna de las dos es pública: la del comercio alimenta su
 * `reputationScore` interno (no su nota de cliente), y la del cliente
 * alimenta su perfil de riesgo. El backend ya las soportaba desde hacía
 * tiempo (`rateBusinessByDriver`, `rateClient`); esto es lo que faltaba
 * para poder mandarlas.
 */

const LOW_RATING_THRESHOLD = 2;

const BUSINESS_REASONS: Array<{ value: ReviewReasonDriverToBusiness; label: string }> = [
  { value: 'order_not_ready', label: 'No estaba listo' },
  { value: 'waiting_time', label: 'Esperé mucho' },
  { value: 'poor_treatment', label: 'Mal trato' },
  { value: 'order_preparation_problem', label: 'Mal empacado' },
  { value: 'other', label: 'Otro' },
];

const CLIENT_REASONS: Array<{ value: ReviewReasonDriverToClient; label: string }> = [
  { value: 'wrong_address', label: 'Dirección incorrecta' },
  { value: 'communication_problem', label: 'No contestó' },
  { value: 'long_wait', label: 'Esperé mucho' },
  { value: 'poor_treatment', label: 'Mal trato' },
  { value: 'other', label: 'Otro' },
];

function Stars({ value, onChange }: { value: number; onChange: (v: number) => void }) {
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
          <Icon name="calificacion" size={32} color={star <= value ? c.warning : c.border} strong={star <= value} />
        </Pressable>
      ))}
    </View>
  );
}

function ReasonPicker<T extends string>({
  reasons, selected, onToggle,
}: { reasons: Array<{ value: T; label: string }>; selected: T[]; onToggle: (v: T) => void }) {
  return (
    <Animated.View entering={FadeIn.duration(180)} style={styles.reasons}>
      {reasons.map((r) => (
        <Chip key={r.value} label={r.label} active={selected.includes(r.value)} onPress={() => onToggle(r.value)} />
      ))}
    </Animated.View>
  );
}

export function DriverRatingSheet({
  visible, onClose, orderId, businessName, canRateBusiness, canRateClient,
}: {
  visible: boolean;
  onClose: () => void;
  orderId: string;
  businessName?: string;
  canRateBusiness: boolean;
  canRateClient: boolean;
}) {
  const rateBusiness = useRateBusinessByDriver();
  const rateClient = useRateClientByDriver();

  const [businessRating, setBusinessRating] = useState(0);
  const [businessReasons, setBusinessReasons] = useState<ReviewReasonDriverToBusiness[]>([]);
  const [clientRating, setClientRating] = useState(0);
  const [clientReasons, setClientReasons] = useState<ReviewReasonDriverToClient[]>([]);

  const reset = useCallback(() => {
    setBusinessRating(0);
    setBusinessReasons([]);
    setClientRating(0);
    setClientReasons([]);
  }, []);

  const toggleBusinessReason = useCallback((v: ReviewReasonDriverToBusiness) => {
    tap('select');
    setBusinessReasons((prev) => (prev.includes(v) ? prev.filter((r) => r !== v) : [...prev, v]));
  }, []);

  const toggleClientReason = useCallback((v: ReviewReasonDriverToClient) => {
    tap('select');
    setClientReasons((prev) => (prev.includes(v) ? prev.filter((r) => r !== v) : [...prev, v]));
  }, []);

  const submitting = rateBusiness.isPending || rateClient.isPending;

  const handleSubmit = useCallback(() => {
    // Ninguna de las dos es obligatoria: un domiciliario puede omitir una
    // y calificar solo la otra, o ninguna — cerrar la hoja no bloquea nada.
    const jobs: Promise<unknown>[] = [];
    if (canRateBusiness && businessRating > 0) {
      jobs.push(
        rateBusiness.mutateAsync({ orderId, rating: businessRating, reasons: businessReasons.length ? businessReasons : undefined })
      );
    }
    if (canRateClient && clientRating > 0) {
      jobs.push(
        rateClient.mutateAsync({ orderId, rating: clientRating, reasons: clientReasons.length ? clientReasons : undefined })
      );
    }

    if (jobs.length === 0) {
      onClose();
      return;
    }

    Promise.all(jobs).then(
      () => { tap('success'); reset(); onClose(); },
      (err) => {
        tap('error');
        Alert.alert('No pudimos guardar tu calificación', err?.response?.data?.message ?? 'Inténtalo de nuevo.');
      }
    );
  }, [canRateBusiness, canRateClient, businessRating, clientRating, businessReasons, clientReasons, orderId, rateBusiness, rateClient, onClose, reset]);

  return (
    <Sheet
      visible={visible}
      onClose={() => { reset(); onClose(); }}
      title="Calificar este pedido"
      height={0.75}
      footer={
        <Button
          title={submitting ? 'Enviando…' : 'Enviar'}
          onPress={handleSubmit}
          disabled={submitting}
          style={styles.action}
        />
      }
    >
      <View style={styles.body}>
        <View style={styles.art}>
          <ContentIcon name="calificacion" size={64} />
        </View>

        {canRateBusiness ? (
          <View style={styles.block}>
            <Text v="strongS" center>{businessName ? `¿Cómo estuvo ${businessName} al recoger?` : '¿Cómo estuvo el comercio al recoger?'}</Text>
            <Text v="caption" tone="textMuted" center>Opcional. No es público.</Text>
            <Stars value={businessRating} onChange={setBusinessRating} />
            {businessRating > 0 && businessRating <= LOW_RATING_THRESHOLD ? (
              <ReasonPicker reasons={BUSINESS_REASONS} selected={businessReasons} onToggle={toggleBusinessReason} />
            ) : null}
          </View>
        ) : null}

        {canRateClient ? (
          <View style={styles.block}>
            <Text v="strongS" center>¿Y el cliente?</Text>
            <Text v="caption" tone="textMuted" center>Opcional. No es público.</Text>
            <Stars value={clientRating} onChange={setClientRating} />
            {clientRating > 0 && clientRating <= LOW_RATING_THRESHOLD ? (
              <ReasonPicker reasons={CLIENT_REASONS} selected={clientReasons} onToggle={toggleClientReason} />
            ) : null}
          </View>
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: Spacing.lg, paddingTop: Spacing.sm },
  art: { alignItems: 'center' },
  block: { gap: Spacing.sm, alignItems: 'center' },
  stars: { flexDirection: 'row', gap: Spacing.sm, paddingVertical: Spacing.xs },
  reasons: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: Spacing.xs },
  action: { width: '100%' },
});
