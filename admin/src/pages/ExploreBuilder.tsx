import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, AlertTriangle, History, PenLine, Plus, RefreshCw, Smartphone } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { fetchBusinessOptions } from '../lib/businessOptions';
import ConfirmDialog from '../components/ConfirmDialog';
import { useAuthStore } from '../stores/authStore';
import { Permission } from '../lib/permissions';
import { SectionList } from '../components/exploreBuilder/SectionList';
import { SectionEditor, type KnownProduct } from '../components/exploreBuilder/SectionEditor';
import { PhonePreview } from '../components/exploreBuilder/PhonePreview';
import { VersionHistory } from '../components/exploreBuilder/VersionHistory';
import {
  TYPE_HINT, TYPE_LABEL, duplicateSection, newSection, sectionTitle,
} from '../components/exploreBuilder/sections';
import type {
  BuilderOptions, DraftResponse, PreviewResponse, Section, SectionType,
} from '../components/exploreBuilder/types';

/**
 * El constructor de Explorar: diseñar la pantalla, no editar un JSON.
 *
 * A la izquierda el orden (01, 02, 03…), en el centro la sección elegida, a
 * la derecha la app de verdad dentro de un teléfono. Todo lo que se toca se
 * ve en la vista previa sin guardar ni publicar; la app no cambia hasta que
 * alguien publica, y publicar siempre deja una versión a la que volver.
 */

const PREVIEW_DEBOUNCE_MS = 600;
const ADD_ORDER: SectionType[] = ['products', 'discovery_band', 'promo', 'businesses'];

interface FieldError { field: string; message: string }

/** "body.sections.2.layout" → "Sección 03 · Mitad de precio: …" */
function describeErrors(err: unknown, sections: Section[], options: BuilderOptions | null): string[] {
  const errors = (err as { response?: { data?: { errors?: FieldError[] } } })?.response?.data?.errors;
  if (!errors?.length) return [apiMessage(err, 'No se pudo procesar el borrador.')];
  return errors.map(({ field, message }) => {
    const match = /sections\.(\d+)/.exec(field);
    if (!match) return message;
    const index = Number(match[1]);
    const section = sections[index];
    const name = section ? sectionTitle(section, options) : '';
    return `Sección ${String(index + 1).padStart(2, '0')}${name ? ` · ${name}` : ''}: ${message}`;
  });
}

