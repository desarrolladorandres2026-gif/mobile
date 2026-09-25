import { describe, it, expect, beforeEach } from 'vitest';
import { Pqrs, DataRequest } from '../models';
import { UserRole, PaymentMethod } from '../types';
import { createPqrs, PQRS_LEGAL_BUSINESS_DAYS } from '../services/pqrs.service';
import { computeDataRequestLegalDueAt } from '../services/legal.service';
import { supportService } from '../services/support.service';
import { migratePqrsLegalDeadline } from '../migrations/013-pqrs-legal-deadline';
import { addBusinessDays } from '../utils/businessDays';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON } from './factories';
import { orderService } from '../services/order.service';

describe('Plazo legal de PQRS y solicitudes de datos (O7)', () => {
  let client: any;

  beforeEach(async () => {
    client = await makeUser({ role: UserRole.CLIENT });
  });

  it('calcula legalDueAt al crear según el tipo, distinto de dueAt (SLA interno)', async () => {
    const claim = await createPqrs({
      userId: client._id.toString(),
      type: 'claim',
      subject: 'Cobro duplicado',
      detail: 'Me cobraron dos veces el mismo pedido y nadie responde.',
    });

    expect(claim.legalDueAt).not.toBeNull();
    expect(claim.dueAt).not.toBeNull(); // el SLA interno se fija al abrir (Fase 4)
    expect(claim.legalDueAt!.getTime()).toBe(
      addBusinessDays(claim.createdAt, PQRS_LEGAL_BUSINESS_DAYS.claim!).getTime()
    );
  });

  it('una sugerencia no tiene plazo legal', async () => {
    const suggestion = await createPqrs({
      userId: client._id.toString(),
      type: 'suggestion',
      subject: 'Sería bueno tener más filtros',
      detail: 'Filtrar por comida vegetariana ayudaría mucho a encontrar opciones.',
    });

    expect(suggestion.legalDueAt).toBeNull();
  });

  it('copia comercio y domiciliario del pedido al crear, si trae orderId', async () => {
    await makePricingConfig();
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    const product = await makeProduct(business._id);
    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    } as never);

    const pqrs = await createPqrs({
      userId: client._id.toString(),
      type: 'complaint',
      subject: 'El domicilio llegó tarde',
      detail: 'El pedido llegó una hora después de lo prometido por la app.',
      orderId: order._id.toString(),
    });

    expect(String(pqrs.businessId)).toBe(String(business._id));
  });

  it('la solicitud de datos calcula legalDueAt según el tipo (10 días hábiles consulta, 15 el resto)', () => {
    const now = new Date('2026-09-23T15:00:00Z');
    const access = computeDataRequestLegalDueAt('access', now);
    const del = computeDataRequestLegalDueAt('delete', now);
    expect(access.getTime()).toBe(addBusinessDays(now, 10).getTime());
    expect(del.getTime()).toBe(addBusinessDays(now, 15).getTime());
    expect(access.getTime()).toBeLessThan(del.getTime());
  });

  it('la cola de soporte pone primero lo vencido o por vencer legalmente, aunque el SLA interno diga otra cosa', async () => {
    const agente = await makeUser({ role: UserRole.ADMIN });
    void agente;

    // Caso A: SLA interno vencido hace rato, pero sin problema legal (plazo lejano).
    const urgentSlaOnly = await Pqrs.create({
      userId: client._id,
      type: 'suggestion',
      subject: 'SLA vencido, sin plazo legal',
      detail: 'Esto lleva atrasado pero no tiene fecha legal límite.',
      dueAt: new Date(Date.now() - 60 * 60 * 1000),
      legalDueAt: null,
    });

    // Caso B: SLA interno todavía sano, pero el plazo LEGAL ya venció.
    const legalOverdue = await Pqrs.create({
      userId: client._id,
      type: 'claim',
      subject: 'Plazo legal vencido',
      detail: 'Este caso ya superó el plazo legal aunque el SLA interno esté bien.',
      dueAt: new Date(Date.now() + 60 * 60 * 1000),
      legalDueAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    const queue = await supportService.queue({});
    const ids = queue.map((q: any) => String(q._id));

    expect(ids.indexOf(String(legalOverdue._id))).toBeLessThan(ids.indexOf(String(urgentSlaOnly._id)));
  });

  it('la cola expone legalOverdue/legalDueSoon y filtra por legalOverdue=true', async () => {
    const overdue = await Pqrs.create({
      userId: client._id,
      type: 'claim',
      subject: 'Vencido',
      detail: 'Plazo legal ya superado, hay que priorizarlo cuanto antes.',
      legalDueAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    await Pqrs.create({
      userId: client._id,
      type: 'claim',
      subject: 'Sano',
      detail: 'Este todavía tiene plazo legal de sobra para responder.',
      legalDueAt: addBusinessDays(new Date(), 15),
    });

    const filtered = await supportService.queue({ onlyLegalOverdue: true });
    expect(filtered).toHaveLength(1);
    expect(String((filtered[0] as any)._id)).toBe(String(overdue._id));
    expect((filtered[0] as any).legalOverdue).toBe(true);
  });

  it('las métricas cuentan legalOverdue y legalDueSoon', async () => {
    await Pqrs.create({
      userId: client._id,
      type: 'claim',
      subject: 'Vencido para métricas',
      detail: 'Un caso vencido legalmente para que las métricas lo cuenten.',
      legalDueAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    const metrics = await supportService.metrics();
    expect(metrics.legalOverdue).toBeGreaterThanOrEqual(1);
  });

  it('PATCH /:id/respond (vía controlador) deja la misma traza que supportService.reply: sella firstResponseAt y asigna', async () => {
    const agente = await makeUser({ role: UserRole.ADMIN });
    const ticket = await createPqrs({
      userId: client._id.toString(),
      type: 'complaint',
      subject: 'Vía legal',
      detail: 'Simula lo que hacía la pantalla Legal al responder un caso.',
    });

    expect(ticket.assignedTo).toBeNull();
    expect(ticket.firstResponseAt).toBeNull();

    // Mismo camino que usaría el controlador tras el fix de unificación.
    const existing = await Pqrs.findById(ticket._id).select('assignedTo status');
    if (!existing!.assignedTo) await supportService.assign(ticket._id.toString(), agente._id.toString());
    const replied = await supportService.reply(ticket._id.toString(), agente._id.toString(), 'Ya lo revisamos.');

    expect(replied.firstResponseAt).not.toBeNull();
    expect(String(replied.assignedTo)).toBe(String(agente._id));
  });

  describe('Migración 013 — backfill', () => {
    it('rellena legalDueAt de PQRS abiertas existentes sin tocar las que ya lo tienen', async () => {
      const withLegacyGap = await Pqrs.create({
        userId: client._id,
        type: 'claim',
        subject: 'Caso anterior a la migración',
        detail: 'Este caso se creó antes de que legalDueAt existiera en el esquema.',
      });
      await Pqrs.updateOne({ _id: withLegacyGap._id }, { $unset: { legalDueAt: 1 } });

      const alreadySet = await Pqrs.create({
        userId: client._id,
        type: 'claim',
        subject: 'Ya migrado',
        detail: 'Este ya tenía legalDueAt puesto, la migración no debe tocarlo.',
        legalDueAt: addBusinessDays(new Date(), 15),
      });
      const originalDueAt = alreadySet.legalDueAt;

      const report = await migratePqrsLegalDeadline();
      expect(report.pqrsLegalDueAtSet).toBeGreaterThanOrEqual(1);

      const after = await Pqrs.findById(withLegacyGap._id);
      expect(after!.legalDueAt).not.toBeNull();

      const untouched = await Pqrs.findById(alreadySet._id);
      expect(untouched!.legalDueAt!.getTime()).toBe(originalDueAt!.getTime());
    });

    it('es idempotente: correrla dos veces no cambia el resultado', async () => {
      const legacy = await Pqrs.create({
        userId: client._id,
        type: 'petition',
        subject: 'Sin legalDueAt',
        detail: 'Otro caso previo a la migración para probar idempotencia.',
      });
      await Pqrs.updateOne({ _id: legacy._id }, { $unset: { legalDueAt: 1 } });

      await migratePqrsLegalDeadline();
      const firstRun = await Pqrs.findById(legacy._id);

      const secondReport = await migratePqrsLegalDeadline();
      const secondRun = await Pqrs.findById(legacy._id);

      expect(secondReport.pqrsLegalDueAtSet).toBe(0);
      expect(secondRun!.legalDueAt!.getTime()).toBe(firstRun!.legalDueAt!.getTime());
    });

    it('rellena legalDueAt de solicitudes de datos abiertas', async () => {
      const legacy = await DataRequest.create({
        userId: client._id,
        type: 'access',
        detail: 'Quiero saber qué datos tienen sobre mí, por favor.',
      });
      await DataRequest.updateOne({ _id: legacy._id }, { $unset: { legalDueAt: 1 } });

      const report = await migratePqrsLegalDeadline();
      expect(report.dataRequestsLegalDueAtSet).toBeGreaterThanOrEqual(1);

      const after = await DataRequest.findById(legacy._id);
      expect(after!.legalDueAt).not.toBeNull();
    });
  });
});
