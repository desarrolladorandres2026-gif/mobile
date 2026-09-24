import { Router } from 'express';

// Dueño: B1 (Fase 2 del panel admin). Rutas relativas a /admin/notes (GET /, POST /, DELETE /:id).
// Se monta con router.use() dentro de admin.routes.ts, así que hereda
// authenticate + authorize(ADMIN); cada handler añade su requirePermission.
const router = Router();

export default router;
