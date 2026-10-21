import { useEffect, useId, useState } from 'react';
import { api } from '../lib/api.js';
import { formatQuantity } from '../lib/invoicing.js';
import { useLoad } from './ui.jsx';

/**
 * Elige un artículo del inventario escribiendo su código o parte del nombre. Es un campo con lista de sugerencias:
 * el artículo queda elegido cuando el texto es exactamente un código de la lista. `text` es lo escrito y `item` el
 * artículo elegido (o `null`); `onChange(text, item)` informa de ambos a la vez.
 */
export function ItemPicker({ base, label = 'Artículo', text, item, onChange, error, className = '', showStock = true }) {
  const listId = useId();
  const [debounced, setDebounced] = useState(text.trim());
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const found = useLoad(
    () => api.get(`${base}/items?type=goods&active=true&limit=20${debounced ? `&search=${encodeURIComponent(debounced)}` : ''}`),
    [base, debounced],
  );
  const options = found.data?.items ?? [];

  const match = (value) => options.find((o) => o.sku.toLowerCase() === value.trim().toLowerCase()) ?? null;

  // Si las sugerencias llegan después de que el texto ya era un código completo, el artículo se elige solo.
  useEffect(() => {
    if (item) {
      // Un artículo elegido con datos de una lista vieja (otra venta ya movió las existencias) se actualiza con la nueva.
      const fresh = options.find((o) => o._id === item._id);
      if (fresh && (fresh.onHand !== item.onHand || fresh.price !== item.price)) onChange(text, fresh);
      return;
    }
    const exact = options.find((o) => o.sku.toLowerCase() === text.trim().toLowerCase());
    if (exact) onChange(text, exact);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  return (
    <div className={className}>
      <input
        aria-label={label}
        aria-invalid={error ? 'true' : undefined}
        list={listId}
        value={text}
        maxLength={40}
        placeholder="Código o nombre"
        onChange={(e) => onChange(e.target.value, match(e.target.value))}
        className={`w-full rounded-sm border bg-papel px-2 py-1.5 text-sm text-tinta focus:outline-2 focus:outline-azul ${error ? 'border-rojo' : 'border-borde-fuerte'}`}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o._id} value={o.sku}>
            {o.name}
          </option>
        ))}
      </datalist>
      {item && showStock ? (
        <p className="mt-1 text-xs text-tinta">
          {item.name} · hay {formatQuantity(item.onHand ?? 0)} {item.unit}
        </p>
      ) : null}
      {item && !showStock ? <p className="mt-1 text-xs text-tinta">{item.name}</p> : null}
      {!item && text.trim() ? <p className="mt-1 text-xs text-tinta-segundo">Elige un código de la lista.</p> : null}
      {error ? (
        <p role="alert" className="text-xs font-semibold text-rojo">
          {error}
        </p>
      ) : null}
    </div>
  );
}
