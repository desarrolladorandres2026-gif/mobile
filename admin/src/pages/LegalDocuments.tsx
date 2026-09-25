import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import api from '../services/api';
import { Permission } from '../lib/permissions';
import { PermissionGate } from '../components/PermissionGate';
import ConfirmDialog from '../components/ConfirmDialog';
import { apiMessage } from '../lib/apiError';

/**
 * Documentos legales versionados.
 *
 * Un documento publicado es la evidencia de lo que aceptó cada persona, así
 * que no se edita: para cambiarlo se publica una versión nueva. La anterior
 * queda archivada con sus aceptaciones intactas.
 */

type Kind = 'terms' | 'privacy' | 'habeas_data' | 'promotions' | 'cancellations' | 'payments' | 'delivery' | 'provider';

interface Doc {
  _id: string;
  kind: Kind;
  version: string;
  title: string;
  isActive: boolean;
  effectiveAt: string;
  changeNote?: string;
  acceptances: number;
  content?: string;
}

interface Acceptance {
  _id: string;
  version: string;
  acceptedAt: string;
  userId?: { name?: string; email?: string } | null;
}

const KIND_LABEL: Record<Kind, string> = {
  terms: 'Términos y condiciones',
  privacy: 'Política de privacidad',
  habeas_data: 'Autorización de tratamiento de datos (Ley 1581)',
  promotions: 'Promociones',
  cancellations: 'Cancelaciones y reembolsos',
  payments: 'Pagos',
  delivery: 'Entregas',
  provider: 'Condiciones para comercios y domiciliarios',
};

const day = (iso: string) => new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });

const EMPTY = { kind: 'terms' as Kind, version: '', title: '', content: '', changeNote: '' };

