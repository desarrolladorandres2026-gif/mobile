import { useState } from 'react';
import { View, Pressable, StyleSheet, Alert } from 'react-native';
import {
  Text, Icon, IconButton, Button, Input, Badge, Sheet, EmptyState, Notice,
} from '../ui';
import {
  useAddresses, useCreateAddress, useDeleteAddress, useSetDefaultAddress,
} from '../../hooks/useApi';
import { captureCurrentPosition } from '../../hooks/useLocation';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { apiMessage } from '../../lib/errors';
import { tap } from '../../lib/haptics';

export interface Address {
  _id: string;
  label: string;
  address: string;
  details?: string;
  isDefault?: boolean;
  location?: { coordinates?: [number, number] };
}

/**
 * Una dirección solo sirve si tiene coordenadas.
 *
 * El precio del envío sale de la distancia real, así que sin punto en el mapa
 * el servidor no puede cotizar y el domiciliario no puede llegar. Se valida
 * aquí para poder avisar antes, y no en el momento de confirmar.
 */
export function hasCoordinates(address: Address | undefined): boolean {
  const coords = address?.location?.coordinates;
  return (
    Array.isArray(coords) &&
    typeof coords[0] === 'number' &&
    typeof coords[1] === 'number' &&
    !(coords[0] === 0 && coords[1] === 0)
  );
}

// ──────────────────────────────────────────────────────────────
// Fila de dirección
// ──────────────────────────────────────────────────────────────

export function AddressRow({
  address, selected, onSelect, onDelete, onMakeDefault,
}: {
  address: Address;
  selected?: boolean;
  onSelect?: () => void;
  onDelete?: () => void;
  onMakeDefault?: () => void;
}) {
  const { c } = useTheme();
  const usable = hasCoordinates(address);

  return (
    <Pressable
      onPress={onSelect ? () => { tap('select'); onSelect(); } : undefined}
      accessibilityRole={onSelect ? 'radio' : undefined}
      accessibilityState={onSelect ? { selected: !!selected } : undefined}
      accessibilityLabel={`${address.label}. ${address.address}${address.details ? `. ${address.details}` : ''}`}
      style={[
        styles.row,
        {
          backgroundColor: c.surface,
          borderColor: selected ? c.primary : c.border,
          borderWidth: selected ? 2 : 1,
        },
      ]}
    >
      <View
        style={[
          styles.rowIcon,
          { backgroundColor: address.isDefault ? c.limeSoft : c.primarySoft },
        ]}
      >
        <Icon
          name={address.isDefault ? 'medalla' : 'ubicacion'}
          size="md"
          color={address.isDefault ? c.limeText : c.primaryText}
        />
      </View>

      <View style={styles.rowBody}>
        <View style={styles.rowTitle}>
          <Text v="strongM" numberOfLines={1}>{address.label}</Text>
          {address.isDefault ? <Badge label="Principal" tone="lime" /> : null}
        </View>
        <Text v="bodyS" tone="textSecondary" numberOfLines={1}>{address.address}</Text>
        {address.details ? (
          <Text v="caption" tone="textMuted" numberOfLines={1}>{address.details}</Text>
        ) : null}
        {!usable ? (
          <Text v="caption" tone="warningText">Sin punto en el mapa · no podemos cotizar el envío</Text>
        ) : null}
      </View>

      <View style={styles.rowActions}>
        {onMakeDefault && !address.isDefault ? (
          <IconButton
            icon="medalla"
            label={`Hacer principal ${address.label}`}
            size={34}
            onPress={onMakeDefault}
          />
        ) : null}
        {onDelete ? (
          <IconButton
            icon="eliminar"
            label={`Eliminar ${address.label}`}
            tone="danger"
            size={34}
            onPress={onDelete}
          />
        ) : null}
        {selected ? <Icon name="checkCirculo" size="lg" color={c.primary} /> : null}
      </View>
    </Pressable>
  );
}

// ──────────────────────────────────────────────────────────────
// Lista de direcciones
// ──────────────────────────────────────────────────────────────

export function AddressList({
  selectedId, onSelect, manage,
}: {
  selectedId?: string | null;
  onSelect?: (address: Address) => void;
  /** Muestra las acciones de eliminar y marcar como principal. */
  manage?: boolean;
}) {
  const { data: addresses = [] } = useAddresses() as { data: Address[] };
  const remove = useDeleteAddress();
  const makeDefault = useSetDefaultAddress();
  const [creating, setCreating] = useState(false);

  const confirmDelete = (address: Address) => {
    Alert.alert(
      `Eliminar ${address.label}`,
      'Esta dirección se quita de tu cuenta. Puedes volver a agregarla cuando quieras.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: () => remove.mutate(address._id),
        },
      ]
    );
  };

  return (
    <View style={styles.list}>
      {addresses.length === 0 ? (
        <EmptyState
          icon="ubicacion"
          title="Todavía no tienes direcciones"
          message="Agrega dónde quieres recibir tus pedidos. Solo se hace una vez."
          compact
        />
      ) : (
        addresses.map((address) => (
          <AddressRow
            key={address._id}
            address={address}
            selected={selectedId === address._id}
            onSelect={onSelect ? () => onSelect(address) : undefined}
            onDelete={manage ? () => confirmDelete(address) : undefined}
            onMakeDefault={manage ? () => { tap('light'); makeDefault.mutate(address._id); } : undefined}
          />
        ))
      )}

      <Button
        title="Agregar dirección"
        icon="mas"
        variant="secondary"
        full
        onPress={() => { tap('light'); setCreating(true); }}
      />

      <NewAddressSheet
        visible={creating}
        onClose={() => setCreating(false)}
        onCreated={(address) => {
          setCreating(false);
          onSelect?.(address);
        }}
      />
    </View>
  );
}

