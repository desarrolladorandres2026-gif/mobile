import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { InternalNote, Order, Pqrs } from '../models';
import { AuditLog, AuditAction } from '../security';
import { Permission } from '../security/rbac';
import {
  internalNoteService,
  NOTE_PERMISSION,
  NOTE_RATE_LIMIT_PER_MINUTE,
  NOTE_AUTHOR_DELETE_WINDOW_MS,
  containsCardNumber,
  NoteActor,
} from '../services/internalNote.service';
import { UserRole } from '../types';
import { makeUser, makeBusiness, makeDriver } from './factories';

const ALL_VIEW = [
  Permission.ORDERS_VIEW_ALL,
  Permission.BUSINESSES_VIEW,
  Permission.DRIVERS_VIEW,
  Permission.USERS_VIEW,
  Permission.SUPPORT_VIEW,
];

function actorOf(user: { _id: any; name: string }, permissions: Permission[] = ALL_VIEW, isSuperAdmin = false): NoteActor {
  return { userId: String(user._id), name: user.name, permissions, isSuperAdmin };
}

async function makeOrderId(): Promise<string> {
  const _id = new Types.ObjectId();
  // Solo hace falta que exista: se salta la validación del pedido completo.
  await Order.collection.insertOne({ _id, orderNumber: String(_id) });
  return String(_id);
}

async function backdate(noteId: string, ms: number) {
  await InternalNote.collection.updateOne(
    { _id: new Types.ObjectId(noteId) },
    { $set: { createdAt: new Date(Date.now() - ms) } }
  );
}

