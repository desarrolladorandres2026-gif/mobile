import { useEffect, useMemo, useState } from 'react';
import {
 Percent, Bike, Receipt, History, Save, AlertTriangle, Lock, CheckCircle2,
 MapPin, Wallet, Banknote, CreditCard
} from 'lucide-react';
import api from '../services/api';
import { apiMessage, apiStatus } from '../lib/apiError';

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
 <div className="zipp-card p-16 text-center text-[var(--color-danger)] text-xs font-semibold">
 {error || 'No hay configuración de precios disponible.'}
 </div>
 );
 }

 const campoMoneda = (campo: keyof PricingConfig, etiqueta: string, ayuda?: string) => (
 <label className="block space-y-1.5">
 <span className="text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider">
 {etiqueta}
 </span>
 <div className="relative">
 <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-xs font-bold text-[var(--color-primary)]">$</span>
 <input
 type="number"
 min={0}
 step={100}
 value={String(valor<number>(campo) ?? 0)}
 onChange={(e) => set(campo as string, Math.round(Number(e.target.value)))}
 className="w-full h-10 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg pl-7 pr-3.5 text-xs font-mono font-bold text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none transition-all"
 />
 </div>
 {ayuda && <p className="text-[10px] text-[var(--color-text-main)]">{ayuda}</p>}
 </label>
 );

 const campoBps = (campo: keyof PricingConfig, etiqueta: string, ayuda?: string) => (
 <label className="block space-y-1.5">
 <span className="text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider">
 {etiqueta}
 </span>
 <div className="relative">
 <input
 type="number"
 min={0}
 max={100}
 step={0.25}
 value={bpsAPorcentaje(valor<number>(campo) ?? 0)}
 onChange={(e) => set(campo as string, porcentajeABps(e.target.value))}
 className="w-full h-10 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg pl-3.5 pr-7 text-xs font-mono font-bold text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none transition-all"
 />
 <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs font-bold text-[var(--color-primary)]">%</span>
 </div>
 {ayuda && <p className="text-[10px] text-[var(--color-text-main)]">{ayuda}</p>}
 </label>
 );

 /** Entero simple con unidad, para campos que no son ni dinero ni una tasa. */
 const campoEntero = (campo: keyof PricingConfig, etiqueta: string, unidad: string, ayuda?: string) => (
 <label className="block space-y-1.5">
 <span className="text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider">
 {etiqueta}
 </span>
 <div className="relative">
 <input
 type="number"
 min={0}
 step={1}
 value={String(valor<number>(campo) ?? 0)}
 onChange={(e) => set(campo as string, Math.round(Number(e.target.value)))}
 className="w-full h-10 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg pl-3.5 pr-14 text-xs font-mono font-bold text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none transition-all"
 />
 <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[10px] font-bold text-[var(--color-text-main)] uppercase">{unidad}</span>
 </div>
 {ayuda && <p className="text-[10px] text-[var(--color-text-main)]">{ayuda}</p>}
 </label>
 );

 /** Interruptor sí/no para reglas que activan o apagan un comportamiento entero. */
 const campoToggle = (campo: keyof PricingConfig, etiqueta: string, ayuda?: string) => (
 <label className="block space-y-1.5">
 <span className="text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider">
 {etiqueta}
 </span>
 <select
 value={valor<boolean>(campo) ? 'on' : 'off'}
 onChange={(e) => set(campo as string, e.target.value === 'on')}
 className="w-full h-10 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-3.5 text-xs font-semibold text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none cursor-pointer"
 >
 <option value="off">Desactivado</option>
 <option value="on">Activado</option>
 </select>
 {ayuda && <p className="text-[10px] text-[var(--color-text-main)]">{ayuda}</p>}
 </label>
 );

 const seccion = (
 icono: typeof Percent,
 titulo: string,
 descripcion: string,
 contenido: React.ReactNode
 ) => {
 const Icono = icono;
 return (
 <div className="zipp-card p-5 space-y-2.5">
 <div className="flex items-start gap-3 border-b border-[var(--color-border-light)] pb-3">
 <div className="w-9 h-9 rounded-lg bg-[var(--color-primary-bg)] text-[var(--color-primary)] flex items-center justify-center">
 <Icono className="w-5 h-5" />
 </div>
 <div>
 <h3 className="text-sm font-bold text-[var(--color-text-main)]">{titulo}</h3>
 <p className="text-xs text-[var(--color-text-main)]">{descripcion}</p>
 </div>
 </div>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">{contenido}</div>
 </div>
 );
 };

 return (
 <div className="space-y-3 animate-fade-in pb-28">
 {/* Header */}
 <div className="page-header">
 <div>
 <h1 className="page-title">Tarifas y Monetización</h1>
 <p className="page-subtitle">Parámetros de cobro de domicilios, comisiones e incentivos</p>
 </div>
 <div className="px-3 py-1.5 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-primary)] font-mono text-xs font-bold shadow-xs">
 Versión Activa: v{config.version}
 </div>
 </div>

 <div className="text-[var(--color-warning)] text-xs flex items-center gap-2.5">
 <AlertTriangle className="w-4 h-4 shrink-0" />
 <p className="font-medium">
 Toda modificación publica una <strong>nueva versión con auditoría</strong>. Los pedidos en curso no se ven afectados por cambios de tarifas.
 </p>
 </div>

 {seccion(Percent, 'Comisión de Comercios', 'Reglas de comisión sobre ventas aplicadas a los negocios aliados.', (
 <>
 {campoBps('merchantCommissionBps', 'Comisión Global ZIPP', 'Aplica a establecimientos sin tarifa personalizada.')}
 <label className="block space-y-1.5">
 <span className="text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider">
 Base de Cálculo
 </span>
 <select
 value={valor<boolean>('commissionAfterMerchantDiscount') ? 'after' : 'before'}
 onChange={(e) => set('commissionAfterMerchantDiscount', e.target.value === 'after')}
 className="w-full h-10 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-3.5 text-xs font-semibold text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none cursor-pointer"
 >
 <option value="after">Sobre el subtotal con descuento</option>
 <option value="before">Sobre el precio bruto de menú</option>
 </select>
 </label>

 <div className="sm:col-span-2 space-y-2">
 <span className="text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider">
 Comisión Diferenciada por Categoría
 </span>
 <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
 {CATEGORIAS.map((cat) => {
 const mapa = (valor<Record<string, number>>('categoryCommissionBps') ?? {}) as Record<string, number>;
 const actual = mapa[cat];
 return (
 <label key={cat} className="block space-y-1">
 <span className="text-[10px] font-bold text-[var(--color-text-main)]">{CATEGORIA_LABEL[cat]}</span>
 <input
 type="number"
 min={0}
 max={100}
 step={0.25}
 placeholder="Global"
 value={actual === undefined ? '' : bpsAPorcentaje(actual)}
 onChange={(e) => {
 const siguiente = { ...mapa };
 if (e.target.value === '') delete siguiente[cat];
 else siguiente[cat] = porcentajeABps(e.target.value);
 set('categoryCommissionBps', siguiente);
 }}
 className="w-full h-9 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2.5 text-xs font-mono font-bold text-[var(--color-primary)] outline-none"
 />
 </label>
 );
 })}
 </div>
 </div>
 </>
 ))}

 {seccion(Bike, 'Tarifas de Domicilio', 'Costo de carrera para el repartidor y cliente final.', (
 <>
 {campoMoneda('driverBaseFee', 'Tarifa Base Repartidor')}
 {campoMoneda('driverPerKm', 'Valor por Kilómetro')}
 {campoMoneda('driverMinFee', 'Pago Mínimo Garantizado')}
 {campoMoneda('freeRadiusMeters', 'Radio Inicial Incluido (Metros)')}
 {campoMoneda('deliveryMarginFixed', 'Margen Fijo ZIPP')}
 {campoBps('deliveryMarginBps', 'Margen Porcentual ZIPP')}
 {campoMoneda('deliveryMinFee', 'Domicilio Mínimo Cliente')}
 {campoMoneda('deliveryMaxFee', 'Domicilio Máximo Cliente')}
 </>
 ))}

 {seccion(Receipt, 'Fee de Servicio', 'Cargos operativos adicionales por procesamiento digital.', (
 <>
 {campoMoneda('serviceFeeFixed', 'Fee Fijo por Pedido')}
 {campoBps('serviceFeeBps', 'Fee Porcentual Servicio')}
 {campoMoneda('serviceFeeMin', 'Fee Mínimo')}
 {campoMoneda('serviceFeeMax', 'Fee Máximo')}
 </>
 ))}

 {seccion(MapPin, 'Cobertura, Propina e Impuesto', 'Límites geográficos y de cobro que aplican a todo pedido, más el redondeo con el que el cliente ve el domicilio.', (
 <>
 {campoEntero('maxRadiusMeters', 'Radio Máximo de Cobertura', 'm', 'Distancia desde el negocio a partir de la cual la dirección queda"fuera de cobertura".')}
 {campoMoneda('deliveryRoundingStep', 'Paso de Redondeo del Domicilio', 'El domicilio final siempre cae en un múltiplo de este valor.')}
 {campoBps('maxTipBps', 'Propina Máxima Permitida', 'Tope sobre el subtotal de productos. El cliente no puede escribir una propina mayor.')}
 {campoBps('taxBps', 'Impuesto Aplicado', 'Se suma sobre subtotal + domicilio + fee de servicio, ya con descuentos aplicados.')}
 </>
 ))}

 {seccion(Wallet, 'Promociones: Subsidio y Presupuesto', 'Techos que protegen el margen de la plataforma frente a cupones y campañas financiadas por ZIPP.', (
 <>
 {campoMoneda('couponSubsidyLimit', 'Tope de Subsidio por Cupón', 'Ningún cupón financiado por ZIPP puede descontar más que esto en un solo pedido, sin importar lo que el cupón permita.')}
 {campoMoneda('campaignBudgetTotal', 'Presupuesto Total de Campañas', 'Techo agregado para todas las campañas activas financiadas por la plataforma. 0 = sin techo agregado.')}
 {campoMoneda('defaultMinimumContributionMargin', 'Margen Mínimo por Defecto', 'Un cupón de plataforma se rechaza si el pedido queda por debajo de este margen, salvo que la campaña esté aprobada por un admin financiero.')}
 </>
 ))}

 {seccion(Banknote, 'Pago Contra Entrega', 'Enciende o apaga el efectivo en toda la plataforma. Requiere un proceso de rendición de cuentas funcionando.', (
 <>
 {campoToggle('cashOnDeliveryEnabled', 'Pago en Efectivo', 'Con esto apagado, el checkout rechaza cualquier intento de pagar contra entrega.')}
 {campoMoneda('cashOnDeliveryMaxAmount', 'Tope por Pedido en Efectivo', 'Un pedido que supere este total obliga a pagar en línea.')}
 </>
 ))}

 {seccion(CreditCard, 'Comisión de la Pasarela (Wompi)', 'La tarifa de tu contrato con Wompi, por método. Cada cobro aprobado asienta esta comisión como gasto y el resultado de la plataforma la resta. En 0 significa sin configurar: no se asienta nada y las cifras de margen siguen marcadas como incompletas.', (
 <>
 {campoBps('gatewayCardBps', 'Tarjeta: Porcentaje')}
 {campoMoneda('gatewayCardFixed', 'Tarjeta: Fijo por Cobro')}
 {campoBps('gatewayPseBps', 'PSE: Porcentaje')}
 {campoMoneda('gatewayPseFixed', 'PSE: Fijo por Cobro')}
 {campoBps('gatewayNequiBps', 'Nequi: Porcentaje')}
 {campoMoneda('gatewayNequiFixed', 'Nequi: Fijo por Cobro')}
 {campoBps('gatewayOtherBps', 'Otros Métodos: Porcentaje', 'Bancolombia, Daviplata y cualquier otro carril de Wompi.')}
 {campoMoneda('gatewayOtherFixed', 'Otros Métodos: Fijo por Cobro')}
 {campoBps('gatewayFeeVatBps', 'IVA sobre la Comisión', 'El IVA que Wompi le suma a su propia comisión. Solo aplica si tu contrato lo cobra aparte.')}
 </>
 ))}

 {/* History */}
 <div className="table-container">
 <div className="px-5 py-3.5 border-b border-[var(--color-border-light)] bg-[var(--color-bg)] flex items-center gap-2">
 <History className="w-4 h-4 text-[var(--color-primary)]" />
 <h3 className="text-sm font-bold text-[var(--color-text-main)]">Auditoría de Cambios de Tarifas</h3>
 </div>

 <div className="max-h-[300px] overflow-y-auto divide-y divide-[var(--color-border-light)]">
 {audit.map((entrada) => (
 <div key={entrada._id} className="p-3.5 px-5 hover:bg-[var(--color-bg)] transition-colors">
 <div className="flex items-center justify-between">
 <span className="text-xs font-bold text-[var(--color-primary)] font-mono">v{entrada.fromVersion ?? 0} → v{entrada.toVersion}</span>
 <span className="text-[10px] text-[var(--color-text-main)] font-mono">
 {new Date(entrada.createdAt).toLocaleString('es-CO')}
 </span>
 </div>
 <p className="text-xs text-[var(--color-text-main)] mt-1 italic">"{entrada.reason}"</p>
 </div>
 ))}
 </div>
 </div>

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

