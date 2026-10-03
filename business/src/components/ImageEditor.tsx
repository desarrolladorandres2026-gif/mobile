import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RotateCw, RotateCcw, ZoomIn, ZoomOut, Move, X, Check, RefreshCw,
} from 'lucide-react';
import {
  MAX_ZOOM, MIN_ZOOM, SQUARE, clamp, clampCrop,
  type Aspect, type CropResult, type CropTransform,
} from '../lib/cropGeometry';
import { OUTPUT_WIDTH, drawCrop, exportCrop } from '../lib/cropRender';

/**
 * Encuadre de una foto antes de subirla.
 *
 * **El comercio no elige la proporción; la elige la pantalla donde va la
 * foto.** Un producto se recorta cuadrado porque el catálogo de ZIPP mezcla
 * fotos de decenas de comercios y la uniformidad es justo lo que hace que
 * una rejilla parezca un catálogo y no un tablón de anuncios; una portada
 * de negocio se recorta 16:9 porque ese es el hueco del encabezado. En los
 * dos casos la decisión está tomada de antemano: dejarla abierta devuelve
 * el problema a quien menos puede resolverlo.
 *
 * La imagen nunca se deforma. Lo único que se mueve es qué parte de la
 * foto cae dentro del marco: se desplaza, se acerca y se gira, y el
 * desplazamiento está acotado para que el marco siempre esté lleno —
 * nunca aparece un borde vacío.
 *
 * Escrito sobre `<canvas>` y eventos de puntero en vez de traer una
 * librería de recorte: son unas líneas de trigonometría, y a cambio el
 * editor usa los tokens de ZIPP y funciona igual con dedo y con ratón.
 */

export type { Aspect, CropResult, CropTransform } from '../lib/cropGeometry';

interface Props {
  /** La foto que el comercio acaba de elegir. */
  file: File;
  busy?: boolean;
  /**
   * Opciones que solo tienen sentido en el momento de subir.
   *
   * Se pintan aquí y no en la ficha del producto porque se aplican
   * durante la subida: cambiarlas después obligaría a volver a mandar el
   * archivo, y para entonces ya no lo tenemos.
   */
  extras?: React.ReactNode;
  /** Proporción del recorte. Por defecto cuadrada, como el catálogo. */
  aspect?: Aspect;
  /** Encuadre con el que se abre: el de un recorte anterior de la misma foto. */
  initial?: CropTransform;
  onCancel: () => void;
  onConfirm: (cropped: Blob, result: CropResult) => void | Promise<void>;
}

interface Offset {
  x: number;
  y: number;
}

