/**
 * Grupos de modificadores en el teléfono.
 *
 * Espejo de `backend/src/utils/modifierSelection.ts`: la misma regla
 * —mínimo, máximo, agotados— aplicada antes de pulsar "Agregar", para que
 * el cliente vea el aviso en el grupo que le falta y no un error genérico
 * al pagar. El servidor vuelve a comprobar todo y el precio final es suyo;
 * esto solo evita el viaje inútil.
 */

export interface ModifierOption {
  _id: string;
  name: string;
  price: number;
  isAvailable?: boolean;
}

export interface ModifierGroup {
  _id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  sortOrder?: number;
  options: ModifierOption[];
  /** Derivados por el servidor; se recalculan aquí por si faltan. */
  isRequired?: boolean;
  selectionType?: 'single' | 'multiple';
}

/** Una opción elegida: lo que viaja al carrito y al pedido. */
export interface ModifierChoice {
  groupId: string;
  groupName: string;
  optionId: string;
  name: string;
  price: number;
}

export const isRequired = (g: ModifierGroup) => (g.isRequired ?? g.minSelect > 0);
export const isSingle = (g: ModifierGroup) => (g.selectionType ?? (g.maxSelect === 1 ? 'single' : 'multiple')) === 'single';

/** Si hay algo que pintar. Sin grupos, la hoja es la de siempre. */
export function hasModifierUI(product: { modifierGroups?: ModifierGroup[] | null } | null | undefined): boolean {
  return Boolean(product?.modifierGroups && product.modifierGroups.length > 0);
}

/** Si el producto exige elegir algo antes de poder agregarse. */
export function needsChoices(product: { modifierGroups?: ModifierGroup[] | null } | null | undefined): boolean {
  return (product?.modifierGroups ?? []).some((g) => isRequired(g));
}

/** Los grupos en el orden que fijó el comercio. */
export function sortedGroups(groups: ModifierGroup[] | null | undefined): ModifierGroup[] {
  return [...(groups ?? [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

/** Cuántas opciones de un grupo están elegidas. */
export function countIn(choices: ModifierChoice[], groupId: string): number {
  return choices.filter((c) => c.groupId === groupId).length;
}

/**
 * Aplica un toque sobre una opción.
 *
 * En un grupo de selección única, tocar otra opción la reemplaza (es un
 * radio: nunca hay que "desmarcar" primero). En uno múltiple alterna, y
 * al llegar al máximo el toque no hace nada — el aviso lo da la cabecera
 * del grupo, no un error.
 */
export function toggleChoice(
  choices: ModifierChoice[],
  group: ModifierGroup,
  option: ModifierOption
): ModifierChoice[] {
  if (option.isAvailable === false) return choices;

  const choice: ModifierChoice = {
    groupId: group._id,
    groupName: group.name,
    optionId: option._id,
    name: option.name,
    price: option.price,
  };
  const already = choices.some((c) => c.optionId === option._id);

  if (isSingle(group)) {
    const others = choices.filter((c) => c.groupId !== group._id);
    // En un grupo obligatorio no se puede dejar vacío tocando lo elegido.
    return already && !isRequired(group) ? others : [...others, choice];
  }

  if (already) return choices.filter((c) => c.optionId !== option._id);
  if (countIn(choices, group._id) >= group.maxSelect) return choices;
  return [...choices, choice];
}

/** Lo que suman las opciones elegidas sobre el precio del producto. */
export function selectionTotal(choices: ModifierChoice[]): number {
  return choices.reduce((sum, c) => sum + c.price, 0);
}

/** El primer grupo que todavía no cumple su mínimo, o null si se puede agregar. */
export function firstUnmetGroup(
  groups: ModifierGroup[] | null | undefined,
  choices: ModifierChoice[]
): ModifierGroup | null {
  for (const group of sortedGroups(groups)) {
    if (countIn(choices, group._id) < group.minSelect) return group;
  }
  return null;
}

/** Texto corto para la cabecera del grupo: qué se espera del cliente. */
export function groupHint(group: ModifierGroup): string {
  if (isSingle(group)) return isRequired(group) ? 'Elige una' : 'Opcional';
  if (group.minSelect === group.maxSelect) return `Elige ${group.minSelect}`;
  if (group.minSelect > 0) return `Elige de ${group.minSelect} a ${group.maxSelect}`;
  return `Hasta ${group.maxSelect}`;
}

/**
 * Comprueba una selección entera contra los grupos, como lo hará el servidor.
 * Devuelve el motivo del primer problema, o null si todo está en orden.
 */
export function validateSelection(
  groups: ModifierGroup[] | null | undefined,
  choices: ModifierChoice[]
): { code: 'MODIFIER_REQUIRED' | 'MODIFIER_TOO_MANY' | 'MODIFIER_UNAVAILABLE' | 'MODIFIER_UNKNOWN'; group?: ModifierGroup } | null {
  const list = sortedGroups(groups);
  for (const choice of choices) {
    const group = list.find((g) => g._id === choice.groupId);
    const option = group?.options.find((o) => o._id === choice.optionId);
    if (!group || !option) return { code: 'MODIFIER_UNKNOWN', group };
    if (option.isAvailable === false) return { code: 'MODIFIER_UNAVAILABLE', group };
  }
  for (const group of list) {
    const n = countIn(choices, group._id);
    if (n < group.minSelect) return { code: 'MODIFIER_REQUIRED', group };
    if (n > group.maxSelect) return { code: 'MODIFIER_TOO_MANY', group };
  }
  return null;
}

/**
 * Los adicionales de una línea en una frase: "Tipo de carne: Angus ·
 * Salsas: BBQ, Chipotle · Queso extra x2".
 *
 * Las opciones se agrupan por su grupo, para que el ticket se lea como
 * lo eligió el cliente; los extras planos van al final, como siempre.
 * Sirve igual para el carrito, el checkout y el seguimiento del pedido.
 */
export function describeExtras(
  extras: Array<{ name: string; quantity?: number; groupName?: string; optionId?: string }> | null | undefined
): string {
  if (!extras?.length) return '';
  const byGroup = new Map<string, string[]>();
  const flat: string[] = [];
  for (const e of extras) {
    const label = (e.quantity ?? 1) > 1 ? `${e.name} x${e.quantity}` : e.name;
    if (e.optionId && e.groupName) {
      const list = byGroup.get(e.groupName) ?? [];
      list.push(label);
      byGroup.set(e.groupName, list);
    } else {
      flat.push(label);
    }
  }
  const parts = [...byGroup.entries()].map(([group, names]) => `${group}: ${names.join(', ')}`);
  return [...parts, ...flat].join(' · ');
}
