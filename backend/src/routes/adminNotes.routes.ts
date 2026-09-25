import { Router } from 'express';
import { requirePermission, validate } from '../middlewares';
import { Permission } from '../security';
import { adminNotesController as c } from '../controllers/adminNotes.controller';
import { listNotesSchema, createNoteSchema, deleteNoteSchema } from '../validators/internalNote.validator';

// /admin/notes. Hereda authenticate + authorize(ADMIN) de admin.routes.ts; el
// permiso por tipo de entidad lo comprueba el servicio.
const router = Router();

router.get('/', requirePermission(Permission.ADMIN_PANEL), validate(listNotesSchema), (req, res, next) => c.list(req, res, next));
router.post('/', requirePermission(Permission.ADMIN_PANEL), validate(createNoteSchema), (req, res, next) => c.create(req, res, next));
router.delete('/:id', requirePermission(Permission.ADMIN_PANEL), validate(deleteNoteSchema), (req, res, next) => c.remove(req, res, next));

export default router;
