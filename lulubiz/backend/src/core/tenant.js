import { ObjectId } from 'mongodb';

export class TenantError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TenantError';
  }
}

/** Identificador de empresa como ObjectId. Falla si el valor no es un id válido. */
export function toTenantId(value) {
  if (typeof value === 'string' && !ObjectId.isValid(value)) {
    throw new TenantError('tenantId inválido');
  }
  return new ObjectId(value);
}
