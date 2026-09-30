import { Fragment, useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Download, Eye, FileDown, Pencil, Upload } from 'lucide-react';
import api from '../services/api';
import ConfirmDialog from './ConfirmDialog';
import { PermissionGate } from './PermissionGate';
import { Permission } from '../lib/permissions';
import { apiMessage } from '../lib/apiError';
import { Section, actionButtonClass, primaryButtonClass, secondaryButtonClass, inputClass, fieldLabelClass } from './fichas/ui';
import {
  accountStatusLabels,
  contractStatusLabels,
  dossierDateTime,
  dossierDay,
  downloadDossierPdf,
  eventLabels,
  indicatorStyles,
  openDossierFile,
  toDateInput,
  type ContractFile,
  type ContractStatus,
  type Dossier,
  type DossierDocument,
  type HistoryEvent,
} from '../lib/dossier';

/**
 * Expediente digital de un domiciliario: perfil, papeles personales, papeles
 * del vehículo, contrato y auditoría, con el PDF consolidado.
 *
 * Todo lo que ve viene de `GET /drivers/:id/dossier`; los archivos se piden al
 * backend con el token del administrador (no hay enlaces del almacén) y cada
 * apertura queda auditada. Sin cajas: tablas donde hay datos comparables, y
 * líneas finas y espacio para separar el resto.
 */

