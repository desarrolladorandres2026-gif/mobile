/**
 * Los colores con los que un comercio puede vestir su encabezado.
 *
 * Copia deliberada de `backend/src/utils/businessBrand.ts`: el panel y el
 * servidor son dos paquetes sin código compartido, y un import cruzado
 * arrastraría medio backend al bundle del navegador. El servidor valida
 * contra su propia lista, así que si estas dos se desincronizan el panel
 * recibe un 400 y nadie guarda un color inválido — lo peor que puede pasar
 * es que aquí falte un tono, no que entre uno ilegible.
 */
export const BRAND_COLORS = [
  { value: '#141B2A', label: 'Obsidiana' },
  { value: '#8A5D08', label: 'Dorado titanio' },
  { value: '#7A1F35', label: 'Vino' },
  { value: '#14532D', label: 'Bosque' },
  { value: '#123A5E', label: 'Marino' },
  { value: '#8C3B1E', label: 'Terracota' },
  { value: '#4C2A57', label: 'Berenjena' },
  { value: '#3F3F46', label: 'Carbón' },
] as const;
