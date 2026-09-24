import { Router } from 'express';

// Dueño: B5 (Fase 2 del panel admin). Rutas relativas a /admin/businesses/:id (GET /profile-360, PATCH /suspension, POST /request-documents); el id llega en req.params.id.
// Se monta con router.use() dentro de admin.routes.ts, así que hereda
// authenticate + authorize(ADMIN); cada handler añade su requirePermission.
const router = Router({ mergeParams: true });

export default router;
