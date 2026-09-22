import { useEffect, useMemo, useState } from 'react';
import { View, PixelRatio, StyleSheet, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useIsFocused } from 'expo-router';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue, useAnimatedStyle, useFrameCallback, useReducedMotion,
  type SharedValue,
} from 'react-native-reanimated';
import { CategoryTile } from './CategoryTile';
import { Spacing } from '../../theme/tokens';

export interface MarqueeCategory {
  key: string;
  label: string;
  /** Imagen configurada por el admin; si falta, `CategoryTile` cae en la ilustración local. */
  imageUrl?: string;
  /** Color de respaldo del panel; solo pinta cuando no hay imagen. */
  color?: string;
  onPress: () => void;
}

/**
 * Ancho fijo de cada cuadro. La clave del "letrero led": los cuadros no se
 * encogen cuando se agregan categorías —se agrega pista, no se aprieta la
 * fila—. Coincide de cerca con lo que medían las 5 tarjetas del grid viejo.
 */
const TILE_WIDTH = 76;
const GAP = Spacing.md;

/**
 * Velocidad del arrastre automático, en píxeles por segundo. Bajo a
 * propósito: se lee de reojo, no compite con el resto del Home.
 */
const SPEED_PX_PER_SEC = 22;

/** Tope de avance por frame: si el hilo JS se congeló, no damos un tirón. */
const MAX_STEP_MS = 50;

/**
 * Píxeles físicos por punto. A 22 pt/s el letrero avanza menos de un píxel
 * físico por frame en pantallas de 90/120 Hz: sin redondear, las imágenes se
 * dibujan en posiciones fraccionarias (se suavizan y se enfocan alternando)
 * mientras el texto salta de píxel en píxel, y el cuadro parece temblar.
 */
const PX = PixelRatio.get();

/**
 * Cuánto se queda quieto el letrero, después de que el usuario lo soltó,
 * antes de volver a desplazarse solo.
 *
 * Es un *worklet*: corre en el hilo de UI (lo llama el bucle de animación).
 * Mantén el cuerpo simple —números y condiciones—, sin imports ni estado de
 * React.
 *
 * TODO(diseño): afina el comportamiento de reanudación. Otras variantes:
 *   - `return null` (no reanudar) hasta que el usuario salga del Home.
 *   - `return 0` (reanudar de inmediato) salvo que soltara a mitad de gesto.
 *   - Escalar la pausa con cuántas veces ya interactuó en esta sesión.
 *
 * @param settledAligned  el letrero quedó casi cuadrado con un cuadro (no a
 *                          medio paso entre dos)
 * @returns ms a esperar antes de reanudar, o `null` para no reanudar
 */
export function resumeDelayFor(settledAligned: boolean): number | null {
  'worklet';
  // Si quedó mirando un cuadro de frente, parece intencional: dale más aire.
  return settledAligned ? 6000 : 3000;
}

/**
 * Carrusel de categorías del Home con desplazamiento automático tipo letrero.
 *
 * Una sola fila se traslada a la izquierda mediante un valor compartido que
 * vive en el hilo de UI; el contenido son varias tandas idénticas de cuadros
 * y la traslación se envuelve por módulo del ancho de una tanda. Como no hay
 * ningún scroll nativo de por medio, no hay bucle de realimentación ni saltos
 * en la costura: el letrero corre parejo.
 *
 * Al tocar, un gesto de arrastre horizontal deja al usuario recorrer la fila
 * en cualquier sentido; el movimiento automático se detiene y vuelve según
 * `resumeDelayFor`. Con "Reducir movimiento" no hay arrastre automático: la
 * fila queda quieta y se recorre solo con el dedo.
 *
 * `offscreen` lo calcula la pantalla que lo contiene (solo ella conoce su
 * scroll): mientras sea `true` el letrero no avanza. Un valor animado que
 * cambia obliga a dibujar un frame nuevo en cada vsync aunque la vista esté
 * fuera de pantalla; quieto, el teléfono no dibuja nada.
 */
