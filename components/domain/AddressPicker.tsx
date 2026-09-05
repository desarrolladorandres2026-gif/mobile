import { useState, useRef, useEffect } from 'react';
import { View, Pressable, StyleSheet, Alert } from 'react-native';
import {
  Text, Icon, IconButton, Button, Input, Badge, Sheet, EmptyState, Notice,
} from '../ui';
import {
  useAddresses, useCreateAddress, useDeleteAddress, useSetDefaultAddress,
} from '../../hooks/useApi';
import { captureCurrentPosition, locationFailureMessage } from '../../hooks/useLocation';
import { ZippMap } from './ZippMap';
import type { MapPoint } from '../../lib/mapbox';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { addressApi, type GeocodedPlace } from '../../services/endpoints';
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

/**
 * Por debajo de esto, la lectura viene de satélites y se puede confiar.
 *
 * Por encima, el teléfono está triangulando con antenas y wifi, que en un
 * pueblo con pocas celdas se va con facilidad a la manzana equivocada. El
 * número es un juicio sobre el terreno, no una constante universal: súbelo
 * si la gente termina moviendo el pin de todas formas, bájalo si están
 * guardando puntos que luego el domiciliario no encuentra.
 */
const GPS_TRUSTWORTHY_METERS = 40;

/**
 * Las dos formas de marcar dónde queda una dirección.
 *
 * Son caminos completos, no un camino y su plan B. El automático es más
 * rápido cuando estás en tu casa y el GPS coopera; el manual sirve para
 * guardar la dirección de tu mamá desde el sofá, y para quien sencillamente
 * prefiere no darle el GPS a la app. En modo manual no se pide permiso de
 * ubicación ni una sola vez.
 */
export type AddressMode = 'auto' | 'manual';

/**
 * Qué decirle al usuario sobre el punto que hay ahora mismo en el mapa.
 *
 * El costo del envío sale de la distancia a este punto y el domiciliario va
 * a llegar exactamente aquí, así que el texto no adorna: distingue el punto
 * que el usuario puso a conciencia del que el teléfono adivinó, y en el
 * segundo caso pide explícitamente que lo revise.
 */
function describePinQuality(input: {
  coords: { latitude: number; longitude: number } | null;
  accuracy: number | null;
  approximate: boolean;
  placedByHand: boolean;
  mode: AddressMode;
  geocoding: boolean;
  place: GeocodedPlace | null;
}): { tone: 'textMuted' | 'warningText' | 'limeText'; message: string } {
  const { coords, accuracy, approximate, placedByHand, mode, geocoding, place } = input;

  if (geocoding) {
    return { tone: 'textMuted', message: 'Buscando qué dirección hay en este punto…' };
  }

  if (!coords) {
    return {
      tone: 'textMuted',
      message:
        mode === 'auto'
          ? 'Toca el botón y tomamos tu punto y tu dirección. También puedes arrastrar el mapa.'
          : 'Arrastra el mapa hasta que el objetivo quede sobre tu casa.',
    };
  }

  if (approximate) {
    return {
      tone: 'warningText',
      message: 'Sin señal de GPS: este es tu último punto conocido y puede estar lejos. Revísalo.',
    };
  }

  if (!placedByHand && accuracy !== null && accuracy > GPS_TRUSTWORTHY_METERS) {
    return {
      tone: 'warningText',
      message: `El GPS solo pudo acercarse a unos ${Math.round(accuracy)} m. Arrastra el mapa para afinar.`,
    };
  }

  // Con el punto ya resuelto, lo que queda por avisar es la dirección: en un
  // municipio pequeño Mapbox suele conocer la vía pero no el número de la
  // casa, y guardar "Calle 5" a secas manda al repartidor a una cuadra
  // entera. Decirlo aquí es más barato que una llamada preguntando cuál es.
  if (mode === 'auto' && place && place.precision !== 'address') {
    return {
      tone: 'warningText',
      message: 'Del mapa solo sale la vía, sin número. Complétalo abajo para que te encuentren.',
    };
  }

  if (placedByHand) {
    return { tone: 'limeText', message: 'Punto puesto por ti. Es el que usaremos.' };
  }

  return { tone: 'limeText', message: 'Ubicación tomada del GPS. Ajústala si no cae en tu puerta.' };
}

