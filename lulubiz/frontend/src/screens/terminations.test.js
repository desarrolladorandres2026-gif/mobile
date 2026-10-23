import { describe, expect, it } from 'vitest';
import { buildTermination } from './Terminations.jsx';

const form = (patch = {}) => ({ employeeId: 'e1', endDate: '2026-10-31', vacationDays: '', severance: '', withholding: '', ...patch });

describe('cuerpo de la liquidación de contrato', () => {
  it('omite lo vacío y convierte los importes', () => {
    expect(buildTermination(form(), 'COP')).toEqual({ ok: true, body: { employeeId: 'e1', endDate: '2026-10-31', vacationDaysPending: 0 } });
    expect(buildTermination(form({ vacationDays: '7,5', severance: '1.000.000,00', withholding: '50.000' }), 'COP').body).toEqual({
      employeeId: 'e1',
      endDate: '2026-10-31',
      vacationDaysPending: 7.5,
      severance: 100_000_000,
      withholding: 5_000_000,
    });
  });

  it('señala lo que falta o no es válido', () => {
    expect(buildTermination(form({ employeeId: '', endDate: '' }), 'COP').errors).toEqual(['Elige el empleado.', 'Elige la fecha de retiro.']);
    expect(buildTermination(form({ vacationDays: '500', severance: 'x', withholding: '-1' }), 'COP').errors).toEqual(['Los días de vacaciones pendientes van de 0 a 400.', 'Indemnización no válida.', 'Retención no válida.']);
  });
});
