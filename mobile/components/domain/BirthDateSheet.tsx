import { useState, useEffect } from 'react';
import { Button, PlainField, Sheet, Notice } from '../ui';
import { useAuthStore, type User } from '../../stores/authStore';
import { authApi } from '../../services/endpoints';
import { fieldMessage } from '../../lib/errors';
import { tap } from '../../lib/haptics';
import { composeBirthDate, formatBirthDate, ageInBogota, MIN_AGE } from '../../lib/birthDate';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Con el usuario ya guardado. El checkout lo usa para seguir con el pedido. */
  onSaved?: (user: User) => void;
  /** Por qué se pide aquí, arriba del campo (p. ej. "tu pedido tiene licor"). */
  reason?: string;
  /** Texto del botón final; por defecto "Sí, guardar DD/MM/AAAA". */
  confirmLabel?: (formatted: string) => string;
}

/**
 * Fecha de nacimiento: se guarda una sola vez.
 *
 * Es lo que decide si alguien puede pedir productos +18, así que dejarla
 * editable haría el bloqueo inútil. Por eso el segundo toque confirma la
 * fecha escrita en el propio botón, en vez de guardar al primero.
 *
 * Vive aparte porque la usan dos sitios: Mi cuenta y el checkout, que la
 * pide en el momento en que hace falta en vez de mandar a buscarla.
 */
export function BirthDateSheet({ visible, onClose, onSaved, reason, confirmLabel }: Props) {
  const setUser = useAuthStore((s) => s.setUser);
  /** Lo escrito, ya con las barras: `09/03/2001`. */
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setText('');
    setError('');
    setConfirming(null);
  }, [visible]);

  // Las barras se ponen solas: en el teclado numérico no hay "/".
  const edit = (t: string) => {
    const digits = t.replace(/\D/g, '').slice(0, 8);
    setText([digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join('/'));
    setError('');
    setConfirming(null);
  };

  const submit = async () => {
    if (!confirming) {
      const [day = '', month = '', year = ''] = text.split('/');
      const result = composeBirthDate(day, month, year);
      if (!result.ok) { setError(result.error); tap('error'); return; }
      const age = ageInBogota(result.value);
      if (age !== null && age < MIN_AGE) {
        setError(`Para usar Zipp necesitas tener al menos ${MIN_AGE} años.`);
        tap('error');
        return;
      }
      setConfirming(result.value);
      tap('warning');
      return;
    }

    setSaving(true);
    try {
      const { user } = await authApi.updateProfile({ birthDate: confirming });
      setUser(user);
      tap('success');
      onClose();
      onSaved?.(user);
    } catch (err) {
      setError(fieldMessage(err, 'No pudimos guardar tu fecha de nacimiento.'));
      setConfirming(null);
      tap('error');
    } finally {
      setSaving(false);
    }
  };

  const formatted = confirming ? formatBirthDate(confirming) : '';

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Fecha de nacimiento"
      height={0.65}
      footer={
        <Button
          title={confirming ? (confirmLabel ? confirmLabel(formatted) : `Sí, guardar ${formatted}`) : 'Continuar'}
          size="lg"
          full
          loading={saving}
          onPress={submit}
          haptic="medium"
        />
      }
    >
      {reason ? <Notice tone="info">{reason}</Notice> : null}

      <PlainField
        label="Fecha de nacimiento"
        icon="celebracion"
        placeholder="DD/MM/AAAA"
        value={text}
        onChangeText={edit}
        error={error || undefined}
        keyboardType="number-pad"
        maxLength={10}
        numeric
        autoFocus
      />

      <Notice tone="warning">
        {confirming
          ? `Vas a guardar ${formatted}. Después solo soporte podrá cambiarla.`
          : 'Solo se puede guardar una vez: revísala bien.'}
      </Notice>
    </Sheet>
  );
}
