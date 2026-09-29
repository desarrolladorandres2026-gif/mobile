import { Router } from 'express';
import { z } from 'zod';
import { adminController } from '../controllers/admin.controller';
import { authenticate, authorize, requirePermission, requireAnyPermission, validate, twoFactorResetRateLimiter } from '../middlewares';
import { UserRole } from '../types';
import { Permission } from '../security';
import { driverIdParamSchema } from '../validators/driver.validator';
import adminNotesRouter from './adminNotes.routes';
import adminAlertsRouter from './adminAlerts.routes';
import adminSearchRouter from './adminSearch.routes';
import adminOrdersRouter from './adminOrders.routes';
import adminBusinessesRouter from './adminBusinesses.routes';
import adminGrowthRouter from './adminGrowth.routes';

const router = Router();

// All admin routes require admin role
router.use(authenticate, authorize(UserRole.ADMIN));

// Dashboard & Financials
router.get('/dashboard', requirePermission(Permission.ORDERS_VIEW_ALL), (req, res, next) => adminController.getDashboard(req, res, next));
router.get('/financials', requirePermission(Permission.FINANCE_VIEW), (req, res, next) => adminController.getFinancials(req, res, next));
router.get('/revenue-chart', requirePermission(Permission.FINANCE_VIEW), (req, res, next) => adminController.getRevenueChart(req, res, next));
router.get('/daily-summary', requirePermission(Permission.REPORTS_VIEW), (req, res, next) => adminController.getDailySummary(req, res, next));
router.get('/daily-summary/zones', requirePermission(Permission.REPORTS_VIEW), (req, res, next) => adminController.getDailySummaryByZone(req, res, next));
router.get('/daily-summary/finance-detail', requirePermission(Permission.FINANCE_VIEW), (req, res, next) => adminController.getDailySummaryFinanceDetail(req, res, next));
// Salud de la app: crashes agrupados de los teléfonos (`ClientError`).
router.get('/health/crashes', requirePermission(Permission.REPORTS_VIEW), (req, res, next) => adminController.getCrashes(req, res, next));
// Marcar o reabrir un error. Es una decisión técnica ("ya está arreglado"),
// por eso pide `settings:update` y no el permiso de solo ver reportes.
const crashMessageSchema = z.object({
  body: z.object({
    message: z.string().min(1).max(500),
    note: z.string().trim().max(300).optional(),
  }).strict(),
});
router.post('/health/crashes/resolve', requirePermission(Permission.SETTINGS_UPDATE), validate(crashMessageSchema), (req, res, next) => adminController.resolveCrash(req, res, next));
router.post('/health/crashes/reopen', requirePermission(Permission.SETTINGS_UPDATE), validate(crashMessageSchema), (req, res, next) => adminController.reopenCrash(req, res, next));

// Envíos dirigidos, referidos y Zipp Pro viven en `adminGrowth.routes.ts` (/growth).

// ── Interruptores de funcionalidad ──
// Separan publicar código de encender comportamiento. Ver
// `featureFlag.service.ts` para por qué existen.
router.get('/feature-flags', requirePermission(Permission.SETTINGS_VIEW), (req, res, next) => adminController.listFeatureFlags(req, res, next));
// Sin esto, `findOneAndUpdate` no corre los validadores del esquema y una
// audiencia inventada quedaba guardada como estaba escrita.
const flagKeySchema = z.string().regex(/^[a-z][a-z0-9._-]{1,59}$/, 'La clave usa minúsculas, números, punto, guion y guion bajo');
const saveFlagSchema = z.object({
  params: z.object({ key: flagKeySchema }),
  body: z.object({
    description: z.string().trim().min(1).max(300).optional(),
    audience: z.enum(['off', 'all', 'staff', 'percentage']).optional(),
    percentage: z.number().int().min(0).max(100).optional(),
  }).strict(),
});
const deleteFlagSchema = z.object({ params: z.object({ key: flagKeySchema }) });
router.put('/feature-flags/:key', requirePermission(Permission.SETTINGS_UPDATE), validate(saveFlagSchema), (req, res, next) => adminController.saveFeatureFlag(req, res, next));
router.delete('/feature-flags/:key', requirePermission(Permission.SETTINGS_UPDATE), validate(deleteFlagSchema), (req, res, next) => adminController.deleteFeatureFlag(req, res, next));

// ── Informes descargables ──
// El permiso existía en el RBAC sin nada que lo usara; estos son sus dos
// primeros consumidores.
// M2: POST con cuerpo, no GET con query string — `reason` y el código TOTP
// viajaban en la URL (morgan, el log de Nginx, `AuditLog.path`). No hay
// pantalla que consuma esto todavía, así que las rutas GET se retiran en
// vez de mantenerlas en paralelo.
router.post('/exports/orders', requirePermission(Permission.REPORTS_EXPORT), (req, res, next) => adminController.exportOrders(req, res, next));
router.post('/exports/users', requirePermission(Permission.REPORTS_EXPORT), (req, res, next) => adminController.exportUsers(req, res, next));

// ── Recorte de fondo de fotos de producto ──
// Sin pantalla todavía: se consulta para cuadrar la factura del proveedor.
router.get('/image-processing/stats', requirePermission(Permission.REPORTS_VIEW), (req, res, next) => adminController.imageProcessingStats(req, res, next));