export default function ImageEditor({
  file, busy = false, extras, aspect = SQUARE, initial, onCancel, onConfirm,
}: Props) {
  /** Alto que corresponde a un ancho dado, con la proporción pedida. */
  const heightFor = useCallback(
    (width: number) => Math.round((width * aspect.h) / aspect.w),
    [aspect.h, aspect.w]
  );

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null);
  /** Distancia entre dos dedos al empezar el pellizco. */
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());

  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(initial?.zoom ?? 1);
  const [rotation, setRotation] = useState(initial?.rotation ?? 0);
  /** En fracciones del ancho del marco, como `CropTransform`. */
  const [offset, setOffset] = useState<Offset>({ x: initial?.x ?? 0, y: initial?.y ?? 0 });

  // ── Carga ──
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      imageRef.current = image;
      setReady(true);
      setFailed(false);
      // Un encuadre heredado ya era válido para esta foto; acotarlo igual
      // cuesta nada y protege de uno que llegue de otra.
      setOffset((current) => clampCrop(current, image, rotation, zoom, aspect));
    };
    // Un archivo con extensión de imagen que el navegador no puede
    // decodificar es exactamente el "archivo corrupto" que hay que
    // rechazar antes de gastar una subida.
    image.onerror = () => setFailed(true);
    image.src = url;

    return () => URL.revokeObjectURL(url);
    // Solo al cambiar de archivo: el giro y el zoom del momento se leen al
    // cargar, no son motivo para volver a decodificar la foto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  /** Recorta el desplazamiento para que no se vea el fondo. */
  const clampOffset = useCallback(
    (next: Offset, currentZoom: number): Offset => {
      const image = imageRef.current;
      if (!image) return { x: 0, y: 0 };
      return clampCrop(next, image, rotation, currentZoom, aspect);
    },
    [rotation, aspect]
  );

  // ── Repintado de la vista previa ──
  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image || !ready) return;

    // A la resolución real de la pantalla: en un móvil retina, pintar a
    // 320 px lógicos deja la vista previa visiblemente peor que el
    // resultado, y el comercio juzga por lo que ve aquí.
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    const width = Math.round((canvas.clientWidth || 320) * ratio);
    const height = heightFor(width);

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    drawCrop(canvas, image, width, { zoom, rotation, x: offset.x, y: offset.y }, aspect);
  }, [ready, offset, zoom, rotation, heightFor, aspect]);

  // ── Gestos ──

  /** Ancho real del marco en pantalla. El alto sale de la proporción. */
  const displayWidth = () => canvasRef.current?.clientWidth || 320;

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    (event.target as Element).setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom };
      dragRef.current = null;
      return;
    }

    dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    // Pellizco para acercar: dos dedos mandan sobre el arrastre.
    if (pointersRef.current.size === 2 && pinchRef.current) {
      const [a, b] = [...pointersRef.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const next = clamp(
        pinchRef.current.zoom * (distance / pinchRef.current.distance),
        MIN_ZOOM,
        MAX_ZOOM
      );
      setZoom(next);
      setOffset((current) => clampOffset(current, next));
      return;
    }

    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;

    // El dedo se mueve en píxeles; el encuadre, en fracciones del marco.
    const width = displayWidth();
    const dx = (event.clientX - drag.x) / width;
    const dy = (event.clientY - drag.y) / width;
    dragRef.current = { id: drag.id, x: event.clientX, y: event.clientY };

    setOffset((current) => clampOffset({ x: current.x + dx, y: current.y + dy }, zoom));
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (dragRef.current?.id === event.pointerId) dragRef.current = null;
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const next = clamp(zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08), MIN_ZOOM, MAX_ZOOM);
    setZoom(next);
    setOffset((current) => clampOffset(current, next));
  };

  const rotate = (degrees: number) => {
    setRotation((current) => (current + degrees + 360) % 360);
    // El giro cambia qué lado sobresale, así que el desplazamiento
    // anterior puede haber quedado fuera de rango. Volver al centro es
    // más predecible que recortarlo a un punto arbitrario.
    setOffset({ x: 0, y: 0 });
  };

  const reset = () => {
    setZoom(1);
    setRotation(0);
    setOffset({ x: 0, y: 0 });
  };

  const applyZoom = (next: number) => {
    const clamped = clamp(next, MIN_ZOOM, MAX_ZOOM);
    setZoom(clamped);
    setOffset((current) => clampOffset(current, clamped));
  };

  // ── Exportación ──

  const confirm = async () => {
    const image = imageRef.current;
    if (!image) return;

    const transform: CropTransform = { zoom, rotation, x: offset.x, y: offset.y };
    const blob = await exportCrop(image, transform, aspect, file.type);
    if (blob) {
      await onConfirm(blob, {
        transform,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        width: OUTPUT_WIDTH,
        height: heightFor(OUTPUT_WIDTH),
      });
    }
  };

  // ── Interfaz ──

  if (failed) {
    return (
      <div className="space-y-3 text-center py-6">
        <p className="text-xs font-semibold text-[var(--color-danger)]">
          No pudimos abrir esa imagen. Puede estar dañada o en un formato que
          no reconocemos.
        </p>
        <button
          onClick={onCancel}
          className="px-4 py-2 rounded-md text-xs font-semibold border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
        >
          Elegir otra
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-muted)]">
        <Move className="w-3.5 h-3.5 shrink-0" />
        Arrastra para mover, pellizca o usa la rueda para acercar.
      </div>

      {/* Lienzo de recorte. El marco es el encuadre real de destino. */}
      <div
        className="relative mx-auto w-full max-w-[320px] rounded-md overflow-hidden bg-[var(--color-bg-alt)] select-none"
        style={{ aspectRatio: `${aspect.w} / ${aspect.h}` }}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          className="w-full h-full touch-none cursor-grab active:cursor-grabbing"
        />

        {!ready && (
          <div className="absolute inset-0 grid place-items-center">
            <RefreshCw className="w-5 h-5 text-[var(--color-primary)] animate-spin" />
          </div>
        )}

        {/* Guías de tercios: ayudan a centrar sin tapar la foto. */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute inset-y-0 left-1/3 w-px bg-white/25" />
          <div className="absolute inset-y-0 left-2/3 w-px bg-white/25" />
          <div className="absolute inset-x-0 top-1/3 h-px bg-white/25" />
          <div className="absolute inset-x-0 top-2/3 h-px bg-white/25" />
          <div className="absolute inset-0 ring-1 ring-inset ring-white/40 rounded-md" />
        </div>
      </div>

      {/* Zoom */}
      <div className="flex items-center gap-3 max-w-[320px] mx-auto">
        <button
          type="button"
          onClick={() => applyZoom(zoom - 0.25)}
          aria-label="Alejar"
          className="p-1.5 rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] cursor-pointer shrink-0"
        >
          <ZoomOut className="w-4 h-4" />
        </button>

        <input
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          aria-label="Nivel de acercamiento"
          onChange={(event) => applyZoom(Number(event.target.value))}
          className="flex-1 accent-[var(--color-primary)] cursor-pointer"
        />

        <button
          type="button"
          onClick={() => applyZoom(zoom + 0.25)}
          aria-label="Acercar"
          className="p-1.5 rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] cursor-pointer shrink-0"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
      </div>

      {/* Giro y reinicio */}
      <div className="flex items-center justify-center gap-2">
        <EditorButton onClick={() => rotate(-90)} icon={RotateCcw} label="Girar a la izquierda" />
        <EditorButton onClick={() => rotate(90)} icon={RotateCw} label="Girar a la derecha" />
        <EditorButton onClick={reset} icon={RefreshCw} label="Volver al encuadre original" />
      </div>

      {extras}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="flex-1 py-2 rounded-md text-xs font-semibold text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] cursor-pointer disabled:opacity-50"
        >
          <X className="w-3.5 h-3.5 inline mr-1.5 -mt-px" />
          Cancelar
        </button>
        <button
          type="button"
          onClick={confirm}
          disabled={!ready || busy}
          className="flex-1 py-2 rounded-md text-xs font-semibold text-[var(--zipp-obsidian)] bg-[var(--color-primary)] hover:bg-[var(--color-primary-light)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? (
            'Subiendo…'
          ) : (
            <>
              <Check className="w-3.5 h-3.5 inline mr-1.5 -mt-px" />
              Usar esta foto
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function EditorButton({
  onClick, icon: Icon, label,
}: {
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="p-2 rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-bg)] transition-colors cursor-pointer"
    >
      <Icon className="w-4 h-4" />
    </button>
  );
}
