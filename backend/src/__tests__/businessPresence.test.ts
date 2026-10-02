import { describe, it, expect } from 'vitest';
import {
  markPanelSeen, sweepUnseenOpenBusinesses, PANEL_SEEN_THRESHOLD_MS,
} from '../services/businessPresence.service';
import { Business, Notification } from '../models';
import { UserRole } from '../types';
import { makeUser, makeBusiness } from './factories';

/**
 * "¿Hay un panel escuchando este negocio?" — y el aviso de Abierto sin
 * nadie conectado. Nada de esto vive en memoria: PM2 corre una sola
 * instancia, pero un reinicio no debe fingir que todo el mundo se acaba de
 * desconectar.
 */
describe('Presencia del panel del comercio', () => {
  it('markPanelSeen escribe panelSeenAt y limpia el aviso previo', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    await Business.updateOne({ _id: business._id }, { $set: { panelDisconnectedNotifiedAt: new Date() } });

    await markPanelSeen([business._id.toString()]);

    const updated = await Business.findById(business._id).lean();
    expect(updated!.panelSeenAt).toBeTruthy();
    expect(updated!.panelDisconnectedNotifiedAt).toBeNull();
  });

  it('un negocio Abierto que nunca se vio entra al barrido', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id); // isActive: true por defecto, panelSeenAt: null

    const alerts = await sweepUnseenOpenBusinesses();
    expect(alerts.map((a) => a.businessId)).toContain(business._id.toString());
    expect(alerts.find((a) => a.businessId === business._id.toString())?.ownerId).toBe(owner._id.toString());
  });

  it('un negocio con panel visto hace poco no entra', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    await markPanelSeen([business._id.toString()]);

    const alerts = await sweepUnseenOpenBusinesses();
    expect(alerts.map((a) => a.businessId)).not.toContain(business._id.toString());
  });

  it('un negocio con panel visto hace mucho entra', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    const longAgo = new Date(Date.now() - PANEL_SEEN_THRESHOLD_MS - 60_000);
    await Business.updateOne({ _id: business._id }, { $set: { panelSeenAt: longAgo } });

    const alerts = await sweepUnseenOpenBusinesses();
    expect(alerts.map((a) => a.businessId)).toContain(business._id.toString());
  });

  it('un negocio Cerrado, suspendido, no aprobado o archivado no entra', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const closed = await makeBusiness(owner._id);
    await Business.updateOne({ _id: closed._id }, { $set: { isActive: false } });

    const suspended = await makeBusiness(owner._id);
    await Business.updateOne({ _id: suspended._id }, { $set: { isSuspended: true } });

    const unapproved = await makeBusiness(owner._id);
    await Business.updateOne({ _id: unapproved._id }, { $set: { isApproved: false } });

    const archived = await makeBusiness(owner._id);
    await Business.updateOne({ _id: archived._id }, { $set: { isArchived: true } });

    const alerts = await sweepUnseenOpenBusinesses();
    const ids = alerts.map((a) => a.businessId);
    expect(ids).not.toContain(closed._id.toString());
    expect(ids).not.toContain(suspended._id.toString());
    expect(ids).not.toContain(unapproved._id.toString());
    expect(ids).not.toContain(archived._id.toString());
  });

  it('no vuelve a avisar hasta reconectar: el barrido marca y el siguiente ya no repite', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);

    const first = await sweepUnseenOpenBusinesses();
    expect(first.map((a) => a.businessId)).toContain(business._id.toString());

    const second = await sweepUnseenOpenBusinesses();
    expect(second.map((a) => a.businessId)).not.toContain(business._id.toString());

    // Pero una reconexión limpia la bandera y, si vuelve a pasar el umbral, avisa de nuevo.
    await markPanelSeen([business._id.toString()]);
    const longAgo = new Date(Date.now() - PANEL_SEEN_THRESHOLD_MS - 60_000);
    await Business.updateOne({ _id: business._id }, { $set: { panelSeenAt: longAgo } });
    const third = await sweepUnseenOpenBusinesses();
    expect(third.map((a) => a.businessId)).toContain(business._id.toString());
  });

  it('notifyBusinessPanelDisconnected crea un aviso al dueño, de tipo SYSTEM', async () => {
    const { notificationService } = await import('../services/notification.service');
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);

    await notificationService.notifyBusinessPanelDisconnected(owner._id.toString(), business._id.toString());

    const note = await Notification.findOne({ userId: owner._id }).lean();
    expect(note?.type).toBe('system');
    expect(note?.data).toMatchObject({ businessId: business._id.toString(), event: 'panel_disconnected' });
  });
});