export function CategoryMarquee({
  categories, offscreen,
}: {
  categories: MarqueeCategory[];
  offscreen?: SharedValue<boolean>;
}) {
  const { width } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const focused = useIsFocused();

  const tx = useSharedValue(0);          // traslación actual, siempre en (-groupW, 0]
  const groupW = useSharedValue(0);      // ancho de UNA tanda
  const paused = useSharedValue(false);  // dedo sobre el letrero
  const armResume = useSharedValue(false);
  const settledAligned = useSharedValue(false);
  const resumeAt = useSharedValue(0);    // timestamp (reloj del frame) hasta el que espera

  // Cuántas tandas hacen falta para tapar la pantalla más una tanda de
  // colchón, para que al envolver nunca asome un hueco. Antes de medir, dos.
  const [copies, setCopies] = useState(2);

  // El ancho de la tanda puede cambiar después de la primera medición —el
  // admin agrega/quita una categoría, o gira el teléfono— y `tx`/el gesto
  // envuelven usando `groupW.value`. Si nos quedáramos con la primera
  // medición para siempre, el envolvimiento usaría un ancho viejo y el
  // letrero saltaría o se trabaría al coser la costura. Por eso se remide en
  // cada layout, no solo la primera vez.
  const onGroupLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w <= 0 || w === groupW.value) return;
    // Reencuadra `tx` al nuevo ancho para no dar un tirón visible si la
    // tanda cambió de tamaño a mitad de ciclo.
    if (groupW.value > 0) {
      tx.value = ((tx.value % w) + w) % w - w;
    }
    groupW.value = w;
    setCopies(Math.max(2, Math.ceil(width / w) + 1));
  };

  const frame = useFrameCallback((info) => {
    'worklet';
    if (groupW.value === 0 || paused.value || offscreen?.value) return;

    const now = info.timestamp;
    if (armResume.value) {
      const wait = resumeDelayFor(settledAligned.value);
      resumeAt.value = wait == null ? Number.POSITIVE_INFINITY : now + wait;
      armResume.value = false;
    }
    if (now < resumeAt.value) return;

    const dt = Math.min(info.timeSincePreviousFrame ?? 16, MAX_STEP_MS) / 1000;
    let next = tx.value - SPEED_PX_PER_SEC * dt;
    if (next <= -groupW.value) next += groupW.value; // costura invisible: el contenido se repite cada tanda
    tx.value = next;
  }, false);

  // El bucle solo corre con el Home a la vista y sin "Reducir movimiento":
  // fuera de foco no gasta el hilo de UI, y con la preferencia activada la
  // fila se queda quieta y se recorre solo con el dedo.
  useEffect(() => {
    frame.setActive(focused && !reduceMotion);
  }, [frame, focused, reduceMotion]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        // El letrero vive dentro del scroll vertical del Home: solo reclama
        // el gesto cuando el movimiento es claramente horizontal.
        .activeOffsetX([-14, 14])
        .failOffsetY([-10, 10])
        .onBegin(() => {
          paused.value = true;
          resumeAt.value = 0;
        })
        .onChange((e) => {
          const g = groupW.value || 1;
          let next = (tx.value + e.changeX) % g;
          if (next > 0) next -= g; // mantener en (-g, 0] para que el bucle no se pierda
          tx.value = next;
        })
        .onFinalize(() => {
          paused.value = false;
          const cell = TILE_WIDTH + GAP;
          const f = ((tx.value % cell) + cell) % cell;
          settledAligned.value = Math.min(f, cell - f) < cell * 0.25;
          armResume.value = true;
        }),
    [groupW, paused, resumeAt, tx, settledAligned, armResume]
  );

  // `tx` acumula en decimales para que la velocidad sea exacta; lo que se
  // pinta va redondeado al píxel físico (ver `PX`).
  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: Math.round(tx.value * PX) / PX }],
  }));

  return (
    <View style={styles.viewport}>
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.row, rowStyle]}>
          {Array.from({ length: copies }, (_, copy) => (
            <View
              key={copy}
              style={styles.group}
              onLayout={copy === 0 ? onGroupLayout : undefined}
            >
              {categories.map((cat) => (
                <View key={`${copy}-${cat.key}`} style={styles.cell}>
                  <CategoryTile
                    categoryKey={cat.key}
                    label={cat.label}
                    imageUrl={cat.imageUrl}
                    color={cat.color}
                    onPress={cat.onPress}
                  />
                </View>
              ))}
            </View>
          ))}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  // Recorta en horizontal (los cuadros entran y salen por los lados); el aire
  // vertical deja respirar la sombra de cada cuadro sin que se corte.
  viewport: { overflow: 'hidden', paddingVertical: Spacing.xs },
  row: { flexDirection: 'row' },
  group: { flexDirection: 'row', gap: GAP, paddingRight: GAP },
  cell: { width: TILE_WIDTH },
});
