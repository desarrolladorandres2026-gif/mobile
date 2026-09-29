import { useRef, type InputHTMLAttributes } from 'react';

/**
 * Entero con separador de miles mientras se escribe: 25000 → 25.000.
 * El estado del formulario sigue guardando solo dígitos ("25000"), así que
 * lo que viaja al servidor no cambia. Para decimales (porcentajes, ratings)
 * se sigue usando `type="number"`.
 *
 * Esta copia vive también en admin/src/components: los paneles no comparten
 * paquete, así que se mantienen a mano iguales.
 */
type Props = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type' | 'min' | 'max' | 'step' | 'inputMode'
> & {
  value: string | number | null | undefined;
  /** Recibe solo dígitos, sin ceros a la izquierda ('' si está vacío). */
  onValueChange: (digits: string) => void;
  maxDigits?: number;
};

const onlyDigits = (raw: string, maxDigits: number): string =>
  raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, maxDigits);

const groupDigits = (digits: string): string =>
  digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

export default function NumericInput({ value, onValueChange, maxDigits = 12, ...rest }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const shown = groupDigits(onlyDigits(String(value ?? ''), maxDigits));

  return (
    <input
      {...rest}
      ref={ref}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      value={shown}
      onChange={(event) => {
        const el = event.currentTarget;
        const raw = el.value;
        // Cuántos dígitos había antes del cursor: el reformateo mueve los puntos
        // y, sin esto, el cursor saltaría al final al editar a la mitad.
        const digitsBeforeCaret = raw.slice(0, el.selectionStart ?? raw.length).replace(/\D/g, '').length;
        onValueChange(onlyDigits(raw, maxDigits));
        requestAnimationFrame(() => {
          const node = ref.current;
          if (!node) return;
          let seen = 0;
          let pos = node.value.length;
          if (digitsBeforeCaret === 0) pos = 0;
          else {
            for (let i = 0; i < node.value.length; i += 1) {
              if (/\d/.test(node.value[i])) seen += 1;
              if (seen === digitsBeforeCaret) { pos = i + 1; break; }
            }
          }
          if (document.activeElement === node) node.setSelectionRange(pos, pos);
        });
      }}
    />
  );
}
