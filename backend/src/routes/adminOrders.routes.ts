import { Router } from 'express';

// Dueño: B4 (Fase 2 del panel admin). Rutas relativas a /admin/orders/:id (GET /profile-360, POST /unassign-driver, POST /notify); el id llega en req.params.id.
// Se monta con router.use() dentro de admin.routes.ts, así que hereda
// authenticate + authorize(ADMIN); cada handler añade su requirePermission.
const router = Router({ mergeParams: true });

export default router;
