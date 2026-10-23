import { Router } from 'express';
import { validate, partnerOtpIpRateLimiter, partnerOtpPhoneRateLimiter, partnerApplyRateLimiter } from '../middlewares';
import { publicFormsController as c } from '../controllers/publicForms.controller';
import { partnerSendOtpSchema, partnerApplySchema } from '../validators/publicForms.validator';

// /partners — solicitudes públicas de comercios y repartidores, sin sesión. La bandeja vive en /admin/partner-applications.
const router = Router();

router.post('/send-otp', partnerOtpIpRateLimiter, validate(partnerSendOtpSchema), partnerOtpPhoneRateLimiter, (req, res, next) => c.partnerSendOtp(req, res, next));
router.post('/applications', partnerApplyRateLimiter, validate(partnerApplySchema), (req, res, next) => c.partnerApply(req, res, next));

export default router;