// ──────────────────────────────────────────────────────────────
// Nueva dirección
// ──────────────────────────────────────────────────────────────

export function NewAddressSheet({
  visible, onClose, onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: (address: Address) => void;
}) {
  const { c } = useTheme();
  const create = useCreateAddress();

  const [label, setLabel] = useState('');
  const [street, setStreet] = useState('');
  const [details, setDetails] = useState('');
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');

  const reset = () => {
    setLabel(''); setStreet(''); setDetails('');
    setCoords(null); setError('');
  };

  const locate = async () => {
    setLocating(true);
    setError('');
    const position = await captureCurrentPosition();
    setLocating(false);

    if (!position) {
      setError('No pudimos leer tu ubicación. Activa el permiso de ubicación e inténtalo otra vez.');
      tap('error');
      return;
    }
    setCoords({ latitude: position.latitude, longitude: position.longitude });
    tap('success');
  };

  const save = () => {
    if (!label.trim() || !street.trim()) {
      setError('Ponle un nombre y escribe la dirección.');
      tap('error');
      return;
    }
    if (!coords) {
      setError('Falta confirmar el punto en el mapa. Sin él no podemos calcular el envío.');
      tap('error');
      return;
    }

    create.mutate(
      {
        label: label.trim(),
        address: street.trim(),
        details: details.trim() || undefined,
        latitude: coords.latitude,
        longitude: coords.longitude,
      },
      {
        onSuccess: (created: Address) => { reset(); onCreated(created); },
        onError: (err) => setError(apiMessage(err, 'No pudimos guardar la dirección.')),
      }
    );
  };

  return (
    <Sheet
      visible={visible}
      onClose={() => { reset(); onClose(); }}
      title="Nueva dirección"
      height={0.9}
      footer={
        <Button
          title="Guardar dirección"
          size="lg"
          full
          loading={create.isPending}
          onPress={save}
          haptic="medium"
        />
      }
    >
      <View style={styles.quickLabels}>
        {['Casa', 'Trabajo', 'Donde mi mamá'].map((preset) => (
          <Pressable
            key={preset}
            onPress={() => { tap('select'); setLabel(preset); }}
            accessibilityRole="button"
            accessibilityLabel={`Usar el nombre ${preset}`}
            style={[
              styles.quickLabel,
              {
                backgroundColor: label === preset ? c.primary : c.surface,
                borderColor: label === preset ? c.primary : c.border,
              },
            ]}
          >
            <Text v="strongS" color={label === preset ? c.textOnPrimary : c.textSecondary}>
              {preset}
            </Text>
          </Pressable>
        ))}
      </View>

      <Input
        label="¿Cómo la llamas?"
        icon="ubicacion"
        placeholder="Casa, Trabajo, Donde mi mamá…"
        value={label}
        onChangeText={(t) => { setLabel(t); setError(''); }}
      />

      <Input
        label="Dirección"
        icon="ruta"
        placeholder="Calle 5 # 3-21"
        value={street}
        onChangeText={(t) => { setStreet(t); setError(''); }}
      />

      <Input
        label="Cómo llegar (opcional)"
        icon="info"
        placeholder="Portón negro, segundo piso, timbre 2"
        value={details}
        onChangeText={setDetails}
        hint="Lo que le dirías a alguien que nunca ha ido."
      />

      <View style={styles.locate}>
        <Text v="strongS" tone="textSecondary">Punto en el mapa</Text>
        <Button
          title={coords ? 'Ubicación confirmada' : 'Usar mi ubicación actual'}
          icon={coords ? 'checkCirculo' : 'miUbicacion'}
          variant={coords ? 'lime' : 'secondary'}
          full
          loading={locating}
          onPress={locate}
        />
        <Text v="caption" tone="textMuted">
          Con esto calculamos el costo del envío y el domiciliario te encuentra a la primera.
        </Text>
      </View>

      {error ? <Notice tone="error">{error}</Notice> : null}
    </Sheet>
  );
}

// ──────────────────────────────────────────────────────────────
// Selector para el checkout
// ──────────────────────────────────────────────────────────────

export function AddressSheet({
  visible, onClose, selectedId, onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  selectedId: string | null;
  onSelect: (address: Address) => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title="¿Dónde te lo dejamos?" height={0.82}>
      <AddressList
        selectedId={selectedId}
        onSelect={(address) => { onSelect(address); onClose(); }}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: { gap: Spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
  },
  rowIcon: {
    width: 40, height: 40, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },

  quickLabels: { flexDirection: 'row', gap: Spacing.sm, flexWrap: 'wrap' },
  quickLabel: {
    paddingHorizontal: Spacing.lg,
    height: 38,
    borderRadius: BorderRadius.full,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  locate: { gap: Spacing.sm },
});
