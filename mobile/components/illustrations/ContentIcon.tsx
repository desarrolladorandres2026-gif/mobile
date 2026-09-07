import { contentIllustration, type ContentIllustrationName } from './contentIllustrations';

interface ContentIconProps {
  /** Nombre semántico de contenido — ver `ContentIllustrationRegistry`. */
  name: ContentIllustrationName;
  size?: number;
}

/**
 * Reemplazo de `<Icon name=... />` para conceptos de contenido: en vez de un
 * glifo lucide monocromo, renderiza la mini-ilustración dorada correspondiente
 * (mismo set visual que `CategoryTile`). Úsalo en categorías, servicios,
 * promociones, cupones, puntos, módulos principales y elementos destacados.
 */
export function ContentIcon({ name, size = 32 }: ContentIconProps) {
  const Illustration = contentIllustration(name);
  return <Illustration size={size} />;
}
