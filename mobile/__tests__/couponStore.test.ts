import { useCouponStore } from '../stores/couponStore';

/**
 * El cupón que viaja de Descuentos al pago.
 *
 * Lo que se prueba aquí no es el descuento —eso lo decide el servidor al
 * cotizar— sino que el código llegue al negocio correcto. Un cupón de la
 * Pizzería apareciendo pre-aplicado en la Panadería produce un rechazo que
 * parece culpa del negocio, y el cliente no tiene forma de saber que venía
 * de una pantalla que visitó hace tres horas.
 */

function reset() {
  useCouponStore.setState({ code: null, businessId: null });
}

const store = () => useCouponStore.getState();

beforeEach(reset);

describe('Guardar un cupón', () => {
  it('normaliza el código a mayúsculas', () => {
    store().save('  bienvenido ');
    expect(store().code).toBe('BIENVENIDO');
  });

  it('un cupón de plataforma sirve en cualquier negocio', () => {
    store().save('BIENVENIDO');

    expect(store().codeFor('cualquiera')).toBe('BIENVENIDO');
    expect(store().codeFor('otro')).toBe('BIENVENIDO');
  });

  it('uno de un negocio solo aparece en ese negocio', () => {
    store().save('PIZZA20', 'pizzeria');

    expect(store().codeFor('pizzeria')).toBe('PIZZA20');
    expect(store().codeFor('panaderia')).toBeNull();
  });

  it('guardar otro reemplaza al anterior: un pedido admite un solo cupón', () => {
    store().save('PRIMERO', 'pizzeria');
    store().save('SEGUNDO');

    expect(store().code).toBe('SEGUNDO');
    expect(store().businessId).toBeNull();
  });
});

describe('Olvidarlo', () => {
  it('sin nada guardado no ofrece nada', () => {
    expect(store().codeFor('pizzeria')).toBeNull();
  });

  it('se limpia entero, código y negocio', () => {
    store().save('PIZZA20', 'pizzeria');
    store().clear();

    expect(store().code).toBeNull();
    expect(store().businessId).toBeNull();
    expect(store().codeFor('pizzeria')).toBeNull();
  });
});
