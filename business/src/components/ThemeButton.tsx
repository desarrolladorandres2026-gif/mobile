import { Laptop, Moon, Sun } from 'lucide-react';
import { useThemeStore, type Theme } from '../stores/themeStore';

const LABELS: Record<Theme, string> = { light: 'Claro', dark: 'Oscuro', auto: 'Automático' };

/**
 * Cambia el tema con un toque: claro, oscuro, automático. Media celda del pie
 * de la barra, así que es solo el icono; el modo actual va en el tooltip.
 */
export default function ThemeButton() {
  const theme = useThemeStore((s) => s.theme);
  const resolved = useThemeStore((s) => s.resolvedTheme);
  const cycle = useThemeStore((s) => s.cycleTheme);
  const Icon = theme === 'auto' ? Laptop : resolved === 'dark' ? Moon : Sun;

  return (
    <button
      type="button"
      onClick={cycle}
      title={`Tema: ${LABELS[theme]}. Pulsa para cambiar.`}
      aria-label={`Tema: ${LABELS[theme]}. Pulsa para cambiar.`}
      className="grid h-14 flex-1 place-items-center rounded-xl text-white hover:bg-white/10 cursor-pointer"
    >
      <Icon className="w-5 h-5" strokeWidth={1.8} />
    </button>
  );
}
