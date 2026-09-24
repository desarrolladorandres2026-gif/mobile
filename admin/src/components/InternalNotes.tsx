import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { dateTime, relativeTime } from '../lib/drivers';
import type { NoteEntityType, NoteView, NotesPage } from '../lib/fichaTypes';
import ConfirmDialog from './ConfirmDialog';

/**
 * Notas internas de una ficha.
 *
 * Solo las ve y las escribe el equipo: nunca llegan al cliente, al comercio ni
 * al domiciliario. Son de solo añadir (una corrección es otra nota) y borrar
 * exige motivo. Sin notas no ocupa espacio: queda solo el campo para escribir.
 *
 * La ficha que lo aloja pone el título de la sección; aquí solo va el contenido.
 */

const MAX_LENGTH = 2000;
const PAGE_SIZE = 20;

export default function InternalNotes({
  entityType,
  entityId,
}: {
  entityType: NoteEntityType;
  entityId: string;
}) {
  const [items, setItems] = useState<NoteView[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState('');
  const [toDelete, setToDelete] = useState<NoteView | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  const params = useCallback(
    (before?: string | null) => ({
      entityType,
      entityId,
      limit: PAGE_SIZE,
      ...(before ? { before } : {}),
    }),
    [entityType, entityId],
  );

  const loadFirst = useCallback(async () => {
    try {
      setLoadError('');
      const { data } = await api.get('/admin/notes', { params: params() });
      const page = data.data as NotesPage;
      setItems(page.items ?? []);
      setNextBefore(page.nextBefore ?? null);
    } catch (err) {
      setLoadError(apiMessage(err, 'No se pudieron cargar las notas.'));
    } finally {
      setLoading(false);
    }
  }, [params]);

  useEffect(() => {
    setLoading(true);
    setItems([]);
    setNextBefore(null);
    void loadFirst();
  }, [loadFirst]);

  const loadMore = async () => {
    if (!nextBefore) return;
    try {
      setLoadingMore(true);
      setLoadError('');
      const { data } = await api.get('/admin/notes', { params: params(nextBefore) });
      const page = data.data as NotesPage;
      setItems((prev) => [...prev, ...(page.items ?? [])]);
      setNextBefore(page.nextBefore ?? null);
    } catch (err) {
      setLoadError(apiMessage(err, 'No se pudieron cargar más notas.'));
    } finally {
      setLoadingMore(false);
    }
  };

  const submit = async () => {
    const body = text.trim();
    // La acción no se deshabilita: si falta el texto, se lleva al campo.
    if (!body) {
      setPostError('Escribe la nota antes de guardarla.');
      fieldRef.current?.focus();
      return;
    }
    try {
      setPosting(true);
      setPostError('');
      const { data } = await api.post('/admin/notes', { entityType, entityId, body });
      setItems((prev) => [data.data as NoteView, ...prev]);
      setText('');
    } catch (err) {
      // 400 (tarjeta o largo), 403 (sin permiso) y 429 (demasiadas): completos.
      setPostError(apiMessage(err, 'No se pudo guardar la nota.'));
    } finally {
      setPosting(false);
    }
  };

  const confirmDelete = async (reason?: string) => {
    const note = toDelete;
    if (!note) return;
    setToDelete(null);
    try {
      setDeleteError('');
      await api.delete(`/admin/notes/${note._id}`, { data: { reason } });
      await loadFirst();
    } catch (err) {
      setDeleteError(apiMessage(err, 'No se pudo eliminar la nota.'));
    }
  };

  return (
    <div className="space-y-4">
      {loading ? (
        <p className="text-[var(--color-text-muted)]">Cargando notas…</p>
      ) : (
        <>
          {items.length > 0 && (
            <ul className="divide-y divide-[var(--color-border-light)]">
              {items.map((note) => {
                const deleted = Boolean(note.deletedAt);
                return (
                  <li key={note._id} className="flex items-start justify-between gap-3 py-2.5 first:pt-0">
                    <div className="min-w-0">
                      <p
                        className={`whitespace-pre-wrap break-words ${
                          deleted
                            ? 'text-[var(--color-text-muted)] line-through'
                            : 'text-[var(--color-text-main)]'
                        }`}
                      >
                        {note.body}
                      </p>
                      <p className="mt-0.5 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                        {note.author.name} · <span title={dateTime(note.createdAt)}>{relativeTime(note.createdAt)}</span>
                        {deleted && ` · eliminada ${relativeTime(note.deletedAt ?? undefined).toLowerCase()}`}
                      </p>
                    </div>
                    {note.canDelete && !deleted && (
                      <button
                        type="button"
                        onClick={() => setToDelete(note)}
                        aria-label="Eliminar nota"
                        className="shrink-0 cursor-pointer p-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {nextBefore && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="cursor-pointer text-xs font-semibold text-[var(--color-primary)]"
            >
              {loadingMore ? 'Cargando…' : 'Cargar más'}
            </button>
          )}
        </>
      )}

      {(loadError || deleteError) && (
        <p className="flex items-start gap-1.5 font-semibold text-[var(--color-danger)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {loadError || deleteError}
        </p>
      )}

      <div className="space-y-1.5">
        <textarea
          ref={fieldRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPostError('');
          }}
          rows={3}
          maxLength={MAX_LENGTH}
          placeholder="Nota interna: solo la ve el equipo"
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
        />
        <div className="flex items-start justify-between gap-3">
          <p className="text-[11px] text-[var(--color-text-muted)]">
            No escribas números de tarjeta ni datos sensibles. Las notas no se editan.
          </p>
          <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-muted)]">
            {text.length}/{MAX_LENGTH}
          </span>
        </div>
        {postError && (
          <p className="flex items-start gap-1.5 font-semibold text-[var(--color-danger)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {postError}
          </p>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={submit}
            disabled={posting}
            className="cursor-pointer rounded-lg bg-[var(--color-primary)] px-3.5 py-1.5 text-xs font-bold text-white disabled:opacity-60"
          >
            {posting ? 'Guardando…' : 'Añadir nota'}
          </button>
        </div>
      </div>

      {toDelete && (
        <ConfirmDialog
          title="Eliminar nota"
          message="La nota deja de verse para el equipo. Queda registrado quién la eliminó y por qué."
          confirmLabel="Eliminar"
          reason={{ label: 'Motivo', placeholder: 'Por qué se elimina', minLength: 5 }}
          onConfirm={confirmDelete}
          onCancel={() => setToDelete(null)}
        />
      )}
    </div>
  );
}
