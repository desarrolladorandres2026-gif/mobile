import { TEMPLATES, type PromotionTemplate } from '../../lib/promotionTemplates';
import { Choice, StepHeading, TemplateLogo } from './ui';

/** Paso 1: elegir una idea. Cada tarjeta rellena el formulario y salta al paso siguiente. */
export default function TemplateStep({ onPick }: { onPick: (template: PromotionTemplate) => void }) {
  return (
    <div className="space-y-5">
      <StepHeading
        title="¿Qué quieres lograr?"
        hint="Elige una idea de partida. Después ajustas lo que quieras: nada queda fijo."
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {TEMPLATES.map((template) => (
          <Choice key={template.id} selected={false} onClick={() => onPick(template)}>
            <TemplateLogo name={template.logo} size={48} />
            <span className="text-sm font-semibold">{template.title}</span>
            <span className="text-xs text-[var(--color-text-secondary)]">{template.blurb}</span>
          </Choice>
        ))}
      </div>
    </div>
  );
}
