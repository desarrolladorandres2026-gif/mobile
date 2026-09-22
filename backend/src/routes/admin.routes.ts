import { Router } from 'express';
import { adminController } from '../controllers/admin.controller';
import { authenticate, authorize, requirePermission, requireAnyPermission } from '../middlewares';
import { UserRole } from '../types';
import { Permission } from '../security';

const router = Router();

// All admin routes require admin role
router.use(authenticate, authorize(UserRole.ADMIN));

// Dashboard & Financials
router.get('/dashboard', (req, res, next) => adminController.getDashboard(req, res, next));
router.get('/financials', (req, res, next) => adminController.getFinancials(req, res, next));
router.get('/revenue-chart', (req, res, next) => adminController.getRevenueChart(req, res, next));
router.get('/daily-summary', (req, res, next) => adminController.getDailySummary(req, res, next));

// ── Envíos dirigidos ──
// El preview va antes del envío a propósito: enseñar "esto llega a 240
// personas" es la diferencia entre una herramienta y una escopeta.
router.post('/campaigns/preview', (req, res, next) => adminController.previewCampaign(req, res, next));
router.post('/campaigns/send', (req, res, next) => adminController.sendCampaign(req, res, next));

// ── Interruptores de funcionalidad ──
// Separan publicar código de encender comportamiento. Ver
// `featureFlag.service.ts` para por qué existen.
router.get('/feature-flags', (req, res, next) => adminController.listFeatureFlags(req, res, next));
router.put('/feature-flags/:key', (req, res, next) => adminController.saveFeatureFlag(req, res, next));
router.delete('/feature-flags/:key', (req, res, next) => adminController.deleteFeatureFlag(req, res, next));

// ── Informes descargables ──
// El permiso existía en el RBAC sin nada que lo usara; estos son sus dos
// primeros consumidores.
router.get('/exports/orders', requirePermission(Permission.REPORTS_EXPORT), (req, res, next) => adminController.exportOrders(req, res, next));
router.get('/exports/users', requirePermission(Permission.REPORTS_EXPORT), (req, res, next) => adminController.exportUsers(req, res, next));

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

// Business management
router.get('/businesses', (req, res, next) => adminController.getBusinesses(req, res, next));
router.patch('/businesses/:id/toggle', (req, res, next) => adminController.toggleBusiness(req, res, next));
router.patch('/businesses/:id/featured', (req, res, next) => adminController.toggleBusinessFeatured(req, res, next));
router.delete('/businesses/:id', (req, res, next) => adminController.deleteBusiness(req, res, next));

// Orders management
router.get('/orders', (req, res, next) => adminController.getAllOrders(req, res, next));

// Trazabilidad de la entrega: evidencias y expediente de seguridad
router.get('/evidences', (req, res, next) => adminController.getEvidences(req, res, next));
router.get('/orders/:id/security', (req, res, next) => adminController.getOrderSecurity(req, res, next));

// Financial
router.get('/commissions', (req, res, next) => adminController.getCommissions(req, res, next));
router.get('/driver-debts', (req, res, next) => adminController.getDriverDebts(req, res, next));

// Driver management
router.patch('/drivers/:id/suspend', (req, res, next) => adminController.suspendDriver(req, res, next));
router.patch('/drivers/:id/reactivate', (req, res, next) => adminController.reactivateDriver(req, res, next));

export default router;