// Users management
router.get('/users', requirePermission(Permission.USERS_VIEW), (req, res, next) => adminController.getUsers(req, res, next));
router.post('/users', requirePermission(Permission.USERS_CREATE), (req, res, next) => adminController.createStaffUser(req, res, next));
router.patch('/users/:id/toggle', requirePermission(Permission.USERS_UPDATE), (req, res, next) => adminController.toggleUser(req, res, next));
router.patch('/users/:id/role', requirePermission(Permission.USERS_ROLE_CHANGE), (req, res, next) => adminController.updateUserRole(req, res, next));
router.patch('/users/:id/contact', requirePermission(Permission.USERS_UPDATE), (req, res, next) => adminController.overrideUserContact(req, res, next));
// La fecha de nacimiento el cliente la guarda una sola vez; esta es la vía de soporte.
router.patch('/users/:id/birth-date', requirePermission(Permission.USERS_UPDATE), (req, res, next) => adminController.correctBirthDate(req, res, next));

// ── Seguridad y Acceso: Cargo, Roles, estado, credenciales ──
router.patch('/users/:id/position', requirePermission(Permission.USERS_UPDATE), (req, res, next) => adminController.assignPosition(req, res, next));
router.patch('/users/:id/roles', requirePermission(Permission.USERS_ROLE_CHANGE), (req, res, next) => adminController.assignRoles(req, res, next));
router.get('/users/:id/profile-360', requirePermission(Permission.USERS_VIEW), (req, res, next) => adminController.userProfile360(req, res, next));
router.get('/users/:id/access', requirePermission(Permission.USERS_VIEW), (req, res, next) => adminController.getEffectiveAccess(req, res, next));
router.patch('/users/:id/status', requireAnyPermission(Permission.USERS_UPDATE, Permission.USERS_BLOCK), (req, res, next) => adminController.setUserStatus(req, res, next));
router.post('/users/:id/reset-password', requirePermission(Permission.USERS_UPDATE), (req, res, next) => adminController.resetUserPassword(req, res, next));
router.post('/users/:id/reset-2fa', requirePermission(Permission.USERS_RESET_2FA), twoFactorResetRateLimiter, (req, res, next) => adminController.resetUserTwoFactor(req, res, next));

// Business management
//
// Sin `requirePermission` a propósito, igual que antes de este cambio: el
// permiso por módulo (S4, anexo A de docs/PANEL-ADMIN.md) es Fase 1 —
// rediseño completo de RBAC restrictivo, con migración de cargos. Meterlo
// aquí a medias dejaría a un ADMIN legacy (el que hoy administra todo el
// panel) bloqueado de una función que siempre tuvo, sin haber hecho esa
// migración. Fase 0 corrige el CONTENIDO de estas acciones (S11: archivar,
// no borrar; motivo obligatorio; auditoría), no quién puede llamarlas.
router.get('/businesses', requirePermission(Permission.BUSINESSES_VIEW), (req, res, next) => adminController.getBusinesses(req, res, next));
router.patch('/businesses/:id/toggle', requirePermission(Permission.BUSINESSES_UPDATE_ALL), (req, res, next) => adminController.toggleBusiness(req, res, next));
router.patch('/businesses/:id/featured', requirePermission(Permission.BUSINESSES_UPDATE_ALL), (req, res, next) => adminController.toggleBusinessFeatured(req, res, next));
// S11: ya no es borrado duro. `DELETE` sigue existiendo por compatibilidad
// con clientes ya desplegados, pero hace exactamente lo mismo que
// `PATCH .../archive`: archivar con motivo obligatorio, nunca `deleteOne`.
router.delete('/businesses/:id', requirePermission(Permission.BUSINESSES_UPDATE_ALL), (req, res, next) => adminController.archiveBusiness(req, res, next));
router.patch('/businesses/:id/archive', requirePermission(Permission.BUSINESSES_UPDATE_ALL), (req, res, next) => adminController.archiveBusiness(req, res, next));
router.patch('/businesses/:id/restore', requirePermission(Permission.BUSINESSES_UPDATE_ALL), (req, res, next) => adminController.restoreBusiness(req, res, next));
// Ficha del comercio y sus acciones (Fase 2). Después de las rutas /businesses/:id de arriba a propósito.
router.use('/businesses/:id', adminBusinessesRouter);

// Orders management
router.get('/orders', requirePermission(Permission.ORDERS_VIEW_ALL), (req, res, next) => adminController.getAllOrders(req, res, next));

// Trazabilidad de la entrega: evidencias y expediente de seguridad
router.get('/evidences', requirePermission(Permission.EVIDENCES_VIEW), (req, res, next) => adminController.getEvidences(req, res, next));
router.get('/orders/:id/security', requirePermission(Permission.EVIDENCES_VIEW), (req, res, next) => adminController.getOrderSecurity(req, res, next));

// Ficha del pedido y sus acciones (Fase 2). Después de las rutas /orders de arriba a propósito.
router.use('/orders/:id', adminOrdersRouter);

// Financial
router.get('/commissions', requirePermission(Permission.COMMISSIONS_VIEW), (req, res, next) => adminController.getCommissions(req, res, next));

// Driver management
router.get('/drivers/:id/profile-360', requirePermission(Permission.DRIVERS_VIEW), validate(driverIdParamSchema), (req, res, next) => adminController.driverProfile360(req, res, next));
router.patch('/drivers/:id/suspend', requirePermission(Permission.DRIVERS_SUSPEND), validate(driverIdParamSchema), (req, res, next) => adminController.suspendDriver(req, res, next));
router.patch('/drivers/:id/reactivate', requirePermission(Permission.DRIVERS_SUSPEND), validate(driverIdParamSchema), (req, res, next) => adminController.reactivateDriver(req, res, next));

// ── Capa común de las fichas (Fase 2): notas, bandeja de alertas, búsqueda global ──
router.use('/notes', adminNotesRouter);
router.use('/alerts', adminAlertsRouter);
router.use('/search', adminSearchRouter);
router.use('/growth', adminGrowthRouter);

export default router;
