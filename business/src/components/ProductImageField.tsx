import { useEffect, useRef, useState } from 'react';
import {
  ImagePlus, Pencil, Sparkles, Trash2, AlertCircle, RefreshCw, Info, Scissors, Undo2, Crop, RotateCw,
} from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import {
  ACTION_LABEL, isImageInProgress, productImageFileName, productImageStatus, type BackgroundAction,
} from '../lib/productImageStatus';
import ImageEditor from './ImageEditor';
import {
  cropSourcePixels, rotateCrop, type CropResult, type CropTransform,
} from '../lib/cropGeometry';
import { renderCrop } from '../lib/cropRender';
import SmartImage, { type ProductImages } from './SmartImage';
import type { Product } from '../lib/catalog';

/**
 * La foto de un producto, de principio a fin.
 *
 * Funciona en dos modos porque la subida necesita un producto que ya
 * exista —el endpoint es `/products/:id/image`— y al crear uno todavía no
 * hay identificador:
 *
 * · **Producto nuevo** (`productId` nulo): el recorte se guarda en
 *   memoria y el formulario lo sube en cuanto el producto existe. Obligar
 *   al comercio a guardar primero y volver a entrar para poner la foto
 *   sería convertir un paso en dos.
 *
 * · **Producto existente**: la subida es inmediata, y "Mejorar" y
 *   "Eliminar" actúan sobre el servidor al momento.
 *
 * Quitar el fondo es automático: la casilla viene marcada, la foto se
 * sube y se ve al instante con su fondo, y el recorte aparece solo unos
 * segundos después. Mientras tanto el formulario sigue usable. Si el
 * recorte falla, se queda la original y se ofrece reintentar.
 *
 * Ningún botón aparece si el servidor no puede cumplirlo.
 */

export interface ImageCapabilities {
  enabled: boolean;
  backgroundRemoval: boolean;
  maxBytes: number;
  minDimension: number;
  recommendedDimension: number;
  acceptedFormats: string[];
  aspectRatio: string;
}

/**
 * Un recorte que todavía no tiene producto al que ir.
 *
 * Lleva las opciones de subida y no solo el binario: si solo se pasara el
 * blob, la casilla que el comercio dejó marcada en el editor se perdería
 * al crear el producto y la foto se quedaría con su fondo.
 */
export interface PendingProductImage {
  blob: Blob;
  removeBackground: boolean;
  /** Medidas del archivo que se va a subir. */
  width: number;
  height: number;
  /** Píxeles de la foto original dentro del recorte: lo que decide la nitidez. */
  sourcePixels: number;
  /**
   * URL local del recorte, para pintarlo fuera del campo (la vista previa).
   * Vive lo que vive este campo: la libera al cambiar de foto o al desmontarse.
   */
  previewUrl: string;
}

/** Cada cuánto se pregunta por un recorte en curso. */
const POLL_MS = 3_000;

interface Props {
  /** Nulo mientras el producto no se ha creado. */
  productId: string | null;
  businessId: string;
  images: ProductImages | null;
  /** Por qué falló el último recorte y cuándo se pidió. */
  imageAsset?: Product['imageAsset'];
  capabilities: ImageCapabilities | null;
  /** Recorte pendiente de subir, en el alta de un producto nuevo. */
  onPendingChange: (pending: PendingProductImage | null) => void;
  /** El producto ya guardado que devuelve el servidor tras cada cambio. */
  onUpdated: (product: Product) => void;
  /** Presentación amplia para el alta de productos. */
  variant?: 'default' | 'hero';
}

