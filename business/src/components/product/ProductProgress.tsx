import type { ProductProgress as Progress } from '../../lib/productForm';

/**
 * "Paso 1 de 3": cuánto le falta al producto.
 *
 * Indicador y no asistente: los tres tramos se llenan solos según lo que
 * ya está escrito, y el formulario entero sigue a la vista. Tres líneas
 * finas y una frase; nada que parezca un botón, porque no lo es.
 */
export default function ProductProgress({ progress, editing }: { progress: Progress; editing: boolean }) {
  const labels = [
    'Foto y datos principales',
    'Precio y disponibilidad',
    editing ? 'Revisa y guarda los cambios' : 'Revisa y crea el producto',
  ];

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5" aria-hidden>
        {progress.steps.map((done, index) => (
          <span
            key={labels[index]}
            className={`h-1 flex-1 rounded-full transition-colors ${
              done ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-border)]'
            }`}
          />
        ))}
      </div>
      <p className="text-xs text-[var(--color-text-secondary)]" aria-live="polite">
        Paso {progress.current} de 3:{' '}
        <span className="font-semibold text-[var(--color-text-main)]">{labels[progress.current - 1]}</span>
      </p>
    </div>
  );
}
