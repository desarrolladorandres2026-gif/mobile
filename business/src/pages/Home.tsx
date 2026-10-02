import { RefreshCw } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { usePermissions } from '../hooks/usePermissions';
import DailySummary from './DailySummary';
import RoleSummary from './RoleSummary';

/**
 * La portada ("/") según quién entra: el propietario ve el cierre del día
 * con neto y comisiones; el resto, el resumen que le toca a su papel. Se
 * espera a conocer los permisos para no pedir el cierre financiero en
 * nombre de alguien que lo tiene prohibido.
 */
export default function Home() {
  const businessId = useAuthStore((s) => s.selectedBusiness?._id);
  const { access, settled } = usePermissions(businessId);

  if (businessId && !settled) {
    return (
      <div className="flex items-center justify-center py-24">
        <RefreshCw className="w-6 h-6 text-[var(--color-primary)] animate-spin" />
      </div>
    );
  }
  return access?.permissions.includes('financial:view') || !businessId ? <DailySummary /> : <RoleSummary />;
}
