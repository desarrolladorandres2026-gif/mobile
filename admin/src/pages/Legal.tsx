import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import LegalOps from './LegalOps';

const LegalDocuments = lazy(() => import('./LegalDocuments'));

/**
 * Un solo item de la barra lateral para lo legal: las solicitudes de datos
 * personales y los documentos versionados comparten permiso (LEGAL_VIEW) y
 * comparten sujeto, así que viven bajo `/legal` con pestañas. La pestaña activa
 * va en `?tab=` para que un enlace directo (alertas, incidencias) caiga bien.
 */
const TABS = [
  { id: 'datos', label: 'Datos personales' },
  { id: 'documentos', label: 'Documentos legales' },
] as const;

export default function Legal() {
  const [params, setParams] = useSearchParams();
  const active = params.get('tab') === 'documentos' ? 'documentos' : 'datos';

  return (
    <div className="space-y-4">
      <div className="flex overflow-x-auto gap-1 border-b border-[var(--color-border-light)]">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setParams(t.id === 'datos' ? {} : { tab: t.id }, { replace: true })}
            className={`px-3.5 py-1.5 text-xs font-bold uppercase tracking-wider transition-all cursor-pointer whitespace-nowrap border-b-2 ${
              active === t.id
                ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                : 'border-transparent text-[var(--color-text-main)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {active === 'datos' ? (
        <LegalOps />
      ) : (
        <Suspense fallback={null}>
          <LegalDocuments />
        </Suspense>
      )}
    </div>
  );
}
