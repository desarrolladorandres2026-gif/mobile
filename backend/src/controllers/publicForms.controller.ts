import { Request, Response, NextFunction } from 'express';
import { sendResponse, param } from '../utils';
import { honeypotTripped } from '../services/publicForms';
import { contactService, CONTACT_RECEIVED_MESSAGE } from '../services/contact.service';
import {
  accountDeletionRequestService, DELETION_OTP_MESSAGE, DELETION_CONFIRM_MESSAGE,
} from '../services/accountDeletionRequest.service';
import {
  partnerService, PARTNER_RECEIVED_MESSAGE, PARTNER_DUPLICATE_MESSAGE, PARTNER_OTP_MESSAGE,
} from '../services/partner.service';

/** Formularios públicos del sitio web y su bandeja en el panel. La lógica vive en los servicios. */
export const publicFormsController = {
  // ── Contacto ──
  async createContact(req: Request, res: Response, next: NextFunction) {
    try {
      // Honeypot: respuesta idéntica a la de un envío real, sin guardar nada.
      if (!honeypotTripped(req.body.website)) {
        await contactService.create(req.body, req);
      }
      sendResponse(res, 201, CONTACT_RECEIVED_MESSAGE);
    } catch (error) { next(error); }
  },

  async listContact(req: Request, res: Response, next: NextFunction) {
    try {
      const { items, meta } = await contactService.list({
        status: req.query.status as never,
        page: Number(req.query.page),
        limit: Number(req.query.limit),
      });
      sendResponse(res, 200, 'Mensajes de contacto', items, meta);
    } catch (error) { next(error); }
  },

  async updateContact(req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Mensaje actualizado', await contactService.update(param(req, 'id'), req.body, req.user!._id.toString(), req));
    } catch (error) { next(error); }
  },

  // ── Eliminación de cuenta ──
  async deletionSendOtp(req: Request, res: Response, next: NextFunction) {
    try {
      await accountDeletionRequestService.sendOtp(req.body.phone);
      sendResponse(res, 200, DELETION_OTP_MESSAGE);
    } catch (error) { next(error); }
  },

  async deletionConfirm(req: Request, res: Response, next: NextFunction) {
    try {
      await accountDeletionRequestService.confirm(req.body, req);
      sendResponse(res, 200, DELETION_CONFIRM_MESSAGE);
    } catch (error) { next(error); }
  },

  // ── Aliados ──
  async partnerSendOtp(req: Request, res: Response, next: NextFunction) {
    try {
      await partnerService.sendOtp(req.body.phone);
      sendResponse(res, 200, PARTNER_OTP_MESSAGE);
    } catch (error) { next(error); }
  },

  async partnerApply(req: Request, res: Response, next: NextFunction) {
    try {
      if (honeypotTripped(req.body.website)) return void sendResponse(res, 201, PARTNER_RECEIVED_MESSAGE);
      const { created } = await partnerService.apply(req.body, req);
      if (created) sendResponse(res, 201, PARTNER_RECEIVED_MESSAGE);
      else sendResponse(res, 200, PARTNER_DUPLICATE_MESSAGE);
    } catch (error) { next(error); }
  },

  async listPartner(req: Request, res: Response, next: NextFunction) {
    try {
      const { items, meta } = await partnerService.list({
        status: req.query.status as never,
        type: req.query.type as never,
        page: Number(req.query.page),
        limit: Number(req.query.limit),
      });
      sendResponse(res, 200, 'Solicitudes de aliados', items, meta);
    } catch (error) { next(error); }
  },

  async getPartner(req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Solicitud de aliado', await partnerService.get(param(req, 'id')));
    } catch (error) { next(error); }
  },

  async updatePartner(req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Solicitud actualizada', await partnerService.update(param(req, 'id'), req.body, req.user!._id.toString(), req));
    } catch (error) { next(error); }
  },

  async approvePartner(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await partnerService.approve(param(req, 'id'), req.body, req.user!, req);
      sendResponse(res, 200, result.needsAccount ? 'Solicitud aprobada: la persona debe registrarse primero como cliente' : 'Solicitud aprobada', result);
    } catch (error) { next(error); }
  },
};
