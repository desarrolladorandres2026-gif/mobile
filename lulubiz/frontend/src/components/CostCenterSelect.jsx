import { api } from '../lib/api.js';
import { useLoad } from './ui.jsx';

/**
 * Los centros de costo activos de la empresa. Quien no puede leerlos (o la empresa no usa ninguno) recibe una lista vacía:
 * los formularios entonces no muestran la columna.
 */
export function useCostCenters(base) {
  const load = useLoad(() => api.get(`${base}/cost-centers?activeOnly=true`).catch(() => ({ items: [] })), [base]);
  return load.data?.items ?? [];
}

/** Selector de centro de costo para una línea. `centers` viene de `useCostCenters`; el valor vacío es «sin centro». */
export function CostCenterSelect({ centers, value, onChange, label, className = '' }) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={onChange}
      className={`rounded-sm border border-borde-fuerte bg-papel px-2 py-1.5 text-sm text-tinta focus:outline-2 focus:outline-azul ${className}`}
    >
      <option value="">Sin centro</option>
      {centers.map((c) => (
        <option key={c.code} value={c.code}>
          {c.code} · {c.name}
        </option>
      ))}
    </select>
  );
}
