from helper import *
T='table-body-cell text-[var(--color-text-main)]'
rep('Campaigns.tsx', lambda k,L: 'className="grid gap-2.5"' in L[k] and 'filtered.map' in L[k+1], grid(
 ['Flyer','Campaña','Anunciante','Ubicación','Estado','Tarifa','Fechas','Prioridad','Impresiones','Clics','Duración','Pagado','Acciones'],
 '''{filtered.map((c) => {
const st = STATUS_STYLES[c.status];
return (
<tr key={c._id}>
<td className="table-body-cell">
<button
onClick={() => setPreviewCampaign(c)}
className="h-10 w-16 cursor-pointer overflow-hidden"
title="Vista previa del flyer"
>
<img src={sizedImage(c.flyerUrl, 640)} alt={c.campaignName} loading="lazy" decoding="async" className="h-full w-full object-cover" />
</button>
</td>
<td className="%s">{c.campaignName}</td>
<td className="%s">{c.advertiserName}</td>
<td className="%s">{PLACEMENT_LABEL[c.placement ?? 'splash']}</td>
<td className="table-body-cell wrap" style={{ color: st.text }}>
{st.label}
{/* Una campaña que compró un comercio y nadie ha
mirado no sale en la app. Se avisa aquí porque
esta es la lista donde se revisa. */}
{c.approvalStatus === 'pending' ? (
<span className="text-[var(--color-warning)]"> · La compró el comercio y espera revisión, no se está mostrando</span>
) : null}
{c.approvalStatus === 'rejected' && c.rejectionReason ? (
<span className="text-[var(--color-danger)]"> · Rechazada: {c.rejectionReason}</span>
) : null}
</td>
<td className="%s">
{c.budget
? `${c.pricingModel === 'cpc'
? `$${(c.cpcRate ?? 0).toLocaleString('es-CO')} por clic`
: `$${(c.cpmRate ?? 0).toLocaleString('es-CO')} por mil impresiones`} · tope $${c.budget.toLocaleString('es-CO')}`
: '—'}
</td>
<td className="%s">{new Date(c.startDate).toLocaleDateString('es-CO')} — {new Date(c.endDate).toLocaleDateString('es-CO')}</td>
<td className="table-body-cell text-[var(--color-primary)]">{c.priority}</td>
<td className="%s">{c.impressionCount}{c.maxImpressions > 0 ? ` / ${c.maxImpressions}` : ''}</td>
<td className="%s">{c.clickCount}</td>
<td className="%s">{c.durationSeconds}s</td>
<td className="%s">{c.pricePaid > 0 ? `$${c.pricePaid.toLocaleString('es-CO')}` : '—'}</td>
<td className="table-body-cell">
<div className="flex items-center gap-2">
{c.approvalStatus === 'pending' ? (
<>
<PermissionGate permission={Permission.ADS_MANAGE}>
<button onClick={() => handleApprove(c)} className="cursor-pointer text-[var(--color-primary)]">
Aprobar
</button>
</PermissionGate>
<button onClick={() => handleReject(c)} className="cursor-pointer text-[var(--color-text-main)]">
Rechazar
</button>
</>
) : null}
{/* Cerrar es cobrar: solo cuando ya terminó o se
canceló, y solo si nadie la ha facturado antes
—el índice único del servidor lo garantiza igual. */}
{(c.status === 'finished' || c.status === 'cancelled') && c.budget ? (
<PermissionGate permission={Permission.ADS_MANAGE}>
<button
onClick={() => handleClose(c)}
className="cursor-pointer text-[var(--color-text-main)]"
title="Cerrar la campaña y emitir su factura"
>
Cerrar y facturar
</button>
</PermissionGate>
) : null}
<button
onClick={() => openStats(c)}
className="cursor-pointer text-[var(--color-text-main)] hover:text-[var(--color-primary)]"
title="Ver estadísticas"
>
<BarChart3 className="w-4 h-4" />
</button>
<PermissionGate permission={Permission.ADS_MANAGE}>
<button
onClick={() => openEdit(c)}
className="cursor-pointer text-[var(--color-text-main)] hover:text-[var(--color-primary)]"
title="Editar campaña"
>
<Pencil className="w-4 h-4" />
</button>
</PermissionGate>
{c.status !== 'cancelled' && c.status !== 'finished' && (
<PermissionGate permission={Permission.ADS_MANAGE}>
<button
onClick={() => handleToggle(c)}
className="cursor-pointer"
title={c.isActive ? 'Pausar campaña' : 'Reactivar campaña'}
>
{c.isActive ? (
<ToggleRight className="w-5 h-5 text-[var(--color-primary)]" />
) : (
<ToggleLeft className="w-5 h-5 text-[var(--color-text-main)]" />
)}
</button>
</PermissionGate>
)}
{c.status !== 'cancelled' && (
<PermissionGate permission={Permission.ADS_MANAGE}>
<button
onClick={() => setConfirmCancel(c)}
className="cursor-pointer text-[var(--color-text-main)] hover:text-[var(--color-danger)]"
title="Cancelar campaña"
>
<XOctagon className="w-4 h-4" />
</button>
</PermissionGate>
)}
<PermissionGate permission={Permission.ADS_MANAGE}>
<button
onClick={() => setConfirmDelete(c)}
className="cursor-pointer text-[var(--color-text-main)] hover:text-[var(--color-danger)]"
title="Eliminar campaña"
>
<Trash2 className="w-4 h-4" />
</button>
</PermissionGate>
</div>
</td>
</tr>
);
})}''' % (T,T,T,T,T,T,T,T,T)), end_tag='AFTER_MAP')
