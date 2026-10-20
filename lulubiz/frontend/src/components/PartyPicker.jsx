import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { SelectField, TextField, useLoad } from './ui.jsx';

const NOUN = { customer: { one: 'cliente', many: 'clientes', article: 'un' }, supplier: { one: 'proveedor', many: 'proveedores', article: 'un' } };

/**
 * Elige un tercero por nombre o número de documento. `role` es `customer` o `supplier`. `initial` es uno ya elegido
 * (por ejemplo desde un informe): se ofrece aunque no salga en la primera página de resultados.
 */
export function PartyPicker({ base, role = 'customer', value, onChange, error, initial = null }) {
  const noun = NOUN[role];
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState(initial);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const found = useLoad(
    () => api.get(`${base}/parties?role=${role}&activeOnly=true&limit=20${debounced ? `&search=${encodeURIComponent(debounced)}` : ''}`),
    [base, role, debounced],
  );
  const options = useMemo(() => {
    const items = found.data?.items ?? [];
    return selected && !items.some((p) => p._id === selected._id) ? [selected, ...items] : items;
  }, [found.data, selected]);
  const title = noun.one[0].toUpperCase() + noun.one.slice(1);

  return (
    <div className="grid gap-x-4 sm:grid-cols-2">
      <TextField label={`Buscar ${noun.one}`} value={search} onChange={(e) => setSearch(e.target.value)} hint="Por nombre o por número de documento." />
      <SelectField
        label={title}
        value={value}
        error={error}
        onChange={(e) => {
          onChange(e.target.value);
          setSelected(options.find((p) => p._id === e.target.value) ?? null);
        }}
        options={[
          { value: '', label: options.length ? `Elige ${noun.article} ${noun.one}` : `No hay ${noun.many} con esa búsqueda` },
          ...options.map((p) => ({ value: p._id, label: `${p.name} — ${p.taxIdType ? `${p.taxIdType} ` : ''}${p.taxId}` })),
        ]}
      />
    </div>
  );
}
