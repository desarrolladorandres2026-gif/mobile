import { describe, it, expect, beforeEach } from 'vitest';
import { Pqrs } from '../models';
import { UserRole } from '../types';
import { supportService } from '../services/support.service';
import { makeUser } from './factories';

/**
 * Centro de soporte.
 *
 * No parte de cero: `Pqrs` ya guardaba tipo, estado, evidencias y
 * respuestas. Lo que le faltaba para ser una bandeja de trabajo son las
 * tres cosas que convierten una lista en una cola — quién lo tiene, cuándo
 * vence y cuánto se tardó en contestar.
 */
describe('Soporte', () => {
  let cliente: any;
  let agente: any;

  const openCase = async (type: 'petition' | 'complaint' | 'claim' | 'suggestion' = 'complaint') =>
    Pqrs.create({
      userId: cliente._id,
      type,
      subject: 'Mi pedido llegó frío',
      detail: 'La sopa llegó helada y el domiciliario no dijo nada.',
    });

  beforeEach(async () => {
    cliente = await makeUser({ role: UserRole.CLIENT });
    agente = await makeUser({ role: UserRole.ADMIN });
  });

  it('quien abrió el caso puede replicar y un caso respondido vuelve a revisión', async () => {
    const id = (await openCase())._id.toString();
    await supportService.reply(id, agente._id.toString(), 'Revisamos tu caso.');
    await Pqrs.updateOne({ _id: id }, { status: 'answered' });

    const ticket = await supportService.requesterReply(id, cliente._id.toString(), 'Sigue sin llegar.');

    expect(ticket.status).toBe('in_review');
    expect(ticket.responses.at(-1)?.from).toBe('requester');
    // La respuesta del personal conserva su autoría por defecto.
    expect(ticket.responses[0].from).toBe('staff');
  });

  it('nadie replica un caso ajeno ni uno cerrado', async () => {
    const id = (await openCase())._id.toString();
    const otro = await makeUser({ role: UserRole.CLIENT });

    await expect(supportService.requesterReply(id, otro._id.toString(), 'Hola')).rejects.toThrow();

    await supportService.close(id, agente._id.toString());
    await expect(supportService.requesterReply(id, cliente._id.toString(), 'Hola')).rejects.toThrow();
  });

  it('reabrir un caso cerrado conserva el plazo legal y no reabre uno abierto', async () => {
    const created = await openCase('claim');
    const id = created._id.toString();
    await Pqrs.updateOne({ _id: id }, { legalDueAt: new Date('2030-01-01') });

    await expect(supportService.reopen(id, agente._id.toString())).rejects.toThrow();

    await supportService.close(id, agente._id.toString());
    const reopened = await supportService.reopen(id, agente._id.toString());

    expect(reopened.status).toBe('in_review');
    expect(reopened.legalDueAt?.toISOString()).toBe(new Date('2030-01-01').toISOString());
  });

  it('la solicitud de reembolso exige pedido y solo admite una pendiente', async () => {
    const sinPedido = (await openCase())._id.toString();
    await expect(supportService.requestRefund(sinPedido, agente._id.toString(), 'Llegó frío')).rejects.toThrow();

    const conPedido = await Pqrs.create({
      userId: cliente._id, type: 'claim', subject: 'Cobro', detail: 'Me cobraron de más en el pedido.',
      orderId: agente._id, // cualquier ObjectId: aquí solo importa que exista
    });
    const id = conPedido._id.toString();
    const ticket = await supportService.requestRefund(id, agente._id.toString(), 'Cobro duplicado');
    expect(ticket.refundRequest?.status).toBe('pending');

    await expect(supportService.requestRefund(id, agente._id.toString(), 'Otra vez')).rejects.toThrow();

    const done = await supportService.resolveRefundRequest(id, agente._id.toString(), 'done', 'Reembolsado');
    expect(done.refundRequest?.status).toBe('done');
    await expect(supportService.resolveRefundRequest(id, agente._id.toString(), 'done')).rejects.toThrow();
  });

  it('la cola filtra sin asignar, por reembolso pendiente y busca por teléfono', async () => {
    const a = (await openCase())._id.toString();
    await openCase();
    await supportService.assign(a, agente._id.toString());

    const sinAsignar = await supportService.queue({ unassigned: true });
    expect(sinAsignar.every((r: any) => !r.assignedTo)).toBe(true);
    expect(sinAsignar.some((r: any) => String(r._id) === a)).toBe(false);

    await Pqrs.updateOne({ _id: a }, { refundRequest: { status: 'pending', reason: 'x'.repeat(6), requestedBy: agente._id, requestedAt: new Date() } });
    const conReembolso = await supportService.queue({ refundRequested: true });
    expect(conReembolso.map((r: any) => String(r._id))).toEqual([a]);

    await (await import('../models')).User.updateOne({ _id: cliente._id }, { phone: '3151234567' });
    const porTelefono = await supportService.queue({ q: '3151234567' });
    expect(porTelefono.length).toBeGreaterThanOrEqual(2);
  });

  it('un reclamo nace con más prioridad que una sugerencia', async () => {
    const reclamo = await supportService.classify((await openCase('claim'))._id.toString());
    const sugerencia = await supportService.classify(
      (await openCase('suggestion'))._id.toString()
    );

    // Un reclamo es dinero en disputa; una sugerencia no tiene plazo real.
    expect(reclamo.priority).toBe('high');
    expect(sugerencia.priority).toBe('low');
  });

  it('el plazo se fija al clasificar, en horas y no en días', async () => {
    const ticket = await supportService.classify((await openCase('claim'))._id.toString());

    const hours = (ticket.dueAt!.getTime() - Date.now()) / 3_600_000;
    // En comida a domicilio, un reclamo de ayer ya no tiene arreglo.
    expect(hours).toBeGreaterThan(3);
    expect(hours).toBeLessThan(5);
  });

  it('se puede subir la prioridad a mano', async () => {
    const ticket = await supportService.classify(
      (await openCase('suggestion'))._id.toString(),
      'urgent'
    );

    expect(ticket.priority).toBe('urgent');
    const minutes = (ticket.dueAt!.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeLessThan(70);
  });

  it('asignar saca el caso de la bandeja compartida', async () => {
    const ticket = await supportService.assign(
      (await openCase())._id.toString(),
      agente._id.toString()
    );

    // Es la diferencia entre "alguien lo verá" y "lo ve Ana".
    expect(ticket.assignedTo!.toString()).toBe(agente._id.toString());
    expect(ticket.status).toBe('in_review');
  });

  it('la primera respuesta se sella aparte', async () => {
    const created = await openCase();

    const first = await supportService.reply(
      created._id.toString(),
      agente._id.toString(),
      'Lamentamos lo ocurrido, ya lo estamos revisando.'
    );
    const firstAt = first.firstResponseAt!.getTime();

    const second = await supportService.reply(
      created._id.toString(),
      agente._id.toString(),
      'Le reembolsamos el pedido.'
    );

    // Es la métrica que mide a soporte, y no se puede reconstruir después
    // mirando el array si alguna respuesta se borra.
    expect(second.firstResponseAt!.getTime()).toBe(firstAt);
    expect(second.responses).toHaveLength(2);
  });

  it('responder mueve el caso a revisión', async () => {
    const created = await openCase();
    const replied = await supportService.reply(
      created._id.toString(),
      agente._id.toString(),
      'Lo estamos viendo'
    );

    expect(replied.status).toBe('in_review');
  });

  it('cerrar con mensaje deja la respuesta y el caso cerrado', async () => {
    const created = await openCase();

    const closed = await supportService.close(
      created._id.toString(),
      agente._id.toString(),
      'Reembolsado. Gracias por avisarnos.'
    );

    expect(closed.status).toBe('closed');
    const saved = await Pqrs.findById(created._id);
    expect(saved!.responses).toHaveLength(1);
  });

  it('la cola ordena por vencimiento, no por antigüedad', async () => {
    const viejo = await openCase('suggestion');
    await supportService.classify(viejo._id.toString());

    const nuevo = await openCase('claim');
    await supportService.classify(nuevo._id.toString());

    const queue = await supportService.queue();

    // Ordenar por llegada deja los urgentes debajo de una pila de
    // sugerencias.
    expect((queue[0] as any)._id.toString()).toBe(nuevo._id.toString());
  });

  it('los casos cerrados salen de la cola', async () => {
    const created = await openCase();
    await supportService.close(created._id.toString(), agente._id.toString());

    expect(await supportService.queue()).toHaveLength(0);
  });

  it('se puede filtrar la cola por lo vencido', async () => {
    const created = await openCase('claim');
    await supportService.classify(created._id.toString());
    await Pqrs.updateOne(
      { _id: created._id },
      { dueAt: new Date(Date.now() - 60_000) }
    );

    expect(await supportService.queue({ onlyOverdue: true })).toHaveLength(1);
  });

  it('las métricas cuentan lo abierto, lo vencido y lo sin asignar', async () => {
    const a = await openCase('claim');
    await supportService.classify(a._id.toString());
    await Pqrs.updateOne({ _id: a._id }, { dueAt: new Date(Date.now() - 60_000) });

    const b = await openCase();
    await supportService.assign(b._id.toString(), agente._id.toString());

    const metrics = await supportService.metrics();

    expect(metrics.open).toBe(2);
    expect(metrics.overdue).toBe(1);
    expect(metrics.unassigned).toBe(1);
  });

  it('el tiempo medio de respuesta sale de casos ya respondidos', async () => {
    const created = await openCase();
    await supportService.reply(created._id.toString(), agente._id.toString(), 'Respondido');

    const metrics = await supportService.metrics();
    expect(metrics.averageFirstResponseMinutes).toBeGreaterThanOrEqual(0);
  });

  it('un caso que no existe da 404, no un fallo silencioso', async () => {
    await expect(
      supportService.assign('507f1f77bcf86cd799439011', agente._id.toString())
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