/** Punto de color + texto. El texto siempre va: el color solo no basta. */
function Indicator({ value }: { value: keyof typeof indicatorStyles }) {
  const s = indicatorStyles[value];
  return (
    <span className={`inline-flex items-center gap-2 ${s.text}`}>
      <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

function Definition({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={fieldLabelClass}>{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-[var(--color-text-main)]">{children || '—'}</dd>
    </div>
  );
}

function HistoryList({ events, empty }: { events: HistoryEvent[]; empty: string }) {
  if (events.length === 0) return <p className="text-xs text-[var(--color-text-secondary)]">{empty}</p>;
  return (
    <ul className="space-y-1.5 text-xs">
      {events.map((e, i) => (
        <li key={`${e.at}-${i}`} className="flex flex-wrap gap-x-3">
          <span className="w-36 shrink-0 text-[var(--color-text-secondary)]">{dossierDateTime(e.at)}</span>
          <span className="font-semibold text-[var(--color-text-main)]">{eventLabels[e.action] ?? e.action}</span>
          <span className="text-[var(--color-text-secondary)]">{e.byName ?? 'Domiciliario'}</span>
          {e.note && <span className="min-w-0 text-[var(--color-text-main)]">— {e.note}</span>}
        </li>
      ))}
    </ul>
  );
}

type Mode = 'reject' | 'update' | 'note' | null;

const modeConfig: Record<Exclude<Mode, null>, { label: string; placeholder: string; submit: string; min: number }> = {
  reject: { label: 'Motivo del rechazo', placeholder: 'Qué debe corregir el domiciliario', submit: 'Rechazar documento', min: 5 },
  update: { label: 'Qué debe actualizar', placeholder: 'Se le avisa al domiciliario en la app', submit: 'Solicitar actualización', min: 5 },
  note: { label: 'Observación interna', placeholder: 'Solo la ve el equipo de ZIPP', submit: 'Registrar observación', min: 3 },
};

function DocumentDetail({
  doc,
  driverId,
  onDone,
}: {
  doc: DossierDocument;
  driverId: string;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const documentId = doc.documentId;
  if (!documentId) {
    return <p className="text-xs text-[var(--color-text-secondary)]">El domiciliario todavía no ha cargado este documento.</p>;
  }

  const run = async (request: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError('');
    try {
      await request();
      setMode(null);
      setText('');
      onDone();
    } catch (err) {
      setError(apiMessage(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const approve = () =>
    run(() => api.patch(`/drivers/documents/${documentId}/review`, { status: 'approved', revision: doc.revision }), 'No se pudo aprobar el documento.');

  const submitMode = () => {
    if (!mode) return;
    const cfg = modeConfig[mode];
    if (text.trim().length < cfg.min) {
      setError(`Escribe al menos ${cfg.min} caracteres.`);
      return;
    }
    const base = `/drivers/${driverId}/documents/${documentId}`;
    if (mode === 'reject') {
      return run(() => api.patch(`/drivers/documents/${documentId}/review`, { status: 'rejected', rejectionReason: text.trim(), revision: doc.revision }), 'No se pudo rechazar el documento.');
    }
    if (mode === 'update') {
      return run(() => api.post(`${base}/request-update`, { reason: text.trim() }), 'No se pudo enviar la solicitud.');
    }
    return run(() => api.post(`${base}/observations`, { note: text.trim() }), 'No se pudo registrar la observación.');
  };

  return (
    <div className="space-y-4 py-2">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-3">
        <Definition label="Número / referencia">{doc.reference}</Definition>
        <Definition label="Motivo del rechazo">{doc.rejectionReason}</Definition>
        <Definition label="Actualización solicitada">
          {doc.updateRequest ? `${doc.updateRequest.reason} (${dossierDay(doc.updateRequest.requestedAt)})` : undefined}
        </Definition>
      </dl>

      <div className="flex flex-wrap items-center gap-2.5">
        {doc.status !== 'approved' && (
          <button type="button" onClick={approve} disabled={busy} className={primaryButtonClass}>
            Aprobar
          </button>
        )}
        <button type="button" onClick={() => setMode('reject')} disabled={busy} className={actionButtonClass}>
          Rechazar
        </button>
        <button type="button" onClick={() => setMode('update')} disabled={busy} className={actionButtonClass}>
          Solicitar actualización
        </button>
        <button type="button" onClick={() => setMode('note')} disabled={busy} className={actionButtonClass}>
          Registrar observación
        </button>
      </div>

      {mode && (
        <div className="max-w-xl space-y-2">
          <label className={fieldLabelClass} htmlFor={`dossier-${documentId}`}>{modeConfig[mode].label}</label>
          <textarea
            id={`dossier-${documentId}`}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={modeConfig[mode].placeholder}
            className={inputClass}
          />
          <div className="flex gap-2">
            <button type="button" onClick={submitMode} disabled={busy} className={primaryButtonClass}>
              {busy ? 'Guardando…' : modeConfig[mode].submit}
            </button>
            <button type="button" onClick={() => { setMode(null); setText(''); setError(''); }} className={secondaryButtonClass}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-danger)]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}

      <div className="space-y-2 pt-1">
        <p className={fieldLabelClass}>Historial de verificaciones</p>
        <HistoryList events={doc.history} empty="Sin movimientos todavía." />
      </div>
    </div>
  );
}

function DocumentTable({
  docs,
  driverId,
  onDone,
  onFileError,
}: {
  docs: DossierDocument[];
  driverId: string;
  onDone: () => void;
  onFileError: (message: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);

  const file = async (doc: DossierDocument, disposition: 'inline' | 'attachment') => {
    onFileError('');
    try {
      await openDossierFile(`/drivers/${driverId}/documents/${doc.documentId}/file`, disposition, doc.label);
    } catch (err) {
      onFileError(err instanceof Error ? err.message : 'No se pudo abrir el documento.');
    }
  };

  return (
    <div className="table-container">
      <div className="overflow-x-auto">
        <table className="data-grid">
          <thead>
            <tr className="text-left">
              {['Documento', 'Estado', 'Cargado', 'Expedición', 'Vence', 'Verificado por', 'Acciones'].map((h) => (
                <th key={h} className="table-header-cell">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {docs.map((doc) => {
              const expanded = open === doc.type;
              return (
                <Fragment key={doc.type}>
                  <tr>
                    <td className="wrap">
                      <span className="font-semibold">{doc.label}</span>
                      <br />
                      <span className={indicatorStyles[doc.indicator].text}>{doc.message}</span>
                    </td>
                    <td><Indicator value={doc.indicator} /></td>
                    <td>{dossierDay(doc.uploadedAt)}</td>
                    <td>{dossierDay(doc.issuedAt)}</td>
                    <td>{dossierDay(doc.effectiveExpiresAt)}</td>
                    <td className="wrap">
                      {doc.reviewedByName ? (
                        <>
                          {doc.reviewedByName}
                          <br />
                          <span className="text-[var(--color-text-secondary)]">{dossierDay(doc.reviewedAt)}</span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <div className="flex items-center gap-1">
                        {doc.hasFile && (
                          <>
                            <button type="button" onClick={() => file(doc, 'inline')} className="flex cursor-pointer items-center gap-1 font-semibold text-[var(--color-primary)]">
                              <Eye className="h-3.5 w-3.5" /> Ver
                            </button>
                            <button type="button" onClick={() => file(doc, 'attachment')} className="flex cursor-pointer items-center gap-1 font-semibold text-[var(--color-primary)]">
                              <Download className="h-3.5 w-3.5" /> Descargar
                            </button>
                          </>
                        )}
                        {doc.documentId && (
                          <button
                            type="button"
                            onClick={() => setOpen(expanded ? null : doc.type)}
                            aria-expanded={expanded}
                            className="cursor-pointer font-semibold text-[var(--color-text-main)]"
                          >
                            {expanded ? 'Cerrar' : 'Gestionar'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td colSpan={7} className="wrap">
                        <DocumentDetail doc={doc} driverId={driverId} onDone={onDone} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VehicleEditor({ dossier, onDone }: { dossier: Dossier; onDone: () => void }) {
  const v = dossier.vehicle;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    brand: v.brand ?? '',
    model: v.model ?? '',
    color: v.color ?? '',
    year: v.year ? String(v.year) : '',
    plate: v.plate ?? '',
    engineCc: v.engineCc ? String(v.engineCc) : '',
    ownerName: v.ownerName ?? '',
    licenseCategory: dossier.licenseCategory ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const body: Record<string, unknown> = {};
      if (form.brand.trim()) body.brand = form.brand.trim();
      if (form.model.trim()) body.model = form.model.trim();
      if (form.color.trim()) body.color = form.color.trim();
      if (form.year.trim()) body.year = Number(form.year);
      if (form.plate.trim()) body.licensePlate = form.plate.trim().toUpperCase();
      if (form.engineCc.trim()) body.engineCc = Number(form.engineCc);
      if (form.ownerName.trim()) body.ownerName = form.ownerName.trim();
      if (form.licenseCategory.trim()) body.licenseCategory = form.licenseCategory.trim().toUpperCase();
      await api.put(`/drivers/${dossier.driverId}/vehicle`, body);
      setEditing(false);
      onDone();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo guardar el vehículo.'));
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, key: keyof typeof form, placeholder: string) => (
    <div>
      <label className={fieldLabelClass} htmlFor={`veh-${key}`}>{label}</label>
      <input id={`veh-${key}`} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} placeholder={placeholder} className={inputClass} />
    </div>
  );

  return (
    <div className="space-y-4">
      {editing ? (
        <div className="space-y-3">
          <div className="grid max-w-4xl grid-cols-2 gap-3 sm:grid-cols-4">
            {field('Marca', 'brand', 'Yamaha')}
            {field('Modelo', 'model', 'FZ 150')}
            {field('Color', 'color', 'Negro')}
            {field('Año', 'year', '2022')}
            {field('Placa', 'plate', 'ABC12D')}
            {field('Cilindraje (cc)', 'engineCc', '150')}
            {field('Propietario', 'ownerName', 'Nombre en la tarjeta')}
            {field('Categoría licencia', 'licenseCategory', 'A2')}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={save} disabled={busy} className={primaryButtonClass}>{busy ? 'Guardando…' : 'Guardar'}</button>
            <button type="button" onClick={() => setEditing(false)} className={secondaryButtonClass}>Cancelar</button>
          </div>
          {error && <p className="text-xs font-semibold text-[var(--color-danger)]">{error}</p>}
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
            <Definition label="Tipo">{v.type}</Definition>
            <Definition label="Placa">{v.plate}</Definition>
            <Definition label="Marca">{v.brand}</Definition>
            <Definition label="Modelo">{v.model}</Definition>
            <Definition label="Color">{v.color}</Definition>
            <Definition label="Año">{v.year ? String(v.year) : undefined}</Definition>
            <Definition label="Cilindraje">{v.engineCc ? `${v.engineCc} cc` : undefined}</Definition>
            <Definition label="Propietario">{v.ownerName}</Definition>
            <Definition label="Categoría de licencia">{dossier.licenseCategory}</Definition>
          </dl>
          <button type="button" onClick={() => setEditing(true)} className={actionButtonClass}>
            <Pencil className="h-3.5 w-3.5" /> Editar vehículo
          </button>
        </>
      )}
    </div>
  );
}

function ContractSection({ dossier, onDone, onFileError }: { dossier: Dossier; onDone: () => void; onFileError: (m: string) => void }) {
  const c = dossier.contract;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ status: (c.status ?? 'draft') as ContractStatus, startDate: toDateInput(c.startDate), endDate: toDateInput(c.endDate), note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [extraName, setExtraName] = useState('');
  const [removing, setRemoving] = useState<ContractFile | null>(null);

  const run = async (request: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError('');
    try {
      await request();
      onDone();
      return true;
    } catch (err) {
      setError(apiMessage(err, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveContract = async () => {
    const ok = await run(
      () =>
        api.put(`/drivers/${dossier.driverId}/contract`, {
          status: form.status,
          startDate: form.startDate || undefined,
          endDate: form.endDate || undefined,
          note: form.note.trim() || undefined,
        }),
      'No se pudo guardar el contrato.'
    );
    if (ok) setEditing(false);
  };

  const upload = async (path: string, file: File, name?: string) => {
    const fd = new FormData();
    fd.append('file', file);
    if (name) fd.append('name', name);
    // La instancia declara JSON por defecto: sin esto axios convertiría el FormData en JSON.
    const ok = await run(() => api.post(`/drivers/${dossier.driverId}/contract/${path}`, fd, { headers: { 'Content-Type': undefined }, timeout: 60_000 }), 'No se pudo subir el archivo.');
    if (ok && name) setExtraName('');
  };

  const openFile = async (f: ContractFile, disposition: 'inline' | 'attachment') => {
    onFileError('');
    try {
      await openDossierFile(`/drivers/${dossier.driverId}/contract/files/${f.id}`, disposition, f.name);
    } catch (err) {
      onFileError(err instanceof Error ? err.message : 'No se pudo abrir el documento.');
    }
  };

  const fileRow = (f: ContractFile, removable: boolean) => (
    <tr key={f.id}>
      <td className="wrap font-semibold">{f.name}</td>
      <td>{f.format.toUpperCase()}</td>
      <td>{dossierDay(f.uploadedAt)}</td>
      <td>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => openFile(f, 'inline')} className="flex cursor-pointer items-center gap-1 font-semibold text-[var(--color-primary)]">
            <Eye className="h-3.5 w-3.5" /> Ver
          </button>
          <button type="button" onClick={() => openFile(f, 'attachment')} className="flex cursor-pointer items-center gap-1 font-semibold text-[var(--color-primary)]">
            <Download className="h-3.5 w-3.5" /> Descargar
          </button>
          {removable && (
            <button type="button" onClick={() => setRemoving(f)} className="cursor-pointer font-semibold text-[var(--color-danger)]">
              Retirar
            </button>
          )}
        </div>
      </td>
    </tr>
  );

  return (
    <div className="space-y-6">
      {editing ? (
        <div className="max-w-2xl space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className={fieldLabelClass} htmlFor="contract-status">Estado contractual</label>
              <select id="contract-status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as ContractStatus })} className={inputClass}>
                {(Object.keys(contractStatusLabels) as ContractStatus[]).map((s) => (
                  <option key={s} value={s}>{contractStatusLabels[s]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={fieldLabelClass} htmlFor="contract-start">Fecha de inicio</label>
              <input id="contract-start" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label className={fieldLabelClass} htmlFor="contract-end">Fecha de finalización</label>
              <input id="contract-end" type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className={inputClass} />
            </div>
          </div>
          <div>
            <label className={fieldLabelClass} htmlFor="contract-note">Motivo del cambio (queda en el historial)</label>
            <input id="contract-note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className={inputClass} />
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={saveContract} disabled={busy} className={primaryButtonClass}>{busy ? 'Guardando…' : 'Guardar contrato'}</button>
            <button type="button" onClick={() => setEditing(false)} className={secondaryButtonClass}>Cancelar</button>
          </div>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
            <Definition label="Estado contractual">{c.status ? contractStatusLabels[c.status] : 'Sin registrar'}</Definition>
            <Definition label="Fecha de vinculación">{dossierDay(dossier.person.linkedAt)}</Definition>
            <Definition label="Fecha de inicio">{dossierDay(c.startDate)}</Definition>
            <Definition label="Fecha de finalización">{c.endDate ? dossierDay(c.endDate) : 'No aplica'}</Definition>
          </dl>
          <button type="button" onClick={() => setEditing(true)} className={actionButtonClass}>
            <Pencil className="h-3.5 w-3.5" /> {c.status ? 'Editar contrato' : 'Registrar contrato'}
          </button>
        </>
      )}

      {c.status && (
        <div className="space-y-2">
          <p className={fieldLabelClass}>Contrato y documentos adicionales</p>
          <div className="table-container">
            <div className="overflow-x-auto">
              <table className="data-grid">
                <thead>
                  <tr className="text-left">
                    {['Documento', 'Formato', 'Cargado', 'Acciones'].map((h) => (
                      <th key={h} className="table-header-cell">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {c.file ? fileRow(c.file, false) : (
                    <tr><td colSpan={4} className="wrap">El contrato firmado aún no se ha cargado.</td></tr>
                  )}
                  {c.extraFiles.map((f) => fileRow(f, true))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-6 pt-2">
            <label className={`${actionButtonClass} ${busy ? 'opacity-60' : ''}`}>
              <Upload className="h-3.5 w-3.5" /> {c.file ? 'Reemplazar contrato' : 'Cargar contrato firmado'}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                className="sr-only"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void upload('file', f);
                }}
              />
            </label>

            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className={fieldLabelClass} htmlFor="extra-name">Documento adicional</label>
                <input id="extra-name" value={extraName} onChange={(e) => setExtraName(e.target.value)} placeholder="Ej. Otrosí, acta de entrega" className={`${inputClass} w-64`} />
              </div>
              <label className={`${actionButtonClass} ${busy || extraName.trim().length < 2 ? 'opacity-60' : ''}`}>
                <Upload className="h-3.5 w-3.5" /> Adjuntar
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  className="sr-only"
                  disabled={busy || extraName.trim().length < 2}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) void upload('extras', f, extraName.trim());
                  }}
                />
              </label>
            </div>
          </div>
        </div>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-danger)]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}

      <div className="space-y-2">
        <p className={fieldLabelClass}>Historial de modificaciones del contrato</p>
        <HistoryList events={c.history} empty="Sin modificaciones registradas." />
      </div>

      {removing && (
        <ConfirmDialog
          title="Retirar documento adicional"
          message={`¿Retirar "${removing.name}" del expediente? Queda constancia en el historial.`}
          confirmLabel="Retirar"
          variant="danger"
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            void run(() => api.delete(`/drivers/${dossier.driverId}/contract/extras/${target.id}`), 'No se pudo retirar el documento.');
          }}
          onCancel={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

export default function DriverDossier({ driverId, onChanged }: { driverId: string; onChanged?: () => void }) {
  const [data, setData] = useState<Dossier | null>(null);
  const [error, setError] = useState('');
  const [fileError, setFileError] = useState('');
  const [exporting, setExporting] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    api
      .get(`/drivers/${driverId}/dossier`)
      .then((res) => {
        if (cancelled) return;
        setData(res.data.data);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(apiMessage(err, 'No se pudo cargar el expediente.'));
      });
    return () => {
      cancelled = true;
    };
  }, [driverId]);

  useEffect(() => load(), [load]);

  const refresh = useCallback(() => {
    load();
    onChanged?.();
  }, [load, onChanged]);

  if (error) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-[var(--color-danger)]">
        <AlertTriangle className="h-4 w-4" /> {error}
      </p>
    );
  }
  if (!data) return <p className="text-sm text-[var(--color-text-main)]">Cargando expediente…</p>;

  const { person, compliance } = data;
  const personal = data.documents.filter((d) => d.group === 'personal');
  const vehicleDocs = data.documents.filter((d) => d.group === 'vehicle');
  const allEvents = [
    ...data.documents.flatMap((d) => d.history.map((h) => ({ ...h, doc: d.label }))),
    ...data.contract.history.map((h) => ({ ...h, doc: 'Contrato' })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const exportPdf = async () => {
    setExporting(true);
    setFileError('');
    try {
      const safe = person.name.normalize('NFD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-') || 'domiciliario';
      await downloadDossierPdf(driverId, `expediente-${safe}.pdf`);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'No se pudo generar el expediente.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="max-w-6xl text-xs">
      <div className="flex flex-wrap items-start justify-between gap-6 pb-6">
        <div className="space-y-2">
          <p className={`flex items-center gap-2 text-base font-bold ${compliance.upToDate ? 'text-[var(--color-text-main)]' : 'text-[var(--color-danger)]'}`}>
            <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${compliance.upToDate ? 'bg-[var(--color-success)]' : 'bg-[var(--color-danger)]'}`} />
            {compliance.upToDate ? 'Documentación al día' : 'La documentación requiere atención'}
          </p>
          {compliance.issues.length > 0 && (
            <ul className="space-y-0.5 text-[var(--color-text-main)]">
              {compliance.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
        <PermissionGate permission={Permission.DRIVERS_APPROVE}>
          <button type="button" onClick={exportPdf} disabled={exporting} className="flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-60">
            <FileDown className="h-4 w-4" /> {exporting ? 'Generando expediente…' : 'Descargar expediente completo'}
          </button>
        </PermissionGate>
      </div>

      {fileError && (
        <p className="flex items-center gap-1.5 pb-4 font-semibold text-[var(--color-danger)]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {fileError}
        </p>
      )}

      <Section title="Perfil">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
          <Definition label="Nombre completo">{person.name}</Definition>
          <Definition label="Documento">{[person.documentType, person.documentNumber].filter(Boolean).join(' ')}</Definition>
          <Definition label="Teléfono">{person.phone}</Definition>
          <Definition label="Correo">{person.email}</Definition>
          <Definition label="Ciudad">{person.city}</Definition>
          <Definition label="Dirección">{person.address}</Definition>
          <Definition label="Fecha de registro">{dossierDay(person.registeredAt)}</Definition>
          <Definition label="Estado actual">{accountStatusLabels[person.status]}</Definition>
          <Definition label="Fecha de vinculación">{dossierDay(person.linkedAt)}</Definition>
          <Definition label="Última actividad">{dossierDateTime(person.lastActivityAt)}</Definition>
          <Definition label="Contacto de emergencia">
            {person.emergencyContact
              ? `${person.emergencyContact.name}${person.emergencyContact.relationship ? ` (${person.emergencyContact.relationship})` : ''} · ${person.emergencyContact.phone}`
              : 'No registró contacto'}
          </Definition>
        </dl>
      </Section>

      <Section title="Documentación personal">
        <DocumentTable docs={personal} driverId={driverId} onDone={refresh} onFileError={setFileError} />
      </Section>

      <Section title="Conducción y vehículo">
        <VehicleEditor key={JSON.stringify(data.vehicle)} dossier={data} onDone={refresh} />
        <DocumentTable docs={vehicleDocs} driverId={driverId} onDone={refresh} onFileError={setFileError} />
      </Section>

      <Section title="Contratación y relación con ZIPP">
        <ContractSection key={JSON.stringify([data.contract.status, data.contract.startDate, data.contract.endDate])} dossier={data} onDone={refresh} onFileError={setFileError} />
      </Section>

      <Section title="Historial de verificaciones">
        {allEvents.length === 0 ? (
          <p className="text-[var(--color-text-secondary)]">Sin movimientos registrados.</p>
        ) : (
          <div className="table-container">
            <div className="overflow-x-auto">
              <table className="data-grid">
                <thead>
                  <tr className="text-left">
                    {['Fecha', 'Documento', 'Evento', 'Por', 'Nota'].map((h) => (
                      <th key={h} className="table-header-cell">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {allEvents.slice(0, 100).map((e, i) => (
                    <tr key={`${e.at}-${i}`}>
                      <td>{dossierDateTime(e.at)}</td>
                      <td className="wrap">{e.doc}</td>
                      <td className="wrap">{eventLabels[e.action] ?? e.action}</td>
                      <td className="wrap">{e.byName ?? 'Domiciliario'}</td>
                      <td className="wrap">{e.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}
