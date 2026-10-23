import { useEffect, useId, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { TextField, useLoad } from './ui.jsx';

const NOUN = { customer: { one: 'cliente', many: 'clientes' }, supplier: { one: 'proveedor', many: 'proveedores' }, any: { one: 'tercero', many: 'terceros' } };

const labelOf = (p) => `${p.name} — ${p.taxIdType ? `${p.taxIdType} ` : ''}${p.taxId}`;

/**
 * Elige un tercero escribiendo su nombre o su número de documento, en un solo campo con sugerencias. `role` es `customer`,
 * `supplier` o `any` (cualquier tercero). El tercero queda elegido cuando el texto es exactamente una sugerencia, su nombre
 * o su número de documento. `initial` es uno ya elegido (por ejemplo desde un informe): se ofrece aunque no salga en la
 * primera página de resultados. `onChange` recibe el identificador, o `''` si el texto no corresponde a ningún tercero.
 */
export function PartyPicker({ base, role = 'customer', value, onChange, error, initial = null }) {
  const noun = NOUN[role];
  const listId = useId();
  const [text, setText] = useState(initial ? labelOf(initial) : '');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  // Si quien llama vacía la elección (por ejemplo tras guardar el documento), el campo se vacía también.
  useEffect(() => {
    if (!value) setText((current) => (current && options.some((p) => labelOf(p) === current) ? '' : current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const found = useLoad(
    () => api.get(`${base}/parties?${role === 'any' ? '' : `role=${role}&`}activeOnly=true&limit=20${debounced ? `&search=${encodeURIComponent(debounced)}` : ''}`),
    [base, role, debounced],
  );
  const options = useMemo(() => {
    const items = found.data?.items ?? [];
    return initial && !items.some((p) => p._id === initial._id) ? [initial, ...items] : items;
  }, [found.data, initial]);

  const match = (typed) => {
    const t = typed.trim().toLowerCase();
    if (!t) return null;
    return options.find((p) => labelOf(p).toLowerCase() === t || p.taxId.toLowerCase() === t || p.name.toLowerCase() === t) ?? null;
  };
  // Si las sugerencias llegan después de que el texto ya era un tercero completo, queda elegido solo.
  useEffect(() => {
    const m = match(text);
    if (m && m._id !== value) onChange(m._id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);
  const chosen = options.find((p) => p._id === value) ?? null;
  const unknown = text.trim() && !chosen && !found.loading && debounced === text.trim() && !match(text);

  return (
    <div>
      <TextField
        label={noun.one[0].toUpperCase() + noun.one.slice(1)}
        list={listId}
        value={text}
        maxLength={120}
        placeholder="Nombre o número de documento"
        error={error}
        onChange={(e) => {
          setText(e.target.value);
          onChange(match(e.target.value)?._id ?? '');
        }}
        hint={unknown ? `No hay ${noun.many} con esa búsqueda.` : chosen ? undefined : `Escribe y elige un ${noun.one} de la lista.`}
      />
      <datalist id={listId}>
        {options.map((p) => (
          <option key={p._id} value={labelOf(p)} />
        ))}
      </datalist>
    </div>
  );
}
