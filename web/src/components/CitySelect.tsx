import { setCity, useCity } from '../lib/city';
import { INPUT } from './ui';

/** Selector de ciudad; no aparece mientras haya una sola con cobertura. */
export function CitySelect() {
  const { city, cities } = useCity();
  if (cities.length < 2) return null;
  return (
    <div className="mt-4 max-w-xs">
      <label htmlFor="ciudad" className="block text-base font-semibold text-text-main">Ciudad</label>
      <select id="ciudad" value={city} onChange={(e) => setCity(e.target.value)} className={`${INPUT} mt-2`}>
        {cities.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    </div>
  );
}
