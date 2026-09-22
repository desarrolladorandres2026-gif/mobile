import { useState, useRef, useEffect } from 'react';
import {
  View, Pressable, StyleSheet, Alert, ActivityIndicator, Keyboard, useWindowDimensions, Linking,
} from 'react-native';
import {
  Text, Icon, IconButton, Button, PlainField, SearchField, Badge, Sheet, Notice,
} from '../ui';
import {
  getAddressVisualConfig,
  HomeAddressIllustration,
  WorkAddressIllustration,
  FamilyAddressIllustration,
  PinAddressIllustration,
} from '../illustrations';
import {
  useAddresses, useCreateAddress, useUpdateAddress, useDeleteAddress,
  useSetDefaultAddress, useAddressSearch, useCoverageCheck,
} from '../../hooks/useApi';
import { captureCurrentPosition, locationFailureMessage, type LocationFailure } from '../../hooks/useLocation';
import { ZippMap } from './ZippMap';
import type { MapPoint } from '../../lib/mapbox';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { addressApi, type GeocodedPlace, type PlaceSuggestion } from '../../services/endpoints';
import { apiMessage } from '../../lib/errors';
import { tap } from '../../lib/haptics';

export interface Address {
  _id: string;
  label: string;
  address: string;
  /** Piso, apartamento, torre. Lo único del domicilio que el mapa no sabe. */
  apartment?: string;
  neighborhood?: string;
  city?: string;
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
 * De dónde salió el punto que hay ahora en el mapa.
 *
 * Sustituye al par de banderas que había antes. Las tres procedencias
 * merecen mensajes distintos —el GPS puede ser impreciso, el dedo nunca se
 * discute, y una sugerencia del buscador cae en el portal pero no en el
 * apartamento— y expresarlas con booleanos sueltos obligaba a inventar
 * combinaciones que no significan nada, como "ni a mano ni del GPS".
 */
export type PinSource = 'gps' | 'hand' | 'search' | null;

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
  source: PinSource;
  geocoding: boolean;
  place: GeocodedPlace | null;
}): { tone: 'textMuted' | 'warningText' | 'limeText'; message: string } {
  const { coords, accuracy, approximate, source, geocoding, place } = input;

  if (geocoding) {
    return { tone: 'textMuted', message: 'Buscando qué dirección hay en este punto…' };
  }

  if (!coords) {
    return {
      tone: 'textMuted',
      message: 'Búscala, usa tu ubicación, o abre el mapa y marca el punto a mano.',
    };
  }

  if (approximate) {
    return {
      tone: 'warningText',
      message: 'Sin señal de GPS: este es tu último punto conocido y puede estar lejos. Revísalo.',
    };
  }

  if (source === 'gps' && accuracy !== null && accuracy > GPS_TRUSTWORTHY_METERS) {
    return {
      tone: 'warningText',
      message: `El GPS solo pudo acercarse a unos ${Math.round(accuracy)} m. Arrastra el mapa para afinar.`,
    };
  }

  // Con el punto ya resuelto, lo que queda por avisar es la dirección: en un
  // municipio pequeño Mapbox suele conocer la vía pero no el número de la
  // casa, y guardar "Calle 5" a secas manda al repartidor a una cuadra
  // entera. Decirlo aquí es más barato que una llamada preguntando cuál es.
  if (place && place.precision !== 'address') {
    return {
      tone: 'warningText',
      message: 'Del mapa solo sale la vía, sin número. Complétalo abajo para que te encuentren.',
    };
  }

  if (source === 'hand') {
    return { tone: 'limeText', message: 'Punto puesto por ti. Es el que usaremos.' };
  }

  if (source === 'search') {
    return {
      tone: 'limeText',
      message: 'Punto de la dirección que elegiste. Arrastra el mapa si no cae en tu puerta.',
    };
  }

  return { tone: 'limeText', message: 'Ubicación tomada del GPS. Ajústala si no cae en tu puerta.' };
}

// ──────────────────────────────────────────────────────────────
// Fila de dirección
// ──────────────────────────────────────────────────────────────

