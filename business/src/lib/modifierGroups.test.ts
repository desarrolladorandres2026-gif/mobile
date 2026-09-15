import { describe, it, expect } from 'vitest';
import { toDrafts, fromDrafts, describeRules, type ApiModifierGroup } from './modifierGroups';
import { describeExtras } from './orderFlow';

/**
 * La conversión formulario ↔ API de los grupos de modificadores.
 *
 * Lo que importa aquí es que los ids sobrevivan a un ciclo de edición
 * —son la identidad que guardan los carritos en los teléfonos— y que el
 * comercio vea el error en sus palabras antes de mandar nada.
 */

const api: ApiModifierGroup[] = [
  {
    _id: 'g2', name: 'Salsas', minSelect: 0, maxSelect: 2, sortOrder: 1,
    options: [{ _id: 'o3', name: 'BBQ', price: 0 }, { _id: 'o4', name: 'Trufa', price: 3000, isAvailable: false }],
  },
  {
    _id: 'g1', name: 'Tipo de carne', minSelect: 1, maxSelect: 1, sortOrder: 0,
    options: [{ _id: 'o1', name: 'Res', price: 0, isAvailable: true }, { _id: 'o2', name: 'Angus', price: 7000 }],
  },
];

describe('toDrafts ↔ fromDrafts', () => {
  it('ordena por sortOrder, conserva ids y vuelve a la API sin pérdida', () => {
    const drafts = toDrafts(api);
    expect(drafts.map((d) => d.name)).toEqual(['Tipo de carne', 'Salsas']);
    expect(drafts[0]._id).toBe('g1');
    expect(drafts[1].options[1]).toEqual({ _id: 'o4', name: 'Trufa', price: '3000', isAvailable: false });

    const back = fromDrafts(drafts);
    expect('groups' in back).toBe(true);
    if (!('groups' in back)) return;
    expect(back.groups[0]).toEqual({
      _id: 'g1', name: 'Tipo de carne', minSelect: 1, maxSelect: 1, sortOrder: 0,
      options: [{ _id: 'o1', name: 'Res', price: 0, isAvailable: true }, { _id: 'o2', name: 'Angus', price: 7000, isAvailable: true }],
    });
    expect(back.groups[1].options[1]).toEqual({ _id: 'o4', name: 'Trufa', price: 3000, isAvailable: false });
  });

  it('un grupo nuevo sale sin _id y con el orden en que se dejó', () => {
    const drafts = [...toDrafts(api), { name: 'Tamaño', minSelect: '1', maxSelect: '1', options: [{ name: 'Grande', price: '2000', isAvailable: true }] }];
    const back = fromDrafts(drafts);
    if (!('groups' in back)) throw new Error(back.error);
    expect(back.groups[2]._id).toBeUndefined();
    expect(back.groups[2].sortOrder).toBe(2);
  });

  it('ignora filas de opción vacías y un precio en blanco vale cero', () => {
    const back = fromDrafts([{ name: 'Extra', minSelect: '0', maxSelect: '1', options: [{ name: 'Huevo', price: '', isAvailable: true }, { name: '  ', price: '5', isAvailable: true }] }]);
    if (!('groups' in back)) throw new Error(back.error);
    expect(back.groups[0].options).toEqual([{ _id: undefined, name: 'Huevo', price: 0, isAvailable: true }]);
  });

  it.each([
    [{ name: '', minSelect: '0', maxSelect: '1', options: [{ name: 'a', price: '0', isAvailable: true }] }, /nombre/],
    [{ name: 'G', minSelect: '2', maxSelect: '1', options: [{ name: 'a', price: '0', isAvailable: true }, { name: 'b', price: '0', isAvailable: true }] }, /mínimo no puede superar/],
    [{ name: 'G', minSelect: '0', maxSelect: '3', options: [{ name: 'a', price: '0', isAvailable: true }] }, /supera las opciones/],
    [{ name: 'G', minSelect: '0', maxSelect: '1', options: [{ name: 'a', price: '-5', isAvailable: true }] }, /entero desde 0/],
    [{ name: 'G', minSelect: '0', maxSelect: '1', options: [{ name: 'a', price: '2500.5', isAvailable: true }] }, /entero desde 0/],
    [{ name: 'G', minSelect: '0', maxSelect: '1', options: [{ name: 'a', price: '0', isAvailable: true }, { name: 'A', price: '0', isAvailable: true }] }, /repetida/],
    [{ name: 'G', minSelect: '0', maxSelect: '1', options: [{ name: '', price: '0', isAvailable: true }] }, /al menos una opción/],
    [{ name: 'G', minSelect: '1', maxSelect: '1', options: [{ name: 'a', price: '0', isAvailable: false }] }, /obligatorio pero/],
  ])('rechaza %j', (draft, message) => {
    const back = fromDrafts([draft]);
    expect('error' in back && back.error).toMatch(message);
  });

  it('rechaza dos grupos con el mismo nombre', () => {
    const g = { name: 'Salsas', minSelect: '0', maxSelect: '1', options: [{ name: 'a', price: '0', isAvailable: true }] };
    const back = fromDrafts([g, { ...g, name: 'salsas' }]);
    expect('error' in back && back.error).toMatch(/dos grupos/);
  });

  it('sin grupos devuelve una lista vacía, que borra los que había', () => {
    expect(fromDrafts([])).toEqual({ groups: [] });
  });
});

describe('describeRules', () => {
  it('lee obligatorio y tipo de selección de los dos números', () => {
    expect(describeRules(1, 1)).toBe('Obligatorio · Selección única');
    expect(describeRules(0, 1)).toBe('Opcional · Selección única');
    expect(describeRules(0, 3)).toBe('Opcional · Hasta 3');
    expect(describeRules(2, 2)).toBe('Obligatorio · Elige exactamente 2');
  });
});

describe('describeExtras (ticket de cocina)', () => {
  it('agrupa las opciones y deja los extras planos con cantidad', () => {
    expect(describeExtras([
      { name: 'Angus', price: 7000, groupId: 'g1', groupName: 'Tipo de carne', optionId: 'o2' },
      { name: 'Queso extra', price: 3000, quantity: 2 },
      { name: 'BBQ', price: 0, groupId: 'g2', groupName: 'Salsas', optionId: 'o3' },
    ])).toBe('Tipo de carne: Angus · Salsas: BBQ · 2× Queso extra');
  });

  it('un pedido antiguo se lee exactamente como antes', () => {
    expect(describeExtras([{ name: 'Queso extra', price: 3000 }, { name: 'Tocineta', price: 3500, quantity: 2 }]))
      .toBe('1× Queso extra · 2× Tocineta');
  });
});
