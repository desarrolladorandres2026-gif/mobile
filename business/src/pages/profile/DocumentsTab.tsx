import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, FileText } from 'lucide-react';
import api from '../../services/api';
import { qk } from '../../lib/queryKeys';
import { useAuthStore } from '../../stores/authStore';
import { apiMessage } from '../../lib/apiError';

/**
 * Pestaña "Documentos y pagos" del perfil.
 *
 * ZIPP no aprueba un comercio ni le paga sin: sus papeles (RUT, Cámara de
 * Comercio, cédula del representante, certificación bancaria y, si vende
 * alimentos, el concepto sanitario), sus datos fiscales y una cuenta de
 * pago verificada. Todo se sube aquí y el equipo de ZIPP lo revisa; si algo
 * se rechaza, el motivo aparece junto al documento.
 */

type DocumentType = 'rut' | 'chamber_of_commerce' | 'legal_rep_id' | 'bank_certificate' | 'health_permit';

interface DocView {
  _id: string;
  type: DocumentType;
  reference: string;
  expiresAt?: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  rejectionReason?: string;
  hasFile?: boolean;
  fileFormat?: string;
  fileUrl?: string;
  submittedAt?: string;
}

interface LegalView {
  documentType: 'NIT' | 'CC' | 'CE';
  documentNumber: string;
  dv?: string;
  legalName: string;
  legalRepName?: string;
  taxRegime?: string;
  billingEmail?: string;
  complete: boolean;
}

interface PayoutView {
  method: 'bank' | 'nequi' | 'daviplata';
  bankName?: string;
  accountType?: 'ahorros' | 'corriente';
  accountMasked: string;
  holderName: string;
  verificationStatus: 'pendingVerification' | 'verified';
}

const DOCUMENT_LABELS: Record<DocumentType, string> = {
  rut: 'RUT',
  chamber_of_commerce: 'Cámara de Comercio',
  legal_rep_id: 'Cédula del representante legal',
  bank_certificate: 'Certificación bancaria',
  health_permit: 'Concepto sanitario',
};

const REQUIRED: DocumentType[] = ['rut', 'chamber_of_commerce', 'legal_rep_id', 'bank_certificate'];
const FOOD_CATEGORIES = ['restaurant', 'fast_food', 'cafe', 'bakery', 'supermarket'];

const STATUS: Record<DocView['status'], { label: string; className: string }> = {
  approved: { label: 'Aprobado', className: 'text-[#047857]' },
  pending: { label: 'En revisión', className: 'text-[var(--color-warning)]' },
  rejected: { label: 'Rechazado', className: 'text-[var(--color-danger)]' },
  expired: { label: 'Vencido', className: 'text-[var(--color-danger)]' },
};

const fieldClass =
  'h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]';
const labelClass = 'mb-1 block text-xs font-medium text-[var(--color-text-main)]';

const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('es-CO') : '');

