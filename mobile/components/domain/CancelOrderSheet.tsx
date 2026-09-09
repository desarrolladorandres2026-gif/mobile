import { useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Text, Button, Sheet, Icon, Input, Notice } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import { useCancelOrder } from '../../hooks/useApi';
import type { CancellationCode } from '../../services/endpoints';
import { canCancelBySelf } from '../../lib/cancelPolicy';
import { apiMessage } from '../../lib/errors';
import { tap } from '../../lib/haptics';
import { Spacing, BorderRadius } from '../../theme/tokens';

/**
 * Cancelar el pedido, desde el cliente.
 *
 * El servidor autorizaba esto desde hacía tiempo —cancelar es literalmente
 * el único cambio de estado que le concede al cliente— y la app no tenía
 * botón. La consecuencia era que cada duda terminaba en un PQRS: la única
 * salida era "Algo anda mal con mi pedido", que abre soporte.
 *
 * Toda cancelación emite reembolso completo por la pasarela, así que la
 * frontera de abajo no es una preferencia de interfaz: es dónde se decide
 * quién asume el coste.
 */

/** Los motivos que le corresponden al cliente, en su idioma. */
const REASONS: { code: CancellationCode; label: string }[] = [
  { code: 'client_changed_mind', label: 'Ya no lo necesito' },
  { code: 'client_ordered_by_mistake', label: 'Lo pedí sin querer' },
  { code: 'client_too_slow', label: 'Se está demorando mucho' },
  { code: 'client_wrong_address', label: 'Puse mal la dirección' },
  { code: 'other', label: 'Otro motivo' },
];

// La política de hasta cuándo se puede cancelar solo vive en
// `lib/cancelPolicy.ts`, sin dependencias de UI, para poder probarla sin
// arrastrar Reanimated. Se reexporta aquí porque el resto del código ya
// importa estos dos nombres desde este archivo.
export { canCancelBySelf, isCancellable } from '../../lib/cancelPolicy';

interface Props {
  visible: boolean;
  onClose: () => void;
  orderId: string;
  status: string;
  /** Ya se cobró en línea: cambia el aviso sobre la devolución. */
  paidOnline: boolean;
  onCancelled?: () => void;
}

export function CancelOrderSheet({
  visible, onClose, orderId, status, paidOnline, onCancelled,
}: Props) {
  const { c } = useTheme();
  const router = useRouter();
  const cancel = useCancelOrder();

  const [code, setCode] = useState<CancellationCode | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setCode(null);
    setNote('');
    setError(null);
    onClose();
  };

  const confirm = async () => {
    if (!code) return;
    setError(null);
    try {
      await cancel.mutateAsync({
        id: orderId,
        code,
        // El texto libre solo viaja cuando aporta algo: repetir la etiqueta
        // que ya va en el código sería ruido en la base de datos.
        note: code === 'other' ? note.trim() || undefined : undefined,
      });
      tap('success');
      close();
      onCancelled?.();
    } catch (err) {
      // El error se pinta dentro de la hoja, no en un Alert. El usuario está
      // a punto de perder un pedido: un diálogo que se cierra solo lo deja
      // sin saber si quedó cancelado o no.
      tap('error');
      setError(apiMessage(err, 'No pudimos cancelar el pedido. Intenta de nuevo.'));
    }
  };

  // ── Desde que la cocina empezó, esto lo mira una persona ──
  if (!canCancelBySelf(status)) {
    return (
      <Sheet visible={visible} onClose={close} title="Cancelar el pedido" height={0.5} scroll={false}>
        <View style={styles.body}>
          <Notice tone="warning">
            Tu pedido ya se está preparando, así que cancelarlo ahora tiene un
            costo para alguien. Lo miramos contigo y buscamos la salida.
          </Notice>
          <Text v="bodyM" tone="textSecondary">
            Cuéntanos qué pasó y lo resolvemos. Si es una demora, muchas veces
            se arregla más rápido de lo que parece.
          </Text>
          <Button
            title="Hablar con soporte"
            icon="ayuda"
            full
            onPress={() => { tap('medium'); close(); router.push('/(client)/help'); }}
          />
          <Button title="Seguir esperando" variant="ghost" full onPress={close} />
        </View>
      </Sheet>
    );
  }

  return (
    <Sheet
      visible={visible}
      onClose={close}
      title="Cancelar el pedido"
      height={0.72}
      footer={
        <Button
          title={cancel.isPending ? 'Cancelando…' : 'Sí, cancelar el pedido'}
          variant="danger"
          full
          loading={cancel.isPending}
          // No se deshabilita sin motivo: se encadena al paso que falta. Sin
          // `code` no hace nada y el texto de arriba sigue pidiéndolo.
          onPress={confirm}
        />
      }
    >
      <View style={styles.body}>
        <Text v="bodyM" tone="textSecondary">
          {code ? 'Confirma abajo y lo cancelamos.' : '¿Qué pasó? Elige un motivo.'}
        </Text>

        {REASONS.map((reason) => {
          const picked = code === reason.code;
          return (
            <Pressable
              key={reason.code}
              onPress={() => { tap('select'); setCode(reason.code); }}
              accessibilityRole="radio"
              accessibilityState={{ selected: picked }}
              accessibilityLabel={reason.label}
              style={[
                styles.reason,
                {
                  backgroundColor: picked ? c.primarySoft : c.surface,
                  borderColor: picked ? c.primary : c.border,
                },
              ]}
            >
              <Text v="bodyM" style={styles.flex}>{reason.label}</Text>
              {picked ? <Icon name="check" size="sm" color={c.primary} /> : null}
            </Pressable>
          );
        })}

        {code === 'other' ? (
          <Input
            value={note}
            onChangeText={setNote}
            placeholder="Cuéntanos qué pasó"
            multiline
            maxLength={200}
          />
        ) : null}

        {paidOnline ? (
          <Notice tone="info">
            Ya se hizo el cobro. La devolución sale automáticamente y llega en
            pocos días hábiles.
          </Notice>
        ) : null}

        {error ? <Notice tone="error">{error}</Notice> : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: Spacing.md, paddingBottom: Spacing.md },
  flex: { flex: 1 },
  reason: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    // Alto real por encima de los 44 pt que exige `tokens.tapMin`. Una lista
    // de opciones es justo donde se falla al tocar.
    minHeight: 52,
  },
});
