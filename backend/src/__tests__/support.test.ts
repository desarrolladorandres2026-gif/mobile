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
