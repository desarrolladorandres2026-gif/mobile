import { useEffect, useMemo, useState } from 'react';
import { Save, AlertTriangle, Lock, CheckCircle2 } from 'lucide-react';
import api from '../services/api';
import { apiMessage, apiStatus } from '../lib/apiError';
import NumericInput from '../components/NumericInput';

interface PricingConfig {
 version: number;
 merchantCommissionBps: number;
 categoryCommissionBps: Record<string, number>;
 commissionAfterMerchantDiscount: boolean;
 driverBaseFee: number;
 driverPerKm: number;
 driverMinFee: number;
 freeRadiusMeters: number;
 deliveryMarginFixed: number;
 deliveryMarginBps: number;
 deliveryMinFee: number;
 deliveryMaxFee: number;
 deliveryRoundingStep: number;
 serviceFeeFixed: number;
 serviceFeeBps: number;
 serviceFeeMin: number;
 serviceFeeMax: number;
 maxTipBps: number;
 maxRadiusMeters: number;
 taxBps: number;
 couponSubsidyLimit: number;
 campaignBudgetTotal: number;
 defaultMinimumContributionMargin: number;
 cashOnDeliveryEnabled: boolean;
 cashOnDeliveryMaxAmount: number;
 gatewayCardBps: number;
 gatewayCardFixed: number;
 gatewayPseBps: number;
 gatewayPseFixed: number;
 gatewayNequiBps: number;
 gatewayNequiFixed: number;
 gatewayOtherBps: number;
 gatewayOtherFixed: number;
 gatewayFeeVatBps: number;
 changeReason: string;
 updatedAt: string;
}

interface AuditEntry {
 _id: string;
 fromVersion: number | null;
 toVersion: number;
 changedByName: string;
 changedBy?: { name: string };
 reason: string;
 changes: Record<string, { before: unknown; after: unknown }>;
 createdAt: string;
}

const CATEGORIAS = ['restaurant', 'fast_food', 'pharmacy', 'cafe', 'supermarket'] as const;

const CATEGORIA_LABEL: Record<string, string> = {
 restaurant: 'Restaurantes',
 fast_food: 'Comida rápida',
 pharmacy: 'Droguerías',
 cafe: 'Cafés',
 supermarket: 'Supermercados',
};

const bpsAPorcentaje = (bps: number) => (bps / 100).toFixed(2);
const porcentajeABps = (pct: string) => Math.round(parseFloat(pct || '0') * 100);

