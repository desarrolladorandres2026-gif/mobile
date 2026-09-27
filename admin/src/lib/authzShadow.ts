import { moduleLabel, actionLabel } from './permissions';

export interface ShadowRow {
 userId: string;
 userName: string;
 email?: string;
 roleSlugs: string[];
 permission: string;
 route: string;
 method: string;
 count: number;
 firstSeen: string;
 lastSeen: string;
}

export function permissionLabel(perm: string): string {
 const [mod, act] = perm.split(':');
 return `${moduleLabel(mod)} · ${actionLabel(act ?? '')}`;
}

/** Agrupa las filas del reporte por persona. Lo usa también Users.tsx. */
export function groupShadowByUser(rows: ShadowRow[]) {
 const map = new Map<string, { userId: string; userName: string; email?: string; roleSlugs: string[]; rows: ShadowRow[] }>();
 for (const r of rows) {
 const g = map.get(r.userId) ?? { userId: r.userId, userName: r.userName, email: r.email, roleSlugs: r.roleSlugs, rows: [] };
 g.rows.push(r);
 map.set(r.userId, g);
 }
 return Array.from(map.values());
}

