import type { Schema } from 'mongoose';
import { emitToAdmin, getIO } from '../sockets/emitter';

/**
 * Recursos que el panel admin sabe refrescar solo. El nombre es el contrato
 * con `admin/src/hooks/useLiveReload.ts`: si cambia aquí, cambia allá.
 */
export type LiveResource =
  | 'orders'
  | 'users'
  | 'businesses'
  | 'drivers'
  | 'driver-documents'
  | 'finance'
  | 'support'
  | 'moderation'
  | 'coupons'
  | 'settings'
  | 'pro'
  | 'campaigns';

/** Ventana de coalescencia: una ráfaga de escrituras se anuncia una sola vez. */
export const COALESCE_MS = 500;

const pending = new Map<LiveResource, NodeJS.Timeout>();

/**
 * Avisa a los admins de que `resource` cambió. NO lleva datos: cada cliente
 * recarga por REST, donde ya se aplican permisos y filtros. Trailing: el aviso
 * sale al final de la ventana, así que el cliente siempre ve el último estado.
 */
export function announceChange(resource: LiveResource): void {
  if (pending.has(resource)) return;
  const timer = setTimeout(() => {
    pending.delete(resource);
    emitToAdmin(getIO(), 'live', 'invalidate', { resource });
  }, COALESCE_MS);
  timer.unref?.();
  pending.set(resource, timer);
}

const QUERY_WRITES = [
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'deleteOne',
  'deleteMany',
] as const;

function changedSomething(result: any): boolean {
  if (result === null || result === undefined) return false;
  if (typeof result !== 'object') return true;
  if ('modifiedCount' in result || 'upsertedCount' in result || 'deletedCount' in result) {
    return (result.modifiedCount ?? 0) + (result.upsertedCount ?? 0) + (result.deletedCount ?? 0) > 0;
  }
  if ('lastErrorObject' in result) return result.value !== null && result.value !== undefined;
  return true;
}

/**
 * Plugin hermano de `cacheInvalidationPlugin`: mismos hooks, pero en lugar de
 * borrar caché anuncia el cambio al panel. Va en el modelo y no en los
 * servicios por la misma razón: hay escrituras que no pasan por ninguno.
 */
export function realtimeInvalidatePlugin(schema: Schema, options: { resource: LiveResource }): void {
  const fire = () => announceChange(options.resource);

  schema.post('save', function () {
    fire();
  });
  schema.post('deleteOne', { document: true, query: false }, function () {
    fire();
  });
  for (const op of QUERY_WRITES) {
    schema.post(op, { document: false, query: true }, function (result: any) {
      if (changedSomething(result)) fire();
    });
  }
  schema.post('insertMany', function () {
    fire();
  });
  schema.post('bulkWrite', function () {
    fire();
  });
}
