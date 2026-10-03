import { useRef, useState } from 'react';
import { AlertCircle, ImagePlus, Trash2 } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';

/**
 * Fotos adicionales de un producto.
 *
 * Van aparte de la principal, y no como "la primera de una lista", por lo
 * mismo en el panel que en el modelo: la principal es la que sale en la
 * carta, en el carrito y en el histórico de pedidos, y confundirla con una
 * más del montón es la forma de que un producto acabe sin miniatura.
 *
 * Solo aparece al editar un producto que ya existe. Una galería sin portada
 * no tiene sentido —el servidor la rechaza— y pedirla en el alta obligaría
 * a subir varias fotos antes de saber si el producto se guarda.
 */

interface GalleryImage {
  thumb: string;
  detail: string;
}

interface Props {
  productId: string;
  businessId: string;
  /** Variantes ya calculadas de cada foto adicional. */
  images: GalleryImage[];
  /** `publicId` de cada foto, en el mismo orden. Es lo que borra. */
  publicIds: string[];
  hasCover: boolean;
  onUpdated: (product: unknown) => void;
}

const MAX = 5;

export default function ProductGalleryField({
  productId,
  businessId,
  images,
  publicIds,
  hasCover,
  onUpdated,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const upload = async (file: File) => {
    setError('');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('businessId', businessId);
      form.append('image', file, file.name);
      // El Content-Type explícito evita que axios convierta el FormData a
      // JSON: la instancia declara 'application/json' por defecto, y con
      // ese tipo puesto la imagen nunca llega — llega el texto "{}".
      const { data } = await api.post(`/products/${productId}/gallery`, form, {
        headers: { 'Content-Type': undefined },
      });
      onUpdated(data.data);
    } catch (err) {
      setError(apiMessage(err, 'No pudimos subir la foto.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (publicId: string) => {
    setError('');
    setBusy(true);
    try {
      const { data } = await api.delete(`/products/${productId}/gallery`, {
        data: { businessId, publicId },
      });
      onUpdated(data.data);
    } catch (err) {
      setError(apiMessage(err, 'No pudimos borrar la foto.'));
    } finally {
      setBusy(false);
    }
  };

  if (!hasCover) {
    return (
      <p className="text-[11px] text-[var(--color-text-main)]">
        Sube primero la foto principal y podrás añadir hasta {MAX} fotos más.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold text-[var(--color-text-main)]">
          Fotos adicionales
        </span>
        <span className="text-[11px] text-[var(--color-text-main)]">
          {images.length} de {MAX}
        </span>
      </div>

      <p className="text-[11px] text-[var(--color-text-main)]">
        Las que enseñan lo que la portada no puede: el plato por dentro, el tamaño real, la
        etiqueta.
      </p>

      <div className="flex flex-wrap gap-2">
        {images.map((image, index) => (
          <div
            key={publicIds[index] ?? image.thumb}
            className="relative h-16 w-16 overflow-hidden rounded-md border border-[var(--color-border)]"
          >
            <img src={image.thumb} alt="" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => remove(publicIds[index])}
              disabled={busy}
              title="Quitar esta foto"
              className="absolute right-0.5 top-0.5 cursor-pointer rounded-md bg-black/60 p-1 text-white disabled:opacity-50"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}

        {images.length < MAX ? (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="flex h-16 w-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-[var(--color-border)] text-[var(--color-text-main)] transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
          >
            <ImagePlus className="h-4 w-4" />
            <span className="text-[10px] font-semibold">{busy ? '…' : 'Añadir'}</span>
          </button>
        ) : null}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          // Sin limpiar el valor, elegir el mismo archivo dos veces
          // seguidas no vuelve a disparar `change`.
          event.target.value = '';
          if (chosen) upload(chosen);
        }}
      />

      {error ? (
        <p className="flex items-start gap-1.5 text-[11px] font-semibold text-[var(--color-danger)]">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
