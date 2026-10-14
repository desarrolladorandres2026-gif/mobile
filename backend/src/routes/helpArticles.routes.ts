import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize, validate } from '../middlewares';
import { requirePermission } from '../middlewares/auth';
import { AuditAction, logAudit, Permission } from '../security';
import { UserRole } from '../types';
import { HelpArticle } from '../models';
import { HELP_CATEGORIES } from '../models/HelpArticle';
import { AppError } from '../middlewares/errorHandler';
import { sendResponse, param } from '../utils';
import { objectId } from '../validators/common';

// /help-articles. Los comercios solo leen lo publicado; crear, editar y
// archivar es `support:manage` y queda auditado.
const router = Router();
router.use(authenticate);

const category = z.enum(HELP_CATEGORIES);
const create = z.object({ body: z.object({
  category,
  question: z.string().trim().min(5).max(200),
  answer: z.string().trim().min(10).max(4000),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isPublished: z.boolean().optional(),
}) });
const update = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    category: category.optional(),
    question: z.string().trim().min(5).max(200).optional(),
    answer: z.string().trim().min(10).max(4000).optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    isPublished: z.boolean().optional(),
  }).refine((b) => Object.keys(b).length > 0, 'Nada que actualizar'),
});
const byId = z.object({ params: z.object({ id: objectId }) });

// Lo que lee el comercio: solo lo publicado y sin ids del personal.
router.get('/', authorize(UserRole.BUSINESS), async (_req, res, next) => {
  try {
    sendResponse(res, 200, 'Centro de ayuda', await HelpArticle.find({ isPublished: true })
      .select('category question answer sortOrder').sort({ category: 1, sortOrder: 1, createdAt: 1 }).lean());
  } catch (e) { next(e); }
});

// Lo que gestiona soporte: también borradores y archivados.
router.get('/manage', authorize(UserRole.ADMIN), requirePermission(Permission.SUPPORT_MANAGE), async (_req, res, next) => {
  try {
    sendResponse(res, 200, 'Artículos de ayuda', await HelpArticle.find().sort({ category: 1, sortOrder: 1, createdAt: 1 }).lean());
  } catch (e) { next(e); }
});

router.post('/', authorize(UserRole.ADMIN), requirePermission(Permission.SUPPORT_MANAGE), validate(create), async (req, res, next) => {
  try {
    const article = await HelpArticle.create({ ...req.body, createdBy: req.user!._id });
    void logAudit(req, { action: AuditAction.HELP_ARTICLE_CREATED, entity: 'help_article', entityId: article._id.toString(), description: 'Artículo de ayuda creado', metadata: { category: article.category } });
    sendResponse(res, 201, 'Artículo creado', article);
  } catch (e) { next(e); }
});

router.patch('/:id', authorize(UserRole.ADMIN), requirePermission(Permission.SUPPORT_MANAGE), validate(update), async (req, res, next) => {
  try {
    const article = await HelpArticle.findByIdAndUpdate(param(req, 'id'), { $set: { ...req.body, updatedBy: req.user!._id } }, { new: true, runValidators: true });
    if (!article) throw new AppError('Artículo no encontrado', 404);
    void logAudit(req, { action: AuditAction.HELP_ARTICLE_UPDATED, entity: 'help_article', entityId: article._id.toString(), description: 'Artículo de ayuda editado', metadata: { fields: Object.keys(req.body) } });
    sendResponse(res, 200, 'Artículo actualizado', article);
  } catch (e) { next(e); }
});

router.delete('/:id', authorize(UserRole.ADMIN), requirePermission(Permission.SUPPORT_MANAGE), validate(byId), async (req, res, next) => {
  try {
    const article = await HelpArticle.findByIdAndDelete(param(req, 'id'));
    if (!article) throw new AppError('Artículo no encontrado', 404);
    void logAudit(req, { action: AuditAction.HELP_ARTICLE_DELETED, entity: 'help_article', entityId: article._id.toString(), description: 'Artículo de ayuda eliminado', metadata: { category: article.category } });
    sendResponse(res, 200, 'Artículo eliminado', null);
  } catch (e) { next(e); }
});

export default router;
