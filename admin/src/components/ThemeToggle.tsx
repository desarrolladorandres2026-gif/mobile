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

 const options: { value: Theme; label: string; description: string }[] = [
 { value: 'light', label: 'Modo Claro', description: 'Luminoso para el día' },
 { value: 'dark', label: 'Modo Oscuro', description: 'Descanso visual y contraste' },
 { value: 'auto', label: 'Automático', description: 'Sigue la preferencia del sistema' },
 ];

 const CurrentIcon = theme === 'auto' ? Laptop : resolvedTheme === 'dark' ? Moon : Sun;

 return (
 <div className="relative" ref={dropdownRef}>
 <button
 onClick={() => setOpen(!open)}
 title={`Tema: ${theme === 'auto' ? 'Automático' : theme === 'dark' ? 'Oscuro' : 'Claro'}`}
 className="p-2 rounded-full text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] transition-all cursor-pointer flex items-center justify-center border border-transparent"
 aria-label="Cambiar tema"
 >
 <CurrentIcon className="w-4 h-4 transition-transform hover:scale-110" />
 </button>

 {open && (
 <div className="absolute right-0 mt-2 w-56 bg-[var(--color-surface)] p-1.5 z-50 animate-fade-in">
 <div className="px-3 py-1.5 border-b border-[var(--color-border)] mb-1">
 <span className="text-[10px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">
 Apariencia del Sistema
 </span>
 </div>

 <div className="space-y-0.5">
 {options.map((opt) => {
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
 ? 'text-[var(--color-primary)] font-bold'
 : 'text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)]'
 }`}
 >
 <div className="flex items-center gap-2.5">
 <div>
 <p className="leading-none text-xs">{opt.label}</p>
 <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5 font-normal">
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

