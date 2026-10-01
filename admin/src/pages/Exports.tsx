import { useState } from 'react';
import { Download } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';

/**
 * Exportes contables para el contador.
 *
 * Cada descarga pide un motivo y el código de tu app de verificación en dos
 * pasos, y queda en la auditoría con el rango y el número de filas. No llevan
 * teléfonos ni documentos de personas.
 */

const KINDS = [
 { id: 'ledger', label: 'Libro mayor', hint: 'Cada asiento contable del rango, línea por línea.' },
 { id: 'settlements', label: 'Liquidaciones', hint: 'Lo liquidado a comercios y domiciliarios, con su estado de pago.' },
 { id: 'refunds', label: 'Reembolsos y contracargos', hint: 'Lo devuelto a clientes y quién asumió cada parte.' },
 { id: 'payments', label: 'Pagos de Wompi', hint: 'Cobros en línea con su comisión estimada.' },
 { id: 'cash', label: 'Efectivo', hint: 'Lo que los domiciliarios cobraron y su estado de rendición.' },
 { id: 'documents', label: 'Comprobantes internos', hint: 'El paquete mensual: un renglón por comprobante INT- emitido.' },
] as const;

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** Una respuesta de error de una descarga llega como Blob: hay que leerla para mostrar el motivo. */
async function downloadError(err: unknown): Promise<string> {
 const blob = (err as { response?: { data?: unknown } })?.response?.data;
 if (blob instanceof Blob) {
 try {
 const body = JSON.parse(await blob.text());
 if (typeof body?.message === 'string') return body.message;
 } catch {
 /* cae al mensaje genérico */
 }
 }
 return apiMessage(err, 'No se pudo generar el exporte.');
}

const input =
 'h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-xs outline-none focus:border-[var(--color-primary)]';
const label = 'text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-main)]';

export default function Exports() {
 const [kind, setKind] = useState<(typeof KINDS)[number]['id']>('ledger');
 const [from, setFrom] = useState(daysAgo(29));
 const [to, setTo] = useState(today());
 const [reason, setReason] = useState('');
 const [totp, setTotp] = useState('');
 const [error, setError] = useState('');
 const [notice, setNotice] = useState('');
 const [busy, setBusy] = useState(false);

 const download = async () => {
 if (reason.trim().length < 5) return setError('Escribe el motivo del exporte (mínimo 5 caracteres).');
 if (totp.trim().length < 6) return setError('Escribe el código de tu app de verificación.');
 setBusy(true);
 setError('');
 setNotice('');
 try {
 const res = await api.post(
 `/finance/exports/${kind}`,
 { reason: reason.trim(), totpToken: totp.trim(), from, to },
 { responseType: 'blob' }
 );
 const name = /filename="([^"]+)"/.exec(res.headers['content-disposition'] ?? '')?.[1] ?? `${kind}.csv`;
 const url = URL.createObjectURL(res.data as Blob);
 const a = document.createElement('a');
 a.href = url;
 a.download = name;
 a.click();
 URL.revokeObjectURL(url);
 setNotice(`Descargado: ${name}`);
 setTotp('');
 } catch (err) {
 setError(await downloadError(err));
 } finally {
 setBusy(false);
 }
 };

 const current = KINDS.find((k) => k.id === kind)!;

 return (
 <div className="max-w-xl space-y-5 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Exportes contables</h1>
 <p className="page-subtitle">CSV para el contador, con motivo y verificación en dos pasos</p>
 </div>
 </div>

 <div className="divide-y divide-[var(--color-border-light)]">
 {KINDS.map((k) => (
 <button
 key={k.id}
 onClick={() => setKind(k.id)}
 className={`block w-full cursor-pointer py-2.5 text-left ${kind === k.id ? '' : 'opacity-70 hover:opacity-100'}`}
 >
 <p className={`text-sm font-bold ${kind === k.id ? 'text-[var(--color-text-main)]' : 'text-[var(--color-text-main)]'}`}>{k.label}</p>
 {kind === k.id && <p className="text-[11px] text-[var(--color-text-main)]">{current.hint}</p>}
 </button>
 ))}
 </div>

 <div className="grid grid-cols-2 gap-3">
 <label className="block space-y-1">
 <span className={label}>Desde</span>
 <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={input} />
 </label>
 <label className="block space-y-1">
 <span className={label}>Hasta</span>
 <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={input} />
 </label>
 </div>
 <label className="block space-y-1">
 <span className={label}>Motivo del exporte</span>
 <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Cierre contable de septiembre" className={input} />
 </label>
 <label className="block space-y-1">
 <span className={label}>Código de verificación en dos pasos</span>
 <input value={totp} onChange={(e) => setTotp(e.target.value)} inputMode="numeric" maxLength={12} autoComplete="one-time-code" className={input} />
 </label>

 {error && <p className="text-xs font-semibold text-[var(--color-danger)]">{error}</p>}
 {notice && <p className="text-xs font-semibold text-[var(--color-text-main)]">{notice}</p>}

 <button
 onClick={download}
 disabled={busy}
 className="flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-[var(--color-primary)] px-5 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-60"
 >
 <Download className="h-4 w-4" /> {busy ? 'Generando…' : `Descargar ${current.label.toLowerCase()}`}
 </button>
 </div>
 );
}
