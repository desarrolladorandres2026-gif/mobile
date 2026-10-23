import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import {
  ContactRequest, PartnerApplication, DataRequest, OtpOutbox, PublicOtp, Business, LegalDocument, User,
} from '../models';
import { UserRole } from '../types';
import { featureFlagService } from '../services/featureFlag.service';
import { clearSitemapCache, escapeXml } from '../services/sitemap.service';
import { incidentCenterService } from '../services/incidentCenter.service';
import { cache } from '../cache';
import { makeUser, makeStaff, makeBusiness, authHeader } from './factories';

const A = '/api/v1';
const ALLOW_ALL = () => true;

async function readOtp(phone: string): Promise<string> {
  // El envío de eliminación no se espera (a propósito): se sondea el buzón.
  return vi.waitFor(async () => {
    const entry = await OtpOutbox.findOne({ channel: 'whatsapp', destination: phone }).sort({ createdAt: -1 });
    if (!entry) throw new Error(`No se envió ningún OTP a ${phone}`);
    return entry.code;
  });
}

beforeEach(async () => {
  await featureFlagService.remove('rbac_enforce');
  await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
  await cache.flush();
  clearSitemapCache();
});

const validContact = {
  name: 'Ana Pérez',
  contact: '3101234567',
  type: 'question',
  subject: 'Horarios',
  detail: 'Quisiera saber hasta qué hora reciben pedidos.',
};

