import { describe, it, expect } from 'vitest';
import {
  autoPayload, codePayload, emptyAutoForm, emptyCodeForm, maxCost, previewDraft, promotionSummary,
} from './promotions';
import {
  QUICK_RANGES, TEMPLATES, applyTemplate, localDay, rangeDates, suggestCode,
} from './promotionTemplates';
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

describe('plantillas de promoción', () => {
  const keep = { productIds: ['p1'] };

  it('toda plantilla produce un cuerpo que el servidor acepta', () => {
    for (const template of TEMPLATES.filter((t) => t.days !== null)) {
      const applied = applyTemplate(template, keep);
      const form = applied.mode === 'code' ? applied.codeForm : applied.autoForm;
      const payload = (applied.mode === 'code'
        ? codePayload(applied.codeForm, false)
        : autoPayload(applied.autoForm, false)) as Record<string, unknown>;

      expect(form.title.trim().length, template.id).toBeGreaterThanOrEqual(3);
      if (form.type === 'percentage') expect(form.value, template.id).toBeLessThanOrEqual(90);
      else expect(Number.isInteger(form.value), template.id).toBe(true);
      expect(scheduleError(form), template.id).toBe('');
      expect(new Date(form.validUntil) > new Date(form.validFrom), template.id).toBe(true);
      for (const forbidden of ['fundedBy', 'scope', 'campaignApproved', 'businessId']) {
        expect(payload, template.id).not.toHaveProperty(forbidden);
      }
      if (applied.mode === 'code') {
        const code = applied.codeForm.code;
        expect(code.length, template.id).toBeGreaterThanOrEqual(3);
        expect(code.length, template.id).toBeLessThanOrEqual(20);
      }
    }
  });

  it('ninguna plantilla nace sin techo de gasto', () => {
    for (const template of TEMPLATES.filter((t) => t.days !== null)) {
      const applied = applyTemplate(template, keep);
      const form = applied.mode === 'code' ? applied.codeForm : applied.autoForm;
      expect(maxCost(form), template.id).not.toBeNull();
    }
  });

  it('«desde cero» deja la fecha de fin para que la elija el comercio', () => {
    const scratch = TEMPLATES.find((t) => t.id === 'scratch')!;
    expect(applyTemplate(scratch, keep).codeForm.validUntil).toBe('');
  });

  it('conserva los productos ya elegidos', () => {
    const star = TEMPLATES.find((t) => t.id === 'star')!;
    expect(applyTemplate(star, keep).autoForm.productIds).toEqual(['p1']);
  });

  it('los atajos de vigencia terminan después de empezar', () => {
    for (const { days } of QUICK_RANGES) {
      const { validFrom, validUntil } = rangeDates(days);
      expect(new Date(validUntil) > new Date(validFrom)).toBe(true);
    }
  });

  it('localDay respeta la fecha local, no la UTC', () => {
    // 11 p. m. del 31 de enero en Colombia ya es 1 de febrero en UTC.
    expect(localDay(0, new Date(2030, 0, 31, 23, 0))).toBe('2030-01-31');
    expect(localDay(1, new Date(2030, 0, 31, 23, 0))).toBe('2030-02-01');
  });
});

describe('suggestCode', () => {
  it('usa la palabra más larga y el porcentaje', () => {
    expect(suggestCode('20% los martes', 'percentage', 20)).toBe('MARTES20');
    expect(suggestCode('Hora feliz', 'percentage', 15)).toBe('FELIZ15');
  });

  it('quita tildes y respeta el largo del servidor (3 a 20)', () => {
    expect(suggestCode('Promoción', 'fixed', 3000)).toBe('PROMOCION');
    const code = suggestCode('Superhamburguesaextraordinariamente grande', 'percentage', 20);
    expect(code.length).toBeLessThanOrEqual(20);
    expect(code.endsWith('20')).toBe(true);
  });

  it('sin palabras utilizables cae a ZIPP', () => {
    expect(suggestCode('', 'fixed', 0)).toBe('ZIPP');
    expect(suggestCode('20%', 'percentage', 20)).toBe('ZIPP20');
  });
});

describe('promotionSummary', () => {
  it('cuenta la promoción en una frase con su costo máximo', () => {
    const text = promotionSummary(
      { ...emptyCodeForm, code: 'martes20', title: 'x', value: 20, validDays: [2], budgetLimit: 100000, validUntil: '2030-01-30' },
      false,
    );
    expect(text).toContain('20% de descuento con el código MARTES20');
    expect(text).toContain('los martes');
    expect(text).toContain('hasta el 30 de enero');
    expect(text).toMatch(/Como máximo te cuesta \$\s?100\.000/);
  });

  it('avisa cuando no hay techo y ordena los días empezando por el lunes', () => {
    const text = promotionSummary(
      { ...emptyCodeForm, code: 'abc', title: 'x', validDays: [0, 5, 1], validUntil: '2030-01-30' },
      false,
    );
    expect(text).toContain('los lunes, viernes y domingos');
    expect(text).toContain('No tiene techo de costo');
  });
});