/**
 * Selector entre marcar la ubicación sola o a mano.
 *
 * Va arriba del mapa y no debajo porque decide qué significan los controles
 * que le siguen: en automático aparece el botón del GPS, en manual no hay
 * botón y el mapa es todo el mecanismo. Un selector que cambia lo de abajo
 * tiene que leerse antes que lo de abajo.
 */
function ModeToggle({
  mode, onChange,
}: {
  mode: AddressMode;
  onChange: (mode: AddressMode) => void;
}) {
  const { c } = useTheme();

  const options: Array<{ value: AddressMode; label: string; hint: string }> = [
    { value: 'auto', label: 'Automática', hint: 'Con el GPS del teléfono' },
    { value: 'manual', label: 'Manual', hint: 'La marcas tú en el mapa' },
  ];

  return (
    <View style={styles.modeRow} accessibilityRole="radiogroup">
      {options.map((option) => {
        const active = mode === option.value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`${option.label}. ${option.hint}`}
            style={[
              styles.modeOption,
              {
                backgroundColor: active ? c.primary : c.surface,
                borderColor: active ? c.primary : c.border,
              },
            ]}
          >
            <Text v="strongS" color={active ? c.textOnPrimary : c.textSecondary}>
              {option.label}
            </Text>
            <Text v="caption" color={active ? c.textOnPrimary : c.textMuted}>
              {option.hint}
            </Text>
          </Pressable>
        );
      })}
    </View>
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
  selectedId, onSelect, manage, onAddPress,
}: {
  selectedId?: string | null;
  onSelect?: (address: Address) => void;
  /** Muestra las acciones de eliminar y marcar como principal. */
  manage?: boolean;
  /** Qué hacer cuando tocan "Agregar dirección". */
  onAddPress: () => void;
}) {
  const { data: addresses = [] } = useAddresses() as { data: Address[] };
  const remove = useDeleteAddress();
  const makeDefault = useSetDefaultAddress();

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
        onPress={() => { tap('light'); onAddPress(); }}
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

  /**
   * Cómo se está marcando el punto.
   *
   * No se reinicia al cerrar la hoja, a diferencia del resto del
   * formulario: quien no quiere dar permiso de ubicación va a querer el
   * modo manual todas las veces, y devolverle el automático en cada
   * dirección nueva sería pedirle que rechace el mismo diálogo del sistema
   * una y otra vez.
   */
  const [mode, setMode] = useState<AddressMode>('auto');

  /** Precisión del último fix, en metros. `null` si el punto lo puso el dedo. */
  const [accuracy, setAccuracy] = useState<number | null>(null);
  /** El GPS no dio fix nuevo y se usó la última posición conocida. */
  const [approximate, setApproximate] = useState(false);
  /** El usuario arrastró el mapa: su punto manda sobre cualquier GPS previo. */
  const [placedByHand, setPlacedByHand] = useState(false);
  /**
   * Sube cada vez que hay que llevar la cámara al `coords`.
   *
   * El mapa en modo `pick` ignora `center` por defecto para no pelearse con
   * el arrastre; esta llave es la única forma de moverlo a propósito.
   */
  const [recenterKey, setRecenterKey] = useState(0);

  const [geocoding, setGeocoding] = useState(false);
  const [place, setPlace] = useState<GeocodedPlace | null>(null);

  /**
   * El usuario escribió en el campo de dirección.
   *
   * A partir de ahí la geocodificación deja de tocarlo. Lo que Mapbox sabe
   * de un punto es una aproximación —en un municipio pequeño rara vez
   * incluye el número de la casa— y sobrescribir lo que alguien acaba de
   * corregir a mano es la forma más rápida de que deje de fiarse del
   * formulario entero.
   */
  const streetEdited = useRef(false);

  /**
   * Descarta respuestas de geocodificación que llegan tarde.
   *
   * Arrastrar dos veces seguidas lanza dos peticiones, y la primera puede
   * contestar después de la segunda. Sin este contador, el punto final
   * acabaría etiquetado con la dirección del punto intermedio.
   */
  const geocodeSeq = useRef(0);
  const geocodeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (geocodeTimer.current) clearTimeout(geocodeTimer.current);
    },
    []
  );

  const reset = () => {
    setLabel(''); setStreet(''); setDetails('');
    setCoords(null); setError('');
    setAccuracy(null); setApproximate(false); setPlacedByHand(false);
    setPlace(null); setGeocoding(false);
    streetEdited.current = false;
    geocodeSeq.current += 1;
    if (geocodeTimer.current) clearTimeout(geocodeTimer.current);
  };

  /**
   * Pregunta qué dirección hay en un punto y la escribe en el campo.
   *
   * Solo en modo automático: quien eligió el manual dijo que la escribe
   * él, y gastar una llamada de pago para rellenar un campo que va a
   * sobrescribir de todas formas no ayuda a nadie.
   *
   * El retardo agrupa los arrastres seguidos. Ajustar un pin son tres o
   * cuatro toques encadenados, y sin esperar a que la mano se quede quieta
   * se pagarían cuatro geocodificaciones para quedarse solo con la última.
   */
  const geocode = (point: { latitude: number; longitude: number }) => {
    if (mode !== 'auto') return;
    if (geocodeTimer.current) clearTimeout(geocodeTimer.current);

    geocodeTimer.current = setTimeout(async () => {
      const seq = ++geocodeSeq.current;
      setGeocoding(true);
      try {
        const found = await addressApi.reverseGeocode({
          lat: point.latitude,
          lng: point.longitude,
        });
        if (seq !== geocodeSeq.current) return;
        setPlace(found);
        if (found && !streetEdited.current) setStreet(found.address);
      } catch {
        // Sin dirección se sigue adelante: el punto ya sirve para cobrar el
        // envío y para llegar, y el campo queda para escribirla a mano.
        if (seq === geocodeSeq.current) setPlace(null);
      } finally {
        if (seq === geocodeSeq.current) setGeocoding(false);
      }
    }, 400);
  };

  const locate = async () => {
    setLocating(true);
    setError('');
    const result = await captureCurrentPosition();
    setLocating(false);

    if (!result.ok) {
      // El mapa sigue ahí y el modo manual está a un toque, así que esto
      // informa sin cerrar el camino: el mensaje dice qué arreglar.
      setError(locationFailureMessage(result.reason));
      tap('error');
      return;
    }

    const next = { latitude: result.position.latitude, longitude: result.position.longitude };
    setCoords(next);
    setAccuracy(result.position.accuracy);
    setApproximate(result.approximate);
    setPlacedByHand(false);
    setRecenterKey((k) => k + 1);
    geocode(next);
    tap('success');
  };

  /**
   * El mapa se soltó en otro sitio.
   *
   * A partir de aquí el punto es del usuario, no del GPS: se olvidan la
   * precisión y la marca de aproximado, porque describían una lectura que
   * ya no es la que se va a guardar.
   */
  const handlePick = (point: MapPoint) => {
    const next = { latitude: point.lat, longitude: point.lng };
    setCoords(next);
    setAccuracy(null);
    setApproximate(false);
    setPlacedByHand(true);
    setError('');
    geocode(next);
  };

  /**
   * Cambiar de modo no borra el punto ni lo ya escrito.
   *
   * Quien probó el GPS, no le gustó dónde cayó y se pasa a manual quiere
   * corregir lo que hay delante, no empezar el formulario de cero.
   */
  const changeMode = (next: AddressMode) => {
    tap('select');
    setMode(next);
    setError('');
    if (next === 'manual') {
      // Cancela lo pendiente y lo ya en vuelo. El temporizador para lo que
      // aún no salió; subir el contador invalida la respuesta de una
      // petición que ya está viajando y llegaría a rellenar un campo que
      // el usuario acaba de reclamar como suyo.
      if (geocodeTimer.current) clearTimeout(geocodeTimer.current);
      geocodeSeq.current += 1;
      setGeocoding(false);
    }
  };

  const save = () => {
    if (!label.trim() || !street.trim()) {
      setError('Ponle un nombre y escribe la dirección.');
      tap('error');
      return;
    }
    if (!coords) {
      setError('Falta marcar el punto en el mapa. Sin él no podemos calcular el envío.');
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

  const quality = describePinQuality({
    coords, accuracy, approximate, placedByHand, mode, geocoding, place,
  });

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

      <View style={styles.locate}>
        <Text v="strongS" tone="textSecondary">¿Cómo marcamos dónde queda?</Text>

        <ModeToggle mode={mode} onChange={changeMode} />

        {/*
          El mapa reclama el gesto antes de que lo haga el ScrollView de la
          hoja. Sin esto, arrastrar hacia arriba o hacia abajo sobre el mapa
          desplaza el formulario en lugar de mover el mapa, y el punto solo
          se podría corregir en horizontal — que es justo la mitad de las
          correcciones que hace falta hacer.
        */}
        <View
          style={styles.mapFrame}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
        >
          <ZippMap
            pick
            height={240}
            zoom={17}
            center={coords ? { lat: coords.latitude, lng: coords.longitude } : null}
            recenterKey={recenterKey}
            onPick={handlePick}
          />
        </View>

        <Text v="caption" tone={quality.tone}>{quality.message}</Text>

        {mode === 'auto' ? (
          <Button
            title={coords ? 'Volver a mi ubicación' : 'Usar mi ubicación actual'}
            icon="miUbicacion"
            variant="secondary"
            full
            loading={locating}
            onPress={locate}
          />
        ) : null}
      </View>

      <Input
        label="Dirección"
        icon="ruta"
        placeholder="Calle 5 # 3-21"
        value={street}
        onChangeText={(t) => {
          streetEdited.current = true;
          setStreet(t);
          setError('');
        }}
        hint={
          mode === 'auto' && place && !streetEdited.current
            ? 'La tomamos del mapa. Corrígela si le falta el número.'
            : undefined
        }
      />

      <Input
        label="Cómo llegar (opcional)"
        icon="info"
        placeholder="Portón negro, segundo piso, timbre 2"
        value={details}
        onChangeText={setDetails}
        hint="Lo que le dirías a alguien que nunca ha ido."
      />

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
  const [creating, setCreating] = useState(false);

  /**
   * `NewAddressSheet` va como hermana de la hoja de lista, no anidada dentro.
   *
   * React Native solo tolera un `Modal` nativo visible a la vez: con dos
   * abiertos al tiempo, el teclado hace que el de abajo salte encima del de
   * arriba y se robe el toque, dejando los campos sin poder escribirse. Por
   * eso esta hoja se oculta mientras se está creando una dirección, en vez de
   * dejar las dos montadas juntas.
   */
  return (
    <>
      <Sheet
        visible={visible && !creating}
        onClose={onClose}
        title="¿Dónde te lo dejamos?"
        height={0.82}
      >
        <AddressList
          selectedId={selectedId}
          onSelect={(address) => { onSelect(address); onClose(); }}
          onAddPress={() => setCreating(true)}
        />
      </Sheet>

      <NewAddressSheet
        visible={visible && creating}
        onClose={() => setCreating(false)}
        onCreated={(address) => {
          setCreating(false);
          onSelect(address);
          onClose();
        }}
      />
    </>
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
  mapFrame: { overflow: 'hidden', borderRadius: BorderRadius.lg },
  modeRow: { flexDirection: 'row', gap: Spacing.sm },
  modeOption: {
    flex: 1,
    gap: 2,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md,
    borderWidth: 1.5,
  },
});
