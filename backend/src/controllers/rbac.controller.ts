import { Request, Response, NextFunction } from 'express';
import { positionService } from '../services/position.service';
import { roleService } from '../services/role.service';
import { sendResponse, param, query } from '../utils';
import { Permission } from '../security';

/**
 * Catálogo de permisos agrupado por módulo, derivado del enum `Permission`
 * (fuente única de verdad — ver rbac.ts). Sirve para pintar la matriz de
 * permisos en el panel sin mantener una segunda lista a mano.
 */
function permissionCatalog() {
  const groups: Record<string, string[]> = {};
  for (const value of Object.values(Permission)) {
    const [moduleName, action] = value.split(':');
    if (!groups[moduleName]) groups[moduleName] = [];
    groups[moduleName].push(action);
  }
  return Object.entries(groups).map(([moduleName, actions]) => ({ module: moduleName, actions }));
}

export class RbacController {
  // ── Permisos (catálogo, solo lectura) ──
  async getPermissions(_req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Catálogo de permisos', permissionCatalog());
    } catch (error) { next(error); }
  }

  // ── Cargos ──
  async listPositions(req: Request, res: Response, next: NextFunction) {
    try {
      const isActiveParam = query(req, 'isActive');
      const result = await positionService.list({
        search: query(req, 'search'),
        isActive: isActiveParam === undefined ? undefined : isActiveParam === 'true',
        page: Number(query(req, 'page')) || 1,
        limit: Number(query(req, 'limit')) || 50,
      });
      sendResponse(res, 200, 'Cargos obtenidos', result.positions, result.meta);
    } catch (error) { next(error); }
  }

  async getPosition(req: Request, res: Response, next: NextFunction) {
    try {
      const position = await positionService.getById(param(req, 'id'));
      sendResponse(res, 200, 'Cargo obtenido', position);
    } catch (error) { next(error); }
  }

  async createPosition(req: Request, res: Response, next: NextFunction) {
    try {
      const position = await positionService.create(req.body, req.user!, req);
      sendResponse(res, 201, 'Cargo creado', position);
    } catch (error) { next(error); }
  }

  async updatePosition(req: Request, res: Response, next: NextFunction) {
    try {
      const position = await positionService.update(param(req, 'id'), req.body, req.user!, req);
      sendResponse(res, 200, 'Cargo actualizado', position);
    } catch (error) { next(error); }
  }

  async deletePosition(req: Request, res: Response, next: NextFunction) {
    try {
      await positionService.delete(param(req, 'id'), req);
      sendResponse(res, 200, 'Cargo eliminado');
    } catch (error) { next(error); }
  }

  async getPositionUsers(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await positionService.getUsersInPosition(
        param(req, 'id'), Number(query(req, 'page')) || 1, Number(query(req, 'limit')) || 20
      );
      sendResponse(res, 200, 'Usuarios del cargo', result.users, result.meta);
    } catch (error) { next(error); }
  }

  // ── Roles ──
  async listRoles(req: Request, res: Response, next: NextFunction) {
    try {
      const isActiveParam = query(req, 'isActive');
      const result = await roleService.list({
        search: query(req, 'search'),
        isActive: isActiveParam === undefined ? undefined : isActiveParam === 'true',
        page: Number(query(req, 'page')) || 1,
        limit: Number(query(req, 'limit')) || 50,
      });
      sendResponse(res, 200, 'Roles obtenidos', result.roles, result.meta);
    } catch (error) { next(error); }
  }

  async getRole(req: Request, res: Response, next: NextFunction) {
    try {
      const role = await roleService.getById(param(req, 'id'));
      sendResponse(res, 200, 'Rol obtenido', role);
    } catch (error) { next(error); }
  }

  async createRole(req: Request, res: Response, next: NextFunction) {
    try {
      const role = await roleService.create(req.body, req.user!, req.permissions || [], req);
      sendResponse(res, 201, 'Rol creado', role);
    } catch (error) { next(error); }
  }

  async updateRole(req: Request, res: Response, next: NextFunction) {
    try {
      const role = await roleService.update(param(req, 'id'), req.body, req.user!, req.permissions || [], req);
      sendResponse(res, 200, 'Rol actualizado', role);
    } catch (error) { next(error); }
  }

  async deleteRole(req: Request, res: Response, next: NextFunction) {
    try {
      await roleService.delete(param(req, 'id'), req.user!, req);
      sendResponse(res, 200, 'Rol eliminado');
    } catch (error) { next(error); }
  }

  async getRoleUsers(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await roleService.getUsersWithRole(
        param(req, 'id'), Number(query(req, 'page')) || 1, Number(query(req, 'limit')) || 20
      );
      sendResponse(res, 200, 'Usuarios del rol', result.users, result.meta);
    } catch (error) { next(error); }
  }
}

export const rbacController = new RbacController();
