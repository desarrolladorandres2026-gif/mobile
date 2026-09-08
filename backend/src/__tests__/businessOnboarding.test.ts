import { describe, it, expect, beforeEach } from 'vitest';
import { Business, BusinessDocument } from '../models';
import { UserRole } from '../types';
import { businessService } from '../services/business.service';
import { makeUser, makeBusiness, GARZON } from './factories';

/**
 * Alta y verificación de comercios.
 *
 * El panel creaba negocios con `isApproved: true` escrito en el código del
 * formulario, así que ningún comercio pasaba jamás por revisión: darlos de
 * alta y aprobarlos era el mismo gesto. Aprobar un negocio es fijar los
 * términos comerciales de alguien a quien se le va a transferir dinero, y
 * eso merece una comprobación.
 */
describe('Alta de comercios', () => {
  let owner: any;
  let business: any;

  const approveDocs = async (
    businessId: string,
    types: string[],
    adminId: string
  ) => {
    for (const type of types) {
      const doc = await businessService.submitDocument(businessId, {
        type: type as never,
        reference: `REF-${type}`,
      });
      await businessService.reviewDocument(doc!._id.toString(), adminId, 'approved');
    }
  };

  beforeEach(async () => {
    owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, {
      category: 'restaurant',
      lat: GARZON.lat,
      lng: GARZON.lng,
      isApproved: false,
    });
  });

  it('un negocio nuevo nace sin aprobar', async () => {
    const saved = await Business.findById(business._id);
    expect(saved!.isApproved).toBe(false);
  });

  it('dice exactamente qué papeles faltan, no solo que faltan', async () => {
    const missing = await businessService.missingDocuments(business._id.toString());

    expect(missing).toContain('rut');
    expect(missing).toContain('chamber_of_commerce');
    expect(missing).toContain('legal_rep_id');
    expect(missing).toContain('bank_certificate');
  });

  it('a un restaurante le pide además el concepto sanitario', async () => {
    const missing = await businessService.missingDocuments(business._id.toString());
    expect(missing).toContain('health_permit');
  });

  it('a una droguería no le inventa el concepto sanitario', async () => {
    const other = await makeBusiness(owner._id, {
      category: 'pharmacy',
      lat: GARZON.lat,
      lng: GARZON.lng,
    });

    const missing = await businessService.missingDocuments(other._id.toString());
    expect(missing).not.toContain('health_permit');
  });

  it('un documento enviado sigue faltando hasta que alguien lo revisa', async () => {
    await businessService.submitDocument(business._id.toString(), {
      type: 'rut',
      reference: '900123456-1',
    });

    const missing = await businessService.missingDocuments(business._id.toString());
    expect(missing).toContain('rut');
  });

  it('reenviar un documento reemplaza al anterior en vez de acumular', async () => {
    await businessService.submitDocument(business._id.toString(), {
      type: 'rut',
      reference: 'primero',
    });
    await businessService.submitDocument(business._id.toString(), {
      type: 'rut',
      reference: 'segundo',
    });

    const docs = await BusinessDocument.find({ businessId: business._id, type: 'rut' });
    expect(docs).toHaveLength(1);
    expect(docs[0].reference).toBe('segundo');
  });

  it('reenviar tras un rechazo vuelve a dejarlo pendiente', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const doc = await businessService.submitDocument(business._id.toString(), {
      type: 'rut',
      reference: 'borroso',
    });
    await businessService.reviewDocument(doc!._id.toString(), admin._id.toString(), 'rejected', 'No se lee');

    const again = await businessService.submitDocument(business._id.toString(), {
      type: 'rut',
      reference: 'legible',
    });

    expect(again!.status).toBe('pending');
    expect(again!.rejectionReason).toBeFalsy();
  });

  it('no deja aprobar con papeles incompletos', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });

    await expect(
      businessService.approve(business._id.toString(), admin._id.toString())
    ).rejects.toMatchObject({ statusCode: 422 });

    const saved = await Business.findById(business._id);
    expect(saved!.isApproved).toBe(false);
  });

  it('aprueba cuando están todos y deja constancia de quién y cuándo', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });

    await approveDocs(
      business._id.toString(),
      ['rut', 'chamber_of_commerce', 'legal_rep_id', 'bank_certificate', 'health_permit'],
      admin._id.toString()
    );

    const approved = await businessService.approve(business._id.toString(), admin._id.toString());

    expect(approved.isApproved).toBe(true);
    expect(approved.approvedAt).toBeInstanceOf(Date);
    expect(approved.approvedBy!.toString()).toBe(admin._id.toString());
  });

  it('un documento vencido vuelve a faltar', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });

    const doc = await businessService.submitDocument(business._id.toString(), {
      type: 'rut',
      reference: '900123456-1',
      expiresAt: new Date(Date.now() - 86_400_000),
    });
    await businessService.reviewDocument(doc!._id.toString(), admin._id.toString(), 'approved');

    const missing = await businessService.missingDocuments(business._id.toString());
    expect(missing).toContain('rut');

    // Y queda marcado como vencido, no como aprobado, para que se vea por qué.
    const saved = await BusinessDocument.findById(doc!._id);
    expect(saved!.status).toBe('expired');
  });

  it('la cola de revisión trae lo que le falta a cada negocio', async () => {
    const pending = await businessService.pendingApprovals();
    const mine = pending.find((b: any) => b._id.toString() === business._id.toString());

    expect(mine).toBeDefined();
    expect(mine!.missingDocuments.length).toBeGreaterThan(0);
  });

  it('un negocio ya aprobado sale de la cola', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await approveDocs(
      business._id.toString(),
      ['rut', 'chamber_of_commerce', 'legal_rep_id', 'bank_certificate', 'health_permit'],
      admin._id.toString()
    );
    await businessService.approve(business._id.toString(), admin._id.toString());

    const pending = await businessService.pendingApprovals();
    expect(pending.find((b: any) => b._id.toString() === business._id.toString())).toBeUndefined();
  });
});
