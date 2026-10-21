import { useCallback, useEffect, useState } from 'react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { Permission } from '../lib/permissions';
import { PermissionGate } from '../components/PermissionGate';
import { useAuthStore } from '../stores/authStore';

/**
 * Impuestos por concepto (M-014).
 *
 * ZIPP no trae ninguna tarifa: cada concepto necesita una regla que el
 * responsable contable y tributario valide con el documento que la respalde.
 * Mientras un concepto no la tenga, aquí aparece «pendiente» y el cálculo no se
 * presenta como definitivo. Una regla validada no se edita: se publica otra con
 * su fecha de inicio, y la anterior termina ese mismo instante.
 */

type Concept = 'products' | 'delivery' | 'service_fee' | 'commission' | 'advertising' | 'pro_subscription' | 'other';

const CONCEPT_LABEL: Record<Concept, string> = {
 products: 'Productos del comercio',
 delivery: 'Servicio de domicilio',
 service_fee: 'Tarifa de servicio',
 commission: 'Comisión de ZIPP',
 advertising: 'Publicidad',
 pro_subscription: 'Suscripción Zipp Pro',
 other: 'Otro servicio comercial',
};

const TREATMENT_LABEL: Record<string, string> = {
 taxed: 'Gravado',
 exempt: 'Exento',
 excluded: 'Excluido',
 not_applicable: 'No aplica',
};

const STATE_LABEL: Record<string, string> = {
 validated: 'Validada y vigente',
 draft_only: 'Solo borrador',
 missing: 'Pendiente de configuración',
};

interface ConceptReadiness {
 concept: Concept;
 state: 'validated' | 'draft_only' | 'missing';
 activeRule: {
 id: string;
 treatment: string;
 rateBps: number | null;
 base: string;
 priceIncludesTax: boolean;
 validFrom: string;
 validTo: string | null;
 validationRef: string;
 } | null;
 upcomingFrom: string | null;
 drafts: number;
 consumer: string;
 pending: string[];
}

interface TaxReadiness {
 mode: 'legacy' | 'rules';
 legacyTaxBps: number;
 definitive: boolean;
 canEnableCheckoutRules: boolean;
 blockers: Concept[];
 concepts: ConceptReadiness[];
 electronicInvoicing: { integrated: boolean; note: string };
}

interface Rule {
 _id: string;
 concept: Concept;
 label: string;
 treatment: string;
 taxType: string;
 rateBps: number | null;
 base: 'net_of_discounts' | 'gross';
 priceIncludesTax: boolean;
 conditions: string;
 validFrom: string;
 validTo: string | null;
 status: 'draft' | 'validated' | 'superseded';
 validationRef: string;
 validatedAt?: string | null;
 /** Doble aprobación: quien propone o edita no aprueba. */
 createdBy?: string;
 lastEditedBy?: string | null;
 validatedBy?: string | null;
 proposedValidFrom?: string | null;
}

const CHECKOUT: Concept[] = ['products', 'delivery', 'service_fee'];
const pct = (bps: number | null) => (bps == null ? '—' : `${(bps / 100).toFixed(2)} %`);
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-CO') : 'sin fin');

const emptyDraft = () => ({
 concept: 'delivery' as Concept,
 label: '',
 treatment: 'taxed',
 taxType: 'iva',
 ratePct: '',
 base: 'net_of_discounts',
 conditions: '',
 validFrom: new Date().toISOString().slice(0, 10),
});