describe('POST /contact', () => {
  it('guarda el mensaje y responde 201 sin datos internos', async () => {
    const res = await request(app).post(`${A}/contact`).send(validContact);
    expect(res.status).toBe(201);
    expect(res.body.message).toMatch(/Recibimos tu mensaje/);
    expect(res.body.data).toBeUndefined();
    const saved = await ContactRequest.findOne({ contact: '3101234567' }).lean();
    expect(saved?.status).toBe('new');
    expect(saved?.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('honeypot: responde 201 igual y NO guarda', async () => {
    const res = await request(app).post(`${A}/contact`).send({ ...validContact, website: 'http://spam.example' });
    expect(res.status).toBe(201);
    expect(res.body.message).toMatch(/Recibimos tu mensaje/);
    expect(await ContactRequest.countDocuments()).toBe(0);
  });

  it('quita HTML del texto y rechaza contacto inválido', async () => {
    await request(app).post(`${A}/contact`).send({ ...validContact, detail: '<script>alert(1)</script>Hola, necesito ayuda con mi pedido' }).expect(201);
    const saved = await ContactRequest.findOne().lean();
    expect(saved?.detail).not.toContain('<');
    expect(saved?.detail).toContain('necesito ayuda');

    const bad = await request(app).post(`${A}/contact`).send({ ...validContact, contact: 'no-es-contacto' });
    expect(bad.status).toBe(422);
  });

  it('valida longitudes y tipo', async () => {
    expect((await request(app).post(`${A}/contact`).send({ ...validContact, name: 'A' })).status).toBe(400);
    expect((await request(app).post(`${A}/contact`).send({ ...validContact, detail: 'corto' })).status).toBe(400);
    expect((await request(app).post(`${A}/contact`).send({ ...validContact, detail: 'x'.repeat(2001) })).status).toBe(400);
    expect((await request(app).post(`${A}/contact`).send({ ...validContact, type: 'otra' })).status).toBe(400);
  });

  it('dedupe: máximo 3 abiertas por contacto en 24 h (429), y una resuelta libera cupo', async () => {
    for (let i = 0; i < 3; i++) await request(app).post(`${A}/contact`).send(validContact).expect(201);
    const blocked = await request(app).post(`${A}/contact`).send(validContact);
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toMatch(/pendientes/);

    // Otro contacto no se ve afectado.
    await request(app).post(`${A}/contact`).send({ ...validContact, contact: 'ana@example.com' }).expect(201);

    await ContactRequest.updateOne({ contact: '3101234567' }, { $set: { status: 'resolved' } });
    await request(app).post(`${A}/contact`).send(validContact).expect(201);
  });
});

describe('admin: contact-requests', () => {
  it('lista paginada con filtro, sin ipHash; PATCH cambia estado y deja responsable', async () => {
    const staff = await makeStaff({ roleSlug: 'soporte' });
    await request(app).post(`${A}/contact`).send(validContact);
    await request(app).post(`${A}/contact`).send({ ...validContact, contact: 'otra@example.com' });
    const headers = await authHeader(staff);

    const list = await request(app).get(`${A}/admin/contact-requests?status=new&limit=1`).set(headers);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.meta.total).toBe(2);
    expect(list.body.data[0].ipHash).toBeUndefined();

    const id = list.body.data[0]._id;
    const patch = await request(app).patch(`${A}/admin/contact-requests/${id}`).set(headers).send({ status: 'resolved', response: 'Atendido por teléfono' });
    expect(patch.status).toBe(200);
    expect(patch.body.data.status).toBe('resolved');
    const saved = await ContactRequest.findById(id).lean();
    expect(String(saved?.handledBy)).toBe(String(staff._id));

    const onlyNew = await request(app).get(`${A}/admin/contact-requests?status=new`).set(headers);
    expect(onlyNew.body.meta.total).toBe(1);
  });

  it('sin permiso de soporte -> 403; sin sesión -> 401; cliente -> 403', async () => {
    const finance = await makeStaff({ roleSlug: 'finanzas' });
    const client = await makeUser();
    expect((await request(app).get(`${A}/admin/contact-requests`).set(await authHeader(finance))).status).toBe(403);
    expect((await request(app).get(`${A}/admin/contact-requests`)).status).toBe(401);
    expect((await request(app).get(`${A}/admin/contact-requests`).set(await authHeader(client))).status).toBe(403);
    expect((await request(app).patch(`${A}/admin/contact-requests/${'a'.repeat(24)}`).set(await authHeader(finance)).send({ status: 'resolved' })).status).toBe(403);
  });

  it('alertas del equipo: una alerta con conteo, visible solo con permiso de soporte', async () => {
    await request(app).post(`${A}/contact`).send(validContact);
    await request(app).post(`${A}/contact`).send({ ...validContact, contact: 'otra@example.com' });
    const all = await incidentCenterService.open(ALLOW_ALL);
    const alert = all.find((i) => i.kind === 'contact_request_new');
    expect(alert?.detail).toMatch(/^2 /);
    expect(alert?.key).toMatch(/^contact_request_new:[0-9a-f]{24}:c2$/);
    expect((await incidentCenterService.open(() => false)).some((i) => i.kind === 'contact_request_new')).toBe(false);

    await ContactRequest.updateMany({}, { $set: { status: 'resolved' } });
    expect((await incidentCenterService.open(ALLOW_ALL)).some((i) => i.kind === 'contact_request_new')).toBe(false);
  });
});

describe('eliminación de cuenta sin sesión', () => {
  const send = (phone: string) => request(app).post(`${A}/legal/deletion-request/send-otp`).send({ phone });
  const confirm = (body: Record<string, unknown>) => request(app).post(`${A}/legal/deletion-request/confirm`).send(body);

  it('send-otp responde idéntico exista o no la cuenta; solo escribe a cuentas reales', async () => {
    const user = await makeUser({ phone: '3201112233' });
    const real = await send(user.phone!);
    const ghost = await send('3209998877');
    expect(real.status).toBe(200);
    expect(ghost.status).toBe(real.status);
    expect(ghost.body).toEqual(real.body);

    await vi.waitFor(async () => expect(await OtpOutbox.countDocuments({ destination: '3201112233' })).toBe(1));
    expect(await OtpOutbox.countDocuments({ destination: '3209998877' })).toBe(0);
    // Ambas dejan el mismo rastro en base: nada distingue las dos rutas.
    expect(await PublicOtp.countDocuments({ purpose: 'account_deletion' })).toBe(2);
  });

  it('con OTP correcto de una cuenta real crea una DataRequest de tipo delete y auditoría; no borra nada', async () => {
    const user = await makeUser({ phone: '3201112233' });
    await send(user.phone!).expect(200);
    const otp = await readOtp(user.phone!);
    const res = await confirm({ phone: user.phone, otp, reason: 'Ya no uso la app' });
    expect(res.status).toBe(200);

    const requests = await DataRequest.find({ userId: user._id }).lean();
    expect(requests).toHaveLength(1);
    expect(requests[0].type).toBe('delete');
    expect(requests[0].status).toBe('received');
    expect(requests[0].detail).toContain('Ya no uso la app');
    expect(requests[0].legalDueAt).toBeTruthy();

    const { AuditLog } = await import('../security');
    const audit = await AuditLog.findOne({ action: 'account_deletion_requested', entityId: String(user._id) }).lean();
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit)).not.toContain(otp);

    const still = await User.findById(user._id);
    expect(still?.anonymizedAt).toBeFalsy();
    expect(still?.isActive).toBe(true);
  });

  it('confirm devuelve exactamente lo mismo con cuenta, sin cuenta y con solicitud ya abierta', async () => {
    const user = await makeUser({ phone: '3201112233' });
    await send(user.phone!);
    const otp = await readOtp(user.phone!);
    const first = await confirm({ phone: user.phone, otp });

    // Sin cuenta: nunca hubo código real, así que el OTP es inválido para el atacante...
    const ghostSend = await send('3209998877');
    expect(ghostSend.status).toBe(200);
    // ...y si la cuenta se borra después de pedir el código, el confirm correcto responde igual.
    const gone = await makeUser({ phone: '3207776655' });
    await send(gone.phone!);
    const goneOtp = await readOtp(gone.phone!);
    await User.updateOne({ _id: gone._id }, { $set: { anonymizedAt: new Date() } });
    const afterGone = await confirm({ phone: gone.phone, otp: goneOtp });
    expect(afterGone.status).toBe(first.status);
    expect(afterGone.body).toEqual(first.body);
    expect(await DataRequest.countDocuments({ userId: gone._id })).toBe(0);

    // Repetir con la solicitud abierta: una sola DataRequest, misma respuesta.
    await PublicOtp.deleteMany({});
    await send(user.phone!);
    const otp2 = await readOtp(user.phone!);
    const again = await confirm({ phone: user.phone, otp: otp2 });
    expect(again.body).toEqual(first.body);
    expect(await DataRequest.countDocuments({ userId: user._id })).toBe(1);
  });

  it('OTP inválido: 400 OTP_INVALID idéntico para número con cuenta, sin cuenta y sin código pedido', async () => {
    const user = await makeUser({ phone: '3201112233' });
    await send(user.phone!);
    await send('3209998877');
    const wrong = await confirm({ phone: user.phone, otp: '000000' });
    const ghost = await confirm({ phone: '3209998877', otp: '000000' });
    const never = await confirm({ phone: '3150000000', otp: '000000' });
    for (const r of [wrong, ghost, never]) {
      expect(r.status).toBe(400);
      expect(r.body.code ?? r.body.errorCode).toBe(wrong.body.code ?? wrong.body.errorCode);
      expect(r.body.message).toBe(wrong.body.message);
    }
    expect(await DataRequest.countDocuments()).toBe(0);
  });

  it('el código se agota a los 5 intentos y no se puede reutilizar', async () => {
    const user = await makeUser({ phone: '3201112233' });
    await send(user.phone!);
    const otp = await readOtp(user.phone!);
    for (let i = 0; i < 5; i++) await confirm({ phone: user.phone, otp: otp === '111111' ? '222222' : '111111' });
    const late = await confirm({ phone: user.phone, otp });
    // 400 (código quemado) o 429 (bloqueo por fuerza bruta): nunca éxito.
    expect([400, 429]).toContain(late.status);
    expect(await DataRequest.countDocuments()).toBe(0);
  });

  it('las cuentas del equipo no generan solicitud', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN, phone: '3201112244' });
    await send(admin.phone!).expect(200);
    expect(await OtpOutbox.countDocuments({ destination: admin.phone })).toBe(0);
  });

  it('valida el teléfono y limita el motivo', async () => {
    expect((await send('123')).status).toBe(400);
    expect((await confirm({ phone: '3201112233', otp: '123456', reason: 'x'.repeat(501) })).status).toBe(400);
    expect((await confirm({ phone: '3201112233', otp: 'abc' })).status).toBe(400);
  });
});

