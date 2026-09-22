import { useEffect, useState } from 'react';
import { MessageSquare, ShieldCheck, AlertCircle, RotateCw } from 'lucide-react';
import api from '../services/api';
import type { DataRequest, PqrsItem } from '../lib/apiTypes';

export default function LegalOps() {
  const [pqrs, setPqrs] = useState<PqrsItem[]>([]);
  const [requests, setRequests] = useState<DataRequest[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      setLoading(true);
      setError('');
      const [p, d] = await Promise.all([
        api.get('/pqrs'),
        api.get('/legal/admin/data-requests')
      ]);
      setPqrs(p.data.data);
      setRequests(d.data.data);
    } catch {
      setError('No fue posible cargar las solicitudes legales.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const answerPqrs = async (id: string) => {
    const message = window.prompt('Respuesta para la PQRS:');
    if (!message?.trim()) return;
    await api.patch(`/pqrs/${id}/respond`, { message, status: 'answered' });
    load();
  };

  const answerData = async (id: string) => {
    const response = window.prompt('Respuesta a la solicitud de datos:');
    if (!response?.trim()) return;
    await api.patch(`/legal/admin/data-requests/${id}`, { response, status: 'resolved' });
    load();
  };

  if (loading) {
    return (
      <div className="table-container p-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
        <RotateCw className="w-6 h-6 text-[var(--color-primary)] animate-spin mx-auto mb-2" />
        Cargando solicitudes legales...
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Legal y Atención al Cliente</h1>
          <p className="page-subtitle">PQRS y solicitudes de protección de datos con trazabilidad</p>
        </div>
      </div>

      {error && (
        <div className="text-[var(--color-danger)] text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          <span>{error}</span>
        </div>
      )}

      {/* PQRS Section */}
      <div className="zipp-card p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-[var(--color-border-light)] pb-3">
          <div className="flex items-center gap-2.5">
            <MessageSquare className="w-5 h-5 text-[var(--color-primary)]" />
            <h2 className="text-sm font-bold text-[var(--color-text-main)]">Peticiones, Quejas y Reclamos (PQRS)</h2>
          </div>
          <span className="text-xs font-bold text-[var(--color-text-secondary)]">{pqrs.length} solicitudes</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--color-text-muted)] border-b border-[var(--color-border-light)]">
                <th className="pb-2 font-semibold">Tipo</th>
                <th className="pb-2 font-semibold">Asunto</th>
                <th className="pb-2 font-semibold">Estado</th>
                <th className="pb-2 font-semibold text-right">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-light)]">
              {pqrs.map((x) => (
                <tr key={x._id} className="hover:bg-[var(--color-bg)] transition-colors">
                  <td className="py-3 font-semibold text-[var(--color-text-main)] capitalize">{x.type}</td>
                  <td className="py-3 text-[var(--color-text-secondary)]">{x.subject}</td>
                  <td className="py-3">
                    <span className="text-[10px] font-bold text-[var(--color-primary)]">
                      {x.status}
                    </span>
                  </td>
                  <td className="py-3 text-right">
                    <button
                      onClick={() => answerPqrs(x._id)}
                      className="px-3 py-1 rounded-md bg-[var(--color-primary)] text-white font-bold hover:bg-[#8A5D08] transition-colors cursor-pointer"
                    >
                      Responder
                    </button>
                  </td>
                </tr>
              ))}
              {pqrs.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-[var(--color-text-muted)]">
                    No hay solicitudes de PQRS pendientes.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Habeas Data Section */}
      <div className="zipp-card p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-[var(--color-border-light)] pb-3">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 text-[var(--color-primary)]" />
            <h2 className="text-sm font-bold text-[var(--color-text-main)]">Protección y Derechos de Datos (Habeas Data)</h2>
          </div>
          <span className="text-xs font-bold text-[var(--color-text-secondary)]">{requests.length} solicitudes</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--color-text-muted)] border-b border-[var(--color-border-light)]">
                <th className="pb-2 font-semibold">Tipo</th>
                <th className="pb-2 font-semibold">Estado</th>
                <th className="pb-2 font-semibold">Detalle</th>
                <th className="pb-2 font-semibold text-right">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-light)]">
              {requests.map((x) => (
                <tr key={x._id} className="hover:bg-[var(--color-bg)] transition-colors">
                  <td className="py-3 font-semibold text-[var(--color-text-main)]">{x.type}</td>
                  <td className="py-3">
                    <span className="text-[10px] font-bold text-[#8A5D08]">
                      {x.status}
                    </span>
                  </td>
                  <td className="py-3 text-[var(--color-text-secondary)]">{x.detail}</td>
                  <td className="py-3 text-right">
                    <button
                      onClick={() => answerData(x._id)}
                      className="px-3 py-1 rounded-md bg-[var(--color-primary)] text-white font-bold hover:bg-[#8A5D08] transition-colors cursor-pointer"
                    >
                      Resolver
                    </button>
                  </td>
                </tr>
              ))}
              {requests.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-[var(--color-text-muted)]">
                    No hay solicitudes de datos pendientes.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

