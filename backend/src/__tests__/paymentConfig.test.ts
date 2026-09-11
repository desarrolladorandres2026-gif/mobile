import { describe, it, expect } from 'vitest';
import { paymentConfigErrors } from '../config/env';

/**
 * La puerta de arranque que impide desplegar una pasarela que no cobra.
 *
 * No protege contra un atacante: protege contra un `.env` copiado a medias,
 * que en esta plataforma tiene exactamente la misma consecuencia que un
 * fallo de seguridad. Con el proveedor `sandbox` en producción, cada pedido
 * en línea sale aprobado sin que se mueva un peso: el comercio cocina, el
 * domiciliario reparte y ZIPP liquida un dinero que nunca entró. Con llaves
 * `pub_test_` de Wompi pasa lo mismo en versión más difícil de ver, porque
 * los cobros van al sandbox de Wompi y se aprueban con tarjetas de prueba.
 *
 * Se prueba como función pura sobre un mapa de variables porque la
 * alternativa —arrancar el proceso con otro NODE_ENV— no es comprobable
 * desde una prueba.
 */

const WOMPI_PROD = {
  PAYMENT_PROVIDER: 'wompi',
  WOMPI_PUBLIC_KEY: 'pub_prod_abc',
  WOMPI_PRIVATE_KEY: 'prv_prod_abc',
  WOMPI_INTEGRITY_SECRET: 'integridad',
  WOMPI_EVENTS_SECRET: 'eventos',
};

describe('Configuración de pagos en producción', () => {
  it('acepta una configuración de Wompi completa y de producción', () => {
    expect(paymentConfigErrors(WOMPI_PROD)).toEqual([]);
  });

  it('rechaza el proveedor sandbox', () => {
    const errors = paymentConfigErrors({ PAYMENT_PROVIDER: 'sandbox' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/sandbox/i);
  });

  it('rechaza no declarar proveedor: el defecto es sandbox', () => {
    expect(paymentConfigErrors({})).not.toEqual([]);
  });

  it('rechaza llaves de prueba de Wompi', () => {
    const errors = paymentConfigErrors({
      ...WOMPI_PROD,
      WOMPI_PUBLIC_KEY: 'pub_test_abc',
      WOMPI_PRIVATE_KEY: 'prv_test_abc',
    });
    expect(errors.some((e) => /PRUEBA/i.test(e))).toBe(true);
  });

  it('rechaza un par de llaves cruzado o con formato desconocido', () => {
    expect(
      paymentConfigErrors({ ...WOMPI_PROD, WOMPI_PUBLIC_KEY: 'no-es-una-llave' })
    ).not.toEqual([]);
  });

  it('exige las cuatro credenciales, no solo las llaves', () => {
    for (const missing of [
      'WOMPI_PUBLIC_KEY',
      'WOMPI_PRIVATE_KEY',
      'WOMPI_INTEGRITY_SECRET',
      'WOMPI_EVENTS_SECRET',
    ]) {
      const errors = paymentConfigErrors({ ...WOMPI_PROD, [missing]: '' });
      expect(errors.some((e) => e.includes(missing))).toBe(true);
    }
  });

  it('deja pasar sandbox solo cuando se declara explícitamente', () => {
    expect(
      paymentConfigErrors({ PAYMENT_PROVIDER: 'sandbox', ALLOW_SANDBOX_PAYMENTS: 'true' })
    ).toEqual([]);

    // Y solo con el valor exacto: cualquier otra cosa no es una declaración.
    expect(
      paymentConfigErrors({ PAYMENT_PROVIDER: 'sandbox', ALLOW_SANDBOX_PAYMENTS: '1' })
    ).not.toEqual([]);
  });

  it('la excepción también cubre las llaves de prueba de Wompi', () => {
    expect(
      paymentConfigErrors({
        ...WOMPI_PROD,
        WOMPI_PUBLIC_KEY: 'pub_test_abc',
        WOMPI_PRIVATE_KEY: 'prv_test_abc',
        ALLOW_SANDBOX_PAYMENTS: 'true',
      })
    ).toEqual([]);
  });
});
