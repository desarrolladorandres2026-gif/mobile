import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PlainButton } from './Button';
import { FormStatus, TextField } from './Form';
import { ADDRESSES_KEY, addressApi, addressPoint, type Address, type PlaceSuggestion } from '../lib/commerceApi';
import { ApiError } from '../lib/http';
import { useCity } from '../lib/city';

const SEARCH_DELAY_MS = 400;
const MIN_SEARCH_LENGTH = 4;

function NewAddress({ onCreated, onCancel }: { onCreated: (a: Address) => void; onCancel: () => void }) {
  const { city } = useCity();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [results, setResults] = useState<PlaceSuggestion[]>([]);
  const [picked, setPicked] = useState<PlaceSuggestion | null>(null);
  const [searching, setSearching] = useState(false);
  const [label, setLabel] = useState('Casa');
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const searchable = !picked && text.trim().length >= MIN_SEARCH_LENGTH;
  // Los resultados viejos no se muestran cuando ya no hay nada que buscar.
  const shown = searchable ? results : [];

  // Busca al dejar de escribir; el backend limita las búsquedas por minuto.
  useEffect(() => {
    const query = `${text.trim()}, ${city}`;
    if (!searchable) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      addressApi.search(query)
        .then((r) => { if (!cancelled) setResults(r ?? []); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, SEARCH_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [text, searchable, city]);

  const useMyLocation = () => {
    setError(null);
    if (!navigator.geolocation) { setError('Tu navegador no permite usar la ubicación. Escribe la dirección.'); return; }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const place = await addressApi.reverse({ lat: pos.coords.latitude, lng: pos.coords.longitude });
          const fallback: PlaceSuggestion = {
            address: 'Mi ubicación', full: 'Mi ubicación', precision: 'area',
            lat: pos.coords.latitude, lng: pos.coords.longitude,
          };
          const chosen = place ? { ...place, lat: pos.coords.latitude, lng: pos.coords.longitude } : fallback;
          setPicked(chosen);
          setText(chosen.address);
        } catch {
          setError('No pudimos encontrar tu dirección. Escríbela.');
        }
      },
      () => setError('No pudimos obtener tu ubicación. Revisa el permiso del navegador o escribe la dirección.'),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!picked) { setError('Busca tu dirección y elígela de la lista.'); return; }
    if (label.trim().length < 2) { setError('Ponle un nombre a la dirección, por ejemplo Casa.'); return; }
    setBusy(true);
    setError(null);
    try {
      const created = await addressApi.create({
        label: label.trim(),
        address: picked.address,
        neighborhood: picked.neighborhood,
        city: picked.city ?? city,
        details: details.trim() || undefined,
        latitude: picked.lat,
        longitude: picked.lng,
      });
      await queryClient.invalidateQueries({ queryKey: ADDRESSES_KEY });
      onCreated(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No pudimos guardar la dirección.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} noValidate className="mt-4 flex flex-col gap-4 border-t border-border pt-4">
      <TextField
        label="Dirección"
        hint="Calle y número, y el barrio si lo sabes."
        value={text}
        onChange={(e) => { setPicked(null); setText(e.target.value); }}
        maxLength={160}
        autoComplete="street-address"
      />
      {searching && searchable && <p className="text-sm text-text-secondary">Buscando…</p>}
      {shown.length > 0 && (
        <ul className="border border-border-strong">
          {shown.slice(0, 5).map((r) => (
            <li key={`${r.lat},${r.lng},${r.full}`}>
              <button
                type="button"
                onClick={() => { setPicked(r); setText(r.address); setResults([]); }}
                className="block min-h-11 w-full px-3 py-2 text-left text-base text-text-main hover:bg-surface-hover"
              >
                {r.full}
              </button>
            </li>
          ))}
        </ul>
      )}
      {picked && picked.precision !== 'address' && (
        <p className="text-sm text-text-secondary">
          Esta dirección no tiene número exacto. Agrega en las indicaciones cómo llegar para que el repartidor la encuentre.
        </p>
      )}
      <button type="button" onClick={useMyLocation} className="min-h-11 self-start text-base font-semibold text-primary-text underline underline-offset-4">
        Usar mi ubicación actual
      </button>
      <TextField label="Nombre de la dirección" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={30} />
      <TextField label="Indicaciones (apartamento, torre, referencia)" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={160} />
      <FormStatus error={error} />
      <div className="flex flex-wrap gap-3">
        <PlainButton type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar dirección'}</PlainButton>
        <PlainButton type="button" variant="tertiary" onClick={onCancel}>Cancelar</PlainButton>
      </div>
    </form>
  );
}

/** Direcciones guardadas para elegir una, y alta de una nueva sin salir del pedido. */
export function AddressPicker({
  selectedId, onSelect,
}: { selectedId: string | null; onSelect: (address: Address | null) => void }) {
  const addresses = useQuery({ queryKey: ADDRESSES_KEY, queryFn: addressApi.list });
  const [adding, setAdding] = useState(false);

  const list = useMemo(() => addresses.data ?? [], [addresses.data]);

  // Primera carga: elige la predeterminada (o la primera) mientras no haya elección.
  useEffect(() => {
    if (selectedId || list.length === 0) return;
    onSelect(list.find((a) => a.isDefault) ?? list[0]);
  }, [list, selectedId, onSelect]);

  if (addresses.isPending) return <p className="text-base text-text-secondary">Cargando tus direcciones…</p>;
  if (addresses.isError) return <FormStatus error="No pudimos cargar tus direcciones. Recarga la página." />;

  return (
    <div>
      {list.length > 0 && (
        <fieldset>
          <legend className="sr-only">Dirección de entrega</legend>
          {list.map((a) => {
            const hasPoint = addressPoint(a) !== null;
            return (
              <label key={a._id} className="flex min-h-11 cursor-pointer items-start gap-3 border-b border-border py-3 text-base">
                <input
                  type="radio"
                  name="direccion"
                  checked={selectedId === a._id}
                  onChange={() => onSelect(a)}
                  className="mt-1 h-5 w-5 accent-primary"
                />
                <span>
                  <span className="font-semibold">{a.label}</span>
                  <span className="block text-text-secondary">{a.address}{a.details ? ` · ${a.details}` : ''}</span>
                  {!hasPoint && <span className="block text-sm text-text-main">Esta dirección no tiene punto en el mapa: no se puede usar para pedir. Crea una nueva.</span>}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
      {adding ? (
        <NewAddress onCreated={(a) => { setAdding(false); onSelect(a); }} onCancel={() => setAdding(false)} />
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="mt-2 min-h-11 text-base font-semibold text-primary-text underline underline-offset-4">
          {list.length === 0 ? 'Agregar una dirección' : 'Usar otra dirección'}
        </button>
      )}
    </div>
  );
}
