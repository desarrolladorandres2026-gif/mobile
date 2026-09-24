import { Request, Response, NextFunction } from 'express';
import { exploreLayoutService } from '../services/exploreLayout.service';
import { advertisementService } from '../services/advertisement.service';
import { AdPlacement } from '../models';
import { sendResponse } from '../utils';
import { AuditAction, AuditSeverity, logAudit } from '../security';
import { publishProblems } from '../validators/exploreLayout.validator';

/**
 * El constructor de Explorar, del lado del panel.
 *
 * Todo pasa por `validators/exploreLayout.validator.ts` antes de llegar
 * aquí: lo que el panel manda nunca se guarda sin validar, venga del
 * formulario o de una petición hecha a mano.
 */
export class ExploreLayoutController {
  async getDraft(_req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Borrador de Explorar', await exploreLayoutService.getDraft());
    } catch (error) { next(error); }
  }

  async saveDraft(req: Request, res: Response, next: NextFunction) {
    try {
      const { sections, revision } = req.body;
      const result = await exploreLayoutService.saveDraft(sections, revision, req.user!._id.toString());
      void logAudit(req, {
        action: AuditAction.EXPLORE_LAYOUT_SAVED,
        entity: 'explore_layout',
        severity: AuditSeverity.LOW,
        description: 'Borrador de Explorar guardado',
        metadata: { revision: result.revision, sections: sections.length },
      });
      sendResponse(res, 200, 'Borrador guardado', result);
    } catch (error) { next(error); }
  }

  /**
   * Resuelve un borrador sin guardarlo ni publicarlo, para la vista previa.
   *
   * No toca la caché y no registra impresiones: la campaña se incluye solo
   * para que se vea dónde cae (leerla no cuenta nada). Los avisos de
   * publicación viajan con los de la resolución para que el panel los
   * enseñe antes de que alguien intente publicar.
   */
  async preview(req: Request, res: Response, next: NextFunction) {
    try {
      const { sections, lat, lng } = req.body;
      const [resolved, ad] = await Promise.all([
        exploreLayoutService.resolveLayout(sections, { lat, lng }),
        advertisementService.getActiveForApp({}, AdPlacement.EXPLORE),
      ]);
      sendResponse(res, 200, 'Vista previa de Explorar', {
        sections: exploreLayoutService.withAd(resolved.sections, ad),
        warnings: resolved.warnings,
        blockers: publishProblems(sections),
      });
    } catch (error) { next(error); }
  }

  async publish(req: Request, res: Response, next: NextFunction) {
    try {
      const { revision, note } = req.body;
      const result = await exploreLayoutService.publish(revision, req.user!._id.toString(), note);
      void logAudit(req, {
        action: AuditAction.EXPLORE_LAYOUT_PUBLISHED,
        entity: 'explore_layout',
        entityId: String(result.version),
        severity: AuditSeverity.MEDIUM,
        description: `Explorar publicado: versión ${result.version}`,
        metadata: { version: result.version, note },
      });
      sendResponse(res, 200, 'Explorar publicado', result);
    } catch (error) { next(error); }
  }

  async listVersions(_req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Versiones de Explorar', await exploreLayoutService.listVersions());
    } catch (error) { next(error); }
  }

  async restore(req: Request, res: Response, next: NextFunction) {
    try {
      const version = Number(req.params.version);
      const { revision, mode } = req.body;
      const result = await exploreLayoutService.restoreVersion(version, revision, mode, req.user!._id.toString());
      void logAudit(req, {
        action: AuditAction.EXPLORE_LAYOUT_RESTORED,
        entity: 'explore_layout',
        entityId: String(version),
        severity: AuditSeverity.MEDIUM,
        description: mode === 'publish'
          ? `Versión ${version} de Explorar republicada como ${result.publishedVersion}`
          : `Versión ${version} de Explorar copiada al borrador`,
        metadata: { version, mode, publishedVersion: result.publishedVersion },
      });
      sendResponse(res, 200, 'Versión restaurada', result);
    } catch (error) { next(error); }
  }

  async options(_req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Opciones del constructor', await exploreLayoutService.getBuilderOptions());
    } catch (error) { next(error); }
  }
}

export const exploreLayoutController = new ExploreLayoutController();
