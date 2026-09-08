import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  DriverVerification,
  VerificationType,
  VerificationStatus,
  driverSecurityService,
} from '../security';
import { UserRole } from '../types';
import { makeUser, makeDriver } from './factories';

/**
 * Verificación de identidad en mitad del turno.
 *
 * Responde a una pregunta que las verificaciones del alta no pueden: la
 * cuenta se aprobó una vez, pero quién conduce la moto hoy. Prestar la
 * cuenta a un tercero sin documentos es el fraude más fácil de esta
 * operación, y el único momento de detectarlo es mientras ocurre.
 */
describe('Verificación de identidad en turno', () => {
  let driverUser: any;
  let driver: any;

  beforeEach(async () => {
    driverUser = await makeUser({ role: UserRole.DRIVER });
    driver = await makeDriver(driverUser._id);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('solicitar crea el registro con su plazo', async () => {
    const created = await driverSecurityService.requestVerification(
      driver._id.toString(),
      driverUser._id.toString()
    );

    expect(created).not.toBeNull();
    expect(created!.status).toBe(VerificationStatus.REQUESTED);
    expect(created!.type).toBe(VerificationType.RANDOM_SELFIE);
    expect(created!.dueAt).toBeInstanceOf(Date);
    // Sin foto todavía: es justo ese hueco el que permite exigirla.
    expect(created!.imageUrl).toBeUndefined();
  });

  it('no acumula solicitudes sin responder', async () => {
    await driverSecurityService.requestVerification(
      driver._id.toString(),
      driverUser._id.toString()
    );
    const second = await driverSecurityService.requestVerification(
      driver._id.toString(),
      driverUser._id.toString()
    );

    expect(second).toBeNull();
    expect(await DriverVerification.countDocuments({ driverId: driver._id.toString() })).toBe(1);
  });

  it('responder la deja pendiente de revisión y desbloquea al domiciliario', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();

    await driverSecurityService.requestVerification(
      driver._id.toString(),
      driverUser._id.toString()
    );

    const filled = await driverSecurityService.fulfillVerification(
      driver._id.toString(),
      VerificationType.RANDOM_SELFIE,
      'https://cdn.example.com/selfie.jpg'
    );

    expect(filled!.status).toBe(VerificationStatus.PENDING);
    expect(filled!.imageUrl).toBe('https://cdn.example.com/selfie.jpg');

    // Aunque venza el plazo, ya no bloquea: el retraso a partir de aquí es
    // de la plataforma, que tiene que revisarla, y no del domiciliario.
    vi.setSystemTime(start + 60 * 60 * 1000);
    expect(await driverSecurityService.hasOverdueVerification(driver._id.toString())).toBeNull();
  });

  it('no bloquea mientras el plazo sigue corriendo', async () => {
    await driverSecurityService.requestVerification(
      driver._id.toString(),
      driverUser._id.toString()
    );

    // Se le pidió una foto, no se le acusó de nada: frenarle antes de
    // tiempo castigaría a quien va conduciendo.
    expect(await driverSecurityService.hasOverdueVerification(driver._id.toString())).toBeNull();
  });

  it('bloquea cuando el plazo vence sin respuesta', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();

    await driverSecurityService.requestVerification(
      driver._id.toString(),
      driverUser._id.toString(),
      VerificationType.RANDOM_SELFIE,
      15
    );

    vi.setSystemTime(start + 16 * 60 * 1000);

    const overdue = await driverSecurityService.hasOverdueVerification(driver._id.toString());
    expect(overdue).not.toBeNull();
    expect(overdue!.type).toBe(VerificationType.RANDOM_SELFIE);
  });

  it('responder algo que nadie pidió no cuela', async () => {
    const result = await driverSecurityService.fulfillVerification(
      driver._id.toString(),
      VerificationType.RANDOM_SELFIE,
      'https://cdn.example.com/selfie.jpg'
    );

    expect(result).toBeNull();
  });

  it('revisar cierra el ciclo', async () => {
    await driverSecurityService.requestVerification(
      driver._id.toString(),
      driverUser._id.toString()
    );
    const filled = await driverSecurityService.fulfillVerification(
      driver._id.toString(),
      VerificationType.RANDOM_SELFIE,
      'https://cdn.example.com/selfie.jpg'
    );

    const adminUser = await makeUser({ role: UserRole.ADMIN });
    const reviewed = await driverSecurityService.reviewVerification(
      filled!._id.toString(),
      adminUser._id.toString(),
      true
    );

    expect(reviewed!.status).toBe(VerificationStatus.APPROVED);
    expect(reviewed!.reviewedBy).toBe(adminUser._id.toString());
    expect(reviewed!.reviewedAt).toBeInstanceOf(Date);
  });

  it('tras rechazar, se puede volver a pedir', async () => {
    await driverSecurityService.requestVerification(
      driver._id.toString(),
      driverUser._id.toString()
    );
    const filled = await driverSecurityService.fulfillVerification(
      driver._id.toString(),
      VerificationType.RANDOM_SELFIE,
      'https://cdn.example.com/selfie.jpg'
    );

    const adminUser = await makeUser({ role: UserRole.ADMIN });
    await driverSecurityService.reviewVerification(
      filled!._id.toString(),
      adminUser._id.toString(),
      false,
      'La foto no se ve'
    );

    const again = await driverSecurityService.requestVerification(
      driver._id.toString(),
      driverUser._id.toString()
    );

    expect(again).not.toBeNull();
  });
});