describe('Notas internas', () => {
  it('NOTE_PERMISSION mapea cada tipo a su permiso de vista', () => {
    expect(NOTE_PERMISSION).toEqual({
      order: Permission.ORDERS_VIEW_ALL,
      business: Permission.BUSINESSES_VIEW,
      driver: Permission.DRIVERS_VIEW,
      user: Permission.USERS_VIEW,
      pqrs: Permission.SUPPORT_VIEW,
    });
  });

  describe('create', () => {
    it('crea la nota y devuelve NoteView con canDelete para el autor', async () => {
      const admin = await makeUser({ role: UserRole.ADMIN });
      const orderId = await makeOrderId();
      const view = await internalNoteService.create({
        entityType: 'order',
        entityId: orderId,
        body: '  Cliente pidió llamar antes de llegar  ',
        actor: actorOf(admin),
      });
      expect(view).toMatchObject({
        entityType: 'order',
        entityId: orderId,
        body: 'Cliente pidió llamar antes de llegar',
        author: { _id: String(admin._id), name: admin.name },
        deletedAt: null,
        canDelete: true,
      });
      expect(typeof view.createdAt).toBe('string');
    });

    it('la auditoría lleva entidad, id y longitud, nunca el texto', async () => {
      const admin = await makeUser({ role: UserRole.ADMIN });
      const orderId = await makeOrderId();
      const body = 'texto secreto que no debe copiarse al log';
      await internalNoteService.create({ entityType: 'order', entityId: orderId, body, actor: actorOf(admin) });

      const log = await AuditLog.findOne({ action: AuditAction.INTERNAL_NOTE_CREATED, entityId: orderId }).lean();
      expect(log).toBeTruthy();
      expect(log!.entity).toBe('order');
      expect(log!.metadata).toMatchObject({ entityType: 'order', entityId: orderId, length: body.length });
      expect(JSON.stringify(log)).not.toContain('secreto');
    });

    it('403 si el actor no tiene el permiso del tipo (solo drivers:view no anota pedidos)', async () => {
      const admin = await makeUser({ role: UserRole.ADMIN });
      const orderId = await makeOrderId();
      await expect(
        internalNoteService.create({
          entityType: 'order',
          entityId: orderId,
          body: 'hola',
          actor: actorOf(admin, [Permission.DRIVERS_VIEW]),
        })
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(await InternalNote.countDocuments()).toBe(0);
    });

    it('404 si la entidad no existe; 400 con ids o tipos inválidos', async () => {
      const admin = await makeUser({ role: UserRole.ADMIN });
      const actor = actorOf(admin);
      await expect(
        internalNoteService.create({ entityType: 'order', entityId: String(new Types.ObjectId()), body: 'x', actor })
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        internalNoteService.create({ entityType: 'order', entityId: 'no-es-id', body: 'x', actor })
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        internalNoteService.create({ entityType: 'ledger', entityId: String(new Types.ObjectId()), body: 'x', actor })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('anota sobre comercio, domiciliario, cliente y PQRS existentes', async () => {
      const admin = await makeUser({ role: UserRole.ADMIN });
      const owner = await makeUser({ role: UserRole.BUSINESS });
      const business = await makeBusiness(owner._id);
      const driverUser = await makeUser({ role: UserRole.DRIVER });
      const driver = await makeDriver(driverUser._id);
      const client = await makeUser();
      const pqrs = await Pqrs.create({ userId: client._id, type: 'claim', subject: 'Tarde', detail: 'Llegó tarde' });
      const actor = actorOf(admin);

      for (const [entityType, id] of [
        ['business', business._id],
        ['driver', driver._id],
        ['user', client._id],
        ['pqrs', pqrs._id],
      ] as const) {
        const v = await internalNoteService.create({ entityType, entityId: String(id), body: `nota ${entityType}`, actor });
        expect(v.entityType).toBe(entityType);
      }
    });

    it('rechaza vacío, más de 2000 caracteres y números de tarjeta', async () => {
      const admin = await makeUser({ role: UserRole.ADMIN });
      const orderId = await makeOrderId();
      const actor = actorOf(admin);
      const make = (body: string) => internalNoteService.create({ entityType: 'order', entityId: orderId, body, actor });

      await expect(make('   ')).rejects.toMatchObject({ statusCode: 400 });
      await expect(make('a'.repeat(2001))).rejects.toMatchObject({ statusCode: 400 });
      await expect(make('a'.repeat(2000))).resolves.toBeTruthy();
      await expect(make('pagó con 4111111111111111 ok')).rejects.toMatchObject({ statusCode: 400, code: 'NOTE_CARD_NUMBER' });
      await expect(make('tarjeta 4111 1111 1111 1111')).rejects.toMatchObject({ statusCode: 400 });
      await expect(make('tarjeta 4111-1111-1111-1111')).rejects.toMatchObject({ statusCode: 400 });
      await expect(make('amex 3782 822463 10005')).rejects.toMatchObject({ statusCode: 400 });
    });

    it('no confunde con tarjeta lo que no pasa Luhn ni dos teléfonos seguidos', () => {
      expect(containsCardNumber('4111111111111112')).toBe(false); // 16 dígitos, Luhn inválido
      expect(containsCardNumber('llamar 3101234567 o 3112421673')).toBe(false);
      expect(containsCardNumber('pedido 123456')).toBe(false);
      expect(containsCardNumber('4111111111111111')).toBe(true);
    });

    it(`429 al pasar de ${NOTE_RATE_LIMIT_PER_MINUTE} notas por minuto (contado en Mongo)`, async () => {
      const admin = await makeUser({ role: UserRole.ADMIN });
      const orderId = await makeOrderId();
      const other = await makeUser({ role: UserRole.ADMIN });
      const docs = Array.from({ length: NOTE_RATE_LIMIT_PER_MINUTE }, (_, i) => ({
        entityType: 'order',
        entityId: new Types.ObjectId(orderId),
        authorId: admin._id,
        authorName: admin.name,
        body: `n${i}`,
      }));
      await InternalNote.insertMany(docs);

      await expect(
        internalNoteService.create({ entityType: 'order', entityId: orderId, body: 'una más', actor: actorOf(admin) })
      ).rejects.toMatchObject({ statusCode: 429 });
      // Otra persona no se ve afectada.
      await expect(
        internalNoteService.create({ entityType: 'order', entityId: orderId, body: 'yo sí', actor: actorOf(other) })
      ).resolves.toBeTruthy();
    });
  });

  describe('listFor', () => {
    it('pagina de la más reciente a la más antigua con nextBefore', async () => {
      const admin = await makeUser({ role: UserRole.ADMIN });
      const orderId = await makeOrderId();
      const actor = actorOf(admin);
      for (let i = 0; i < 5; i++) {
        const v = await internalNoteService.create({ entityType: 'order', entityId: orderId, body: `n${i}`, actor });
        await backdate(v._id, (5 - i) * 1000);
      }

      const p1 = await internalNoteService.listFor({ entityType: 'order', entityId: orderId, limit: 2, actor });
      expect(p1.items.map((n) => n.body)).toEqual(['n4', 'n3']);
      expect(p1.nextBefore).toBeTruthy();

      const p2 = await internalNoteService.listFor({ entityType: 'order', entityId: orderId, limit: 2, before: p1.nextBefore!, actor });
      expect(p2.items.map((n) => n.body)).toEqual(['n2', 'n1']);

      const p3 = await internalNoteService.listFor({ entityType: 'order', entityId: orderId, limit: 2, before: p2.nextBefore!, actor });
      expect(p3.items.map((n) => n.body)).toEqual(['n0']);
      expect(p3.nextBefore).toBeNull();
    });

    it('403 sin el permiso del tipo; 400 con "before" inválido; el tope es 50', async () => {
      const admin = await makeUser({ role: UserRole.ADMIN });
      const orderId = await makeOrderId();
      await expect(
        internalNoteService.listFor({ entityType: 'order', entityId: orderId, actor: actorOf(admin, [Permission.DRIVERS_VIEW]) })
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        internalNoteService.listFor({ entityType: 'order', entityId: orderId, before: 'ayer', actor: actorOf(admin) })
      ).rejects.toMatchObject({ statusCode: 400 });
      const res = await internalNoteService.listFor({ entityType: 'order', entityId: orderId, limit: 9999, actor: actorOf(admin) });
      expect(res.items).toEqual([]);
    });

    it('las notas de otra entidad no aparecen', async () => {
      const admin = await makeUser({ role: UserRole.ADMIN });
      const a = await makeOrderId();
      const b = await makeOrderId();
      const actor = actorOf(admin);
      await internalNoteService.create({ entityType: 'order', entityId: a, body: 'de A', actor });
      const res = await internalNoteService.listFor({ entityType: 'order', entityId: b, actor });
      expect(res.items).toHaveLength(0);
    });
  });

  describe('softDelete', () => {
    async function seed() {
      const author = await makeUser({ role: UserRole.ADMIN });
      const other = await makeUser({ role: UserRole.ADMIN });
      const boss = await makeUser({ role: UserRole.ADMIN });
      const orderId = await makeOrderId();
      const note = await internalNoteService.create({
        entityType: 'order',
        entityId: orderId,
        body: 'contenido privado',
        actor: actorOf(author),
      });
      return { author, other, boss, orderId, note };
    }

    it('el autor borra su nota dentro de 15 min sin motivo', async () => {
      const { author, note } = await seed();
      const res = await internalNoteService.softDelete({ id: note._id, actor: actorOf(author) });
      expect(res.deletedAt).toBeTruthy();
      expect(res.canDelete).toBe(false);
      const row = await InternalNote.findById(note._id).lean();
      expect(row!.deletedAt).toBeTruthy();
      expect(String(row!.deletedBy)).toBe(String(author._id));
    });

    it('otro admin no puede borrarla (403) aunque tenga el permiso de vista', async () => {
      const { other, note } = await seed();
      await expect(internalNoteService.softDelete({ id: note._id, reason: 'no me gusta', actor: actorOf(other) }))
        .rejects.toMatchObject({ statusCode: 403 });
      expect((await InternalNote.findById(note._id).lean())!.deletedAt).toBeNull();
    });

    it('pasados 15 min el autor ya no puede; el Super Administrador sí, con motivo', async () => {
      const { author, boss, note } = await seed();
      await backdate(note._id, NOTE_AUTHOR_DELETE_WINDOW_MS + 60_000);

      await expect(internalNoteService.softDelete({ id: note._id, actor: actorOf(author) }))
        .rejects.toMatchObject({ statusCode: 403 });

      const asBoss = actorOf(boss, ALL_VIEW, true);
      await expect(internalNoteService.softDelete({ id: note._id, actor: asBoss }))
        .rejects.toMatchObject({ statusCode: 400 });
      await expect(internalNoteService.softDelete({ id: note._id, reason: 'no', actor: asBoss }))
        .rejects.toMatchObject({ statusCode: 400 });

      const res = await internalNoteService.softDelete({ id: note._id, reason: 'Contiene datos personales', actor: asBoss });
      expect(res.deletedAt).toBeTruthy();
      const row = await InternalNote.findById(note._id).lean();
      expect(row!.deleteReason).toBe('Contiene datos personales');
    });

    it('borrar dos veces → 409; dos borrados simultáneos → uno gana', async () => {
      const { author, note } = await seed();
      const results = await Promise.allSettled([
        internalNoteService.softDelete({ id: note._id, actor: actorOf(author) }),
        internalNoteService.softDelete({ id: note._id, actor: actorOf(author) }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason.statusCode).toBe(409);
      await expect(internalNoteService.softDelete({ id: note._id, actor: actorOf(author) }))
        .rejects.toMatchObject({ statusCode: 409 });
    });

    it('404 si no existe, 403 sin permiso del tipo', async () => {
      const { author, note } = await seed();
      await expect(internalNoteService.softDelete({ id: String(new Types.ObjectId()), actor: actorOf(author) }))
        .rejects.toMatchObject({ statusCode: 404 });
      await expect(internalNoteService.softDelete({ id: note._id, actor: actorOf(author, [Permission.DRIVERS_VIEW]) }))
        .rejects.toMatchObject({ statusCode: 403 });
    });

    it('la auditoría del borrado no lleva el texto de la nota', async () => {
      const { author, orderId, note } = await seed();
      await internalNoteService.softDelete({ id: note._id, actor: actorOf(author) });
      const log = await AuditLog.findOne({ action: AuditAction.INTERNAL_NOTE_DELETED, entityId: orderId }).lean();
      expect(log).toBeTruthy();
      expect(log!.metadata).toMatchObject({ noteId: note._id, entityType: 'order', byAuthor: true });
      expect(JSON.stringify(log)).not.toContain('privado');
    });

    it('las borradas solo las lista el Super Administrador (como eliminadas); canDelete se calcula por actor', async () => {
      const { author, other, boss, orderId, note } = await seed();
      await internalNoteService.softDelete({ id: note._id, actor: actorOf(author) });

      const asOther = await internalNoteService.listFor({ entityType: 'order', entityId: orderId, actor: actorOf(other) });
      expect(asOther.items).toHaveLength(0);

      const asBoss = await internalNoteService.listFor({ entityType: 'order', entityId: orderId, actor: actorOf(boss, ALL_VIEW, true) });
      expect(asBoss.items).toHaveLength(1);
      expect(asBoss.items[0].deletedAt).toBeTruthy();
      expect(asBoss.items[0].canDelete).toBe(false);
    });

    it('canDelete: autor dentro de la ventana, no otro admin, sí el Super Administrador', async () => {
      const { author, other, boss, orderId } = await seed();
      const asAuthor = await internalNoteService.listFor({ entityType: 'order', entityId: orderId, actor: actorOf(author) });
      const asOther = await internalNoteService.listFor({ entityType: 'order', entityId: orderId, actor: actorOf(other) });
      const asBoss = await internalNoteService.listFor({ entityType: 'order', entityId: orderId, actor: actorOf(boss, ALL_VIEW, true) });
      expect(asAuthor.items[0].canDelete).toBe(true);
      expect(asOther.items[0].canDelete).toBe(false);
      expect(asBoss.items[0].canDelete).toBe(true);

      await backdate(asAuthor.items[0]._id, NOTE_AUTHOR_DELETE_WINDOW_MS + 1000);
      const later = await internalNoteService.listFor({ entityType: 'order', entityId: orderId, actor: actorOf(author) });
      expect(later.items[0].canDelete).toBe(false);
    });
  });
});
