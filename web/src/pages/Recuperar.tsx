import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PlainButton } from '../components/Button';
import { FormStatus, OtpField, TextField } from '../components/Form';
import { acceptSession, authApi, needsSecondFactor, WrongRoleError } from '../lib/authApi';
import { ApiError } from '../lib/http';
import { setPageMeta } from '../lib/meta';
import { PASSWORD_RULES, meetsPasswordRules } from '../lib/passwordRules';
import { isValidPhone } from '../lib/validate';
import { ME_KEY } from '../lib/useAuth';

/** Restablecer la contraseña con un código por WhatsApp; al terminar queda la sesión abierta. */
export default function Recuperar() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState((params.get('celular') ?? '').replace(/\D/g, '').slice(0, 10));
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPageMeta({ title: 'Recuperar contraseña | ZIPP' });
  }, []);

  const sendOtp = async () => {
    if (!isValidPhone(phone)) throw new Error('Escribe un celular de 10 dígitos que empiece por 3.');
    try {
      await authApi.sendOtp(phone);
    } catch (e) {
      throw new Error(e instanceof ApiError ? e.message : 'No pudimos enviar el código. Intenta de nuevo.', { cause: e });
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isValidPhone(phone)) { setError('Escribe un celular de 10 dígitos que empiece por 3.'); return; }
    if (!/^\d{6}$/.test(otp)) { setError('Pide el código y escribe los 6 dígitos.'); return; }
    if (!meetsPasswordRules(password)) { setError('La contraseña no cumple todas las reglas de abajo.'); return; }
    setBusy(true);
    setError(null);
    try {
      const result = await authApi.resetPassword({ phone, otpCode: otp, password });
      if (needsSecondFactor(result)) {
        // Con 2FA no se abre sesión aquí: la contraseña ya cambió, falta el segundo factor.
        navigate('/ingresar', { replace: true });
        return;
      }
      await acceptSession(result);
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof WrongRoleError || err instanceof ApiError ? err.message : 'No pudimos cambiar la contraseña.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md px-6 py-10 sm:px-10">
      <h1 className="text-2xl font-semibold text-text-main">Recuperar contraseña</h1>
      <form onSubmit={submit} noValidate className="mt-6 flex flex-col gap-6">
        <TextField
          label="Celular de tu cuenta"
          name="phone"
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          maxLength={10}
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
        />
        <OtpField code={otp} onCodeChange={setOtp} onSend={sendOtp} />
        <div>
          <TextField label="Contraseña nueva" name="new-password" type="password" autoComplete="new-password" maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
          <ul className="mt-2 text-sm">
            {PASSWORD_RULES.map((r) => (
              <li key={r.label} className={r.test(password) ? 'text-ok' : 'text-text-secondary'}>
                {r.test(password) ? 'Listo: ' : 'Falta: '}{r.label}
              </li>
            ))}
          </ul>
        </div>
        <FormStatus error={error} />
        <div className="flex flex-wrap items-center gap-x-6">
          <PlainButton type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Cambiar contraseña'}</PlainButton>
          <Link to="/ingresar" className="inline-flex min-h-11 items-center text-base text-text-secondary underline underline-offset-4">Volver</Link>
        </div>
      </form>
    </div>
  );
}