export default function TaxRules() {
 const [readiness, setReadiness] = useState<TaxReadiness | null>(null);
 const [rules, setRules] = useState<Rule[]>([]);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [ok, setOk] = useState('');
 const [draft, setDraft] = useState(emptyDraft());
 const [refs, setRefs] = useState<Record<string, string>>({});
 const [working, setWorking] = useState(false);
 const { hasPermission, user } = useAuthStore();

 // Aprueba otra persona con permiso de aprobación tributaria: nunca quien creó o editó el borrador.
 const canApprove = (r: Rule) =>
 hasPermission(Permission.TAX_RULES_APPROVE) && !!user && r.createdBy !== user._id && r.lastEditedBy !== user._id;

 const load = useCallback(async () => {
 try {
 setLoading(true);
 const [r, list] = await Promise.all([api.get('/finance/config/readiness'), api.get('/finance/tax-rules')]);
 setReadiness(r.data.data.tax);
 setRules(list.data.data ?? []);
 setError('');
 } catch (err) {
 setError(apiMessage(err, 'No se pudieron cargar las reglas tributarias.'));
 } finally {
 setLoading(false);
 }
 }, []);

 useEffect(() => { load(); }, [load]);

 const run = async (action: () => Promise<unknown>, done: string, fallback: string) => {
 setWorking(true);
 setError('');
 setOk('');
 try {
 await action();
 setOk(done);
 await load();
 } catch (err) {
 setError(apiMessage(err, fallback));
 } finally {
 setWorking(false);
 }
 };

 const checkout = CHECKOUT.includes(draft.concept);

 const createDraft = () => {
 const taxed = draft.treatment === 'taxed';
 const rateBps = taxed ? Math.round(parseFloat(draft.ratePct.replace(',', '.') || '0') * 100) : null;
 if (taxed && (!rateBps || rateBps <= 0)) return setError('Un concepto gravado necesita su tarifa.');
 void run(
 () => api.post('/finance/tax-rules', {
 concept: draft.concept,
 ...(draft.concept === 'other' ? { label: draft.label.trim() } : {}),
 treatment: draft.treatment,
 taxType: draft.taxType,
 rateBps,
 base: draft.base,
 // En el checkout el impuesto va encima; en los demás cobros, incluido en el precio.
 priceIncludesTax: !checkout,
 conditions: draft.conditions.trim(),
 validFrom: new Date(`${draft.validFrom}T00:00:00-05:00`).toISOString(),
 }),
 'Borrador creado. Todavía no se usa para nada: falta validarlo.',
 'No se pudo crear el borrador.',
 );
 };

 const validate = (rule: Rule) => {
 const ref = (refs[rule._id] ?? '').trim();
 if (ref.length < 5) return setError('Escribe el documento que respalda la regla (concepto del contador, circular, radicado).');
 void run(
 () => api.post(`/finance/tax-rules/${rule._id}/validate`, { validationRef: ref }),
 'Regla aprobada. Rige desde su fecha de inicio, nunca hacia atrás.',
 'No se pudo aprobar la regla.',
 );
 };

 const remove = (rule: Rule) =>
 run(() => api.delete(`/finance/tax-rules/${rule._id}`), 'Borrador eliminado.', 'No se pudo eliminar el borrador.');

 const inputClass = 'h-8 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-xs font-semibold text-[var(--color-text-main)] focus:border-[var(--color-primary)] outline-none';
 const labelClass = 'block text-xs font-bold text-[var(--color-text-main)] mb-1';

 if (loading && !readiness) {
 return <div className="state-line">Cargando reglas tributarias…</div>;
 }

 return (
 <div className="space-y-6">
 <div>
 <h2 className="text-lg font-bold text-[var(--color-text-main)]">Impuestos por concepto</h2>
 <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
 Cada concepto necesita su propia regla, respaldada por el responsable contable y tributario. ZIPP no trae ninguna tarifa: lo que no esté validado aparece pendiente y no se presenta como definitivo.
 </p>
 </div>

 {error ? <p className="text-xs font-semibold text-[var(--color-danger)]">{error}</p> : null}
 {ok ? <p className="text-xs font-semibold text-[var(--color-success)]">{ok}</p> : null}

 {readiness ? (
 <section className="space-y-2">
 <p className="text-xs font-semibold text-[var(--color-text-main)]">
 {readiness.mode === 'rules'
 ? 'El checkout calcula el impuesto con las reglas validadas de cada concepto.'
 : `El checkout usa una tasa global de ${pct(readiness.legacyTaxBps)} sobre productos, domicilio y tarifa de servicio. Esa tasa no está validada por contabilidad.`}
 {readiness.mode === 'legacy' && readiness.blockers.length > 0
 ? ` Para encender las reglas faltan: ${readiness.blockers.map((c) => CONCEPT_LABEL[c]).join(', ')}.`
 : ''}
 {readiness.mode === 'legacy' && readiness.canEnableCheckoutRules ? ' Ya puedes encenderlas en Tarifas y Precios.' : ''}
 </p>
 <p className="text-xs text-[var(--color-text-secondary)]">{readiness.electronicInvoicing.note}</p>

 <div className="overflow-x-auto">
 <table className="data-grid min-w-[860px]">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Concepto</th>
 <th className="table-header-cell">Estado</th>
 <th className="table-header-cell">Regla vigente</th>
 <th className="table-header-cell">Desde</th>
 <th className="table-header-cell">Respaldo</th>
 <th className="table-header-cell">Dónde se usa</th>
 </tr>
 </thead>
 <tbody>
 {readiness.concepts.map((c) => (
 <tr key={c.concept}>
 <td className="table-body-cell wrap font-semibold text-[var(--color-text-main)]">{CONCEPT_LABEL[c.concept]}</td>
 <td className="table-body-cell wrap">
 {STATE_LABEL[c.state]}
 {c.drafts > 0 ? ` · ${c.drafts} borrador${c.drafts > 1 ? 'es' : ''}` : ''}
 {c.upcomingFrom ? ` · cambia el ${day(c.upcomingFrom)}` : ''}
 </td>
 <td className="table-body-cell wrap">
 {c.activeRule
 ? `${TREATMENT_LABEL[c.activeRule.treatment]}${c.activeRule.rateBps != null ? ` ${pct(c.activeRule.rateBps)}` : ''} · ${c.activeRule.base === 'gross' ? 'valor bruto' : 'tras descuentos'} · ${c.activeRule.priceIncludesTax ? 'incluido en el precio' : 'encima del precio'}`
 : '—'}
 </td>
 <td className="table-body-cell">{c.activeRule ? day(c.activeRule.validFrom) : '—'}</td>
 <td className="table-body-cell wrap">{c.activeRule?.validationRef || '—'}</td>
 <td className="table-body-cell wrap text-[var(--color-text-secondary)]">{c.consumer}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>

 {readiness.concepts.some((c) => c.state === 'missing') ? (
 <details className="text-xs text-[var(--color-text-main)]">
 <summary className="cursor-pointer font-semibold">Qué debe validar el responsable contable por cada concepto pendiente</summary>
 <ul className="mt-2 list-disc space-y-0.5 pl-5">
 {(readiness.concepts.find((c) => c.state === 'missing')?.pending ?? []).map((p) => <li key={p}>{p}</li>)}
 </ul>
 </details>
 ) : null}
 </section>
 ) : null}

 <PermissionGate permission={Permission.FINANCE_MANAGE}>
 <section className="space-y-3">
 <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Nueva regla (borrador)</h3>
 <p className="text-xs text-[var(--color-text-secondary)]">
 Un borrador no se usa para nada. La regla rige solo cuando se valida con su documento de respaldo, y nunca con fecha pasada.
 </p>
 <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
 <label>
 <span className={labelClass}>Concepto</span>
 <select className={inputClass} value={draft.concept} onChange={(e) => setDraft({ ...draft, concept: e.target.value as Concept })}>
 {(Object.keys(CONCEPT_LABEL) as Concept[]).map((c) => <option key={c} value={c}>{CONCEPT_LABEL[c]}</option>)}
 </select>
 </label>
 {draft.concept === 'other' ? (
 <label>
 <span className={labelClass}>¿Qué servicio?</span>
 <input className={inputClass} value={draft.label} maxLength={80} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
 </label>
 ) : null}
 <label>
 <span className={labelClass}>Tratamiento</span>
 <select className={inputClass} value={draft.treatment} onChange={(e) => setDraft({ ...draft, treatment: e.target.value })}>
 {Object.entries(TREATMENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
 </select>
 </label>
 {draft.treatment === 'taxed' ? (
 <>
 <label>
 <span className={labelClass}>Impuesto</span>
 <select className={inputClass} value={draft.taxType} onChange={(e) => setDraft({ ...draft, taxType: e.target.value })}>
 <option value="iva">IVA</option>
 <option value="consumption">Impoconsumo</option>
 <option value="other">Otro</option>
 </select>
 </label>
 <label>
 <span className={labelClass}>Tarifa (%)</span>
 <input className={inputClass} inputMode="decimal" value={draft.ratePct} placeholder="Según el concepto del contador" onChange={(e) => setDraft({ ...draft, ratePct: e.target.value })} />
 </label>
 </>
 ) : null}
 <label>
 <span className={labelClass}>Base gravable</span>
 <select className={inputClass} value={draft.base} onChange={(e) => setDraft({ ...draft, base: e.target.value })}>
 <option value="net_of_discounts">Lo que paga el cliente, tras descuentos</option>
 <option value="gross">Valor bruto, antes de descuentos</option>
 </select>
 </label>
 <label>
 <span className={labelClass}>Rige desde</span>
 <input type="date" className={inputClass} value={draft.validFrom} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDraft({ ...draft, validFrom: e.target.value })} />
 </label>
 <label className="sm:col-span-3">
 <span className={labelClass}>Condiciones de aplicación</span>
 <input className={inputClass} value={draft.conditions} maxLength={500} placeholder="Ej. solo si el comercio es responsable de IVA" onChange={(e) => setDraft({ ...draft, conditions: e.target.value })} />
 </label>
 </div>
 <p className="text-xs text-[var(--color-text-secondary)]">
 {checkout
 ? 'En el checkout el impuesto se suma encima del precio.'
 : 'Este cobro no tiene una línea donde sumar el impuesto: se registra como incluido en el precio y solo informa cuánto es impuesto; no cambia lo que se cobra.'}
 </p>
 <button
 onClick={createDraft}
 disabled={working}
 className="cursor-pointer rounded border border-[var(--color-border)] px-3 py-1.5 text-xs font-bold text-[var(--color-text-main)]"
 >
 Guardar borrador
 </button>
 </section>
 </PermissionGate>

 <section className="space-y-2">
 <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Reglas</h3>
 {rules.length === 0 ? (
 <p className="text-xs text-[var(--color-text-main)]">Todavía no hay ninguna regla: todos los conceptos están pendientes.</p>
 ) : (
 <div className="overflow-x-auto">
 <table className="data-grid min-w-[860px]">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Concepto</th>
 <th className="table-header-cell">Regla</th>
 <th className="table-header-cell">Vigencia</th>
 <th className="table-header-cell">Estado</th>
 <th className="table-header-cell">Respaldo / acción</th>
 </tr>
 </thead>
 <tbody>
 {rules.map((r) => (
 <tr key={r._id}>
 <td className="table-body-cell wrap font-semibold text-[var(--color-text-main)]">
 {CONCEPT_LABEL[r.concept]}{r.label ? ` · ${r.label}` : ''}
 </td>
 <td className="table-body-cell wrap">
 {TREATMENT_LABEL[r.treatment]}{r.rateBps != null ? ` ${pct(r.rateBps)}` : ''} · {r.base === 'gross' ? 'bruto' : 'tras descuentos'} · {r.priceIncludesTax ? 'incluido' : 'encima'}
 {r.conditions ? <span className="block text-[var(--color-text-secondary)]">{r.conditions}</span> : null}
 </td>
 <td className="table-body-cell">{day(r.validFrom)} → {day(r.validTo)}</td>
 <td className="table-body-cell">{r.status === 'draft' ? 'Borrador' : r.status === 'validated' ? 'Validada' : 'Reemplazada'}</td>
 <td className="table-body-cell wrap">
 {r.status === 'draft' ? (
 <div className="space-y-1.5">
 {canApprove(r) ? (
 <div className="flex flex-wrap items-center gap-2">
 <input
 className={`${inputClass} max-w-[260px]`}
 placeholder="Documento que la respalda"
 value={refs[r._id] ?? ''}
 maxLength={300}
 onChange={(e) => setRefs({ ...refs, [r._id]: e.target.value })}
 />
 <button onClick={() => validate(r)} disabled={working} className="cursor-pointer rounded bg-[var(--color-success)] px-2.5 py-1 text-xs font-bold text-[var(--zp-bg)]">Aprobar</button>
 </div>
 ) : (
 <p className="text-xs text-[var(--color-text-secondary)]">
 Espera la aprobación de otra persona con permiso de aprobación tributaria. Quien propone o edita una regla no la aprueba.
 </p>
 )}
 <PermissionGate permission={Permission.FINANCE_MANAGE}>
 <button onClick={() => remove(r)} disabled={working} className="cursor-pointer rounded border border-[var(--color-border)] px-2.5 py-1 text-xs font-semibold text-[var(--color-text-main)]">Eliminar</button>
 </PermissionGate>
 </div>
 ) : (
 <>
 {r.validationRef || '—'}
 {r.proposedValidFrom ? <span className="block text-[var(--color-text-secondary)]">Se pidió desde {day(r.proposedValidFrom)}; rige desde su aprobación.</span> : null}
 </>
 )}
 </td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}
 </section>
 </div>
 );
}
