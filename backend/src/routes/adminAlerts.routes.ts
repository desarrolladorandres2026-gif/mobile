import { Router } from 'express';

// Dueño: B2 (Fase 2 del panel admin). Rutas relativas a /admin/alerts (GET /, POST /seen).
// Se monta con router.use() dentro de admin.routes.ts, así que hereda
// authenticate + authorize(ADMIN); cada handler añade su requirePermission.
const router = Router();

export default router;