describe('partners', () => {
  const sendOtp = (phone: string) => request(app).post(`${A}/partners/send-otp`).send({ phone });
  const baseBusiness = {
    type: 'business', name: 'Luis Gómez', phone: '3115550001', city: 'Garzón',
    businessName: 'Panadería El Trigal', category: 'cafe', address: 'Cra 10 #5-23',
  };
  const baseDriver = { type: 'driver', name: 'Pedro Ruiz', phone: '3115550002', city: 'Garzón', vehicleType: 'moto' };
  const apply = async (body: Record<string, unknown>) => {
    await sendOtp(String(body.phone)).expect(200);
    const otp = await readOtp(String(body.phone));
    return request(app).post(`${A}/partners/applications`).send({ ...body, otp });
  };

  it('crea la solicitud con OTP válido (201) y solo una abierta por celular+tipo (200 sin duplicar)', async () => {
    const first = await apply(baseBusiness);
    expect(first.status).toBe(201);
    expect(await PartnerApplication.countDocuments()).toBe(1);

    const second = await apply(baseBusiness);
    expect(second.status).toBe(200);
    expect(second.body.message).toMatch(/Ya recibimos tu solicitud/);
    expect(await PartnerApplication.countDocuments()).toBe(1);

    // Otro tipo con el mismo celular es otra solicitud.
    const asDriver = await apply({ ...baseDriver, phone: baseBusiness.phone });
    expect(asDriver.status).toBe(201);
    expect(await PartnerApplication.countDocuments()).toBe(2);
  });

  it('OTP inválido -> 400 y no guarda; honeypot -> 201 y no guarda (ni verifica el código)', async () => {
    await sendOtp(baseDriver.phone).expect(200);
    const bad = await request(app).post(`${A}/partners/applications`).send({ ...baseDriver, otp: '000000' });
    expect(bad.status).toBe(400);
    const bot = await request(app).post(`${A}/partners/applications`).send({ ...baseDriver, otp: '000000', website: 'x' });
    expect(bot.status).toBe(201);
    expect(await PartnerApplication.countDocuments()).toBe(0);
  });

  it('exige businessName+category+address para comercio y vehicleType para repartidor', async () => {
    expect((await apply({ ...baseBusiness, phone: '3115551001', businessName: undefined })).status).toBe(400);
    expect((await apply({ ...baseBusiness, phone: '3115551002', address: undefined })).status).toBe(400);
    expect((await apply({ ...baseBusiness, phone: '3115551003', category: undefined })).status).toBe(400);
    expect((await apply({ ...baseDriver, phone: '3115551004', vehicleType: undefined })).status).toBe(400);
    expect((await apply({ ...baseDriver, phone: '3115551005', vehicleType: 'avion' })).status).toBe(400);
    expect(await PartnerApplication.countDocuments()).toBe(0);
  });

  it('send-otp respeta el enfriamiento (429 OTP_COOLDOWN)', async () => {
    await sendOtp('3115550009').expect(200);
    const again = await sendOtp('3115550009');
    expect(again.status).toBe(429);
  });

  it('enlaza userId si ya hay cuenta con ese celular', async () => {
    const user = await makeUser({ phone: baseDriver.phone });
    await apply(baseDriver).then((r) => expect(r.status).toBe(201));
    const saved = await PartnerApplication.findOne().lean();
    expect(String(saved?.userId)).toBe(String(user._id));
  });

  describe('admin', () => {
    it('lista, filtra y actualiza; PATCH no puede aprobar', async () => {
      const staff = await makeStaff({ roleSlug: 'soporte' });
      const headers = await authHeader(staff);
      await apply(baseBusiness);
      await apply(baseDriver);

      const list = await request(app).get(`${A}/admin/partner-applications?type=driver`).set(headers);
      expect(list.status).toBe(200);
      expect(list.body.meta.total).toBe(1);
      expect(list.body.data[0].ipHash).toBeUndefined();

      const id = list.body.data[0]._id;
      const one = await request(app).get(`${A}/admin/partner-applications/${id}`).set(headers);
      expect(one.body.data.name).toBe('Pedro Ruiz');

      const contacted = await request(app).patch(`${A}/admin/partner-applications/${id}`).set(headers).send({ status: 'contacted', adminNote: 'Llamado' });
      expect(contacted.status).toBe(200);
      expect(contacted.body.data.status).toBe('contacted');
      expect(String(contacted.body.data.assignedTo)).toBe(String(staff._id));

      const sneaky = await request(app).patch(`${A}/admin/partner-applications/${id}`).set(headers).send({ status: 'approved' });
      expect(sneaky.status).toBe(422);
    });

    it('sin permiso -> 403 en todas las rutas; sin sesión -> 401', async () => {
      const finance = await makeStaff({ roleSlug: 'finanzas' });
      const headers = await authHeader(finance);
      const id = 'a'.repeat(24);
      expect((await request(app).get(`${A}/admin/partner-applications`).set(headers)).status).toBe(403);
      expect((await request(app).get(`${A}/admin/partner-applications/${id}`).set(headers)).status).toBe(403);
      expect((await request(app).patch(`${A}/admin/partner-applications/${id}`).set(headers).send({ status: 'contacted' })).status).toBe(403);
      expect((await request(app).post(`${A}/admin/partner-applications/${id}/approve`).set(headers).send({})).status).toBe(403);
      expect((await request(app).post(`${A}/admin/partner-applications/${id}/approve`).send({})).status).toBe(401);
    });

    it('approve (comercio): cliente pasa a business y se crea el Business en borrador, sin aprobar', async () => {
      const staff = await makeStaff({ roleSlug: 'super_admin' });
      const owner = await makeUser({ phone: baseBusiness.phone, email: 'luis@example.com' });
      await apply(baseBusiness);
      const appDoc = (await PartnerApplication.findOne())!;

      const res = await request(app).post(`${A}/admin/partner-applications/${appDoc._id}/approve`).set(await authHeader(staff)).send({ adminNote: 'Todo en orden' });
      expect(res.status).toBe(200);
      expect(res.body.data.needsAccount).toBe(false);
      expect(res.body.data.application.status).toBe('approved');

      const updatedUser = await User.findById(owner._id);
      expect(updatedUser?.role).toBe(UserRole.BUSINESS);

      const business = await Business.findOne({ ownerId: owner._id }).lean();
      expect(business?.name).toBe('Panadería El Trigal');
      expect(business?.category).toBe('cafe');
      expect(business?.isApproved).toBe(false);
      expect(business?.address).toBe('Cra 10 #5-23');
      expect(String(res.body.data.application.businessId)).toBe(String(business?._id));

      // Idempotente: aprobar de nuevo no duplica el negocio.
      const again = await request(app).post(`${A}/admin/partner-applications/${appDoc._id}/approve`).set(await authHeader(staff)).send({});
      expect(again.status).toBe(200);
      expect(await Business.countDocuments({ ownerId: owner._id })).toBe(1);
    });

    it('approve (repartidor): cliente pasa a driver y no se crea Business', async () => {
      const staff = await makeStaff({ roleSlug: 'super_admin' });
      const user = await makeUser({ phone: baseDriver.phone });
      await apply(baseDriver);
      const appDoc = (await PartnerApplication.findOne())!;
      const res = await request(app).post(`${A}/admin/partner-applications/${appDoc._id}/approve`).set(await authHeader(staff)).send({});
      expect(res.status).toBe(200);
      expect((await User.findById(user._id))?.role).toBe(UserRole.DRIVER);
      expect(res.body.data.application.createdUserRole).toBe('driver');
      expect(await Business.countDocuments()).toBe(0);
    });

    it('approve sin cuenta con ese celular: approved + needsAccount true, nada más cambia', async () => {
      const staff = await makeStaff({ roleSlug: 'super_admin' });
      await apply(baseDriver);
      const appDoc = (await PartnerApplication.findOne())!;
      const res = await request(app).post(`${A}/admin/partner-applications/${appDoc._id}/approve`).set(await authHeader(staff)).send({});
      expect(res.status).toBe(200);
      expect(res.body.data.needsAccount).toBe(true);
      expect(res.body.data.application.status).toBe('approved');
      expect(await User.countDocuments({ phone: baseDriver.phone })).toBe(0);
    });

    it('approve cambia un rol solo con users:role_change; soporte (sin ese permiso) recibe 403 y no cambia nada', async () => {
      const support = await makeStaff({ roleSlug: 'soporte' });
      const user = await makeUser({ phone: baseDriver.phone });
      await apply(baseDriver);
      const appDoc = (await PartnerApplication.findOne())!;
      const res = await request(app).post(`${A}/admin/partner-applications/${appDoc._id}/approve`).set(await authHeader(support)).send({});
      expect(res.status).toBe(403);
      expect((await User.findById(user._id))?.role).toBe(UserRole.CLIENT);
      expect((await PartnerApplication.findById(appDoc._id))?.status).toBe('new');
    });

    it('approve de comercio exige correo en la cuenta y categoría resoluble, antes de tocar nada', async () => {
      const staff = await makeStaff({ roleSlug: 'super_admin' });
      const headers = await authHeader(staff);
      const user = await makeUser({ phone: baseBusiness.phone });
      await apply({ ...baseBusiness, category: 'Ferretería' });
      const appDoc = (await PartnerApplication.findOne())!;

      const noEmail = await request(app).post(`${A}/admin/partner-applications/${appDoc._id}/approve`).set(headers).send({ businessCategory: 'cafe' });
      expect(noEmail.status).toBe(422);
      expect((await User.findById(user._id))?.role).toBe(UserRole.CLIENT);

      await User.updateOne({ _id: user._id }, { $set: { email: 'luis@example.com' } });
      const noCategory = await request(app).post(`${A}/admin/partner-applications/${appDoc._id}/approve`).set(headers).send({});
      expect(noCategory.status).toBe(422);
      expect((await User.findById(user._id))?.role).toBe(UserRole.CLIENT);

      const ok = await request(app).post(`${A}/admin/partner-applications/${appDoc._id}/approve`).set(headers).send({ businessCategory: 'supermarket' });
      expect(ok.status).toBe(200);
      expect((await Business.findOne({ ownerId: user._id }))?.category).toBe('supermarket');
    });

    it('alerta partner_application_new con conteo', async () => {
      await apply(baseBusiness);
      await apply(baseDriver);
      const alert = (await incidentCenterService.open(ALLOW_ALL)).find((i) => i.kind === 'partner_application_new');
      expect(alert?.key).toMatch(/:c2$/);
    });
  });
});