function DocumentRow({ businessId, type, doc, onDone }: { businessId: string; type: DocumentType; doc?: DocView; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [reference, setReference] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const queryClient = useQueryClient();

  const submit = async () => {
    if (!file) return setError('Elige el archivo (JPG, PNG, WEBP o PDF de hasta 8 MB).');
    if (reference.trim().length < 3) return setError('Escribe el número o referencia del documento.');
    const form = new FormData();
    form.append('file', file);
    form.append('type', type);
    form.append('reference', reference.trim());
    if (expiresAt) form.append('expiresAt', new Date(`${expiresAt}T12:00:00`).toISOString());
    try {
      setBusy(true);
      setError('');
      // Sin esto axios manda el FormData como JSON: la instancia del panel
      // declara 'application/json' por defecto.
      await api.post(`/businesses/${businessId}/documents`, form, { headers: { 'Content-Type': undefined } });
      // El aviso de vencimiento del Dashboard lee la misma lista.
      void queryClient.invalidateQueries({ queryKey: qk.documents(businessId) });
      setOpen(false);
      setFile(null);
      setReference('');
      setExpiresAt('');
      onDone();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo subir el documento.'));
    } finally {
      setBusy(false);
    }
  };

  const status = doc ? STATUS[doc.status] : null;
  const canReplace = !doc || doc.status !== 'approved' || open;

  return (
    <li className="space-y-3 border-t border-[var(--color-border-light)] first:border-t-0 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[var(--color-text-main)]">{DOCUMENT_LABELS[type]}</p>
            {doc ? (
              <>
                <p className="font-mono text-xs text-[var(--color-text-secondary)]">{doc.reference}</p>
                <p className="text-[11px] text-[var(--color-text-muted)]">
                  {doc.submittedAt ? `Enviado el ${day(doc.submittedAt)}` : ''}
                  {doc.expiresAt ? ` · vence el ${day(doc.expiresAt)}` : ''}
                </p>
                {doc.status === 'rejected' && doc.rejectionReason && (
                  <p className="pt-1 text-xs font-semibold text-[var(--color-danger)]">
                    Lo rechazamos: {doc.rejectionReason}. Vuelve a subirlo.
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-[var(--color-text-muted)]">Aún no lo has enviado.</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {status && <span className={`text-[11px] font-semibold ${status.className}`}>{status.label}</span>}
          {doc?.hasFile && doc.fileUrl && (
            <a href={doc.fileUrl} target="_blank" rel="noreferrer" className="text-xs font-semibold text-[var(--color-primary)] hover:underline">
              Ver archivo
            </a>
          )}
          <button
            onClick={() => setOpen((v) => !v)}
            className="cursor-pointer rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-main)]"
          >
            {open ? 'Cancelar' : doc ? 'Reemplazar' : 'Subir'}
          </button>
        </div>
      </div>

      {open && canReplace && (
        <div className="grid gap-3 pl-7 md:grid-cols-3">
          <label>
            <span className={labelClass}>Archivo</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-xs text-[var(--color-text-secondary)]"
            />
          </label>
          <label>
            <span className={labelClass}>Número o referencia</span>
            <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={500} className={fieldClass} placeholder="Ej. NIT 900123456-8" />
          </label>
          <label>
            <span className={labelClass}>Vence (si aplica)</span>
            <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className={fieldClass} />
          </label>
          <div className="md:col-span-3 flex flex-wrap items-center gap-3">
            <button
              onClick={submit}
              className="cursor-pointer rounded-md bg-[var(--color-primary)] hover:bg-[var(--color-primary-light)] px-4 py-2 text-xs font-semibold text-[var(--zipp-obsidian)]"
            >
              {busy ? 'Subiendo…' : 'Enviar a revisión'}
            </button>
            {error && <p className="text-xs font-semibold text-[var(--color-danger)]">{error}</p>}
          </div>
        </div>
      )}
    </li>
  );
}

export default function DocumentsTab() {
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const businessId = selectedBusiness?._id;
  const needsHealthPermit = FOOD_CATEGORIES.includes(selectedBusiness?.category ?? '');

  const [docs, setDocs] = useState<DocView[]>([]);
  const [legal, setLegal] = useState<LegalView | null>(null);
  const [payout, setPayout] = useState<PayoutView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [legalForm, setLegalForm] = useState({
    documentType: 'NIT', documentNumber: '', legalName: '', legalRepName: '', taxRegime: '', billingEmail: '',
  });
  const [payoutForm, setPayoutForm] = useState({
    method: 'bank', bankName: '', accountType: 'ahorros', accountNumber: '', holderName: '', holderDocument: '',
  });
  const [saving, setSaving] = useState<'legal' | 'payout' | null>(null);
  const [notice, setNotice] = useState('');
  const [formError, setFormError] = useState('');
  const [reauth, setReauth] = useState<{ channel: 'password' | 'whatsapp' } | null>(null);
  const [reauthProof, setReauthProof] = useState('');
  const [reauthError, setReauthError] = useState('');

  const load = useCallback(async () => {
    if (!businessId) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError('');
      const [d, l, p] = await Promise.all([
        api.get(`/businesses/${businessId}/documents`),
        api.get(`/businesses/${businessId}/legal`),
        api.get(`/businesses/${businessId}/payout-account`),
      ]);
      setDocs(d.data.data ?? []);
      setLegal(l.data.data ?? null);
      setPayout(p.data.data ?? null);
      if (l.data.data) {
        const v = l.data.data as LegalView;
        setLegalForm({
          documentType: v.documentType, documentNumber: v.documentNumber, legalName: v.legalName,
          legalRepName: v.legalRepName ?? '', taxRegime: v.taxRegime ?? '', billingEmail: v.billingEmail ?? '',
        });
      }
    } catch (err) {
      setError(apiMessage(err, 'No se pudieron cargar tus documentos.'));
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => { load(); }, [load]);

  const saveLegal = async () => {
    if (!businessId) return;
    try {
      setSaving('legal');
      setFormError('');
      setNotice('');
      await api.put(`/businesses/${businessId}/legal`, {
        documentType: legalForm.documentType,
        documentNumber: legalForm.documentNumber.trim(),
        legalName: legalForm.legalName.trim(),
        ...(legalForm.legalRepName.trim() ? { legalRepName: legalForm.legalRepName.trim() } : {}),
        ...(legalForm.taxRegime ? { taxRegime: legalForm.taxRegime } : {}),
        ...(legalForm.billingEmail.trim() ? { billingEmail: legalForm.billingEmail.trim() } : {}),
      });
      setNotice('Datos fiscales guardados.');
      await load();
    } catch (err) {
      setFormError(apiMessage(err, 'No se pudieron guardar los datos fiscales.'));
    } finally {
      setSaving(null);
    }
  };

  // Cambiar la cuenta mueve el dinero de todas tus próximas liquidaciones:
  // pedimos confirmar con la contraseña o, si la cuenta no tiene, con un
  // código al celular verificado. Empieza pidiendo el canal.
  const startPayoutSave = async () => {
    if (!businessId) return;
    if (payoutForm.method === 'bank' && (!payoutForm.bankName.trim() || !payoutForm.accountType)) {
      return setFormError('Elige el banco y el tipo de cuenta.');
    }
    if (!payoutForm.accountNumber.trim() || !payoutForm.holderName.trim() || !payoutForm.holderDocument.trim()) {
      return setFormError('Completa el número de cuenta, el titular y su documento.');
    }
    setFormError('');
    try {
      const { data } = await api.post(`/businesses/${businessId}/payout-account/reauth-otp`);
      setReauth(data.data);
      setReauthProof('');
      setReauthError('');
    } catch (err) {
      setFormError(apiMessage(err, 'No se pudo iniciar la confirmación.'));
    }
  };

  const savePayout = async () => {
    if (!businessId || !reauth) return;
    if (!reauthProof.trim()) {
      setReauthError(reauth.channel === 'password' ? 'Escribe tu contraseña.' : 'Escribe el código que te enviamos.');
      return;
    }
    try {
      setSaving('payout');
      setReauthError('');
      setFormError('');
      setNotice('');
      await api.put(`/businesses/${businessId}/payout-account`, {
        method: payoutForm.method,
        ...(payoutForm.method === 'bank' ? { bankName: payoutForm.bankName.trim(), accountType: payoutForm.accountType } : {}),
        accountNumber: payoutForm.accountNumber.replace(/\s/g, ''),
        holderName: payoutForm.holderName.trim(),
        holderDocument: payoutForm.holderDocument.trim(),
        ...(reauth.channel === 'password' ? { currentPassword: reauthProof } : { otpCode: reauthProof }),
      });
      setNotice('Cuenta guardada. ZIPP la verificará antes de girarte dinero.');
      setPayoutForm((f) => ({ ...f, accountNumber: '' }));
      setReauth(null);
      setReauthProof('');
      await load();
    } catch (err) {
      setReauthError(apiMessage(err, 'No se pudo confirmar el cambio.'));
    } finally {
      setSaving(null);
    }
  };

  if (!businessId) {
    return <p className="py-16 text-center text-xs font-semibold text-[var(--color-text-secondary)]">Selecciona un local para ver sus documentos.</p>;
  }

  const types: DocumentType[] = needsHealthPermit ? [...REQUIRED, 'health_permit'] : REQUIRED;
  const approved = types.filter((t) => docs.find((d) => d.type === t)?.status === 'approved').length;

  return (
    <div className="space-y-5">
      <div>
        <p className="page-subtitle">
          {approved} de {types.length} documentos aprobados ·{' '}
          {legal?.complete ? 'datos fiscales completos' : 'faltan datos fiscales'} ·{' '}
          {payout ? (payout.verificationStatus === 'verified' ? 'cuenta de pago verificada' : 'cuenta de pago en verificación') : 'sin cuenta de pago'}
        </p>
        {selectedBusiness?.isApproved === false && (
          <p className="pt-2 text-xs font-semibold text-[var(--color-warning)]">
            Tu local sale a la venta cuando ZIPP apruebe estos tres bloques.
          </p>
        )}
      </div>

      {error && (
        <p className="flex items-start gap-2 text-xs font-semibold text-[var(--color-danger)]">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </p>
      )}
      {notice && (
        <p className="flex items-center gap-2 text-xs font-semibold text-[#047857]">
          <CheckCircle2 className="h-4 w-4" /> {notice}
        </p>
      )}

      {loading ? (
        <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-secondary)]">Cargando…</p>
      ) : (
        <div className="cols3">
          <section>
            <h2 className="col-title">Documentos</h2>
            <ul>
              {types.map((type) => (
                <DocumentRow key={type} businessId={businessId} type={type} doc={docs.find((d) => d.type === type)} onDone={load} />
              ))}
            </ul>
          </section>

          <section className="space-y-4">
            <div>
              <h2 className="col-title">Datos fiscales</h2>
              <p className="text-xs text-[var(--color-text-secondary)]">Con estos datos ZIPP te emite los comprobantes de tus liquidaciones.</p>
            </div>
            <div className="grid gap-3 grid-cols-2">
              <label>
                <span className={labelClass}>Tipo de documento</span>
                <select value={legalForm.documentType} onChange={(e) => setLegalForm({ ...legalForm, documentType: e.target.value })} className={fieldClass}>
                  <option value="NIT">NIT</option>
                  <option value="CC">Cédula de ciudadanía</option>
                  <option value="CE">Cédula de extranjería</option>
                </select>
              </label>
              <label>
                <span className={labelClass}>Número{legal?.dv ? ` (DV ${legal.dv})` : ''}</span>
                <input value={legalForm.documentNumber} onChange={(e) => setLegalForm({ ...legalForm, documentNumber: e.target.value })} className={fieldClass} placeholder="900.123.456" />
              </label>
              <label>
                <span className={labelClass}>Razón social o nombre</span>
                <input value={legalForm.legalName} onChange={(e) => setLegalForm({ ...legalForm, legalName: e.target.value })} className={fieldClass} />
              </label>
              <label>
                <span className={labelClass}>Representante legal</span>
                <input value={legalForm.legalRepName} onChange={(e) => setLegalForm({ ...legalForm, legalRepName: e.target.value })} className={fieldClass} />
              </label>
              <label>
                <span className={labelClass}>Régimen tributario</span>
                <select value={legalForm.taxRegime} onChange={(e) => setLegalForm({ ...legalForm, taxRegime: e.target.value })} className={fieldClass}>
                  <option value="">No lo sé</option>
                  <option value="simple">Régimen simple</option>
                  <option value="ordinario">Ordinario</option>
                  <option value="no_responsable_iva">No responsable de IVA</option>
                  <option value="otro">Otro</option>
                </select>
              </label>
              <label>
                <span className={labelClass}>Correo de facturación</span>
                <input type="email" value={legalForm.billingEmail} onChange={(e) => setLegalForm({ ...legalForm, billingEmail: e.target.value })} className={fieldClass} />
              </label>
            </div>
            <button onClick={saveLegal} className="cursor-pointer rounded-md bg-[var(--color-primary)] hover:bg-[var(--color-primary-light)] px-4 py-2 text-xs font-semibold text-[var(--zipp-obsidian)]">
              {saving === 'legal' ? 'Guardando…' : 'Guardar datos fiscales'}
            </button>
          </section>

          <section className="space-y-4">
            <div>
              <h2 className="col-title">Cuenta para recibir tus pagos</h2>
              {payout ? (
                <p className="text-xs text-[var(--color-text-secondary)]">
                  Registrada: <strong className="text-[var(--color-text-main)]">{payout.method === 'bank' ? payout.bankName : payout.method}</strong>{' '}
                  <span className="font-mono">{payout.accountMasked}</span> · titular {payout.holderName} ·{' '}
                  <span className={payout.verificationStatus === 'verified' ? 'font-semibold text-[#047857]' : 'font-semibold text-[var(--color-warning)]'}>
                    {payout.verificationStatus === 'verified' ? 'verificada' : 'pendiente de verificación'}
                  </span>
                  . Si la cambias, ZIPP debe verificarla de nuevo antes de girarte dinero.
                </p>
              ) : (
                <p className="text-xs text-[var(--color-text-secondary)]">
                  Sin cuenta, no podemos pagarte tus ventas. El titular debe ser tuyo o de tu empresa.
                </p>
              )}
            </div>
            <div className="grid gap-3 grid-cols-2">
              <label>
                <span className={labelClass}>Medio</span>
                <select value={payoutForm.method} onChange={(e) => setPayoutForm({ ...payoutForm, method: e.target.value })} className={fieldClass}>
                  <option value="bank">Cuenta bancaria</option>
                  <option value="nequi">Nequi</option>
                  <option value="daviplata">DaviPlata</option>
                </select>
              </label>
              {payoutForm.method === 'bank' && (
                <>
                  <label>
                    <span className={labelClass}>Banco</span>
                    <input value={payoutForm.bankName} onChange={(e) => setPayoutForm({ ...payoutForm, bankName: e.target.value })} className={fieldClass} placeholder="Bancolombia" />
                  </label>
                  <label>
                    <span className={labelClass}>Tipo de cuenta</span>
                    <select value={payoutForm.accountType} onChange={(e) => setPayoutForm({ ...payoutForm, accountType: e.target.value })} className={fieldClass}>
                      <option value="ahorros">Ahorros</option>
                      <option value="corriente">Corriente</option>
                    </select>
                  </label>
                </>
              )}
              <label>
                <span className={labelClass}>{payoutForm.method === 'bank' ? 'Número de cuenta' : 'Celular'}</span>
                <input value={payoutForm.accountNumber} onChange={(e) => setPayoutForm({ ...payoutForm, accountNumber: e.target.value })} className={fieldClass} inputMode="numeric" autoComplete="off" />
              </label>
              <label>
                <span className={labelClass}>Titular</span>
                <input value={payoutForm.holderName} onChange={(e) => setPayoutForm({ ...payoutForm, holderName: e.target.value })} className={fieldClass} />
              </label>
              <label>
                <span className={labelClass}>Documento del titular</span>
                <input value={payoutForm.holderDocument} onChange={(e) => setPayoutForm({ ...payoutForm, holderDocument: e.target.value })} className={fieldClass} />
              </label>
            </div>
            {reauth ? (
              <div className="space-y-2 border-t border-[var(--color-border-light)] pt-3">
                <p className="text-xs text-[var(--color-text-secondary)]">
                  {reauth.channel === 'password'
                    ? 'Confirma con tu contraseña para guardar la nueva cuenta.'
                    : 'Te enviamos un código a tu celular. Escríbelo para confirmar.'}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type={reauth.channel === 'password' ? 'password' : 'text'}
                    value={reauthProof}
                    onChange={(e) => setReauthProof(e.target.value)}
                    autoFocus
                    className={`${fieldClass} w-full`}
                    placeholder={reauth.channel === 'password' ? 'Contraseña' : 'Código de 6 dígitos'}
                  />
                  <button onClick={savePayout} className="cursor-pointer rounded-md bg-[var(--color-primary)] hover:bg-[var(--color-primary-light)] px-4 py-2 text-xs font-semibold text-[var(--zipp-obsidian)]">
                    {saving === 'payout' ? 'Confirmando…' : 'Confirmar y guardar'}
                  </button>
                  <button onClick={() => { setReauth(null); setReauthProof(''); setReauthError(''); }} className="cursor-pointer text-xs font-semibold text-[var(--color-text-secondary)]">
                    Cancelar
                  </button>
                </div>
                {reauthError && <p className="text-xs font-semibold text-[var(--color-danger)]">{reauthError}</p>}
              </div>
            ) : (
              <button onClick={startPayoutSave} className="cursor-pointer rounded-md bg-[var(--color-primary)] hover:bg-[var(--color-primary-light)] px-4 py-2 text-xs font-semibold text-[var(--zipp-obsidian)]">
                {payout ? 'Reemplazar cuenta' : 'Guardar cuenta'}
              </button>
            )}
            {formError && <p className="text-xs font-semibold text-[var(--color-danger)]">{formError}</p>}
          </section>
        </div>
      )}
    </div>
  );
}
