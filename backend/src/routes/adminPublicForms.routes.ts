import { Router } from 'express';
import { requirePermission, validate } from '../middlewares';
import { Permission } from '../security';
import { publicFormsController as c } from '../controllers/publicForms.controller';
import {
  listContactSchema, updateContactSchema, listPartnerSchema, partnerIdSchema, updatePartnerSchema, approvePartnerSchema,
} from '../validators/publicForms.validator';

// Bandejas de los formularios públicos. Heredan authenticate + authorize(ADMIN) de admin.routes.ts.
// Mismo permiso que PQRS y soporte: es la misma cola de atención. Aprobar un aliado además cambia el
// rol de una cuenta, y eso exige `users:role_change` dentro de `partnerService.approve`.

export const contactRequestsRouter = Router();
contactRequestsRouter.get('/', requirePermission(Permission.SUPPORT_VIEW), validate(listContactSchema), (req, res, next) => c.listContact(req, res, next));
contactRequestsRouter.patch('/:id', requirePermission(Permission.SUPPORT_MANAGE), validate(updateContactSchema), (req, res, next) => c.updateContact(req, res, next));

export const partnerApplicationsRouter = Router();
partnerApplicationsRouter.get('/', requirePermission(Permission.SUPPORT_VIEW), validate(listPartnerSchema), (req, res, next) => c.listPartner(req, res, next));
partnerApplicationsRouter.get('/:id', requirePermission(Permission.SUPPORT_VIEW), validate(partnerIdSchema), (req, res, next) => c.getPartner(req, res, next));
partnerApplicationsRouter.patch('/:id', requirePermission(Permission.SUPPORT_MANAGE), validate(updatePartnerSchema), (req, res, next) => c.updatePartner(req, res, next));
partnerApplicationsRouter.post('/:id/approve', requirePermission(Permission.SUPPORT_MANAGE), validate(approvePartnerSchema), (req, res, next) => c.approvePartner(req, res, next));