export default function ProductImageField({
  productId,
  businessId,
  images,
  imageAsset,
  capabilities,
  onPendingChange,
  onUpdated,
  variant = 'default',
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  /** La foto abierta en el editor. */
  const [file, setFile] = useState<File | null>(null);
  /** Encuadre con el que se abre el editor; vacío es el de partida. */
  const [editorInitial, setEditorInitial] = useState<CropTransform | undefined>(undefined);
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  /**
   * La foto original del recorte pendiente y cómo se encuadró.
   *
   * Se conservan para "Recortar" y "Girar": los dos rehacen el recorte
   * desde la original, no desde el archivo ya exportado.
   */
  const [pending, setPending] = useState<{ source: File; crop: CropResult; blob: Blob } | null>(null);
  const [busy, setBusy] = useState<'upload' | 'enhance' | 'delete' | 'background' | 'rotate' | null>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  /**
   * Quitar el fondo al subir. Marcado por defecto: la función tiene que
   * sentirse automática, y desmarcarlo antes de subir es la forma de no
   * gastar un recorte en una foto que no lo necesita (un plato servido,
   * una foto de ambiente).
   */
  const [removeBackground, setRemoveBackground] = useState(true);
  const canRemoveBackground = Boolean(capabilities?.backgroundRemoval);

  const status = productImageStatus(
    images,
    imageAsset?.backgroundRemoval?.errorCode,
    canRemoveBackground
  );

  // Mientras el servidor recorta, se le pregunta por el producto hasta
  // verlo terminado. Con tope de tiempo (`isImageInProgress`): un recorte
  // que se alarga lo retoma el servidor más tarde y no hace falta tener
  // el panel preguntando mientras tanto.
  //
  // Un intervalo y no una consulta cacheada: una respuesta vieja guardada
  // en caché devolvería el estado anterior justo después de "Reintentar".
  // Aquí, al dejar de sondear, lo que siga en vuelo se descarta.
  const polling = Boolean(productId) && isImageInProgress({ images, imageAsset });
  const onUpdatedRef = useRef(onUpdated);
  useEffect(() => {
    onUpdatedRef.current = onUpdated;
  });

  useEffect(() => {
    if (!polling || !productId) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const { data } = await api.get(`/products/${productId}`);
        if (!cancelled) onUpdatedRef.current(data.data as Product);
      } catch {
        // Un fallo de red suelto: la siguiente vuelta lo vuelve a pedir.
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [polling, productId]);

  // La URL del objeto se libera al cambiarla o al desmontar: sin esto,
  // cada foto que el comercio prueba y descarta se queda en memoria.
  useEffect(() => {
    return () => { if (pendingPreview) URL.revokeObjectURL(pendingPreview); };
  }, [pendingPreview]);

  const acceptedFormats = capabilities?.acceptedFormats?.length
    ? capabilities.acceptedFormats
    : ['image/jpeg', 'image/png', 'image/webp'];
  const accept = acceptedFormats.join(',');
  const maxMb = capabilities ? Math.round(capabilities.maxBytes / (1024 * 1024)) : 8;
  const requirements = `JPG, PNG o WEBP · mínimo ${capabilities?.minDimension ?? 500} px · hasta ${maxMb} MB`;

  const pick = () => {
    setError('');
    inputRef.current?.click();
  };

  /** Una foto nueva, elegida o soltada: al editor, con el encuadre de partida. */
  const takeFile = (chosen: File) => {
    if (!acceptedFormats.includes(chosen.type)) {
      setError('Ese archivo no es una foto JPG, PNG o WEBP.');
      return;
    }

    if (capabilities && chosen.size > capabilities.maxBytes) {
      setError(
        `Esa foto pesa ${(chosen.size / (1024 * 1024)).toFixed(1)} MB y el máximo ` +
          `son ${maxMb} MB. Tómala de nuevo con menos resolución.`
      );
      return;
    }

    setError('');
    setEditorInitial(undefined);
    setFile(chosen);
  };

  const onFileChosen = (event: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    // El mismo archivo dos veces seguidas no dispara `change` si no se
    // limpia el valor: pasa siempre que alguien cancela el recorte y
    // vuelve a elegir la misma foto.
    event.target.value = '';
    if (chosen) takeFile(chosen);
  };

  const onDrop = (event: React.DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) takeFile(dropped);
  };

  /** Un recorte terminado, venga del editor o de "Girar". */
  const acceptCrop = async (blob: Blob, crop: CropResult, source: File) => {
    setFile(null);

    if (!productId) {
      // Producto nuevo: se guarda para subirlo en cuanto exista.
      if (pendingPreview) URL.revokeObjectURL(pendingPreview);
      const previewUrl = URL.createObjectURL(blob);
      setPendingPreview(previewUrl);
      setPending({ source, crop, blob });
      onPendingChange({
        blob,
        removeBackground: removeBackground && canRemoveBackground,
        width: crop.width,
        height: crop.height,
        sourcePixels: cropSourcePixels(crop),
        previewUrl,
      });
      return;
    }

    await upload(blob);
  };

  /** Reabre el editor sobre la original, con el encuadre que ya tenía. */
  const recrop = () => {
    if (!pending) return;
    setError('');
    setEditorInitial(pending.crop.transform);
    setFile(pending.source);
  };

  /** Gira 90° a la derecha sin abrir el editor. */
  const rotatePending = async () => {
    if (!pending) return;
    setBusy('rotate');
    setError('');
    try {
      const transform = rotateCrop(pending.crop.transform);
      const blob = await renderCrop(pending.source, transform);
      if (blob) await acceptCrop(blob, { ...pending.crop, transform }, pending.source);
    } catch (err) {
      setError(apiMessage(err, 'No pudimos girar la foto.'));
    } finally {
      setBusy(null);
    }
  };

  const upload = async (blob: Blob) => {
    if (!productId) return;
    setBusy('upload');
    setError('');
    try {
      const form = new FormData();
      form.append('businessId', businessId);
      form.append('image', blob, productImageFileName(blob));
      if (removeBackground && canRemoveBackground) form.append('removeBackground', 'true');

      // El Content-Type explícito evita que axios convierta el FormData a
      // JSON: la instancia declara 'application/json' por defecto, y con
      // ese tipo puesto la imagen nunca llega — llega el texto "{}".
      const { data } = await api.post(`/products/${productId}/image`, form, {
        headers: { 'Content-Type': undefined },
      });
      onUpdated(data.data);
      onPendingChange(null);
      setPending(null);
      if (pendingPreview) {
        URL.revokeObjectURL(pendingPreview);
        setPendingPreview(null);
      }
    } catch (err) {
      setError(apiMessage(err, 'No pudimos subir la imagen.'));
    } finally {
      setBusy(null);
    }
  };

  const toggleEnhance = async () => {
    if (!productId || !images) return;
    setBusy('enhance');
    setError('');
    try {
      const { data } = await api.patch(`/products/${productId}/image`, {
        businessId,
        enhance: !images.enhanced,
      });
      onUpdated(data.data);
    } catch (err) {
      setError(apiMessage(err, 'No pudimos cambiar la mejora.'));
    } finally {
      setBusy(null);
    }
  };

  /** Reintentar, quitar el fondo ahora, o elegir entre la original y el recorte. */
  const runBackgroundAction = async (action: BackgroundAction) => {
    if (!productId) return;
    setBusy('background');
    setError('');
    try {
      const { data } =
        action === 'use-original' || action === 'use-cutout'
          ? await api.patch(`/products/${productId}/image`, {
              businessId,
              useOriginal: action === 'use-original',
            })
          : await api.post(`/products/${productId}/image/background-removal`, { businessId });
      onUpdated(data.data);
    } catch (err) {
      setError(apiMessage(err, 'No pudimos cambiar la foto. Inténtalo de nuevo.'));
    } finally {
      setBusy(null);
    }
  };

  const removeImage = async () => {
    setError('');

    // Recorte que aún no ha salido del navegador: no hay nada que borrar
    // en el servidor.
    if (!productId || !images) {
      if (pendingPreview) URL.revokeObjectURL(pendingPreview);
      setPendingPreview(null);
      setPending(null);
      onPendingChange(null);
      return;
    }

    setBusy('delete');
    try {
      const { data } = await api.delete(`/products/${productId}/image`, {
        data: { businessId },
      });
      onUpdated(data.data);
    } catch (err) {
      setError(apiMessage(err, 'No pudimos eliminar la imagen.'));
    } finally {
      setBusy(null);
    }
  };

  // ── Editor abierto ──
  if (file) {
    return (
      <Frame variant={variant}>
        <ImageEditor
          file={file}
          initial={editorInitial}
          busy={busy === 'upload'}
          onCancel={() => setFile(null)}
          onConfirm={(blob, crop) => acceptCrop(blob, crop, file)}
          extras={
            // Solo si el servidor puede hacerlo: un botón que falla
            // siempre es peor que no tenerlo.
            canRemoveBackground ? (
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={removeBackground}
                  onChange={(event) => setRemoveBackground(event.target.checked)}
                  className="mt-0.5 accent-[var(--color-primary)]"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-main)]">
                    <Scissors className="w-3.5 h-3.5 text-[var(--color-primary)]" />
                    Quitar el fondo
                  </span>
                  <span className="block text-[11px] text-[var(--color-text-main)] mt-0.5 leading-relaxed">
                    Dejamos solo el producto, centrado en el catálogo. Tu foto
                    original se conserva y puedes volver a ella.
                  </span>
                </span>
              </label>
            ) : null
          }
        />
      </Frame>
    );
  }

  const hasSomething = Boolean(images || pendingPreview);
  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept={accept}
      onChange={onFileChosen}
      className="hidden"
    />
  );

  // ── Sin imagen ──
  if (!hasSomething) {
    const hero = variant === 'hero';
    return (
      <Frame variant={variant}>
        {fileInput}

        <button
          type="button"
          onClick={pick}
          onDragOver={(event) => {
            event.preventDefault();
            if (!dragging) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          disabled={capabilities?.enabled === false || busy === 'upload'}
          className={`w-full rounded-md border border-dashed transition-colors flex flex-col items-center justify-center cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-bg)] ${
            dragging
              ? 'border-[var(--color-primary)] bg-[var(--color-primary-bg)]'
              : 'border-[var(--color-border-strong)]'
          } ${hero ? 'mx-auto max-w-[300px] aspect-square px-6 gap-1.5' : 'py-8 gap-2'}`}
        >
          {busy === 'upload' ? (
            <RefreshCw className={`${hero ? 'w-8 h-8' : 'w-6 h-6'} text-[var(--color-primary)] animate-spin`} />
          ) : (
            <ImagePlus className={`${hero ? 'w-8 h-8' : 'w-6 h-6'} text-[var(--color-primary)]`} />
          )}
          <span className={`${hero ? 'text-sm' : 'text-xs'} font-semibold text-[var(--color-text-main)]`}>
            {busy === 'upload' ? 'Subiendo…' : hero ? 'Selecciona la foto que quieres cargar' : 'Agregar imagen'}
          </span>
          {hero && !busy ? (
            <span className="text-xs text-[var(--color-text-secondary)]">O arrástrala y suéltala aquí</span>
          ) : null}
          {capabilities?.enabled === false ? (
            <span className="text-[11px] text-[var(--color-text-main)] px-6 text-center font-semibold">
              La subida de imágenes no está disponible en este entorno.
            </span>
          ) : hero ? (
            <>
              <span className="mt-2 rounded-md bg-[var(--color-primary)] hover:bg-[var(--color-primary-light)] px-7 py-2 text-xs font-semibold text-[var(--zipp-obsidian)]">
                Seleccionar foto
              </span>
              <span className="mt-2 text-[11px] text-[var(--color-text-secondary)] text-center">
                {requirements}
              </span>
            </>
          ) : (
            <span className="text-[11px] text-[var(--color-text-main)] px-6 text-center font-semibold">
              {requirements}
            </span>
          )}
        </button>

        {error && <FieldError message={error} />}
      </Frame>
    );
  }

  const showSpinner = Boolean(busy) || (!pendingPreview && status.working);
  const caption = pendingPreview
    ? 'Se subirá al guardar el producto.'
    : status.message ?? 'Así se verá en el catálogo de ZIPP.';
  // Solo sobre la foto que aún no ha salido del navegador: reencuadrar una
  // ya subida es otra subida y otro recorte de fondo (con tope diario).
  const canReframe = Boolean(pendingPreview && pending);

  const actions = (
    <>
      {canReframe && (
        <>
          <Action icon={Crop} label="Recortar" onClick={recrop} disabled={!!busy} />
          <Action icon={RotateCw} label="Girar" onClick={rotatePending} disabled={!!busy} />
        </>
      )}

      <Action icon={Pencil} label="Cambiar" onClick={pick} disabled={!!busy} />

      {/*
        Las acciones del recorte y "Mejorar" solo tienen sentido sobre
        una imagen que ya está en el servidor: son ajustes de la
        entrega, no del archivo local.
      */}
      {images && !pendingPreview && status.action && (
        <Action
          icon={status.action === 'use-original' ? Undo2 : Scissors}
          label={ACTION_LABEL[status.action]}
          onClick={() => runBackgroundAction(status.action!)}
          disabled={!!busy}
          active={status.action === 'retry'}
        />
      )}

      {images && !pendingPreview && (
        <Action
          icon={Sparkles}
          label={images.enhanced ? 'Mejora activada' : 'Mejorar'}
          onClick={toggleEnhance}
          disabled={!!busy}
          active={images.enhanced}
        />
      )}

      <Action
        icon={Trash2}
        label="Eliminar"
        onClick={removeImage}
        disabled={!!busy}
        danger
      />
    </>
  );

  const enhancedNote = images?.enhanced && !pendingPreview ? (
    <p className="flex items-start gap-1.5 text-[10px] text-[var(--color-text-main)] leading-relaxed">
      <Info className="w-3 h-3 mt-px shrink-0" />
      Ajustamos luz, contraste y balance de blancos. Tu foto original
      se conserva: puedes desactivarlo cuando quieras.
    </p>
  ) : null;

  // ── Con imagen, en grande: el alta y la edición del producto ──
  if (variant === 'hero') {
    const details = pendingPreview && pending
      ? `${pending.crop.width} × ${pending.crop.height} px · ${formatBytes(pending.blob.size)} · ${formatLabel(pending.blob.type)}`
      : images
        ? `${images.width} × ${images.height} px`
        : '';

    return (
      <Frame variant={variant}>
        {fileInput}

        {details && (
          <p className="text-center text-[11px] text-[var(--color-text-secondary)]">
            Detalles de imagen:{' '}
            <span className="font-semibold text-[var(--color-text-main)] tabular">{details}</span>
          </p>
        )}

        <div className="relative mx-auto w-full max-w-[300px]">
          {pendingPreview ? (
            <img
              src={pendingPreview}
              alt="Vista previa del producto"
              className="w-full aspect-square rounded-md object-cover bg-[var(--color-bg-alt)]"
            />
          ) : (
            <SmartImage
              images={images}
              alt="Producto"
              base="detail"
              sizes="300px"
              priority
              className="w-full aspect-square rounded-md"
            />
          )}

          {showSpinner && (
            <div className="absolute inset-0 rounded-md bg-black/45 grid place-items-center">
              <RefreshCw className="w-6 h-6 text-white animate-spin" />
            </div>
          )}
        </div>

        <div className="flex flex-wrap justify-center gap-1.5">{actions}</div>

        <p
          className={`text-center text-[11px] leading-relaxed ${
            !pendingPreview && status.tone === 'warning'
              ? 'font-semibold text-[var(--color-warning)]'
              : 'text-[var(--color-text-secondary)]'
          }`}
          aria-live="polite"
        >
          {caption}
        </p>

        {enhancedNote}
        {error && <FieldError message={error} />}
      </Frame>
    );
  }

  // ── Con imagen: vista previa y acciones ──
  return (
    <Frame variant={variant}>
      {fileInput}

      <div className="flex items-start gap-4">
        <div className="relative shrink-0">
          {pendingPreview ? (
            // Recorte local: se ve exactamente lo que se va a subir.
            <img
              src={pendingPreview}
              alt="Vista previa del producto"
              className="w-28 h-28 rounded-md object-cover bg-[var(--color-bg-alt)]"
            />
          ) : (
            <SmartImage
              images={images}
              alt="Producto"
              base="detail"
              sizes="112px"
              priority
              className="w-28 h-28 rounded-md"
            />
          )}

          {showSpinner && (
            <div className="absolute inset-0 rounded-md bg-black/45 grid place-items-center">
              <RefreshCw className="w-5 h-5 text-white animate-spin" />
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0 space-y-2.5">
          <p
            className={`text-[11px] leading-relaxed ${
              !pendingPreview && status.tone === 'warning'
                ? 'font-semibold text-[var(--color-warning)]'
                : 'text-[var(--color-text-main)]'
            }`}
            aria-live="polite"
          >
            {caption}
          </p>

          <div className="flex flex-wrap gap-1.5">{actions}</div>

          {enhancedNote}
        </div>
      </div>

      {error && <FieldError message={error} />}
    </Frame>
  );
}

// ── Piezas ─────────────────────────────────────────────────────────────

/** 318 KB · 1,2 MB */
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString('es-CO', { maximumFractionDigits: 1 })} MB`;
}

/** image/jpeg → JPG */
function formatLabel(type: string): string {
  const subtype = type.split('/')[1] ?? '';
  return subtype === 'jpeg' ? 'JPG' : subtype.toUpperCase();
}

function Frame({ children, variant = 'default' }: { children: React.ReactNode; variant?: 'default' | 'hero' }) {
  return (
    <div className={variant === 'hero' ? 'space-y-3' : 'space-y-2.5'}>
      {variant === 'default' ? (
        <span className="block text-[11px] font-semibold text-[var(--color-text-main)]">
          Foto del producto
        </span>
      ) : null}
      {children}
    </div>
  );
}

function Action({
  icon: Icon, label, onClick, disabled, danger = false, active = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
}) {
  const tone = danger
    ? 'text-[var(--color-danger)] border-[var(--color-danger)]/30 hover:bg-[var(--color-danger-bg)]'
    : active
      ? 'text-[var(--color-primary)] border-[var(--color-primary)]/40 bg-[var(--color-primary-bg)]'
      : 'text-[var(--color-text-main)] border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-[11px] font-semibold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${tone}`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

function FieldError({ message }: { message: string }) {
  return (
    <p className="flex items-start gap-1.5 text-[11px] font-semibold text-[var(--color-danger)]">
      <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" />
      {message}
    </p>
  );
}