export default function ExploreBuilder() {
  const queryClient = useQueryClient();
  const canManage = useAuthStore((s) => s.hasPermission(Permission.EXPLORE_MANAGE));

  const [options, setOptions] = useState<BuilderOptions | null>(null);
  const [businesses, setBusinesses] = useState<Array<{ _id: string; name: string }>>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [revision, setRevision] = useState(0);
  const [currentVersion, setCurrentVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string[]>([]);
  const [notice, setNotice] = useState('');

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewErrors, setPreviewErrors] = useState<string[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [knownProducts, setKnownProducts] = useState<Record<string, KnownProduct>>({});

  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [addOpen, setAddOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishNote, setPublishNote] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError([]);
    try {
      const [opts, draft, biz] = await Promise.all([
        api.get('/explore-layout/options'),
        api.get('/explore-layout/draft'),
        fetchBusinessOptions(queryClient),
      ]);
      const d: DraftResponse = draft.data.data;
      setOptions(opts.data.data);
      setBusinesses(biz.data.data ?? []);
      setSections(d.sections);
      setRevision(d.revision);
      setCurrentVersion(d.currentVersion);
      setDirty(false);
      setSelectedId((current) => (current && d.sections.some((s) => s.id === current) ? current : d.sections[0]?.id ?? null));
      if (d.dropped) setNotice(`Se descartaron ${d.dropped} sección(es) del borrador que ya no se podían leer.`);
    } catch (err) {
      setError([apiMessage(err, 'No se pudo cargar el constructor de Explorar.')]);
    } finally {
      setLoading(false);
    }
  }, [queryClient]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Vista previa: se resuelve el borrador local, con retardo ──
  const previewRequest = useRef(0);
  useEffect(() => {
    if (loading) return;
    const request = ++previewRequest.current;
    const timer = window.setTimeout(async () => {
      setPreviewLoading(true);
      try {
        const { data } = await api.post('/explore-layout/preview', { sections });
        if (request !== previewRequest.current) return;
        const result: PreviewResponse = data.data;
        setPreview(result);
        setPreviewErrors([]);
        // Los nombres de lo elegido a mano salen de aquí: el borrador solo guarda ids.
        const seen: Record<string, KnownProduct> = {};
        for (const section of result.sections as Array<{ type?: string; products?: Array<{ _id: string; name: string; businessName?: string }> }>) {
          if (section.type !== 'products') continue;
          for (const p of section.products ?? []) seen[p._id] = { name: p.name, businessName: p.businessName };
        }
        setKnownProducts((prev) => ({ ...prev, ...seen }));
      } catch (err) {
        if (request !== previewRequest.current) return;
        setPreviewErrors(describeErrors(err, sections, options));
      } finally {
        if (request === previewRequest.current) setPreviewLoading(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [sections, loading, options]);

  // Salir con cambios sin guardar pregunta antes, como cualquier editor.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // ── Edición local ──
  const update = (next: Section[]) => {
    setSections(next);
    setDirty(true);
    setNotice('');
  };
  const updateSection = (section: Section) => update(sections.map((s) => (s.id === section.id ? section : s)));

  const insertAfterSelected = (section: Section) => {
    const index = selectedId ? sections.findIndex((s) => s.id === selectedId) : sections.length - 1;
    const next = [...sections];
    next.splice(index + 1, 0, section);
    update(next);
    setSelectedId(section.id);
  };

  const addSection = (type: SectionType) => {
    setAddOpen(false);
    insertAfterSelected(newSection(type, options));
  };

  const duplicate = (id: string) => {
    const original = sections.find((s) => s.id === id);
    if (!original) return;
    const copy = duplicateSection(original);
    const index = sections.findIndex((s) => s.id === id);
    const next = [...sections];
    next.splice(index + 1, 0, copy);
    update(next);
    setSelectedId(copy.id);
  };

  const remove = (id: string) => {
    const index = sections.findIndex((s) => s.id === id);
    const next = sections.filter((s) => s.id !== id);
    update(next);
    if (selectedId === id) setSelectedId(next[Math.min(index, next.length - 1)]?.id ?? null);
    setConfirmDelete(null);
  };

  // ── Servidor ──
  const save = async (): Promise<number | null> => {
    setSaving(true);
    setError([]);
    try {
      const { data } = await api.put('/explore-layout/draft', { sections, revision });
      setRevision(data.data.revision);
      setDirty(false);
      return data.data.revision as number;
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      setError(status === 409
        ? ['Otra persona guardó el borrador antes que tú. Recarga para ver sus cambios: los tuyos sin guardar se perderán.']
        : describeErrors(err, sections, options));
      return null;
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = async () => {
    if (!dirty) {
      setNotice('No hay cambios por guardar.');
      return;
    }
    if ((await save()) !== null) setNotice('Borrador guardado. La app sigue igual hasta que publiques.');
  };

  /** Publicar nunca está gris: si falta algo, se dice qué. */
  const askPublish = () => {
    const blockers = preview?.blockers ?? [];
    if (previewErrors.length) {
      setError(['Antes de publicar, corrige lo que marca la vista previa.', ...previewErrors]);
      return;
    }
    if (blockers.length) {
      setError(['Antes de publicar:', ...blockers]);
      return;
    }
    setPublishOpen(true);
  };

  const publish = async () => {
    const rev = dirty ? await save() : revision;
    if (rev === null) {
      setPublishOpen(false);
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.post('/explore-layout/publish', { revision: rev, note: publishNote.trim() });
      setCurrentVersion(data.data.version);
      setPublishOpen(false);
      setPublishNote('');
      setNotice(`Publicado como versión ${data.data.version}. La app lo muestra en menos de un minuto.`);
    } catch (err) {
      setPublishOpen(false);
      setError(describeErrors(err, sections, options));
    } finally {
      setSaving(false);
    }
  };

  const restore = async (version: number, restoreMode: 'draft' | 'publish') => {
    if (dirty) {
      setHistoryOpen(false);
      setError(['Guarda o descarta tus cambios antes de restaurar una versión.']);
      return;
    }
    try {
      const { data } = await api.post(`/explore-layout/versions/${version}/restore`, { revision, mode: restoreMode });
      setHistoryOpen(false);
      await load();
      setNotice(restoreMode === 'publish'
        ? `La versión ${version} volvió a la app como versión ${data.data.publishedVersion}.`
        : `La versión ${version} está en el borrador. Revísala y publica cuando quieras.`);
    } catch (err) {
      setHistoryOpen(false);
      setError([apiMessage(err, 'No se pudo restaurar esa versión.')]);
    }
  };

  const selected = sections.find((s) => s.id === selectedId) ?? null;
  const readOnly = !canManage;

  if (loading && !options) {
    return (
      <div className="flex items-center justify-center py-24">
        <RefreshCw className="w-6 h-6 text-[var(--color-primary)] animate-spin" />
      </div>
    );
  }

  const buttonGhost = 'h-9 px-3.5 rounded-lg border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)] flex items-center gap-1.5 cursor-pointer hover:border-[var(--color-primary)] transition-colors';
  const buttonPrimary = 'h-9 px-4 rounded-lg bg-[var(--color-primary)] text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-60';

  return (
    <div className="space-y-3 animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Constructor de Explorar</h1>
          <p className="page-subtitle">
            {currentVersion
              ? `En la app: versión ${currentVersion}.`
              : 'Sin publicar todavía: la app muestra el Explorar de siempre.'}
            {dirty ? ' · Tienes cambios sin guardar.' : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={buttonGhost} onClick={() => setHistoryOpen(true)}>
            <History className="w-3.5 h-3.5" /> Historial
          </button>
          <button type="button" className={buttonGhost} onClick={() => setMode(mode === 'edit' ? 'preview' : 'edit')}>
            {mode === 'edit' ? <><Smartphone className="w-3.5 h-3.5" /> Solo vista previa</> : <><PenLine className="w-3.5 h-3.5" /> Editar</>}
          </button>
          {canManage ? (
            <>
              {dirty ? (
                <button type="button" className={buttonGhost} onClick={() => setConfirmDiscard(true)}>Descartar</button>
              ) : null}
              <button type="button" className={buttonGhost} onClick={saveDraft} disabled={saving}>Guardar borrador</button>
              <button type="button" className={buttonPrimary} onClick={askPublish} disabled={saving}>
                {saving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : null} Publicar
              </button>
            </>
          ) : null}
        </div>
      </div>

      {error.length ? (
        <div className="flex items-start gap-2.5 text-xs text-[var(--color-danger)]">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="space-y-1">{error.map((line, i) => <p key={i} className={i === 0 ? 'font-semibold' : ''}>{line}</p>)}</div>
        </div>
      ) : null}
      {notice ? <p className="text-xs text-[var(--color-text-secondary)]">{notice}</p> : null}
      {readOnly ? (
        <p className="text-xs text-[var(--color-text-secondary)]">Solo lectura: puedes mirar y previsualizar, pero no guardar ni publicar.</p>
      ) : null}

      <div className={`grid gap-8 ${mode === 'edit' ? 'xl:grid-cols-[320px_minmax(0,1fr)_auto]' : 'lg:grid-cols-[320px_minmax(0,1fr)]'}`}>
        {/* ── El orden ── */}
        <section className="space-y-3 min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">
            Orden de Explorar · {sections.length} {sections.length === 1 ? 'sección' : 'secciones'}
          </p>
          {sections.length ? (
            <SectionList
              sections={sections}
              selectedId={selectedId}
              onSelect={(id) => { setSelectedId(id); setMode('edit'); }}
              onChange={update}
              onDuplicate={duplicate}
              onDelete={(id) => setConfirmDelete(id)}
              options={options}
              readOnly={readOnly}
            />
          ) : (
            <p className="text-xs text-[var(--color-text-muted)] py-4">Explorar está vacío. Agrega una sección para empezar.</p>
          )}

          {canManage && sections.length < (options?.limits.maxSections ?? 24) ? (
            addOpen ? (
              <ul className="divide-y divide-[var(--color-border-light)] border-t border-[var(--color-border-light)]">
                {ADD_ORDER.map((type) => (
                  <li key={type}>
                    <button type="button" onClick={() => addSection(type)} className="w-full text-left py-3 cursor-pointer group">
                      <span className="block text-sm font-semibold text-[var(--color-text-main)] group-hover:text-[var(--color-primary)]">{TYPE_LABEL[type]}</span>
                      <span className="block text-[11px] text-[var(--color-text-secondary)] mt-0.5">{TYPE_HINT[type]}</span>
                    </button>
                  </li>
                ))}
                <li>
                  <button type="button" onClick={() => setAddOpen(false)} className="py-2 text-xs text-[var(--color-text-muted)] cursor-pointer">Cancelar</button>
                </li>
              </ul>
            ) : (
              <button type="button" onClick={() => setAddOpen(true)} className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-primary)] cursor-pointer pt-1">
                <Plus className="w-3.5 h-3.5" /> Agregar sección {selected ? 'debajo de la seleccionada' : ''}
              </button>
            )
          ) : null}

          {preview?.warnings.length || preview?.blockers.length || previewErrors.length ? (
            <div className="space-y-2 pt-4 border-t border-[var(--color-border-light)]">
              {[...previewErrors, ...(preview?.blockers ?? [])].map((line, i) => (
                <p key={`b${i}`} className="flex items-start gap-2 text-[11px] text-[var(--color-danger)]">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" /> {line}
                </p>
              ))}
              {(preview?.warnings ?? []).map((line, i) => (
                <p key={`w${i}`} className="flex items-start gap-2 text-[11px] text-[var(--color-warning)]">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" /> {line}
                </p>
              ))}
            </div>
          ) : null}
        </section>

        {/* ── La sección elegida ── */}
        {mode === 'edit' ? (
          <section className="min-w-0 xl:border-l xl:border-[var(--color-border-light)] xl:pl-8">
            {selected && options ? (
              <SectionEditor
                key={selected.id}
                section={selected}
                onChange={updateSection}
                options={options}
                businesses={businesses}
                knownProducts={knownProducts}
                onKnownProducts={(products) => setKnownProducts((prev) => ({ ...prev, ...products }))}
              />
            ) : (
              <p className="text-xs text-[var(--color-text-muted)]">Elige una sección de la lista para editarla.</p>
            )}
          </section>
        ) : null}

        {/* ── La app de verdad ── */}
        <section className={`${mode === 'preview' ? 'justify-self-center' : ''} xl:sticky xl:top-6 self-start`}>
          <PhonePreview sections={preview?.sections ?? null} loading={previewLoading} large={mode === 'preview'} />
        </section>
      </div>

      {confirmDelete ? (
        <ConfirmDialog
          title="Eliminar sección"
          message={`¿Quitar "${sectionTitle(sections.find((s) => s.id === confirmDelete)!, options)}" del borrador? Si no guardas, puedes descartar los cambios para recuperarla.`}
          confirmLabel="Eliminar"
          variant="danger"
          onConfirm={() => remove(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      ) : null}

      {confirmDiscard ? (
        <ConfirmDialog
          title="Descartar cambios"
          message="Vuelves al último borrador guardado. Lo que cambiaste desde entonces se pierde."
          confirmLabel="Descartar"
          variant="warning"
          onConfirm={() => { setConfirmDiscard(false); void load(); }}
          onCancel={() => setConfirmDiscard(false)}
        />
      ) : null}

      {publishOpen ? (
        <div className="fixed inset-0 z-[80] bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in" onClick={() => setPublishOpen(false)}>
          <div className="Zipp-modal w-full max-w-md rounded-2xl p-6 space-y-2.5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-[var(--color-text-main)]">Publicar Explorar</h3>
            <p className="text-xs text-[var(--color-text-secondary)]">
              {dirty ? 'Se guarda el borrador y ' : ''}la app muestra esta versión en menos de un minuto. Siempre podrás volver a una anterior desde el historial.
            </p>
            <label className="block space-y-1.5">
              <span className="block text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">Qué cambió (opcional)</span>
              <textarea
                value={publishNote}
                onChange={(e) => setPublishNote(e.target.value)}
                maxLength={200}
                rows={2}
                placeholder="Ej. Almuerzos arriba de 11 a 2:30"
                className="w-full rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3.5 py-2.5 text-xs text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:outline-none resize-none"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className={buttonGhost} onClick={() => setPublishOpen(false)}>Cancelar</button>
              <button type="button" className={buttonPrimary} onClick={publish} disabled={saving}>
                {saving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : null} Publicar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {historyOpen ? (
        <VersionHistory onClose={() => setHistoryOpen(false)} onRestore={restore} canManage={canManage} />
      ) : null}
    </div>
  );
}
