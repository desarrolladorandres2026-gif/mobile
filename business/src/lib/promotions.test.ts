import { describe, it, expect } from 'vitest';
import {
  autoPayload, codePayload, emptyAutoForm, emptyCodeForm, maxCost, previewDraft,
} from './promotions';
import { scheduleError } from './schedule';

/**
 * Lo que el panel manda al servidor. El servidor valida todo otra vez; lo que
 * se fija aquí es que el formulario no ofrezca ni envíe lo que sabe que será
 * rechazado, y que el horario viaje con la convención del servidor.
 */

const code = { ...emptyCodeForm, code: ' martes20 ', title: '20 %', value: 20, validUntil: '2030-01-31' };

describe('codePayload', () => {
  it('normaliza el código y manda el tope solo en un porcentaje', () => {
    const percentage = codePayload({ ...code, maxDiscountAmount: 5000 }, false);
    expect(percentage.code).toBe('MARTES20');
    expect(percentage.maxDiscountAmount).toBe(5000);

    const fixed = codePayload({ ...code, type: 'fixed', value: 3000, maxDiscountAmount: 5000 }, false);
    expect(fixed).not.toHaveProperty('maxDiscountAmount');
  });

  it('nunca manda quién financia, el alcance ni nada reservado a ZIPP', () => {
    const payload = codePayload(code, false) as Record<string, unknown>;
    for (const forbidden of ['fundedBy', 'scope', 'campaignApproved', 'businessId', 'restrictedToUserId']) {
      expect(payload).not.toHaveProperty(forbidden);
    }
  });

  it('«primer pedido» no manda un tope por cliente: lo fija el servidor en uno', () => {
    expect(codePayload({ ...code, firstOrderOnly: true, perUserLimit: 5 }, false)).not.toHaveProperty('perUserLimit');
    expect(codePayload({ ...code, firstOrderOnly: false, perUserLimit: 5 }, false).perUserLimit).toBe(5);
  });

  it('al editar no manda ni el código ni el tipo', () => {
    const payload = codePayload(code, true) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('code');
    expect(payload).not.toHaveProperty('type');
  });

  it('una franja completa viaja tal cual; una vacía solo al editar, para poder quitarla', () => {
    const withWindow = { ...code, validDays: [1, 5], validFromTime: '11:00', validUntilTime: '13:00' };
    expect(codePayload(withWindow, false)).toMatchObject({ validDays: [1, 5], validFromTime: '11:00', validUntilTime: '13:00' });

    expect(codePayload(code, false)).not.toHaveProperty('validFromTime');
    expect(codePayload(code, true)).toMatchObject({ validFromTime: '', validUntilTime: '' });
  });
});

describe('autoPayload', () => {
  const auto = { ...emptyAutoForm, title: 'Hamburguesas', productIds: ['p1'], validUntil: '2030-01-31' };

  it('marca la promoción como automática solo al crearla', () => {
    expect(autoPayload(auto, false)).toMatchObject({ autoApply: true, productIds: ['p1'] });
    expect(autoPayload(auto, true)).not.toHaveProperty('autoApply');
  });

  it('manda la condición de primer pedido', () => {
    expect(autoPayload({ ...auto, firstOrderOnly: true }, false).firstOrderOnly).toBe(true);
  });
});

describe('previewDraft', () => {
  it('es lo que se guardaría, sin código ni productos reales', () => {
    const draft = previewDraft({ ...code, minOrderAmount: 20000, budgetLimit: 50000 }, false);
    expect(draft).toMatchObject({ type: 'percentage', value: 20, minOrderAmount: 20000, budgetLimit: 50000, autoApply: false });
    expect(draft).not.toHaveProperty('code');
  });

  it('una promoción automática viaja marcada como tal', () => {
    expect(previewDraft({ ...emptyAutoForm, validUntil: '2030-01-31' }, true).autoApply).toBe(true);
  });
});

describe('maxCost', () => {
  it('el presupuesto es un techo real', () => {
    expect(maxCost({ type: 'percentage', value: 20, budgetLimit: 40000 })).toBe(40000);
  });

  it('un tope de usos acota solo si cada uso cuesta una cifra conocida', () => {
    expect(maxCost({ type: 'fixed', value: 3000, usageLimit: 10 })).toBe(30000);
    expect(maxCost({ type: 'percentage', value: 20, usageLimit: 10, maxDiscountAmount: 4000 })).toBe(40000);
    expect(maxCost({ type: 'percentage', value: 20, usageLimit: 10 })).toBeNull();
  });

  it('sin topes no hay máximo que prometer', () => {
    expect(maxCost({ type: 'percentage', value: 20 })).toBeNull();
  });
});

describe('scheduleError', () => {
  it('acepta ninguna hora o las dos en orden', () => {
    expect(scheduleError({ validFromTime: '', validUntilTime: '' })).toBe('');
    expect(scheduleError({ validFromTime: '11:00', validUntilTime: '13:00' })).toBe('');
  });

  it('rechaza una sola hora y la franja que cruza la medianoche', () => {
    expect(scheduleError({ validFromTime: '11:00', validUntilTime: '' })).not.toBe('');
    expect(scheduleError({ validFromTime: '22:00', validUntilTime: '02:00' })).not.toBe('');
  });
});
