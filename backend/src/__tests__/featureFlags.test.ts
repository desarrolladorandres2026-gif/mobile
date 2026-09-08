import { describe, it, expect, beforeEach } from 'vitest';
import { FeatureFlag } from '../models';
import { UserRole } from '../types';
import { featureFlagService } from '../services/featureFlag.service';

/**
 * Interruptores de funcionalidad.
 *
 * Existen por una lección concreta: el reparto automático se desplegó
 * correcto y aun así habría roto la operación, porque el otro extremo —la
 * app del domiciliario— todavía no existía. Hizo falta una variable de
 * entorno de urgencia para separar publicar código de encender
 * comportamiento. Esto convierte esa urgencia en algo normal.
 */
describe('Interruptores de funcionalidad', () => {
  beforeEach(async () => {
    await FeatureFlag.deleteMany({});
    featureFlagService.invalidate();
  });

  it('una función que nadie ha declarado está apagada', async () => {
    // Que la clave no exista no puede significar "adelante": una errata en
    // el nombre encendería en producción algo que nadie revisó.
    expect(await featureFlagService.isEnabled('lo.que.sea')).toBe(false);
  });

  it('creada por primera vez nace apagada', async () => {
    await featureFlagService.upsert('pedidos.programados', {
      description: 'Reservar entregas para más tarde',
    });

    expect(await featureFlagService.isEnabled('pedidos.programados')).toBe(false);
  });

  it('encender para todos alcanza a cualquiera', async () => {
    await featureFlagService.upsert('busqueda.productos', {
      description: 'Buscar productos, no solo negocios',
      audience: 'all',
    });

    expect(await featureFlagService.isEnabled('busqueda.productos')).toBe(true);
    expect(
      await featureFlagService.isEnabled('busqueda.productos', { userId: 'quien-sea' })
    ).toBe(true);
  });

  it('el público "staff" deja fuera a los clientes', async () => {
    await featureFlagService.upsert('panel.nuevo', {
      description: 'Probar en producción con quien sabe qué mira',
      audience: 'staff',
    });

    expect(
      await featureFlagService.isEnabled('panel.nuevo', { userId: 'a', role: UserRole.ADMIN })
    ).toBe(true);
    expect(
      await featureFlagService.isEnabled('panel.nuevo', { userId: 'b', role: UserRole.CLIENT })
    ).toBe(false);
  });

  it('el reparto por porcentaje es estable para el mismo usuario', async () => {
    await featureFlagService.upsert('cashback', {
      description: 'Devolver un porcentaje de la compra',
      audience: 'percentage',
      percentage: 50,
    });

    // Con un sorteo en cada consulta, la función aparecería y desaparecería
    // entre pantallas, que es peor que no tenerla.
    const primera = await featureFlagService.isEnabled('cashback', { userId: 'usuario-fijo' });
    for (let i = 0; i < 20; i++) {
      expect(await featureFlagService.isEnabled('cashback', { userId: 'usuario-fijo' })).toBe(
        primera
      );
    }
  });

  it('el porcentaje reparte de verdad, no todo o nada', async () => {
    await featureFlagService.upsert('cashback', {
      description: 'Devolver un porcentaje de la compra',
      audience: 'percentage',
      percentage: 50,
    });

    let dentro = 0;
    for (let i = 0; i < 200; i++) {
      if (await featureFlagService.isEnabled('cashback', { userId: `usuario-${i}` })) dentro++;
    }

    // Margen ancho: se comprueba que reparte, no que el hash sea perfecto.
    expect(dentro).toBeGreaterThan(60);
    expect(dentro).toBeLessThan(140);
  });

  it('sin usuario identificado, un reparto por porcentaje dice que no', async () => {
    await featureFlagService.upsert('cashback', {
      description: 'Devolver un porcentaje de la compra',
      audience: 'percentage',
      percentage: 100,
    });

    expect(await featureFlagService.isEnabled('cashback')).toBe(false);
  });

  it('un porcentaje de cero se rechaza en vez de fingir que enciende', async () => {
    await expect(
      featureFlagService.upsert('vacio', {
        description: 'Nada',
        audience: 'percentage',
        percentage: 0,
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('actualizar no borra la descripción ni rompe la escritura', async () => {
    await featureFlagService.upsert('mandados', { description: 'RappiFavor de ZIPP' });
    const updated = await featureFlagService.upsert('mandados', { audience: 'all' });

    expect(updated.description).toBe('RappiFavor de ZIPP');
    expect(updated.audience).toBe('all');
  });

  it('apagar surte efecto sin esperar a que caduque la caché', async () => {
    await featureFlagService.upsert('algo', { description: 'x', audience: 'all' });
    expect(await featureFlagService.isEnabled('algo')).toBe(true);

    // Apagar algo roto no puede tardar diez segundos porque la caché aún no
    // ha expirado: la escritura invalida.
    await featureFlagService.upsert('algo', { audience: 'off' });
    expect(await featureFlagService.isEnabled('algo')).toBe(false);
  });

  it('resolveAll devuelve el mapa que la app necesita para pintarse', async () => {
    await featureFlagService.upsert('a', { description: 'a', audience: 'all' });
    await featureFlagService.upsert('b', { description: 'b', audience: 'off' });

    const flags = await featureFlagService.resolveAll({ userId: 'u', role: UserRole.CLIENT });
    expect(flags).toEqual({ a: true, b: false });
  });

  it('eliminar deja la función apagada, no encendida', async () => {
    await featureFlagService.upsert('temporal', { description: 't', audience: 'all' });
    await featureFlagService.remove('temporal');

    expect(await featureFlagService.isEnabled('temporal')).toBe(false);
  });
});
