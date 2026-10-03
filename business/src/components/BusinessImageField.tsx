import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImagePlus, Pencil, Trash2, AlertCircle, X } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import ImageEditor, { type Aspect } from './ImageEditor';
import ConfirmDialog from './ConfirmDialog';

/**
 * El logo o la portada del comercio, editados sobre la propia cabecera del
 * perfil — donde el comercio ya los está viendo — y no en una segunda copia
 * dentro del formulario.
 *
 * Sube al momento y no al guardar el formulario, igual que la foto de un
 * producto: una imagen es un cambio que el comercio quiere **ver** antes de
 * quedarse tranquilo, y dejarla esperando a un botón de guardar al otro
 * extremo de la pantalla es cómo se acaba subiendo la misma foto tres veces
 * porque no parecía haber pasado nada.
 *
 * El recorte es obligatorio y su proporción la fija la pantalla de destino,
 * no el comercio. Ver la cabecera de `ImageEditor`. El encuadre va en un
 * modal porque el hueco de la cabecera es demasiado chico para recortar.
 */

export type ImageSlot = 'logo' | 'cover';

const SLOT: Record<ImageSlot, { aspect: Aspect; endpoint: string; noun: string; hint: string }> = {
  // El logo se pinta en un círculo dentro de la app, así que se recorta
  // cuadrado: cualquier otra proporción perdería los bordes al enmascararla.
  logo: {
    aspect: { w: 1, h: 1 },
    endpoint: 'logo',
    noun: 'logo',
    hint: 'En la app se muestra dentro de un círculo: deja lo importante en el centro.',
  },
  cover: {
    aspect: { w: 16, h: 9 },
    endpoint: 'cover',
    noun: 'portada',
    hint: 'Lo que quede dentro del marco es exactamente lo que sale en la app.',
  },
};

interface Props {
  businessId: string;
  slot: ImageSlot;
  /** URL actual, o null si no hay ninguna puesta. */
  value: string | null;
  onChange: (url: string | null) => void;
  /** Errores de quitar la imagen: se pintan en la pantalla, no aquí. */
  onError: (message: string) => void;
  className?: string;
}

export default function BusinessImageField({
  businessId, slot, value, onChange, onError, className = '',
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const { aspect, endpoint, noun, hint } = SLOT[slot];

  const openPicker = () => {
    setMenuOpen(false);
    inputRef.current?.click();
  };

  const choose = (file: File | undefined) => {
    if (!file) return;
    setUploadError('');
    setPicked(file);
    // Sin esto, elegir el mismo archivo dos veces seguidas —después de
    // cancelar el recorte— no dispara `change` y parece que el botón
    // dejó de funcionar.
    if (inputRef.current) inputRef.current.value = '';
  };

  const upload = async (cropped: Blob) => {
    try {
      setBusy(true);
      setUploadError('');

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
      setUploadError(apiMessage(err, 'No se pudo subir la imagen.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setConfirmRemove(false);
    try {
      setBusy(true);
      await api.delete(`/businesses/${businessId}/image/${slot}`);
      onChange(null);
    } catch (err) {
      onError(apiMessage(err, 'No se pudo quitar la imagen.'));
    } finally {
      setBusy(false);
    }
  };

  // Sin imagen, el botón abre directo el selector: no hay nada que quitar,
  // así que un menú de una sola opción sería un clic de más.
  const onTrigger = () => (value ? setMenuOpen((v) => !v) : openPicker());

  return (
    <div className={className}>
      {/* Mismo botón de icono para logo y portada: las dos son miniaturas
          en la cabecera del perfil. */}
      <button
        type="button"
        disabled={busy}
        onClick={onTrigger}
        aria-label={busy ? 'Subiendo…' : `${value ? 'Editar' : 'Subir'} ${slot === 'cover' ? 'portada' : 'logo'}`}
        title={busy ? 'Subiendo…' : `${value ? 'Editar' : 'Subir'} ${slot === 'cover' ? 'portada' : 'logo'}`}
        className="grid h-7 w-7 place-items-center rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] cursor-pointer disabled:opacity-60 disabled:cursor-wait"
      >
        {value ? <Pencil className="h-3.5 w-3.5" /> : <ImagePlus className="h-3.5 w-3.5" />}
      </button>

      {menuOpen && (
        <>
          <button
            type="button"
            aria-label="Cerrar menú"
            onClick={() => setMenuOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            role="menu"
            className={`absolute z-50 mt-1.5 w-44 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-md ${
              slot === 'cover' ? 'right-0' : 'left-0'
            }`}
          >
            <button
              type="button"
              role="menuitem"
              onClick={openPicker}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
            >
              <Pencil className="h-3.5 w-3.5" />
              Cambiar {noun}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { setMenuOpen(false); setConfirmRemove(true); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] cursor-pointer"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Quitar {noun}
            </button>
          </div>
        </>
      )}

      {/* Portal: la cabecera tiene `overflow-hidden` y la página entra con
          una animación que deja un `transform` puesto — cualquiera de los
          dos encierra a un `fixed` dentro de la portada. */}
      {picked && createPortal(
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Cancelar"
            onClick={() => !busy && setPicked(null)}
            className="absolute inset-0 bg-black/50 cursor-default"
          />
          <div
            role="dialog"
            aria-label={`Encuadrar ${noun}`}
            className="relative w-full max-w-xl max-h-[90vh] overflow-y-auto zipp-modal p-6 space-y-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-[var(--color-text-main)]">Encuadra tu {noun}</h3>
                <p className="mt-1 text-xs text-[var(--color-text-secondary)]">{hint}</p>
              </div>
              <button
                type="button"
                onClick={() => setPicked(null)}
                disabled={busy}
                aria-label="Cerrar"
                className="p-1 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <ImageEditor
              file={picked}
              aspect={aspect}
              busy={busy}
              onCancel={() => setPicked(null)}
              onConfirm={upload}
            />

            {uploadError && (
              <p className="text-xs font-semibold text-[var(--color-danger)] flex items-start gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                {uploadError}
              </p>
            )}
          </div>
        </div>,
        document.body
      )}

      {confirmRemove && createPortal(
        <ConfirmDialog
          title={`¿Quitar tu ${noun}?`}
          message={
            slot === 'cover'
              ? 'Tu ficha en la app mostrará el color del encabezado en su lugar.'
              : 'Tu ficha en la app quedará sin logo hasta que subas otro.'
          }
          confirmLabel="Quitar"
          onConfirm={remove}
          onCancel={() => setConfirmRemove(false)}
        />,
        document.body
      )}

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
