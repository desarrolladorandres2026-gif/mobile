import {
  hasModifierUI, needsChoices, toggleChoice, selectionTotal, firstUnmetGroup,
  validateSelection, groupHint, describeExtras, type ModifierGroup, type ModifierChoice,
} from '../lib/modifiers';

/**
 * La regla de los grupos en el teléfono es una copia de la del servidor.
 * Si estas dos se desvían, el cliente arma algo que el checkout rechaza
 * —o, peor, el botón le dice que falta algo que no falta.
 */

const carne: ModifierGroup = {
  _id: 'g1', name: 'Tipo de carne', minSelect: 1, maxSelect: 1, sortOrder: 0,
  options: [{ _id: 'o1', name: 'Res', price: 0 }, { _id: 'o2', name: 'Angus', price: 7000 }],
};
const salsas: ModifierGroup = {
  _id: 'g2', name: 'Salsas', minSelect: 0, maxSelect: 2, sortOrder: 1,
  options: [
    { _id: 'o3', name: 'BBQ', price: 0 }, { _id: 'o4', name: 'Chipotle', price: 1000 },
    { _id: 'o5', name: 'Ranch', price: 0 }, { _id: 'o6', name: 'Trufa', price: 3000, isAvailable: false },
  ],
};
const acomp: ModifierGroup = {
  _id: 'g3', name: 'Acompañantes', minSelect: 2, maxSelect: 2, sortOrder: 2,
  options: [{ _id: 'o7', name: 'Papas', price: 0 }, { _id: 'o8', name: 'Ensalada', price: 0 }, { _id: 'o9', name: 'Arroz', price: 0 }],
};
const groups = [salsas, acomp, carne]; // desordenados a propósito

const pick = (g: ModifierGroup, id: string): ModifierChoice => {
  const o = g.options.find((x) => x._id === id)!;
  return { groupId: g._id, groupName: g.name, optionId: o._id, name: o.name, price: o.price };
};

describe('sin grupos no hay UI de grupos', () => {
  it('un producto sin grupos no pinta nada ni exige nada', () => {
    expect(hasModifierUI({ modifierGroups: [] })).toBe(false);
    expect(hasModifierUI({})).toBe(false);
    expect(hasModifierUI(null)).toBe(false);
    expect(needsChoices({ modifierGroups: [] })).toBe(false);
    expect(firstUnmetGroup([], [])).toBeNull();
    expect(validateSelection(undefined, [])).toBeNull();
  });

  it('un producto con grupos opcionales pinta UI pero no exige', () => {
    expect(hasModifierUI({ modifierGroups: [salsas] })).toBe(true);
    expect(needsChoices({ modifierGroups: [salsas] })).toBe(false);
    expect(needsChoices({ modifierGroups: groups })).toBe(true);
  });
});

describe('toggleChoice', () => {
  it('en selección única, tocar otra opción la reemplaza', () => {
    let c = toggleChoice([], carne, carne.options[0]);
    c = toggleChoice(c, carne, carne.options[1]);
    expect(c).toHaveLength(1);
    expect(c[0].optionId).toBe('o2');
  });

  it('en selección única obligatoria, tocar la elegida no la quita', () => {
    const c = toggleChoice(toggleChoice([], carne, carne.options[0]), carne, carne.options[0]);
    expect(c).toHaveLength(1);
  });

  it('en selección única opcional, tocar la elegida sí la quita', () => {
    const queso: ModifierGroup = { _id: 'q', name: 'Queso', minSelect: 0, maxSelect: 1, options: [{ _id: 'c', name: 'Cheddar', price: 2500 }] };
    const c = toggleChoice(toggleChoice([], queso, queso.options[0]), queso, queso.options[0]);
    expect(c).toHaveLength(0);
  });

  it('en múltiple alterna y respeta el máximo', () => {
    let c = toggleChoice([], salsas, salsas.options[0]);
    c = toggleChoice(c, salsas, salsas.options[1]);
    c = toggleChoice(c, salsas, salsas.options[2]); // tercera: ignorada
    expect(c.map((x) => x.optionId)).toEqual(['o3', 'o4']);
    c = toggleChoice(c, salsas, salsas.options[0]); // quitar
    expect(c.map((x) => x.optionId)).toEqual(['o4']);
  });

  it('una opción agotada no se puede elegir', () => {
    expect(toggleChoice([], salsas, salsas.options[3])).toEqual([]);
  });

  it('no toca las elecciones de otros grupos', () => {
    let c = toggleChoice([], salsas, salsas.options[1]);
    c = toggleChoice(c, carne, carne.options[1]);
    c = toggleChoice(c, carne, carne.options[0]);
    expect(c.map((x) => x.optionId).sort()).toEqual(['o1', 'o4']);
  });
});

