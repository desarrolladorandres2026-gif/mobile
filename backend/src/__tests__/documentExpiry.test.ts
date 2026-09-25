import { describe, it, expect, vi, afterEach } from 'vitest';
import { BusinessDocument, DriverDocument } from '../models';
import { UserRole } from '../types';
import { pushService } from '../services/push.service';
import { reminderStage, sendExpiryReminders } from '../services/documentExpiry.service';
import { makeUser, makeBusiness, makeDriver } from './factories';

const DAY = 24 * 60 * 60 * 1000;

describe('Avisos de vencimiento de documentos', () => {
  afterEach(() => vi.restoreAllMocks());

  it('elige la etapa que toca hoy: 30, 7, 1 y el día que vence', () => {
    const now = new Date('2026-09-25T12:00:00Z');
    const at = (days: number) => new Date(now.getTime() + days * DAY);
    expect(reminderStage(at(45), now)).toBeNull();
    expect(reminderStage(at(30), now)).toBe(30);
    expect(reminderStage(at(12), now)).toBe(30);
    expect(reminderStage(at(5), now)).toBe(7);
    expect(reminderStage(at(0.5), now)).toBe(1);
    expect(reminderStage(at(-1), now)).toBe(0);
    // Lo vencido hace tiempo no se avisa: no llega spam de lo viejo al desplegar.
    expect(reminderStage(at(-10), now)).toBeNull();
  });

  it('avisa una sola vez por etapa al dueño y al domiciliario, y vuelve a empezar si se renueva', async () => {
    const sent = vi.spyOn(pushService, 'sendToUser').mockResolvedValue();
    const now = new Date();

    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    const bdoc = await BusinessDocument.create({
      businessId: business._id, type: 'rut', reference: '900', status: 'approved', expiresAt: new Date(now.getTime() + 5 * DAY),
    });

    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id);
    await DriverDocument.deleteMany({ driverId: driver._id, type: 'soat' });
    await DriverDocument.create({
      driverId: driver._id, type: 'soat', reference: 'S-1', status: 'approved', expiresAt: new Date(now.getTime() + 20 * DAY),
    });

    // Un papel en revisión no se avisa.
    await BusinessDocument.create({
      businessId: business._id, type: 'health_permit', reference: 'X', status: 'pending', expiresAt: new Date(now.getTime() + 2 * DAY),
    });

    expect(await sendExpiryReminders(now)).toEqual({ business: 1, driver: 1 });
    expect(sent).toHaveBeenCalledTimes(2);
    const toOwner = sent.mock.calls.find(([userId]) => userId === String(owner._id))!;
    expect(toOwner[1].title).toMatch(/RUT vence en 7 días/);
    const toDriver = sent.mock.calls.find(([userId]) => userId === String(driverUser._id))!;
    expect(toDriver[1].title).toMatch(/SOAT vence en 30 días/);

    // El siguiente barrido no repite.
    expect(await sendExpiryReminders(now)).toEqual({ business: 0, driver: 0 });

    // Al día siguiente de vencer llega "venció".
    const after = new Date(now.getTime() + 5.5 * DAY);
    const res = await sendExpiryReminders(after);
    expect(res.business).toBe(1);
    expect(sent.mock.calls.at(-1)![1].title).toMatch(/RUT venció/);

    // Renovado con otra fecha: el ciclo empieza de nuevo sin limpiar nada.
    await BusinessDocument.updateOne({ _id: bdoc._id }, { $set: { expiresAt: new Date(after.getTime() + 6 * DAY), status: 'approved' } });
    expect((await sendExpiryReminders(after)).business).toBe(1);
  });
});
