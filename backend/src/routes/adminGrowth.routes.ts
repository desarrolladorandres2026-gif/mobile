import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { requirePermission, validate } from '../middlewares';
import { Permission } from '../security';
import { AuditAction, AuditSeverity, logAudit } from '../security';
import { sendResponse } from '../utils';
import { AppError } from '../middlewares';
import { CampaignSend } from '../models';
import { campaignService } from '../services/campaign.service';
import { adminGrowthService } from '../services/adminGrowth.service';

/**
 * /admin/growth: lo que Crecimiento necesita del panel y no tenía pantalla.
 * Los permisos son los que ya existían: enviar avisos, ver cupones (los
 * referidos son una palanca de descuento) y ver finanzas (Zipp Pro es dinero).
 */
const router = Router();

// ── Envíos dirigidos ──────────────────────────────────────────────

const segmentSchema = z
  .object({
    city: z.string().trim().min(2).max(80).optional(),
    // Solo clientes o domiciliarios: comercios y staff no son audiencia.
    role: z.enum(['client', 'driver']).optional(),
    boughtFromBusinessId: z
      .string()
      .refine((v) => Types.ObjectId.isValid(v), 'Negocio inválido')
      .optional(),
    inactiveForDays: z.number().int().min(1).max(365).optional(),
    minDeliveredOrders: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

const previewSchema = z.object({ body: z.object({ segment: segmentSchema.default({}) }) });

const sendSchema = z.object({
  body: z.object({
    segment: segmentSchema.default({}),
    message: z.object({
      title: z.string().trim().min(3).max(60),
      body: z.string().trim().min(3).max(240),
    }),
    // El panel manda el alcance que la persona vio en la vista previa: si
    // el segmento creció entre tanto, se rechaza y se vuelve a confirmar.
    confirmedReach: z.number().int().min(1),
  }),
});

router.post(
  '/campaigns/preview',
  requirePermission(Permission.NOTIFICATIONS_SEND),
  validate(previewSchema),
  async (req, res, next) => {
    try {
      const reach = await campaignService.preview(req.body.segment);
      sendResponse(res, 200, 'Alcance del segmento', { reach });
    } catch (error) { next(error); }
  }
);

router.post(
  '/campaigns/send',
  requirePermission(Permission.NOTIFICATIONS_SEND),
  validate(sendSchema),
  async (req, res, next) => {
    try {
      const { segment, message, confirmedReach } = req.body;
      const reach = await campaignService.preview(segment);
      if (reach === 0) {
        throw new AppError('El segmento no alcanza a nadie con comunicaciones activadas', 400);
      }
      if (reach > Math.ceil(confirmedReach * 1.1)) {
        throw new AppError(`El alcance cambió a ${reach} personas. Revisa la vista previa y confirma de nuevo.`, 409);
      }

      const record = await campaignService.launch(req.user!._id.toString(), segment, message);

      void logAudit(req, {
        action: AuditAction.SUSPICIOUS_ACTIVITY,
        entity: 'campaign',
        entityId: String(record._id),
        severity: AuditSeverity.MEDIUM,
        description: `Envío dirigido a ${reach} personas: "${message.title}"`,
        metadata: { segment, reach },
      });

      sendResponse(res, 202, 'Envío en curso', record);
    } catch (error) { next(error); }
  }
);

router.get(
  '/campaigns/history',
  requirePermission(Permission.NOTIFICATIONS_VIEW),
  async (_req, res, next) => {
    try {
      const rows = await CampaignSend.find().sort({ createdAt: -1 }).limit(30).populate('sentBy', 'name').lean();
      sendResponse(res, 200, 'Historial de envíos', rows);
    } catch (error) { next(error); }
  }
);

// ── Referidos ─────────────────────────────────────────────────────

const referralsSchema = z.object({
  query: z.object({
    status: z.enum(['pending', 'converted', 'blocked']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

router.get(
  '/referrals',
  requirePermission(Permission.COUPONS_VIEW),
  validate(referralsSchema),
  async (req, res, next) => {
    try {
      const { status, limit } = req.query as { status?: 'pending' | 'converted' | 'blocked'; limit?: string };
      sendResponse(res, 200, 'Invitaciones', await adminGrowthService.referrals({ status, limit: limit ? Number(limit) : undefined }));
    } catch (error) { next(error); }
  }
);

// ── Zipp Pro ──────────────────────────────────────────────────────

router.get('/pro', requirePermission(Permission.FINANCE_VIEW), async (_req, res, next) => {
  try {
    sendResponse(res, 200, 'Zipp Pro', await adminGrowthService.proOverview());
  } catch (error) { next(error); }
});

export default router;
