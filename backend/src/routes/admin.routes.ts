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

// Users management
router.get('/users', requirePermission(Permission.USERS_VIEW), (req, res, next) => adminController.getUsers(req, res, next));
router.post('/users', requirePermission(Permission.USERS_CREATE), (req, res, next) => adminController.createStaffUser(req, res, next));
router.patch('/users/:id/toggle', requirePermission(Permission.USERS_UPDATE), (req, res, next) => adminController.toggleUser(req, res, next));
router.patch('/users/:id/role', requirePermission(Permission.USERS_ROLE_CHANGE), (req, res, next) => adminController.updateUserRole(req, res, next));
router.patch('/users/:id/contact', requirePermission(Permission.USERS_UPDATE), (req, res, next) => adminController.overrideUserContact(req, res, next));

// ── Seguridad y Acceso: Cargo, Roles, estado, credenciales ──
router.patch('/users/:id/position', requirePermission(Permission.USERS_UPDATE), (req, res, next) => adminController.assignPosition(req, res, next));
router.patch('/users/:id/roles', requirePermission(Permission.USERS_ROLE_CHANGE), (req, res, next) => adminController.assignRoles(req, res, next));
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
