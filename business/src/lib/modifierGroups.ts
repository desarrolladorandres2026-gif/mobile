/**
 * Grupos de modificadores en el formulario del producto.
 *
 * El formulario trabaja con cadenas (lo que escribe el comercio) y la API
 * con números y reglas. Esta conversión vive aparte del componente para
 * poder probarla sin montar nada, y para que el mensaje de "el máximo no
 * puede superar las opciones" salga aquí, antes de mandar nada, con las
 * mismas reglas que aplica el servidor.
 */

export interface ApiModifierOption {
  _id?: string;
  name: string;
  price: number;
  isAvailable?: boolean;
}

export interface ApiModifierGroup {
  _id?: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  sortOrder?: number;
  options: ApiModifierOption[];
}

/** Lo que se edita en pantalla. Los ids se conservan para no romper carritos guardados. */
export interface OptionDraft {
  _id?: string;
  name: string;
  price: string;
  isAvailable: boolean;
}

export interface GroupDraft {
  _id?: string;
  name: string;
  minSelect: string;
  maxSelect: string;
  options: OptionDraft[];
}

export const emptyOption = (): OptionDraft => ({ name: '', price: '0', isAvailable: true });
export const emptyGroup = (): GroupDraft => ({ name: '', minSelect: '0', maxSelect: '1', options: [emptyOption()] });

export function toDrafts(groups: ApiModifierGroup[] | null | undefined): GroupDraft[] {
  return [...(groups ?? [])]
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((g) => ({
      _id: g._id,
      name: g.name,
      minSelect: String(g.minSelect),
      maxSelect: String(g.maxSelect),
      options: g.options.map((o) => ({
        _id: o._id,
        name: o.name,
        price: String(o.price),
        isAvailable: o.isAvailable !== false,
      })),
    }));
}

/** "Obligatorio · Selección única", derivado como en el servidor. */
export function describeRules(min: number, max: number): string {
  const required = min > 0 ? 'Obligatorio' : 'Opcional';
  const kind = max === 1 ? 'Selección única' : min === max ? `Elige exactamente ${min}` : `Hasta ${max}`;
  return `${required} · ${kind}`;
}

const int = (raw: string) => {
  const n = Number(raw);
  return Number.isInteger(n) ? n : NaN;
};

/**
 * Convierte los borradores en lo que acepta la API, o devuelve el primer
 * error en palabras del comercio. Devuelve los ids intactos.
 */
export function fromDrafts(drafts: GroupDraft[]): { groups: ApiModifierGroup[] } | { error: string } {
  const groups: ApiModifierGroup[] = [];
  const groupNames = new Set<string>();

  for (const [index, draft] of drafts.entries()) {
    const name = draft.name.trim();
    const label = name || `Grupo ${index + 1}`;
    if (!name) return { error: `El grupo ${index + 1} necesita un nombre.` };
    if (groupNames.has(name.toLowerCase())) return { error: `Hay dos grupos llamados "${name}".` };
    groupNames.add(name.toLowerCase());

    const minSelect = int(draft.minSelect);
    const maxSelect = int(draft.maxSelect);
    if (Number.isNaN(minSelect) || minSelect < 0) return { error: `El mínimo de "${label}" tiene que ser un entero desde 0.` };
    if (Number.isNaN(maxSelect) || maxSelect < 1) return { error: `El máximo de "${label}" tiene que ser un entero desde 1.` };
    if (minSelect > maxSelect) return { error: `En "${label}" el mínimo no puede superar al máximo.` };

    const options: ApiModifierOption[] = [];
    const optionNames = new Set<string>();
    for (const option of draft.options) {
      const optionName = option.name.trim();
      if (!optionName) continue; // una fila vacía sobrante no es un error
      if (optionNames.has(optionName.toLowerCase())) return { error: `"${optionName}" está repetida en "${label}".` };
      optionNames.add(optionName.toLowerCase());
      const price = int(option.price === '' ? '0' : option.price);
      if (Number.isNaN(price) || price < 0) return { error: `El precio de "${optionName}" tiene que ser un entero desde 0.` };
      options.push({ _id: option._id, name: optionName, price, isAvailable: option.isAvailable });
    }

    if (!options.length) return { error: `"${label}" necesita al menos una opción.` };
    if (options.length > 30) return { error: `"${label}" tiene más de 30 opciones.` };
    if (maxSelect > options.length) return { error: `En "${label}" el máximo (${maxSelect}) supera las opciones (${options.length}).` };
    if (minSelect > 0 && options.filter((o) => o.isAvailable).length < minSelect) {
      return { error: `"${label}" es obligatorio pero no tiene suficientes opciones disponibles.` };
    }

    groups.push({ _id: draft._id, name, minSelect, maxSelect, sortOrder: index, options });
  }

  if (groups.length > 15) return { error: 'Un producto admite hasta 15 grupos.' };
  return { groups };
}