export default function LegalDocuments() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Doc | null>(null);
  const [acceptances, setAcceptances] = useState<{ rows: Acceptance[]; total: number } | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const { data } = await api.get('/legal/admin/documents');
      setDocs(data.data ?? []);
    } catch (err) {
      setError(apiMessage(err, 'No se pudieron cargar los documentos legales.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const byKind = useMemo(() => {
    const groups = new Map<Kind, Doc[]>();
    for (const doc of docs) groups.set(doc.kind, [...(groups.get(doc.kind) ?? []), doc]);
    return [...groups.entries()];
  }, [docs]);

  const hasPrevious = docs.some((d) => d.kind === form.kind);

  const open = async (doc: Doc) => {
    if (openId === doc._id) { setOpenId(null); return; }
    setOpenId(doc._id);
    setDetail(null);
    setAcceptances(null);
    try {
      const [full, who] = await Promise.all([
        api.get(`/legal/admin/documents/${doc._id}`),
        api.get(`/legal/admin/documents/${doc._id}/acceptances`, { params: { limit: 25 } }),
      ]);
      setDetail(full.data.data);
      setAcceptances(who.data.data);
    } catch (err) {
      setError(apiMessage(err, 'No se pudo abrir el documento.'));
    }
  };

  const publish = async () => {
    setConfirming(false);
    try {
      setError('');
      await api.post('/legal/admin/documents', {
        ...form,
        changeNote: form.changeNote.trim() || undefined,
      });
      setDrafting(false);
      setForm(EMPTY);
      await load();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo publicar el documento.'));
    }
  };

  const canPublish = form.version.trim() && form.title.trim().length >= 3 && form.content.trim().length >= 50 && (!hasPrevious || form.changeNote.trim());

  const fieldClass = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-main)]';

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Documentos legales</h1>
          <p className="page-subtitle">
            Cada versión publicada queda como evidencia y no se edita: para cambiar algo se publica una nueva.
          </p>
        </div>
        <PermissionGate permission={Permission.LEGAL_PUBLISH}>
          <button
            onClick={() => setDrafting(true)}
            className="flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-xs font-bold text-white"
          >
            <Plus className="h-4 w-4" /> Nueva versión
          </button>
        </PermissionGate>
      </div>

      {error && (
        <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
          <AlertCircle className="h-4 w-4" /> {error}
        </p>
      )}

      {drafting && (
        <div className="space-y-3 border-y border-[var(--color-border-light)] py-4">
          <div className="grid gap-3 md:grid-cols-3">
            <select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as Kind })}
              className={fieldClass}
            >
              {Object.entries(KIND_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <input
              value={form.version}
              onChange={(e) => setForm({ ...form, version: e.target.value })}
              placeholder="Versión (ej. 2026.09)"
              maxLength={30}
              className={fieldClass}
            />
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Título"
              maxLength={160}
              className={fieldClass}
            />
          </div>
          {hasPrevious && (
            <input
              value={form.changeNote}
              onChange={(e) => setForm({ ...form, changeNote: e.target.value })}
              placeholder="¿Qué cambió respecto a la versión anterior?"
              maxLength={500}
              className={fieldClass}
            />
          )}
          <textarea
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
            rows={12}
            placeholder="Texto completo del documento"
            className={fieldClass}
          />
          <p className="text-xs text-[var(--color-text-muted)]">
            Al publicar, esta versión pasa a ser la vigente en la app y la anterior se archiva. Revísala con tu asesor legal antes.
          </p>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => { setDrafting(false); setForm(EMPTY); }}
              className="cursor-pointer rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)]"
            >
              Cancelar
            </button>
            <button
              onClick={() => (canPublish ? setConfirming(true) : setError('Completa versión, título, texto (mínimo 50 caracteres)' + (hasPrevious ? ' y qué cambió.' : '.')))}
              className="cursor-pointer rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-xs font-bold text-white"
            >
              Publicar
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-secondary)]">Cargando…</p>
      ) : byKind.length === 0 ? (
        <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-muted)]">
          Aún no hay documentos legales publicados.
        </p>
      ) : (
        byKind.map(([kind, versions]) => (
          <section key={kind} className="space-y-1">
            <h2 className="pt-4 text-sm font-bold text-[var(--color-text-main)]">{KIND_LABEL[kind] ?? kind}</h2>
            <ul>
              {versions.map((doc) => {
                const isOpen = openId === doc._id;
                return (
                  <li key={doc._id} className="border-b border-[var(--color-border-light)] py-3">
                    <button onClick={() => open(doc)} className="flex w-full cursor-pointer items-center gap-2 text-left">
                      {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      <span className="font-semibold text-[var(--color-text-main)]">Versión {doc.version}</span>
                      <span className={`text-[10px] font-bold uppercase tracking-wider ${doc.isActive ? 'text-[var(--color-success)]' : 'text-[var(--color-text-muted)]'}`}>
                        {doc.isActive ? 'Vigente' : 'Archivada'}
                      </span>
                      <span className="text-xs text-[var(--color-text-muted)]">
                        {day(doc.effectiveAt)} · {doc.acceptances} aceptaci{doc.acceptances === 1 ? 'ón' : 'ones'}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="mt-3 space-y-3 pl-6">
                        {doc.changeNote && (
                          <p className="text-xs text-[var(--color-text-secondary)]"><span className="font-semibold">Qué cambió:</span> {doc.changeNote}</p>
                        )}
                        <p className="max-h-72 overflow-y-auto whitespace-pre-wrap border-l-2 border-[var(--color-primary)] pl-3 text-sm text-[var(--color-text-secondary)]">
                          {detail?._id === doc._id ? detail.content : 'Cargando…'}
                        </p>
                        {acceptances && (
                          <div>
                            <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                              Quién la aceptó ({acceptances.total})
                            </p>
                            {acceptances.rows.length === 0 ? (
                              <p className="text-xs text-[var(--color-text-muted)]">Nadie ha aceptado esta versión todavía.</p>
                            ) : (
                              <ul className="text-xs text-[var(--color-text-main)]">
                                {acceptances.rows.map((a) => (
                                  <li key={a._id} className="py-0.5">
                                    {a.userId?.name ?? 'Cuenta eliminada'}{a.userId?.email ? ` · ${a.userId.email}` : ''}
                                    <span className="ml-2 text-[var(--color-text-muted)]">{day(a.acceptedAt)}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {acceptances.total > acceptances.rows.length && (
                              <p className="text-xs text-[var(--color-text-muted)]">Se muestran las {acceptances.rows.length} más recientes.</p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}

      {confirming && (
        <ConfirmDialog
          title={`Publicar ${KIND_LABEL[form.kind]} ${form.version}`}
          message="Pasa a ser la versión vigente para todos y no se podrá editar. La anterior queda archivada."
          confirmLabel="Publicar"
          variant="warning"
          onConfirm={publish}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