describe('total y validación', () => {
  it('suma solo los precios de las opciones elegidas', () => {
    expect(selectionTotal([pick(carne, 'o2'), pick(salsas, 'o4'), pick(acomp, 'o7')])).toBe(8000);
    expect(selectionTotal([])).toBe(0);
  });

  it('firstUnmetGroup respeta el orden del comercio, no el del array', () => {
    expect(firstUnmetGroup(groups, [])!._id).toBe('g1');
    expect(firstUnmetGroup(groups, [pick(carne, 'o1')])!._id).toBe('g3');
    expect(firstUnmetGroup(groups, [pick(carne, 'o1'), pick(acomp, 'o7')])!._id).toBe('g3');
    expect(firstUnmetGroup(groups, [pick(carne, 'o1'), pick(acomp, 'o7'), pick(acomp, 'o8')])).toBeNull();
  });

  it('validateSelection detecta lo mismo que el servidor', () => {
    const ok = [pick(carne, 'o1'), pick(acomp, 'o7'), pick(acomp, 'o8')];
    expect(validateSelection(groups, ok)).toBeNull();
    expect(validateSelection(groups, ok.slice(1))?.code).toBe('MODIFIER_REQUIRED');
    expect(validateSelection(groups, [...ok, pick(salsas, 'o3'), pick(salsas, 'o4'), pick(salsas, 'o5')])?.code).toBe('MODIFIER_TOO_MANY');
    expect(validateSelection(groups, [...ok, pick(salsas, 'o6')])?.code).toBe('MODIFIER_UNAVAILABLE');
    expect(validateSelection(groups, [...ok, { ...pick(salsas, 'o3'), optionId: 'zzz' }])?.code).toBe('MODIFIER_UNKNOWN');
  });

  it('groupHint dice qué se espera', () => {
    expect(groupHint(carne)).toBe('Elige una');
    expect(groupHint(salsas)).toBe('Hasta 2');
    expect(groupHint(acomp)).toBe('Elige 2');
    expect(groupHint({ ...salsas, minSelect: 1, maxSelect: 3 })).toBe('Elige de 1 a 3');
    expect(groupHint({ ...carne, minSelect: 0 })).toBe('Opcional');
  });
});

describe('describeExtras', () => {
  it('agrupa por grupo y deja los extras planos al final', () => {
    expect(describeExtras([
      { name: 'Angus', groupName: 'Tipo de carne', optionId: 'o2' },
      { name: 'Queso extra', quantity: 2 },
      { name: 'BBQ', groupName: 'Salsas', optionId: 'o3' },
      { name: 'Chipotle', groupName: 'Salsas', optionId: 'o4' },
    ])).toBe('Tipo de carne: Angus · Salsas: BBQ, Chipotle · Queso extra x2');
  });

  it('con solo extras heredados se lee como antes', () => {
    expect(describeExtras([{ name: 'Queso extra', quantity: 1 }, { name: 'Tocineta', quantity: 2 }])).toBe('Queso extra · Tocineta x2');
    expect(describeExtras([])).toBe('');
    expect(describeExtras(undefined)).toBe('');
  });
});
