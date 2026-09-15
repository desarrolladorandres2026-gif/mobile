import { AppError } from '../middlewares/errorHandler';
import type { ModifierGroup, SelectedExtra } from '../types';

/**
 * Resuelve la selección de modificadores de una línea del carrito contra
 * el producto tal como está en la base de datos.
 *
 * El cliente solo dice *qué* eligió —`groupId` + `optionId`—; el nombre y
 * el precio salen de aquí. Es el mismo principio que ya regía para los
 * `extras` planos: un precio enviado por el teléfono nunca se lee.
 *
 * Es una función pura sobre datos planos, sin Mongoose, para que el móvil
 * y el panel puedan copiar exactamente la misma regla y el cliente vea el
 * mismo rechazo antes de pulsar "Agregar" que el que daría el servidor.
 */

export interface RequestedModifier {
  groupId?: string;
  optionId?: string;
  /** Aceptado por compatibilidad; para grupos no se usa. */
  name?: string;
  quantity?: number;
}

export interface ModifierSelectionResult {
  lines: SelectedExtra[];
  total: number;
}

type GroupLike = Pick<ModifierGroup, 'name' | 'minSelect' | 'maxSelect' | 'options'> & { _id?: unknown };

const idOf = (value: unknown): string => (value == null ? '' : String(value));

/**
 * Los grupos se recorren **todos**, no solo los que el cliente mencionó:
 * un grupo obligatorio que no viene en la petición es exactamente el caso
 * que hay que rechazar.
 */
export function resolveModifierSelection(
  product: { name: string; modifierGroups?: GroupLike[] | null },
  requested: RequestedModifier[]
): ModifierSelectionResult {
  const groups = product.modifierGroups ?? [];
  const withGroup = requested.filter((r) => r.groupId || r.optionId);

  if (!groups.length) {
    if (withGroup.length) {
      throw new AppError(
        `"${product.name}" no tiene opciones para elegir`,
        400,
        'MODIFIER_UNKNOWN'
      );
    }
    return { lines: [], total: 0 };
  }

  const byGroup = new Map<string, RequestedModifier[]>();
  for (const item of withGroup) {
    const groupId = idOf(item.groupId);
    const group = groups.find((g) => idOf(g._id) === groupId);
    if (!group) {
      throw new AppError(
        `Una de las opciones elegidas ya no existe para "${product.name}"`,
        400,
        'MODIFIER_UNKNOWN'
      );
    }
    const list = byGroup.get(groupId) ?? [];
    list.push(item);
    byGroup.set(groupId, list);
  }

  const lines: SelectedExtra[] = [];
  let total = 0;

  for (const group of groups) {
    const chosen = byGroup.get(idOf(group._id)) ?? [];
    const seen = new Set<string>();

    for (const pick of chosen) {
      const optionId = idOf(pick.optionId);
      const option = group.options.find((o) => idOf(o._id) === optionId);
      if (!option) {
        throw new AppError(
          `Una de las opciones de "${group.name}" ya no existe para "${product.name}"`,
          400,
          'MODIFIER_UNKNOWN'
        );
      }
      if (seen.has(optionId)) {
        throw new AppError(
          `"${option.name}" está repetida en "${group.name}"`,
          400,
          'MODIFIER_DUPLICATE'
        );
      }
      seen.add(optionId);

      if (option.isAvailable === false) {
        throw new AppError(
          `"${option.name}" está agotada en "${product.name}". Elige otra opción.`,
          400,
          'MODIFIER_UNAVAILABLE'
        );
      }

      const price = Math.round(option.price);
      lines.push({
        name: option.name,
        price,
        quantity: 1,
        groupId: idOf(group._id),
        groupName: group.name,
        optionId,
      });
      total += price;
    }

    if (chosen.length < group.minSelect) {
      throw new AppError(
        group.minSelect === 1
          ? `Elige ${group.name} para "${product.name}"`
          : `Elige ${group.minSelect} opciones de ${group.name} para "${product.name}"`,
        400,
        'MODIFIER_REQUIRED'
      );
    }
    if (chosen.length > group.maxSelect) {
      throw new AppError(
        `${group.name} admite máximo ${group.maxSelect} ${group.maxSelect === 1 ? 'opción' : 'opciones'} en "${product.name}"`,
        400,
        'MODIFIER_TOO_MANY'
      );
    }
  }

  return { lines, total };
}
