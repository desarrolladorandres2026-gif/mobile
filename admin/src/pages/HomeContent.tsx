import { useSearchParams } from 'react-router-dom';
import { Permission } from '../lib/permissions';
import { useAuthStore } from '../stores/authStore';
import CuratedHomeBlocks from './CuratedHomeBlocks';
import HomeCategories from './HomeCategories';
import ExploreBuilder from './ExploreBuilder';

type TabId = 'blocks' | 'categories' | 'explore';

const TABS: { id: TabId; label: string; permission: string }[] = [
 { id: 'blocks', label: 'Bloques curados', permission: Permission.CONTENT_VIEW },
 { id: 'categories', label: 'Categorías de inicio', permission: Permission.CONTENT_VIEW },
 { id: 'explore', label: 'Constructor de Explorar', permission: Permission.EXPLORE_VIEW },
];

/**
 * Un solo ítem del menú para lo que se ve en Inicio y Explorar. Cada pestaña
 * conserva su propio permiso: el ítem exige `content:view`, y la de Explorar
 * además pide `explore:view`. La pestaña vive en `?tab=` para poder enlazarla.
 */
export default function HomeContent() {
 const hasPermission = useAuthStore((s) => s.hasPermission);
 useAuthStore((s) => s.permissions);
 const [params, setParams] = useSearchParams();

 const visible = TABS.filter((t) => hasPermission(t.permission));
 const requested = params.get('tab');
 const active = visible.find((t) => t.id === requested) ?? visible[0];

 return (
 <div className="space-y-3 animate-fade-in">
 <div className="flex gap-1.5">
 {visible.map((t) => (
 <button
 key={t.id}
 onClick={() => setParams({ tab: t.id }, { replace: true })}
 className={`px-4 py-2 text-xs font-bold whitespace-nowrap transition-all cursor-pointer border-b-2 ${active?.id === t.id
 ? 'border-[var(--color-primary)] text-[var(--color-text-main)]'
 : 'border-transparent text-[var(--color-text-main)]'
 }`}
 >
 {t.label}
 </button>
 ))}
 </div>

 {active?.id === 'blocks' && <CuratedHomeBlocks />}
 {active?.id === 'categories' && <HomeCategories />}
 {active?.id === 'explore' && <ExploreBuilder />}
 </div>
 );
}
