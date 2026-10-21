import { describe, expect, it } from 'vitest';
// Solo para esta prueba de paridad: los permisos que el servidor deja dar a una clave son los que la interfaz sabe nombrar.
import { GRANTABLE_SCOPES } from '../../../backend/src/auth/apiKeys.js';
import { AREAS, groupScopes, scopeLabel, validateKey } from './apiKeys.js';

describe('permisos de las claves de API', () => {
  it('todo permiso que el servidor deja dar tiene nombre y área en la interfaz', () => {
    const areas = AREAS.map(([area]) => area);
    for (const scope of GRANTABLE_SCOPES) {
      expect(scopeLabel(scope), scope).not.toBe(scope);
      expect(areas, scope).toContain(scope.split(':')[0]);
    }
  });

  it('agrupa por área en el orden fijo y no pierde ninguno', () => {
    const groups = groupScopes(GRANTABLE_SCOPES);
    expect(groups.map((g) => g.area)).toEqual(AREAS.map(([a]) => a));
    expect(groups.flatMap((g) => g.items.map((i) => i.scope)).sort()).toEqual([...GRANTABLE_SCOPES].sort());
  });

  it('un permiso desconocido va a «Otros», sin nombre inventado', () => {
    const groups = groupScopes(['inventory:read', 'nuevo:algo']);
    expect(groups.at(-1)).toMatchObject({ area: 'other', items: [{ scope: 'nuevo:algo', label: 'nuevo:algo' }] });
  });
});

describe('formulario de clave', () => {
  const today = '2026-10-21';
  it('arma el cuerpo y omite el vencimiento vacío', () => {
    expect(validateKey({ name: ' Contabilidad ', scopes: ['inventory:read'], expiresAt: '' }, today).body).toEqual({ name: 'Contabilidad', scopes: ['inventory:read'] });
    expect(validateKey({ name: 'x', scopes: ['inventory:read'], expiresAt: '2027-01-01' }, today).body.expiresAt).toBe('2027-01-01');
  });
  it('exige nombre, permisos y un vencimiento que no haya pasado', () => {
    const r = validateKey({ name: '', scopes: [], expiresAt: '2020-01-01' }, today);
    expect(r.ok).toBe(false);
    expect(Object.keys(r.errors).sort()).toEqual(['expiresAt', 'name', 'scopes']);
    expect(validateKey({ name: 'x', scopes: ['a:b'], expiresAt: today }, today).ok).toBe(true);
  });
});
