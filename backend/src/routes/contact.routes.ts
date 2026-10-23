import { Router } from 'express';
import { validate, contactCreateRateLimiter } from '../middlewares';
import { publicFormsController as c } from '../controllers/publicForms.controller';
import { createContactSchema } from '../validators/publicForms.validator';

// POST /contact — formulario público, sin sesión. La bandeja del equipo vive en /admin/contact-requests.
const router = Router();

router.post('/', contactCreateRateLimiter, validate(createContactSchema), (req, res, next) => c.createContact(req, res, next));

export default router;
