import { useEffect, useRef, useState } from 'react';
import {
  ImagePlus, Pencil, Sparkles, Trash2, AlertCircle, RefreshCw, Info, Scissors,
} from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import ImageEditor from './ImageEditor';
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
 * Ningún botón aparece si el servidor no puede cumplirlo: el recorte de
 * fondo se pinta solo cuando la cuenta de Cloudinary tiene el complemento.
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
 * Lleva las opciones de subida y no solo el binario: el recorte de fondo
 * se aplica **durante** la subida, así que si solo se pasara el blob, la
 * casilla que el comercio marcó en el editor se perdería al crear el
 * producto y la foto subiría con su fondo.
 */
export interface PendingProductImage {
  blob: Blob;
  removeBackground: boolean;
}

interface Props {
  /** Nulo mientras el producto no se ha creado. */
  productId: string | null;
  businessId: string;
  images: ProductImages | null;
  capabilities: ImageCapabilities | null;
  /** Recorte pendiente de subir, en el alta de un producto nuevo. */
  onPendingChange: (pending: PendingProductImage | null) => void;
  /** El producto ya guardado que devuelve el servidor tras cada cambio. */
  onUpdated: (product: Product) => void;
}

export default function ProductImageField({
  productId,
  businessId,
  images,
  capabilities,
  onPendingChange,
  onUpdated,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<'upload' | 'enhance' | 'delete' | null>(null);
  const [error, setError] = useState('');
  /**
   * Recorte de fondo, si la cuenta de Cloudinary tiene el complemento.
   *
   * Se decide antes de subir porque se aplica durante la subida: no es un
   * interruptor de la URL como la mejora, y cambiarlo después exigiría el
   * archivo original, que ya no está en el navegador.
   */
  const [removeBackground, setRemoveBackground] = useState(false);

  // La URL del objeto se libera al cambiarla o al desmontar: sin esto,
  // cada foto que el comercio prueba y descarta se queda en memoria.
  useEffect(() => {
    return () => { if (pendingPreview) URL.revokeObjectURL(pendingPreview); };
  }, [pendingPreview]);

  const accept = capabilities?.acceptedFormats?.join(',') || 'image/jpeg,image/png,image/webp';
  const maxMb = capabilities ? Math.round(capabilities.maxBytes / (1024 * 1024)) : 8;

  const pick = () => {
    setError('');
    inputRef.current?.click();
  };

  const onFileChosen = (event: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    // El mismo archivo dos veces seguidas no dispara `change` si no se
    // limpia el valor: pasa siempre que alguien cancela el recorte y
    // vuelve a elegir la misma foto.
    event.target.value = '';
    if (!chosen) return;

    if (capabilities && chosen.size > capabilities.maxBytes) {
      setError(
        `Esa foto pesa ${(chosen.size / (1024 * 1024)).toFixed(1)} MB y el máximo ` +
          `son ${maxMb} MB. Tómala de nuevo con menos resolución.`
      );
      return;
    }

    setError('');
    setFile(chosen);
  };

  /** Sale del editor con el recorte hecho. */
  const onCropped = async (blob: Blob) => {
    setFile(null);

    if (!productId) {
      // Producto nuevo: se guarda para subirlo en cuanto exista.
      if (pendingPreview) URL.revokeObjectURL(pendingPreview);
      setPendingPreview(URL.createObjectURL(blob));
      onPendingChange({ blob, removeBackground });
      return;
    }

    await upload(blob);
  };

  const upload = async (blob: Blob) => {
    if (!productId) return;
    setBusy('upload');
    setError('');
    try {
      const form = new FormData();
      form.append('businessId', businessId);
      form.append('image', blob, 'producto.jpg');
      if (removeBackground) form.append('removeBackground', 'true');

      const { data } = await api.post(`/products/${productId}/image`, form);
      onUpdated(data.data);
      onPendingChange(null);
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

  const removeImage = async () => {
    setError('');

    // Recorte que aún no ha salido del navegador: no hay nada que borrar
    // en el servidor.
    if (!productId || !images) {
      if (pendingPreview) URL.revokeObjectURL(pendingPreview);
      setPendingPreview(null);
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
      <Frame>
        <ImageEditor
          file={file}
          busy={busy === 'upload'}
          onCancel={() => setFile(null)}
          onConfirm={onCropped}
          extras={
            // Solo se pinta si el servidor dice que puede hacerlo. Es un
            // complemento de pago de Cloudinary que la mayoría de las
            // cuentas no tiene, y un botón que falla siempre es peor que
            // no tenerlo.
            capabilities?.backgroundRemoval ? (
              <label className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl border border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-surface-hover)] transition-colors">
                <input
                  type="checkbox"
                  checked={removeBackground}
                  onChange={(event) => setRemoveBackground(event.target.checked)}
                  className="mt-0.5 accent-[var(--color-primary)]"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-xs font-bold text-[var(--color-text-main)]">
                    <Scissors className="w-3.5 h-3.5 text-[var(--color-primary)]" />
                    Quitar el fondo
                  </span>
                  <span className="block text-[11px] text-[var(--color-text-muted)] mt-0.5 leading-relaxed">
                    Deja el producto sobre un fondo limpio con sombra suave.
                    Funciona mejor con objetos de contorno definido.
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

  // ── Sin imagen ──
  if (!hasSomething) {
    return (
      <Frame>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          onChange={onFileChosen}
          className="hidden"
        />

        <button
          type="button"
          onClick={pick}
          disabled={capabilities?.enabled === false}
          className="w-full rounded-2xl border border-dashed border-[var(--color-border-strong)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-bg)] transition-colors py-8 flex flex-col items-center gap-2 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <ImagePlus className="w-6 h-6 text-[var(--color-primary)]" />
          <span className="text-xs font-bold text-[var(--color-text-main)]">
            Agregar imagen
          </span>
          <span className="text-[11px] text-[var(--color-text-muted)] px-6 text-center">
            {capabilities?.enabled === false
              ? 'La subida de imágenes no está disponible en este entorno.'
              : `JPG, PNG o WEBP · mínimo ${capabilities?.minDimension ?? 500} px · hasta ${maxMb} MB`}
          </span>
        </button>

        {error && <FieldError message={error} />}
      </Frame>
    );
  }

  // ── Con imagen: vista previa y acciones ──
  return (
    <Frame>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={onFileChosen}
        className="hidden"
      />

      <div className="flex items-start gap-4">
        <div className="relative shrink-0">
          {pendingPreview ? (
            // Recorte local: se ve exactamente lo que se va a subir.
            <img
              src={pendingPreview}
              alt="Vista previa del producto"
              className="w-28 h-28 rounded-2xl object-cover bg-[var(--color-bg-alt)]"
            />
          ) : (
            <SmartImage
              images={images}
              alt="Producto"
              base="detail"
              sizes="112px"
              priority
              className="w-28 h-28 rounded-2xl"
            />
          )}

          {busy && (
            <div className="absolute inset-0 rounded-2xl bg-black/45 grid place-items-center">
              <RefreshCw className="w-5 h-5 text-white animate-spin" />
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0 space-y-2.5">
          <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
            {pendingPreview
              ? 'Se subirá al guardar el producto.'
              : 'Así se verá en el catálogo de ZIPP.'}
          </p>

          <div className="flex flex-wrap gap-1.5">
            <Action icon={Pencil} label="Cambiar" onClick={pick} disabled={!!busy} />

            {/*
              "Mejorar" solo tiene sentido sobre una imagen que ya está en
              el servidor: es un ajuste de la URL de entrega, no del
              archivo. Sobre un recorte local no habría nada que cambiar.
            */}
            {images && (
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
          </div>

          {images?.enhanced && (
            <p className="flex items-start gap-1.5 text-[10px] text-[var(--color-text-muted)] leading-relaxed">
              <Info className="w-3 h-3 mt-px shrink-0" />
              Ajustamos luz, contraste y balance de blancos. Tu foto original
              se conserva: puedes desactivarlo cuando quieras.
            </p>
          )}
        </div>
      </div>

      {error && <FieldError message={error} />}
    </Frame>
  );
}

// ── Piezas ─────────────────────────────────────────────────────────────

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-2.5">
      <span className="block text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">
        Foto del producto
      </span>
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
      : 'text-[var(--color-text-secondary)] border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${tone}`}
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
