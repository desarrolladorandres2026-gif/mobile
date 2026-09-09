/** Contrato común de toda ilustración de categoría. */
export interface IllustrationProps {
  /**
   * Lado del cuadro (viewBox es siempre 64x64, esto solo escala el render).
   * Acepta `"100%"` para que la ilustración llene su contenedor en vez de
   * quedar centrada con margen —lo usa el grid de Categorías de Home.
   */
  size?: number | string;
  /**
   * Fondo a sangre: pinta el degradado sobre todo el `viewBox` (rectángulo)
   * en vez del blob circular. Para contenedores que recortan con
   * `overflow: hidden` y quieren el cuadro relleno de borde a borde, sin
   * esquinas de otro color. Por defecto `false` (blob circular con aire).
   */
  bleed?: boolean;
}
