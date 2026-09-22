import { useRef, useState } from 'react';
import { ImagePlus, Pencil, Trash2, AlertCircle, RefreshCw } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import ImageEditor, { type Aspect } from './ImageEditor';

/**
 * El logo o la portada del comercio, de principio a fin.
 *
 * Sube al momento y no al guardar el formulario, igual que la foto de un
 * producto: una imagen es un cambio que el comercio quiere **ver** antes de
 * quedarse tranquilo, y dejarla esperando a un botón de guardar al otro
 * extremo de la pantalla es cómo se acaba subiendo la misma foto tres veces
 * porque no parecía haber pasado nada.
 *
 * El recorte es obligatorio y su proporción la fija la pantalla de destino,
 * no el comercio. Ver la cabecera de `ImageEditor`.
 */

export type ImageSlot = 'logo' | 'cover';

const SLOT: Record<ImageSlot, { aspect: Aspect; endpoint: string; frame: string }> = {
  // El logo se pinta en un círculo dentro de la app, así que se recorta
  // cuadrado: cualquier otra proporción perdería los bordes al enmascararla.
  logo: { aspect: { w: 1, h: 1 }, endpoint: 'logo', frame: 'w-24 h-24 rounded-full' },
  cover: { aspect: { w: 16, h: 9 }, endpoint: 'cover', frame: 'w-full aspect-video rounded-xl' },
};

interface Props {
  businessId: string;
  slot: ImageSlot;
  label: string;
  hint: string;
  /** URL actual, o null si no hay ninguna puesta. */
  value: string | null;
  onChange: (url: string | null) => void;
}

export default function BusinessImageField({
  businessId, slot, label, hint, value, onChange,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const { aspect, endpoint, frame } = SLOT[slot];

  const choose = (file: File | undefined) => {
    if (!file) return;
    setError('');
    setPicked(file);
    // Sin esto, elegir el mismo archivo dos veces seguidas —después de
    // cancelar el recorte— no dispara `change` y parece que el botón
    // dejó de funcionar.
    if (inputRef.current) inputRef.current.value = '';
  };

  const upload = async (cropped: Blob) => {
    try {
      setBusy(true);
      setError('');

      const form = new FormData();
      form.append('image', cropped, `${slot}.${cropped.type === 'image/png' ? 'png' : 'jpg'}`);

      // La cabecera va explícita: la instancia de axios declara
      // `application/json` para todo el panel, y con ese tipo puesto axios
      // serializa el FormData a JSON en vez de mandarlo como multipart. Con
      // `undefined` el navegador pone su propio Content-Type con el
      // boundary — es el mismo patrón que ya usa el resto del panel.
      const { data } = await api.post(`/businesses/${businessId}/${endpoint}`, form, {
        headers: { 'Content-Type': undefined },
      });

      onChange(data.data?.logo ?? data.data?.coverImage ?? null);
      setPicked(null);
    } catch (err) {
      setError(apiMessage(err, 'No se pudo subir la imagen.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      setBusy(true);
      setError('');
      await api.delete(`/businesses/${businessId}/image/${slot}`);
      onChange(null);
    } catch (err) {
      setError(apiMessage(err, 'No se pudo quitar la imagen.'));
    } finally {
      setBusy(false);
    }
  };

  if (picked) {
    return (
      <div className="space-y-2">
        <p className="text-xs font-bold text-[var(--color-text-main)]">{label}</p>
        <ImageEditor
          file={picked}
          aspect={aspect}
          busy={busy}
          onCancel={() => setPicked(null)}
          onConfirm={upload}
        />
        {error && <FieldError message={error} />}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-bold text-[var(--color-text-main)]">{label}</p>

      <div className="flex items-start gap-4">
        <div
          className={`${frame} shrink-0 overflow-hidden bg-[var(--color-bg-alt)] border border-[var(--color-border)] grid place-items-center`}
        >
          {value ? (
            <img src={value} alt="" className="w-full h-full object-cover" />
          ) : busy ? (
            <RefreshCw className="w-5 h-5 text-[var(--color-primary)] animate-spin" />
          ) : (
            <ImagePlus className="w-5 h-5 text-[var(--color-text-muted)]" />
          )}
        </div>

        <div className="flex-1 space-y-2 min-w-0">
          <p className="text-xs text-[var(--color-text-secondary)]">{hint}</p>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
            >
              <Pencil className="w-3.5 h-3.5" />
              {value ? 'Cambiar' : 'Subir'}
            </button>

            {value && (
              <button
                type="button"
                disabled={busy}
                onClick={remove}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-[var(--color-border)] text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Quitar
              </button>
            )}
          </div>

          {error && <FieldError message={error} />}
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(event) => choose(event.target.files?.[0])}
      />
    </div>
  );
}

function FieldError({ message }: { message: string }) {
  return (
    <p className="text-xs font-semibold text-[var(--color-danger)] flex items-start gap-1.5">
      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      {message}
    </p>
  );
}
