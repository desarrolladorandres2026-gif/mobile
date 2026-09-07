import { useState, useRef, useEffect } from 'react';
import { Sun, Moon, Laptop, Check } from 'lucide-react';
import { useThemeStore, type Theme } from '../stores/themeStore';

export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useThemeStore();
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const options: { value: Theme; label: string; icon: typeof Sun; description: string }[] = [
    { value: 'light', label: 'Modo Claro', icon: Sun, description: 'Luminoso para el día' },
    { value: 'dark', label: 'Modo Oscuro', icon: Moon, description: 'Descanso visual y contraste' },
    { value: 'auto', label: 'Automático', icon: Laptop, description: 'Sigue la preferencia del sistema' },
  ];

  const CurrentIcon = theme === 'auto' ? Laptop : resolvedTheme === 'dark' ? Moon : Sun;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        title={`Tema: ${theme === 'auto' ? 'Automático' : theme === 'dark' ? 'Oscuro' : 'Claro'}`}
        className="p-2 rounded-xl text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800/80 transition-all cursor-pointer flex items-center justify-center border border-transparent hover:border-slate-200 dark:hover:border-slate-700/60"
        aria-label="Cambiar tema"
      >
        <CurrentIcon className="w-4 h-4 transition-transform hover:scale-110" />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-56 rounded-2xl bg-[var(--color-surface)] dark:bg-[#1B2437] p-1.5 shadow-xl border border-slate-200 dark:border-slate-800 z-50 animate-fade-in">
          <div className="px-3 py-1.5 border-b border-slate-100 dark:border-slate-800/80 mb-1">
            <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
              Apariencia del Sistema
            </span>
          </div>

          <div className="space-y-0.5">
            {options.map((opt) => {
              const Icon = opt.icon;
              const isSelected = theme === opt.value;

              return (
                <button
                  key={opt.value}
                  onClick={() => {
                    setTheme(opt.value);
                    setOpen(false);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-all text-left cursor-pointer ${
                    isSelected
                      ? 'bg-[var(--color-primary)]/10 dark:bg-[#D69E26]/20 text-[var(--color-primary)] font-bold'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`w-6 h-6 rounded-lg flex items-center justify-center ${
                        isSelected
                          ? 'bg-[var(--color-primary)] text-white'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                    </div>
                    <div>
                      <p className="leading-none text-xs">{opt.label}</p>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5 font-normal">
                        {opt.description}
                      </p>
                    </div>
                  </div>

                  {isSelected && <Check className="w-3.5 h-3.5 text-[var(--color-primary)]" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

