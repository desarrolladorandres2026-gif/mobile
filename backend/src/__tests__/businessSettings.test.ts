import { describe, it, expect, beforeEach } from 'vitest';
import { Business } from '../models';
import { UserRole } from '../types';
import { businessService } from '../services/business.service';
import { makeUser, makeBusiness, GARZON } from './factories';

/**
 * Lo que un comercio puede cambiar de sí mismo.
 *
 * La frontera importa: su horario y su promoción de envío son decisiones
 * suyas porque las paga él, pero su comisión y su aprobación son el acuerdo
 * con ZIPP. Que un negocio pudiera tocar lo segundo desde su panel sería
 * dejarle fijar cuánto cobra la plataforma.
 */
describe('Ajustes del comercio', () => {
  let owner: any;
  let business: any;

  beforeEach(async () => {
    owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
  });

  it('puede fijar su umbral de envío gratis', async () => {
    await businessService.update(business._id.toString(), owner._id.toString(), {
      freeDeliveryThreshold: 45000,
    });

    const saved = await Business.findById(business._id);
    expect(saved!.freeDeliveryThreshold).toBe(45000);
  });

  it('puede desactivarlo poniéndolo en cero', async () => {
    await businessService.update(business._id.toString(), owner._id.toString(), {
      freeDeliveryThreshold: 45000,
    });
    await businessService.update(business._id.toString(), owner._id.toString(), {
      freeDeliveryThreshold: 0,
    });

    const saved = await Business.findById(business._id);
    expect(saved!.freeDeliveryThreshold).toBe(0);
  });

  it('puede cambiar su horario', async () => {
    await businessService.update(business._id.toString(), owner._id.toString(), {
      schedule: {
        monday: { open: '08:00', close: '20:00', isOpen: true },
        sunday: { isOpen: false },
      },
    });

    const saved = await Business.findById(business._id);
    expect(saved!.schedule.monday.open).toBe('08:00');
    expect(saved!.schedule.sunday.isOpen).toBe(false);
  });

  it('NO puede tocar su comisión, aunque la mande en el cuerpo', async () => {
    const before = await Business.findById(business._id);

    await businessService.update(business._id.toString(), owner._id.toString(), {
      commissionRateBps: 0,
    } as never);

    const after = await Business.findById(business._id);
    expect(after!.commissionRateBps).toBe(before!.commissionRateBps);
  });

  it('NO puede aprobarse a sí mismo', async () => {
    await Business.updateOne({ _id: business._id }, { isApproved: false });

    await businessService.update(business._id.toString(), owner._id.toString(), {
      isApproved: true,
    } as never);

    const after = await Business.findById(business._id);
    expect(after!.isApproved).toBe(false);
  });

  it('NO puede destacarse a sí mismo en el inicio', async () => {
    await businessService.update(business._id.toString(), owner._id.toString(), {
      isFeatured: true,
    } as never);

    const after = await Business.findById(business._id);
    expect(after!.isFeatured).toBe(false);
  });

  it('el dueño de otro negocio no puede cambiar este', async () => {
    const intruso = await makeUser({ role: UserRole.BUSINESS });

    await expect(
      businessService.update(business._id.toString(), intruso._id.toString(), {
        freeDeliveryThreshold: 1000,
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