export function AddressRow({
  address, selected, onSelect, onEdit, onDelete, onMakeDefault,
}: {
  address: Address;
  selected?: boolean;
  onSelect?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onMakeDefault?: () => void;
}) {
  const { c } = useTheme();
  const usable = hasCoordinates(address);
  const visual = getAddressVisualConfig(address.label);
  const Illustration = visual.illustration;

  return (
    <Pressable
      onPress={onSelect ? () => { tap('select'); onSelect(); } : undefined}
      accessibilityRole={onSelect ? 'radio' : undefined}
      accessibilityState={onSelect ? { selected: !!selected } : undefined}
      accessibilityLabel={`${address.label}. ${address.address}${address.details ? `. ${address.details}` : ''}`}
      style={({ pressed }) => [
        styles.row,
        { opacity: pressed && onSelect ? 0.6 : 1 },
      ]}
    >
      <Illustration size={44} />

      <View style={styles.rowInfo}>
        <View style={styles.rowTitleLine}>
          <Text v="strongL" numberOfLines={1} style={styles.rowLabel}>
            {address.label}
          </Text>

          {address.isDefault ? (
            <View style={styles.defaultInlineRow}>
              <View style={styles.activeDot} />
              <Text v="strongS" color="#10B981" style={styles.boldBadgeText}>
                Principal
              </Text>
            </View>
          ) : null}
        </View>

        <Text v="bodyM" tone="textSecondary" numberOfLines={2} style={styles.cardStreet}>
          {address.address}
        </Text>

        {/*
          El piso va en su propia línea y no pegado a la calle: es el dato
          que el domiciliario lee ya con el pedido en la mano, y enterrarlo
          dentro del renglón de la dirección era la razón de que se perdiera.
        */}
        {address.apartment ? (
          <View style={styles.detailsRow}>
            <Icon name="edificio" size={15} color={c.textMuted} />
            <Text v="bodyS" tone="textMuted" numberOfLines={1} style={styles.detailsText}>
              {address.apartment}
            </Text>
          </View>
        ) : null}

        {address.details ? (
          <View style={styles.detailsRow}>
            <Icon name="chat" size={15} color={c.textMuted} />
            <Text v="bodyS" tone="textMuted" numberOfLines={2} style={styles.detailsText}>
              {address.details}
            </Text>
          </View>
        ) : null}

        {!usable ? (
          <Text v="bodyS" tone="warningText" style={styles.rowWarning}>
            Sin punto en el mapa. No podemos calcular el envío.
          </Text>
        ) : null}

        {/*
          "Marcar como principal" es texto y no un botón con fondo porque en
          una lista plana un botón relleno vuelve a dibujar la caja que
          acabamos de quitar. Solo aparece donde significa algo: en la que
          ya es principal, la etiqueta de arriba lo dice y aquí no va nada.
        */}
        {onMakeDefault && !address.isDefault ? (
          <Pressable
            onPress={() => { tap('light'); onMakeDefault(); }}
            accessibilityRole="button"
            accessibilityLabel={`Hacer principal ${address.label}`}
            hitSlop={8}
            style={({ pressed }) => [styles.makeDefaultBtn, { opacity: pressed ? 0.5 : 1 }]}
          >
            <Text v="strongS" color={c.primaryText} style={styles.makeDefaultText}>
              Marcar como principal
            </Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.rowActions}>
        {onSelect ? (
          <View
            style={[
              styles.radioIndicator,
              {
                borderColor: selected ? c.primary : c.border,
                backgroundColor: selected ? c.primary : 'transparent',
              },
            ]}
          >
            {selected ? <Icon name="check" size={12} color={c.textOnPrimary} /> : null}
          </View>
        ) : null}

        {onEdit ? (
          <Pressable
            onPress={() => { tap('light'); onEdit(); }}
            accessibilityLabel={`Editar ${address.label}`}
            hitSlop={10}
            style={({ pressed }) => [styles.iconBtn, { opacity: pressed ? 0.45 : 0.75 }]}
          >
            <Icon name="editar" size="sm" color={c.textMuted} />
          </Pressable>
        ) : null}

        {onDelete ? (
          <Pressable
            onPress={() => { tap('light'); onDelete(); }}
            accessibilityLabel={`Eliminar ${address.label}`}
            hitSlop={10}
            style={({ pressed }) => [styles.iconBtn, { opacity: pressed ? 0.45 : 0.75 }]}
          >
            <Icon name="eliminar" size="sm" color={c.textMuted} />
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  );
}

// ──────────────────────────────────────────────────────────────
// Lista de direcciones
// ──────────────────────────────────────────────────────────────

export function AddressList({
  selectedId, onSelect, manage, onEditPress,
}: {
  selectedId?: string | null;
  onSelect?: (address: Address) => void;
  /** Muestra las acciones de editar, eliminar y marcar como principal. */
  manage?: boolean;
  /** Qué hacer cuando tocan el lápiz. Sin esto no se ofrece editar. */
  onEditPress?: (address: Address) => void;
}) {
  const { c } = useTheme();
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

  /**
   * Línea de separación entre filas.
   *
   * Es lo que sustituye al borde de las tarjetas: sin caja, lo único que
   * tiene que quedar claro es dónde acaba una dirección y empieza la
   * siguiente, y para eso basta un trazo del grosor mínimo del sistema.
   */
  const divider = <View style={[styles.divider, { backgroundColor: c.border }]} />;

  return (
    <View style={styles.list}>
      {addresses.length === 0 ? (
        <View style={styles.empty}>
          <PinAddressIllustration size={72} />
          <Text v="strongL" style={styles.emptyTitle}>
            Todavía no tienes direcciones
          </Text>
          <Text v="bodyM" tone="textSecondary" style={styles.emptyText}>
            Guarda los lugares a los que pides —tu casa, el trabajo, donde tu
            mamá— y aparecerán aquí listos para elegir.
          </Text>
        </View>
      ) : (
        addresses.map((address, index) => (
          <View key={address._id}>
            {index > 0 ? divider : null}
            <AddressRow
              address={address}
              selected={selectedId === address._id}
              onSelect={onSelect ? () => onSelect(address) : undefined}
              onEdit={manage && onEditPress ? () => onEditPress(address) : undefined}
              onDelete={manage ? () => confirmDelete(address) : undefined}
              onMakeDefault={manage ? () => { tap('light'); makeDefault.mutate(address._id); } : undefined}
            />
          </View>
        ))
      )}

    </View>
  );
}

/**
 * Botón para agregar una dirección.
 *
 * Va fuera de la lista, anclado al pie de quien lo use, y no como una fila
 * más al final: con varias direcciones guardadas la fila quedaba debajo del
 * scroll y había que buscarla, que es justo lo contrario de lo que hace un
 * botón de acción principal.
 *
 * El contorno lo dibuja `c.text` y no un negro literal. En claro es el
 * negro que se pidió; en oscuro, un negro fijo sería un borde invisible
 * contra el fondo, y un botón sin contorno visible no es un botón con
 * contorno.
 */
export function AddAddressButton({ onPress }: { onPress: () => void }) {
  const { c } = useTheme();

  return (
    <Pressable
      onPress={() => { tap('light'); onPress(); }}
      accessibilityRole="button"
      accessibilityLabel="Agregar nueva dirección"
      style={({ pressed }) => [
        styles.addButton,
        {
          borderColor: c.text,
          backgroundColor: pressed ? c.surfaceLight : 'transparent',
        },
      ]}
    >
      <Icon name="mas" size="sm" color={c.text} />
      <Text v="strongM" color={c.text}>
        Agregar dirección
      </Text>
    </Pressable>
  );
}

// ──────────────────────────────────────────────────────────────
// Nueva dirección
// ──────────────────────────────────────────────────────────────

/** Nombres frecuentes, con su ilustración. "Otro" no está: ese es el modo manual. */
const LABEL_PRESETS = [
  { name: 'Casa', illustration: HomeAddressIllustration },
  { name: 'Trabajo', illustration: WorkAddressIllustration },
  { name: 'Donde mi mamá', illustration: FamilyAddressIllustration },
];

/**
 * Retrasa un valor hasta que deja de cambiar.
 *
 * Sin esto cada pulsación en el buscador sería una llamada de pago a
 * Mapbox. Está copiado del buscador del catálogo en vez de compartido a
 * propósito: son ocho líneas, y un módulo nuevo para dos usos cuesta más
 * en saltos entre archivos de lo que ahorra en duplicación.
 */
function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

/**
 * Cuánto dura el eco de un recentrado hecho por la app.
 *
 * La animación del mapa dura 600 ms; el resto es margen para el puente con
 * el WebView. Subirlo mucho empezaría a tragarse arrastres de verdad justo
 * después de elegir una sugerencia, que es cuando más gente afina el pin.
 */
const RECENTER_ECHO_MS = 900;

/**
 * Alta y edición de una dirección.
 *
 * Es el mismo formulario para las dos cosas a propósito: los campos, el
 * mapa y las validaciones son idénticos, y mantener dos copias solo
 * garantiza que dentro de un mes una tenga un campo que la otra no.
 */
export function AddressFormSheet({
  visible, onClose, onSaved, address,
}: {
  visible: boolean;
  onClose: () => void;
  onSaved: (address: Address) => void;
  /** Si viene, se edita esa dirección. Si no, se crea una nueva. */
  address?: Address | null;
}) {
  const { c } = useTheme();
  const create = useCreateAddress();
  const update = useUpdateAddress();
  const editing = !!address;

  const [label, setLabel] = useState('');
  /** El desplegable de nombres está abierto. */
  const [labelPickerOpen, setLabelPickerOpen] = useState(false);
  /**
   * Escribiendo un nombre a mano en vez de elegir uno de la lista.
   *
   * Arranca en `false` y no se deduce de `label` en cada render: mientras se
   * escribe, lo tecleado puede coincidir con un preset a medias ("Casa" al
   * borrar "Casa de mis papás") sin que eso deba devolver el campo al modo
   * lista debajo del dedo.
   */
  const [customLabel, setCustomLabel] = useState(false);
  const [street, setStreet] = useState('');
  const [apartment, setApartment] = useState('');
  const [details, setDetails] = useState('');
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');
  // Solo importa para poder ofrecer "Abrir ajustes" cuando el motivo es un
  // permiso denegado -- el mensaje ya lo dice, pero antes no habia ningun
  // boton que llevara ahi, solo enterrado en el menu de Perfil.
  const [errorReason, setErrorReason] = useState<LocationFailure | null>(null);

  /**
   * Barrio y municipio.
   *
   * No tienen campo en el formulario porque nadie debería teclear lo que
   * el geocodificador ya sabe. Se guardan igual: al repartidor le sirve
   * para orientarse cuando la calle está mal numerada, que en un municipio
   * pequeño es la mitad de las veces.
   */
  const [neighborhood, setNeighborhood] = useState('');
  const [city, setCity] = useState('');

  /** Texto del buscador de direcciones. */
  const [term, setTerm] = useState('');

  /**
   * El mapa está abierto a pantalla completa.
   *
   * Ajustar un pin en un recuadro de 200 px es la parte más incómoda de
   * guardar una dirección: el dedo tapa justo lo que hay que mirar. En
   * grande, el mapa deja de ser una miniatura de confirmación y pasa a ser
   * la herramienta con la que de verdad se coloca el punto.
   */
  const [expanded, setExpanded] = useState(false);

  /** Precisión del último fix, en metros. `null` si el punto no vino del GPS. */
  const [accuracy, setAccuracy] = useState<number | null>(null);
  /** El GPS no dio fix nuevo y se usó la última posición conocida. */
  const [approximate, setApproximate] = useState(false);
  /** De dónde salió el punto actual. Decide qué se le dice al usuario. */
  const [source, setSource] = useState<PinSource>(null);
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

  /**
   * Hasta cuándo ignorar los avisos de movimiento del mapa.
   *
   * El mapa avisa de que se movió también cuando lo movemos nosotros —al
   * centrarlo en el GPS o en una sugerencia del buscador— y ese eco es
   * indistinguible de un arrastre del usuario. Sin esta ventana, tomar la
   * ubicación por GPS se registraba como punto puesto a mano: se borraba
   * la precisión del fix y con ella el aviso de que el GPS solo pudo
   * acercarse a doscientos metros, que era justo el caso que había que
   * avisar.
   *
   * Es una ventana de tiempo y no un contador de ecos porque se cura sola.
   * Un contador que espere un eco que no llega —el mapa no anima si ya
   * estaba en ese punto— se queda descuadrado para siempre y se traga el
   * siguiente arrastre, que sí era del usuario.
   */
  const programmaticMoveUntil = useRef(0);

  useEffect(
    () => () => {
      if (geocodeTimer.current) clearTimeout(geocodeTimer.current);
    },
    []
  );

  /** Lleva la cámara al punto sin que el movimiento cuente como arrastre. */
  const recenter = () => {
    programmaticMoveUntil.current = Date.now() + RECENTER_ECHO_MS;
    setRecenterKey((k) => k + 1);
  };

  /**
   * Punto desde el que sesgar la búsqueda, redondeado a ~1 km.
   *
   * Redondeado y no exacto para que arrastrar el pin no invalide la caché
   * de resultados a cada metro: es la misma resolución con la que el
   * servidor cachea, así que afinar más aquí no traería nada nuevo.
   */
  const near = coords
    ? { lat: Number(coords.latitude.toFixed(2)), lng: Number(coords.longitude.toFixed(2)) }
    : undefined;

  const debouncedTerm = useDebounced(term);
  const { data: suggestions = [], isFetching: searching } = useAddressSearch(debouncedTerm, near) as {
    data: PlaceSuggestion[];
    isFetching: boolean;
  };

  /**
   * ¿Repartimos aquí?
   *
   * Informativo, nunca bloqueante: se puede vivir fuera de la zona y
   * querer guardar la dirección igual —para mandarle algo a alguien, o
   * porque la cobertura crece. Lo que no se puede es enterarse en el
   * checkout, con el carrito lleno y el pago elegido.
   */
  const { data: coverage } = useCoverageCheck(coords?.latitude, coords?.longitude);
  const outOfCoverage = coverage ? coverage.covered === false : false;

  /**
   * Carga la dirección que se va a editar cuando se abre la hoja.
   *
   * `streetEdited` arranca marcado: lo que el usuario guardó la última vez
   * manda sobre lo que Mapbox opine del punto, y sin esto el recentrado
   * inicial le reescribiría encima la dirección que había corregido a mano.
   */
  useEffect(() => {
    if (!visible || !address) return;

    setLabel(address.label);
    // Si ya traía un nombre que no es de la lista, abre directo en modo
    // manual: mandarlo al desplegable sin selección le escondería su propio
    // nombre detrás de "Elige un nombre".
    setCustomLabel(!LABEL_PRESETS.some((preset) => preset.name === address.label));
    setStreet(address.address);
    setApartment(address.apartment ?? '');
    setNeighborhood(address.neighborhood ?? '');
    setCity(address.city ?? '');
    setDetails(address.details ?? '');
    setSource('hand');
    streetEdited.current = true;

    const saved = address.location?.coordinates;
    if (Array.isArray(saved) && saved.length === 2) {
      setCoords({ latitude: saved[1], longitude: saved[0] });
      programmaticMoveUntil.current = Date.now() + RECENTER_ECHO_MS;
      setRecenterKey((k) => k + 1);
    }
  }, [visible, address]);

  const reset = () => {
    setLabel(''); setStreet(''); setApartment(''); setDetails('');
    setNeighborhood(''); setCity(''); setTerm('');
    setLabelPickerOpen(false); setCustomLabel(false);
    setCoords(null); setError('');
    setAccuracy(null); setApproximate(false); setSource(null);
    setPlace(null); setGeocoding(false);
    streetEdited.current = false;
    geocodeSeq.current += 1;
    if (geocodeTimer.current) clearTimeout(geocodeTimer.current);
  };

  /**
   * Pregunta qué dirección hay en un punto y la escribe en el campo.
   *
   * Corre siempre. Antes había un modo "manual" que lo desactivaba, pero
   * `streetEdited` ya hace ese trabajo mejor y sin preguntar: en cuanto
   * alguien escribe una letra en el campo de dirección, esto deja de
   * tocarlo. Deducirlo de lo que el usuario hace es más fiable que pedirle
   * que lo declare por adelantado.
   *
   * El retardo agrupa los arrastres seguidos. Ajustar un pin son tres o
   * cuatro toques encadenados, y sin esperar a que la mano se quede quieta
   * se pagarían cuatro geocodificaciones para quedarse solo con la última.
   */
  const geocode = (point: { latitude: number; longitude: number }) => {
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
        if (found) {
          // El barrio y el municipio se aceptan siempre, aunque el usuario
          // haya escrito la calle a mano: no tienen campo donde corregirse,
          // así que lo único que puede pisarse aquí es un dato viejo.
          setNeighborhood(found.neighborhood ?? '');
          setCity(found.city ?? '');
          if (!streetEdited.current) setStreet(found.address);
        }
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
      setErrorReason(result.reason);
      tap('error');
      return;
    }
    setErrorReason(null);

    const next = { latitude: result.position.latitude, longitude: result.position.longitude };
    setCoords(next);
    setAccuracy(result.position.accuracy);
    setApproximate(result.approximate);
    setSource('gps');
    recenter();
    geocode(next);
    tap('success');
  };

  /**
   * El usuario eligió una dirección del buscador.
   *
   * La sugerencia trae su propio punto, así que el mapa se mueve a ella en
   * vez de al revés. Se marca la calle como editada aunque la haya escrito
   * Mapbox: viene de un resultado que el usuario eligió a conciencia, y
   * dejar que la geocodificación del recentrado la reescriba sería
   * cambiarle delante lo que acaba de seleccionar.
   */
  const applySuggestion = (suggestion: PlaceSuggestion) => {
    tap('select');
    Keyboard.dismiss();

    // Corta lo pendiente y lo que ya va en vuelo, por el mismo motivo que
    // al pasar a modo manual: una respuesta tardía llegaría a pisar esto.
    if (geocodeTimer.current) clearTimeout(geocodeTimer.current);
    geocodeSeq.current += 1;
    setGeocoding(false);

    setCoords({ latitude: suggestion.lat, longitude: suggestion.lng });
    setStreet(suggestion.address);
    setNeighborhood(suggestion.neighborhood ?? '');
    setCity(suggestion.city ?? '');
    setPlace(suggestion);
    setAccuracy(null);
    setApproximate(false);
    setSource('search');
    setError('');
    setTerm('');
    streetEdited.current = true;

    recenter();
  };

  /**
   * El mapa se soltó en otro sitio.
   *
   * A partir de aquí el punto es del usuario, no del GPS: se olvidan la
   * precisión y la marca de aproximado, porque describían una lectura que
   * ya no es la que se va a guardar.
   */
  const handlePick = (point: MapPoint) => {
    // Descarta el eco de un recentrado nuestro. Ver `programmaticMoveUntil`.
    if (Date.now() < programmaticMoveUntil.current) return;

    const next = { latitude: point.lat, longitude: point.lng };
    setCoords(next);
    setAccuracy(null);
    setApproximate(false);
    setSource('hand');
    setError('');
    geocode(next);
  };

  /**
   * Qué falta para poder guardar, en el orden en que se pregunta.
   *
   * Un solo mensaje que junta todos los requisitos —"ponle un nombre y
   * escribe la dirección"— obliga a comparar la frase con el formulario
   * para averiguar cuál de los dos es el que falta. Se avisa de uno, el
   * primero que aparece leyendo hacia abajo, que es el que hay que ir a
   * arreglar.
   */
  const missing = (): string | null => {
    if (!coords) return 'Falta marcar el punto en el mapa. Sin él no podemos calcular el envío.';
    if (!street.trim()) return 'Falta la dirección: calle o carrera con su número.';
    if (!label.trim()) return 'Ponle un nombre para reconocerla, como "Casa".';
    return null;
  };

  const save = () => {
    const problem = missing();

    // El `!coords` repite lo que `missing()` ya comprobó, pero es lo que le
    // dice a TypeScript que más abajo hay coordenadas: no sabe seguir la
    // garantía a través de la llamada.
    if (problem || !coords) {
      setError(problem ?? '');
      tap('error');
      return;
    }

    // Los opcionales van como cadena vacía y no como `undefined`: al
    // editar, borrar el contenido de un campo tiene que poder borrarlo de
    // verdad, y un `undefined` significaría "déjalo como estaba".
    const payload = {
      label: label.trim(),
      address: street.trim(),
      apartment: apartment.trim(),
      neighborhood,
      city,
      details: details.trim(),
      latitude: coords.latitude,
      longitude: coords.longitude,
    };

    const handlers = {
      onSuccess: (saved: Address) => { reset(); onSaved(saved); },
      onError: (err: unknown) => setError(apiMessage(err, 'No pudimos guardar la dirección.')),
    };

    if (address) update.mutate({ id: address._id, ...payload }, handlers);
    else create.mutate(payload, handlers);
  };

  const quality = describePinQuality({
    coords, accuracy, approximate, source, geocoding, place,
  });

  const saving = create.isPending || update.isPending;

  /**
   * Alto del mapa grande, calculado y no `flex: 1`.
   *
   * `ZippMap` necesita un número: por dentro es un WebView, y un WebView
   * sin alto explícita colapsa a cero en lugar de estirarse. Se descuenta
   * lo que ocupan el asa, la cabecera y el pie de la hoja.
   */
  const { height: windowHeight } = useWindowDimensions();
  const fullMapHeight = Math.max(320, Math.round(windowHeight * 0.94) - 210);

  return (
    <>
    <Sheet
      visible={visible && !expanded}
      onClose={() => { reset(); onClose(); }}
      title={editing ? 'Editar dirección' : 'Nueva dirección'}
      fullScreen
      footer={
        <Button
          title={editing ? 'Guardar cambios' : 'Guardar dirección'}
          size="lg"
          full
          loading={saving}
          onPress={save}
          haptic="medium"
        />
      }
    >
      {/*
        Primero dónde queda, después cómo se llama.

        Antes el formulario abría pidiendo el nombre, y nombrar un sitio que
        todavía no has encontrado es trabajo al revés: la pregunta que trae
        aquí a la gente es "¿dónde?", y el buscador quedaba enterrado bajo
        dos campos de bautizo.
      */}
      <View style={styles.locate}>
        <Text v="strongS" tone="textSecondary">¿Dónde queda?</Text>

        {/*
          Buscar por texto es el camino corto: arrastrar el mapa sirve para
          confirmar una dirección, pero no para encontrarla. Quien manda un
          pedido a casa de un amigo sabe la calle y no sabe dónde cae en el
          mapa, y sin esto tenía que hacer de geocodificador a pulso.
        */}
        <SearchField
          value={term}
          onChange={setTerm}
          placeholder="Busca tu calle o barrio"
        />

        {/*
          El panel empuja el contenido hacia abajo en vez de flotar encima.
          Una capa absoluta se recorta contra el borde del ScrollView de la
          hoja en Android, y una sugerencia a medio pintar es peor que un
          mapa que baja un poco.

          Sin caja: nada de fondo ni borde alrededor del panel. Lo único que
          separa una fila de la siguiente es el trazo fino que ya llevaba
          cada sugerencia.
        */}
        <View style={styles.suggestions}>
          {/*
            El GPS va aquí arriba y no en un botón bajo el mapa porque es la
            primera respuesta a "¿dónde queda?" para quien está en su casa,
            y es donde la gente lo busca: pegado al campo de búsqueda, como
            una opción más de la lista.
          */}
          <Pressable
            onPress={locate}
            accessibilityRole="button"
            accessibilityLabel="Usar mi ubicación actual"
            style={({ pressed }) => [styles.suggestion, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Icon name="miUbicacion" size="sm" color={c.primaryText} />
            <View style={styles.suggestionText}>
              <Text v="strongS" color={c.primaryText} numberOfLines={1}>
                {coords ? 'Volver a mi ubicación' : 'Usar mi ubicación actual'}
              </Text>
              <Text v="caption" tone="textMuted" numberOfLines={1}>
                Con el GPS del teléfono
              </Text>
            </View>
            {locating ? <ActivityIndicator size="small" color={c.textMuted} /> : null}
          </Pressable>

          {term.trim().length >= 3 ? (
            searching && suggestions.length === 0 ? (
              <View style={[styles.suggestionEmpty, { borderTopColor: c.border }]}>
                <ActivityIndicator size="small" color={c.textMuted} />
                <Text v="caption" tone="textMuted">Buscando direcciones…</Text>
              </View>
            ) : suggestions.length === 0 ? (
              <View style={[styles.suggestionEmpty, { borderTopColor: c.border }]}>
                <Text v="caption" tone="textMuted">
                  No encontramos esa dirección. Márcala en el mapa.
                </Text>
              </View>
            ) : (
              suggestions.map((suggestion, index) => (
                <Pressable
                  key={`${suggestion.lat},${suggestion.lng},${index}`}
                  onPress={() => applySuggestion(suggestion)}
                  accessibilityRole="button"
                  accessibilityLabel={suggestion.full}
                  style={({ pressed }) => [
                    styles.suggestion,
                    {
                      opacity: pressed ? 0.6 : 1,
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: c.border,
                    },
                  ]}
                >
                  <Icon name="ubicacion" size="sm" color={c.textMuted} />
                  <View style={styles.suggestionText}>
                    <Text v="strongS" numberOfLines={1}>{suggestion.address}</Text>
                    <Text v="caption" tone="textMuted" numberOfLines={1}>{suggestion.full}</Text>
                  </View>
                </Pressable>
              ))
            )
          ) : null}
        </View>

        {/*
          El mapa pequeño es una vista previa, no un control.

          Antes se arrastraba aquí mismo, y por eso hacía falta robarle el
          gesto al ScrollView de la hoja. Colocar un punto con el dedo
          tapando el objetivo, en 200 px y peleando con el scroll, era la
          peor parte del formulario: ahora un toque abre el mapa grande, que
          es donde se ajusta de verdad.

          El escudo transparente existe porque el WebView se queda con el
          gesto si no se le tapa, y entonces el toque no llega al Pressable.
        */}
        <Pressable
          onPress={() => { tap('light'); setExpanded(true); }}
          accessibilityRole="button"
          accessibilityLabel="Abrir el mapa para ajustar el punto"
          style={styles.mapFrame}
        >
          <ZippMap
            pick
            height={200}
            zoom={17}
            center={coords ? { lat: coords.latitude, lng: coords.longitude } : null}
            recenterKey={recenterKey}
          />

          <View style={StyleSheet.absoluteFill} />

          <View style={[styles.mapHint, { backgroundColor: c.background }]} pointerEvents="none">
            <Icon name="explorar" size={14} color={c.text} />
            <Text v="strongS">
              {coords ? 'Toca para ajustar el punto' : 'Toca para marcar el punto'}
            </Text>
          </View>
        </Pressable>

        <Text v="caption" tone={quality.tone}>{quality.message}</Text>

        {/*
          Avisa, no impide. Alguien puede vivir fuera de la zona y querer
          guardar su casa igual —para mandarle algo a un familiar, o porque
          la cobertura crece—, y un botón bloqueado ahí sería un callejón
          sin salida. Lo que sí evita es que se entere en el checkout.
        */}
        {outOfCoverage ? (
          <Notice tone="warning">
            {coverage?.reason || 'Todavía no repartimos en esta dirección.'} Puedes guardarla
            de todas formas, pero aún no podremos llevarte pedidos ahí.
          </Notice>
        ) : null}
      </View>

      <PlainField
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
          place && !streetEdited.current
            ? 'La tomamos del mapa. Corrígela si le falta el número.'
            : undefined
        }
      />

      {/*
        El piso tiene campo propio y no vive dentro de "cómo llegar" porque
        es el único dato del domicilio que ningún mapa puede saber: la
        coordenada llega al portal, nunca a la puerta. Mezclado entre las
        referencias se perdía — esa nota se lee entera, de corrido y con la
        moto encendida.
      */}
      <PlainField
        label="Piso o apartamento (opcional)"
        icon="edificio"
        placeholder="Torre B, apto 502"
        value={apartment}
        onChangeText={setApartment}
      />

      <PlainField
        label="Cómo llegar (opcional)"
        icon="info"
        placeholder="Portón negro, timbre 2, al lado de la tienda"
        value={details}
        onChangeText={setDetails}
        hint="Lo que le dirías a alguien que nunca ha ido."
      />

      {/*
        Desplegable y no chips: en un formulario ya largo, una lista que se
        abre solo cuando hace falta pesa menos que cuatro opciones siempre
        pintadas. "Escribir otro nombre" es una fila más de la lista, no un
        campo aparte, para que elegir y escribir sean el mismo gesto.
      */}
      <View style={styles.labelField}>
        <Text v="strongS" tone="textSecondary">¿Cómo la llamas?</Text>

        {customLabel ? (
          <>
            <PlainField
              label="Nombre"
              icon="ubicacion"
              placeholder="Casa de mis papás, la oficina…"
              value={label}
              onChangeText={(t) => { setLabel(t); setError(''); }}
            />
            <Pressable
              onPress={() => { tap('light'); setCustomLabel(false); setLabelPickerOpen(true); }}
              accessibilityRole="button"
              accessibilityLabel="Elegir un nombre de la lista"
              hitSlop={8}
              style={styles.labelSwitch}
            >
              <Text v="strongS" color={c.primaryText}>Elegir de la lista</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Pressable
              onPress={() => { tap('light'); setLabelPickerOpen((open) => !open); }}
              accessibilityRole="button"
              accessibilityState={{ expanded: labelPickerOpen }}
              accessibilityLabel={
                label ? `Nombre: ${label}. Toca para cambiarlo` : 'Elige un nombre para la dirección'
              }
              style={styles.labelTrigger}
            >
              <Icon name="ubicacion" size="sm" color={c.textMuted} />
              <Text v="bodyM" tone={label ? 'text' : 'textMuted'} style={styles.flexText} numberOfLines={1}>
                {label || 'Elige un nombre'}
              </Text>
              <Icon name={labelPickerOpen ? 'plegar' : 'desplegar'} size="sm" color={c.textMuted} />
            </Pressable>
            <View style={[styles.labelLine, { backgroundColor: c.border }]} />

            {labelPickerOpen ? (
              <View accessibilityRole="radiogroup">
                {LABEL_PRESETS.map((preset, index) => {
                  const active = label === preset.name;
                  const PresetIcon = preset.illustration;
                  return (
                    <Pressable
                      key={preset.name}
                      onPress={() => {
                        tap('select'); setLabel(preset.name); setError(''); setLabelPickerOpen(false);
                      }}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                      style={[
                        styles.labelOption,
                        index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
                      ]}
                    >
                      <PresetIcon size={22} />
                      <Text v={active ? 'strongS' : 'bodyM'} style={styles.flexText}>{preset.name}</Text>
                      {active ? <Icon name="check" size="sm" color={c.primaryText} /> : null}
                    </Pressable>
                  );
                })}

                <Pressable
                  onPress={() => { tap('select'); setCustomLabel(true); setLabelPickerOpen(false); setError(''); }}
                  accessibilityRole="button"
                  accessibilityLabel="Escribir otro nombre"
                  style={[styles.labelOption, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border }]}
                >
                  <PinAddressIllustration size={22} />
                  <Text v="bodyM" style={styles.flexText}>Escribir otro nombre</Text>
                </Pressable>
              </View>
            ) : null}
          </>
        )}
      </View>

      {error ? (
        <View style={styles.locationErrorBlock}>
          <Notice tone="error">{error}</Notice>
          {errorReason === 'permission' ? (
            <Button
              title="Abrir ajustes"
              variant="secondary"
              size="sm"
              onPress={() => { tap('light'); Linking.openSettings().catch(() => {}); }}
            />
          ) : null}
        </View>
      ) : null}
    </Sheet>

    {/*
      El mapa grande es una hoja hermana, no una capa dentro de la anterior.

      React Native solo tolera un `Modal` nativo visible a la vez, así que
      la del formulario se oculta mientras esta está abierta — el mismo
      arreglo que ya usa el selector del checkout. Ocultarla no la
      desmonta: lo escrito en los campos sigue ahí al volver.
    */}
    <Sheet
      visible={visible && expanded}
      onClose={() => setExpanded(false)}
      title={coords ? 'Ajusta el punto' : 'Marca el punto'}
      height={0.94}
      scroll={false}
      footer={
        <View style={styles.fullMapFooter}>
          <Text v="strongM" numberOfLines={1}>
            {street || 'Sin dirección todavía'}
          </Text>
          <Text v="caption" tone={quality.tone} numberOfLines={2}>
            {quality.message}
          </Text>
          <Button
            title="Confirmar ubicación"
            size="lg"
            full
            disabled={!coords}
            onPress={() => { setExpanded(false); recenter(); }}
            haptic="medium"
          />
        </View>
      }
    >
      {/*
        Solo se monta cuando está abierto. Dos WebViews de mapa vivos a la
        vez es memoria gastada en uno que nadie está mirando, y además el
        oculto seguiría respondiendo a los recentrados.
      */}
      {expanded ? (
        <ZippMap
          pick
          height={fullMapHeight}
          zoom={17}
          center={coords ? { lat: coords.latitude, lng: coords.longitude } : null}
          recenterKey={recenterKey}
          onPick={handlePick}
        />
      ) : null}
    </Sheet>
    </>
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
   * `AddressFormSheet` va como hermana de la hoja de lista, no anidada dentro.
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
        footer={<AddAddressButton onPress={() => setCreating(true)} />}
      >
        <AddressList
          selectedId={selectedId}
          onSelect={(address) => { onSelect(address); onClose(); }}
        />
      </Sheet>

      <AddressFormSheet
        visible={visible && creating}
        onClose={() => setCreating(false)}
        onSaved={(address) => {
          setCreating(false);
          onSelect(address);
          onClose();
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  locationErrorBlock: { gap: 8 },
  list: {},

  // Fila de dirección, sin caja: separadores en vez de bordes
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
  },
  rowInfo: {
    flex: 1,
    gap: 3,
  },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  rowLabel: {
    flexShrink: 1,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  rowWarning: {
    marginTop: 2,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  defaultInlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  activeDot: {
    width: 6.5,
    height: 6.5,
    borderRadius: 4,
    backgroundColor: '#10B981',
  },
  boldBadgeText: {
    fontWeight: '700',
  },
  radioIndicator: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardStreet: {
    lineHeight: 20,
  },
  detailsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 3,
  },
  detailsText: {
    flex: 1,
  },

  // Acciones de la fila
  makeDefaultBtn: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  makeDefaultText: {
    fontWeight: '700',
  },
  iconBtn: {
    padding: Spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    paddingTop: 2,
  },

  // Estado vacío, también sin caja
  empty: {
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.xxl,
  },
  emptyTitle: {
    textAlign: 'center',
    marginTop: Spacing.xs,
  },
  emptyText: {
    textAlign: 'center',
    paddingHorizontal: Spacing.md,
  },

  // Agregar dirección: contorno, sin relleno
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    height: 52,
    borderRadius: BorderRadius.md,
    borderWidth: 1.5,
  },

  // Nombre de la dirección: desplegable sin caja, línea fina en vez de borde
  labelField: { gap: Spacing.sm },
  labelTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    height: 40,
  },
  labelLine: { height: StyleSheet.hairlineWidth },
  labelOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
  },
  labelSwitch: { alignSelf: 'flex-start', paddingVertical: 2 },
  flexText: { flex: 1 },

  locate: { gap: Spacing.sm },
  mapFrame: { overflow: 'hidden', borderRadius: BorderRadius.lg },
  /** Etiqueta flotante sobre la vista previa del mapa. */
  mapHint: {
    position: 'absolute',
    bottom: Spacing.sm,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: 999,
  },
  fullMapFooter: { gap: Spacing.sm },

  // Sugerencias del buscador de direcciones, sin caja: separadores finos
  suggestions: {},
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  suggestionText: {
    flex: 1,
    gap: 1,
  },
  suggestionEmpty: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
});
