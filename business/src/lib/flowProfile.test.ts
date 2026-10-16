import { describe, it, expect } from 'vitest';
import { flowProfileOf, nextBusinessStep, statusLabel, statusStyle } from './orderFlow';

describe('perfil de flujo por categoría', () => {
  it('droguería y mercado alistan; el resto cocina', () => {
    expect(flowProfileOf('pharmacy')).toBe('picking');
    expect(flowProfileOf('supermarket')).toBe('picking');
    for (const category of ['restaurant', 'fast_food', 'cafe']) {
      expect(flowProfileOf(category)).toBe('cooking');
    }
  });

  it('una categoría desconocida o ausente se trata como cocina', () => {
    expect(flowProfileOf('otra')).toBe('cooking');
    expect(flowProfileOf(undefined)).toBe('cooking');
    expect(flowProfileOf(null)).toBe('cooking');
  });

  it('solo el paso del medio cambia de nombre', () => {
    expect(statusLabel('preparing')).toBe('En cocina');
    expect(statusLabel('preparing', 'picking')).toBe('Alistando');
    for (const status of ['pending', 'accepted', 'ready', 'picked_up', 'on_way', 'delivered', 'cancelled']) {
      expect(statusLabel(status, 'picking')).toBe(statusLabel(status, 'cooking'));
    }
  });

  it('el estilo conserva el color del punto con el nombre nuevo', () => {
    expect(statusStyle('preparing', 'picking').dot).toBe(statusStyle('preparing').dot);
    expect(statusStyle('preparing', 'picking').label).toBe('Alistando');
  });

  it('el botón del paso del medio cambia, la transición no', () => {
    expect(nextBusinessStep('accepted')).toEqual({ status: 'preparing', label: 'Empezar cocina' });
    expect(nextBusinessStep('accepted', 'picking')).toEqual({ status: 'preparing', label: 'Empezar a alistar' });
    expect(nextBusinessStep('pending', 'picking')?.status).toBe('accepted');
    expect(nextBusinessStep('preparing', 'picking')?.status).toBe('ready');
  });
});