describe('GET /sitemap.xml', () => {
  it('incluye páginas fijas, documentos legales vigentes y solo comercios públicos; XML válido', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const pub = await makeBusiness(owner._id, { name: 'Pizzería Pública' });
    const pending = await makeBusiness(owner._id, { name: 'Sin Aprobar', isApproved: false });
    const suspended = await makeBusiness(owner._id, { name: 'Suspendida' });
    await Business.updateOne({ _id: suspended._id }, { $set: { isSuspended: true } });
    const archived = await makeBusiness(owner._id, { name: 'Archivada' });
    await Business.updateOne({ _id: archived._id }, { $set: { isArchived: true } });
    const closed = await makeBusiness(owner._id, { name: 'Cerrada Hoy', isActive: false });

    await LegalDocument.create({ kind: 'terms', version: '1', title: 'Términos', content: 'x'.repeat(60), isActive: true });
    await LegalDocument.create({ kind: 'privacy', version: '1', title: 'Privacidad', content: 'x'.repeat(60), isActive: false });

    const res = await request(app).get('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(res.text).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    for (const path of ['/', '/comercios', '/soporte', '/unete-comercio', '/repartidores', '/eliminar-cuenta']) {
      expect(res.text).toMatch(new RegExp(`<loc>[^<]*${path === '/' ? '/' : path}</loc>`));
    }
    expect(res.text).toContain('/legal/terms</loc>');
    expect(res.text).not.toContain('/legal/privacy');
    expect(res.text).toContain(`/negocio/${pub.slug}</loc>`);
    expect(res.text).toContain(`/negocio/${closed.slug}</loc>`);
    for (const hidden of [pending, suspended, archived]) expect(res.text).not.toContain(`/negocio/${hidden.slug}<`);
    expect(res.text).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}T/);
  });

  it('escapa XML en la URL', async () => {
    expect(escapeXml(`a&b<c>"d"'e'`)).toBe('a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;');
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const b = await makeBusiness(owner._id, { name: 'Raro' });
    // El slug se genera limpio; se fuerza uno hostil por el driver para probar el escape.
    await Business.collection.updateOne({ _id: b._id }, { $set: { slug: `a&b<c>"d'e` } });
    const res = await request(app).get('/sitemap.xml');
    expect(res.text).not.toContain('a&b<c>');
    expect(res.text).toContain('a%26b%3Cc%3E%22d&apos;e');
    expect(res.text).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it('cachea 10 minutos en memoria', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    await request(app).get('/sitemap.xml');
    const late = await makeBusiness(owner._id, { name: 'Llegó Tarde' });
    const cached = await request(app).get('/sitemap.xml');
    expect(cached.text).not.toContain(`/negocio/${late.slug}<`);
    clearSitemapCache();
    const fresh = await request(app).get('/sitemap.xml');
    expect(fresh.text).toContain(`/negocio/${late.slug}<`);
  });
});