export default function Pricing() {
 const [config, setConfig] = useState<PricingConfig | null>(null);
 const [borrador, setBorrador] = useState<Record<string, unknown>>({});
 const [motivo, setMotivo] = useState('');
 const [audit, setAudit] = useState<AuditEntry[]>([]);
 const [loading, setLoading] = useState(true);
 const [guardando, setGuardando] = useState(false);
 const [error, setError] = useState('');
 const [ok, setOk] = useState('');
 const [sinPermiso, setSinPermiso] = useState(false);

 const cargar = async () => {
 try {
 setLoading(true);
 const [resConfig, resAudit] = await Promise.all([
 api.get('/finance/config'),
 api.get('/finance/config/audit?limit=25'),
 ]);
 setConfig(resConfig.data.data);
 setBorrador({});
 setAudit(resAudit.data.data);
 } catch (err) {
 setError(apiMessage(err, 'No se pudo cargar la configuración de precios.'));
 } finally {
 setLoading(false);
 }
 };

 useEffect(() => { cargar(); }, []);

 const set = (campo: string, valor: unknown) =>
 setBorrador((prev) => ({ ...prev, [campo]: valor }));

 const valor = <T,>(campo: keyof PricingConfig): T =>
 (campo in borrador ? borrador[campo as string] : config?.[campo]) as T;

 const cambios = useMemo(() => Object.keys(borrador).length, [borrador]);

 const guardar = async () => {
 setError('');
 setOk('');

 if (motivo.trim().length < 5) {
 setError('Escribe el motivo del cambio (mínimo 5 caracteres para la auditoría).');
 return;
 }
 if (cambios === 0) {
 setError('No has modificado ningún valor.');
 return;
 }

 try {
 setGuardando(true);
 const { data } = await api.put('/finance/config', { ...borrador, reason: motivo.trim() });
 setOk(`Publicada con éxito la versión v${data.data.config.version}. Aplica desde el próximo pedido.`);
 setMotivo('');
 await cargar();
 } catch (err) {
 if (apiStatus(err) === 403) {
 setSinPermiso(true);
 setError('Permisos insuficientes para modificar las tarifas de la plataforma.');
 } else {
 setError(apiMessage(err, 'No se pudo publicar la nueva versión.'));
 }
 } finally {
 setGuardando(false);
 }
 };

 if (loading) {
 return (
 <div className="table-container p-16 text-center text-[var(--color-text-main)] text-xs font-semibold">
 Cargando tarifas y motor de precios...
 </div>
 );
 }

 if (!config) {
 return (
 <div className="p-16 text-center text-[var(--color-danger)] text-xs font-semibold">
 {error || 'No hay configuración de precios disponible.'}
 </div>
 );
 }

 const inputBase =
 'h-7 w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md text-xs font-mono font-bold text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none transition-all';

 const ctrlMoneda = (campo: keyof PricingConfig) => (
 <div className="relative">
 <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs font-bold text-[var(--color-primary)]">$</span>
 <NumericInput
 value={valor<number>(campo) ?? 0}
 onValueChange={(d) => set(campo as string, Number(d))}
 className={`${inputBase} pl-5 pr-2`}
 />
 </div>
 );

 const ctrlBps = (campo: keyof PricingConfig) => (
 <div className="relative">
 <input
 type="number"
 min={0}
 max={100}
 step={0.25}
 value={bpsAPorcentaje(valor<number>(campo) ?? 0)}
 onChange={(e) => set(campo as string, porcentajeABps(e.target.value))}
 className={`${inputBase} pl-2 pr-6`}
 />
 <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-bold text-[var(--color-primary)]">%</span>
 </div>
 );

 /** Entero simple con unidad, para campos que no son ni dinero ni una tasa. */
 const ctrlEntero = (campo: keyof PricingConfig, unidad: string) => (
 <div className="relative">
 <NumericInput
 value={valor<number>(campo) ?? 0}
 onValueChange={(d) => set(campo as string, Number(d))}
 className={`${inputBase} pl-2 pr-7`}
 />
 <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-[var(--color-text-main)] uppercase">{unidad}</span>
 </div>
 );

 /** Interruptor sí/no para reglas que activan o apagan un comportamiento entero. */
 const ctrlToggle = (campo: keyof PricingConfig) => (
 <select
 value={valor<boolean>(campo) ? 'on' : 'off'}
 onChange={(e) => set(campo as string, e.target.value === 'on')}
 className="h-7 w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 text-xs font-semibold text-[var(--color-text-main)] focus:border-[var(--color-primary)] outline-none cursor-pointer"
 >
 <option value="off">Apagado</option>
 <option value="on">Activado</option>
 </select>
 );

 /** Un parámetro: etiqueta, control, texto largo (tooltip) y nota corta (5.ª columna). */
 interface Param { etiqueta: string; control: React.ReactNode; ayuda?: string; nota?: string }

 const COLS5 = ['Parámetro', 'Valor', 'Parámetro', 'Valor', 'Nota'];

 /** Dos parámetros por fila; la 5.ª columna junta las notas de ambos. */
 const tablaPares = (params: Param[], columnas: string[] = COLS5) => {
 const filas: Param[][] = [];
 for (let i = 0; i < params.length; i += 2) filas.push(params.slice(i, i + 2));
 return (
 <div className="overflow-x-auto">
 <table className="data-grid table-fixed min-w-[820px]">
 <colgroup>
 <col className="w-[21%]" /><col className="w-[13%]" /><col className="w-[21%]" /><col className="w-[13%]" /><col />
 </colgroup>
 <thead>
 <tr className="text-left">
 {columnas.map((c, i) => <th key={`${c}-${i}`} className="table-header-cell">{c}</th>)}
 </tr>
 </thead>
 <tbody>
 {filas.map(([a, b]) => {
 const notas = [...new Set([a.nota, b?.nota].filter(Boolean))].join(' · ');
 return (
 <tr key={a.etiqueta}>
 <td className="table-body-cell wrap font-semibold text-[var(--color-text-main)]" title={a.ayuda}>{a.etiqueta}</td>
 <td className="table-body-cell">{a.control}</td>
 <td className="table-body-cell wrap font-semibold text-[var(--color-text-main)]" title={b?.ayuda}>{b?.etiqueta}</td>
 <td className="table-body-cell">{b?.control}</td>
 <td className="table-body-cell wrap text-[var(--color-text-secondary)]">{notas}</td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>
 );
 };

 const seccion = (titulo: string, descripcion: string, contenido: React.ReactNode) => (
 <section className="pt-6 first:pt-0 space-y-2">
 <div>
 <h3 className="text-sm font-semibold text-[var(--color-text-main)]">{titulo}</h3>
 <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">{descripcion}</p>
 </div>
 {contenido}
 </section>
 );

 const mapaCategorias = (valor<Record<string, number>>('categoryCommissionBps') ?? {}) as Record<string, number>;

 const paramCategoria = (cat: (typeof CATEGORIAS)[number]): Param => {
 const actual = mapaCategorias[cat];
 return {
 etiqueta: CATEGORIA_LABEL[cat],
 nota: 'Vacío = comisión global',
 control: (
 <div className="relative">
 <input
 type="number"
 min={0}
 max={100}
 step={0.25}
 placeholder="Global"
 value={actual === undefined ? '' : bpsAPorcentaje(actual)}
 onChange={(e) => {
 const siguiente = { ...mapaCategorias };
 if (e.target.value === '') delete siguiente[cat];
 else siguiente[cat] = porcentajeABps(e.target.value);
 set('categoryCommissionBps', siguiente);
 }}
 className={`${inputBase} pl-2 pr-6 text-[var(--color-primary)]`}
 />
 <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-bold text-[var(--color-primary)]">%</span>
 </div>
 ),
 };
 };

 return (
 <div className="space-y-3 animate-fade-in pb-28">
 {/* Header */}
 <div className="page-header">
 <div>
 <h1 className="page-title">Tarifas y Monetización</h1>
 <p className="page-subtitle">Parámetros de cobro de domicilios, comisiones e incentivos. Pasa el cursor sobre un parámetro para ver su explicación completa.</p>
 </div>
 <div className="text-right">
 <p className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">Versión activa</p>
 <p className="text-sm font-bold text-[var(--color-primary)] font-mono">v{config.version}</p>
 </div>
 </div>

 <div className="text-[var(--color-warning)] text-xs flex items-center gap-2.5">
 <AlertTriangle className="w-4 h-4 shrink-0" />
 <p className="font-medium">
 Toda modificación publica una <strong>nueva versión con auditoría</strong>. Los pedidos en curso no se ven afectados por cambios de tarifas.
 </p>
 </div>

 {seccion('Comisión de Comercios', 'Reglas de comisión sobre ventas aplicadas a los negocios aliados.', (
 <>
 {tablaPares([
 { etiqueta: 'Comisión Global ZIPP', control: ctrlBps('merchantCommissionBps'), nota: 'Negocios sin tarifa propia', ayuda: 'Aplica a establecimientos sin tarifa personalizada.' },
 {
 etiqueta: 'Base de Cálculo',
 nota: 'Sobre qué monto se cobra',
 control: (
 <select
 value={valor<boolean>('commissionAfterMerchantDiscount') ? 'after' : 'before'}
 onChange={(e) => set('commissionAfterMerchantDiscount', e.target.value === 'after')}
 className="h-7 w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 text-xs font-semibold text-[var(--color-text-main)] focus:border-[var(--color-primary)] outline-none cursor-pointer"
 >
 <option value="after">Subtotal con descuento</option>
 <option value="before">Precio bruto de menú</option>
 </select>
 ),
 },
 ])}
 <div className="pt-2">
 {tablaPares(CATEGORIAS.map(paramCategoria), ['Categoría', 'Comisión', 'Categoría', 'Comisión', 'Nota'])}
 </div>
 </>
 ))}

 {seccion('Tarifas de Domicilio', 'Costo de carrera para el repartidor y cliente final.', tablaPares([
 { etiqueta: 'Tarifa Base Repartidor', control: ctrlMoneda('driverBaseFee'), nota: 'Pago al repartidor' },
 { etiqueta: 'Valor por Kilómetro', control: ctrlMoneda('driverPerKm') },
 { etiqueta: 'Pago Mínimo Garantizado', control: ctrlMoneda('driverMinFee'), nota: 'Pago al repartidor' },
 { etiqueta: 'Radio Inicial Incluido', control: ctrlEntero('freeRadiusMeters', 'm'), ayuda: 'Distancia cubierta por la tarifa base, antes de cobrar por kilómetro.' },
 { etiqueta: 'Margen Fijo ZIPP', control: ctrlMoneda('deliveryMarginFixed'), nota: 'Margen ZIPP' },
 { etiqueta: 'Margen Porcentual ZIPP', control: ctrlBps('deliveryMarginBps') },
 { etiqueta: 'Domicilio Mínimo', control: ctrlMoneda('deliveryMinFee'), nota: 'Tope al cliente' },
 { etiqueta: 'Domicilio Máximo', control: ctrlMoneda('deliveryMaxFee') },
 ]))}

 {seccion('Fee de Servicio', 'Cargos operativos adicionales por procesamiento digital.', tablaPares([
 { etiqueta: 'Fee Fijo por Pedido', control: ctrlMoneda('serviceFeeFixed'), nota: 'Componentes del fee' },
 { etiqueta: 'Fee Porcentual', control: ctrlBps('serviceFeeBps') },
 { etiqueta: 'Fee Mínimo', control: ctrlMoneda('serviceFeeMin'), nota: 'Rango del fee' },
 { etiqueta: 'Fee Máximo', control: ctrlMoneda('serviceFeeMax') },
 ]))}

 {seccion('Cobertura, Propina e Impuesto', 'Límites geográficos y de cobro que aplican a todo pedido, más el redondeo con el que el cliente ve el domicilio.', tablaPares([
 { etiqueta: 'Radio Máximo de Cobertura', control: ctrlEntero('maxRadiusMeters', 'm'), nota: 'Fuera de cobertura', ayuda: 'Distancia desde el negocio a partir de la cual la dirección queda "fuera de cobertura".' },
 { etiqueta: 'Paso de Redondeo', control: ctrlMoneda('deliveryRoundingStep'), ayuda: 'El domicilio final siempre cae en un múltiplo de este valor.' },
 { etiqueta: 'Propina Máxima', control: ctrlBps('maxTipBps'), nota: 'Tope sobre el subtotal de productos', ayuda: 'Tope sobre el subtotal de productos. El cliente no puede escribir una propina mayor.' },
 { etiqueta: 'Impuesto Aplicado', control: ctrlBps('taxBps'), nota: 'Sobre subtotal + domicilio + fee', ayuda: 'Se suma sobre subtotal + domicilio + fee de servicio, ya con descuentos aplicados.' },
 ]))}

 {seccion('Promociones: Subsidio y Presupuesto', 'Techos que protegen el margen de la plataforma frente a cupones y campañas financiadas por ZIPP.', tablaPares([
 { etiqueta: 'Tope de Subsidio por Cupón', control: ctrlMoneda('couponSubsidyLimit'), nota: 'Por pedido', ayuda: 'Ningún cupón financiado por ZIPP puede descontar más que esto en un solo pedido, sin importar lo que el cupón permita.' },
 { etiqueta: 'Presupuesto de Campañas', control: ctrlMoneda('campaignBudgetTotal'), nota: '0 = sin techo agregado', ayuda: 'Techo agregado para todas las campañas activas financiadas por la plataforma. 0 = sin techo agregado.' },
 { etiqueta: 'Margen Mínimo por Defecto', control: ctrlMoneda('defaultMinimumContributionMargin'), nota: 'Cupón de plataforma se rechaza bajo este margen', ayuda: 'Un cupón de plataforma se rechaza si el pedido queda por debajo de este margen, salvo que la campaña esté aprobada por un admin financiero.' },
 ]))}

 {seccion('Pago Contra Entrega', 'Enciende o apaga el efectivo en toda la plataforma. Requiere un proceso de rendición de cuentas funcionando.', tablaPares([
 { etiqueta: 'Pago en Efectivo', control: ctrlToggle('cashOnDeliveryEnabled'), nota: 'Apagado: el checkout rechaza efectivo', ayuda: 'Con esto apagado, el checkout rechaza cualquier intento de pagar contra entrega.' },
 { etiqueta: 'Tope por Pedido', control: ctrlMoneda('cashOnDeliveryMaxAmount'), nota: 'Superarlo obliga a pagar en línea', ayuda: 'Un pedido que supere este total obliga a pagar en línea.' },
 ]))}

 {seccion('Comisión de la Pasarela (Wompi)', 'La tarifa de tu contrato con Wompi, por método. Cada cobro aprobado asienta esta comisión como gasto y el resultado de la plataforma la resta. En 0 significa sin configurar: no se asienta nada y las cifras de margen siguen marcadas como incompletas.', tablaPares([
 { etiqueta: 'Tarjeta: Porcentaje', control: ctrlBps('gatewayCardBps'), nota: 'Tarjeta' },
 { etiqueta: 'Tarjeta: Fijo', control: ctrlMoneda('gatewayCardFixed') },
 { etiqueta: 'PSE: Porcentaje', control: ctrlBps('gatewayPseBps'), nota: 'PSE' },
 { etiqueta: 'PSE: Fijo', control: ctrlMoneda('gatewayPseFixed') },
 { etiqueta: 'Nequi: Porcentaje', control: ctrlBps('gatewayNequiBps'), nota: 'Nequi' },
 { etiqueta: 'Nequi: Fijo', control: ctrlMoneda('gatewayNequiFixed') },
 { etiqueta: 'Otros: Porcentaje', control: ctrlBps('gatewayOtherBps'), nota: 'Bancolombia, Daviplata y otros carriles', ayuda: 'Bancolombia, Daviplata y cualquier otro carril de Wompi.' },
 { etiqueta: 'Otros: Fijo', control: ctrlMoneda('gatewayOtherFixed') },
 { etiqueta: 'IVA sobre la Comisión', control: ctrlBps('gatewayFeeVatBps'), nota: 'Solo si el contrato lo cobra aparte', ayuda: 'El IVA que Wompi le suma a su propia comisión. Solo aplica si tu contrato lo cobra aparte.' },
 ]))}

 {seccion('Auditoría de cambios de tarifas', 'Últimas versiones publicadas.', (
 <div className="max-h-[320px] overflow-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Versión</th>
 <th className="table-header-cell">Fecha</th>
 <th className="table-header-cell">Autor</th>
 <th className="table-header-cell">Campos</th>
 <th className="table-header-cell">Motivo</th>
 </tr>
 </thead>
 <tbody>
 {audit.map((entrada) => (
 <tr key={entrada._id}>
 <td className="table-body-cell font-mono font-bold text-[var(--color-primary)]">v{entrada.fromVersion ?? 0} → v{entrada.toVersion}</td>
 <td className="table-body-cell font-mono text-[var(--color-text-main)]">{new Date(entrada.createdAt).toLocaleString('es-CO')}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{entrada.changedByName || entrada.changedBy?.name || '—'}</td>
 <td className="table-body-cell font-mono text-[var(--color-text-main)]">{Object.keys(entrada.changes ?? {}).length}</td>
 <td className="table-body-cell wrap italic text-[var(--color-text-main)]">{entrada.reason}</td>
 </tr>
 ))}
 {audit.length === 0 && (
 <tr>
 <td colSpan={5} className="table-body-cell text-center text-[var(--color-text-secondary)]">Aún no hay cambios registrados.</td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 ))}

 {/* Floating Action Bar */}
 <div className="fixed bottom-6 left-6 lg:left-72 right-6 z-40 bg-[var(--color-surface)] p-3.5 rounded-2xl border border-[var(--color-border)] flex flex-col sm:flex-row items-center justify-between gap-3 shadow-xl">
 <input
 value={motivo}
 onChange={(e) => setMotivo(e.target.value)}
 placeholder="Escribe la justificación del cambio de precios..."
 className="w-full sm:flex-1 h-10 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-3.5 text-xs font-medium text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)]"
 />

 <button
 onClick={guardar}
 disabled={guardando || cambios === 0 || sinPermiso}
 className="w-full sm:w-auto h-10 px-5 bg-[var(--color-primary)] hover:bg-[#8A5D08] text-white font-bold text-xs uppercase tracking-wider rounded-lg transition-all shadow-xs cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
 >
 {sinPermiso ? <Lock className="w-4 h-4" /> : <Save className="w-4 h-4" />}
 <span>{guardando ? 'Publicando...' : 'Publicar Tarifas'}</span>
 </button>
 </div>

 {error && (
 <div className="fixed bottom-24 right-6 z-50 p-3.5 rounded-xl bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger)] text-xs font-bold animate-fade-in shadow-lg">
 {error}
 </div>
 )}

 {ok && (
 <div className="fixed bottom-24 right-6 z-50 p-3.5 rounded-xl bg-[var(--color-primary-bg)] border border-[var(--color-primary-bg)] text-[var(--color-primary)] text-xs font-bold animate-fade-in flex items-center gap-2 shadow-lg">
 <CheckCircle2 className="w-4 h-4" />
 <span>{ok}</span>
 </div>
 )}
 </div>
 );
}

