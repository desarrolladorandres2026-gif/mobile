import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { PlainButton } from '../components/Button';
import { FormStatus, OtpField, TextAreaField, TextField } from '../components/Form';
import { ApiError } from '../lib/http';
import { isValidPhone } from '../lib/validate';
import { setPageMeta } from '../lib/meta';
import { confirmDeletion, requestDeletionOtp } from '../lib/publicApi';

/**
 * Página pública de eliminación de cuenta y datos. Google Play exige una URL
 * así, accesible sin abrir la app, que explique qué se borra y qué se conserva.
 *
 * El texto de abajo describe lo que el sistema hace hoy: la solicitud llega a
 * administración (no borra nada sola) y se responde con el plazo del habeas
 * data. Si cambia la política, cambia aquí y en el documento legal.
 */
export default function EliminarCuenta() {
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ phone?: string; otp?: string }>({});
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setPageMeta({
      title: 'Eliminar mi cuenta y mis datos | ZIPP',
      description: 'Cómo pedir la eliminación de tu cuenta de ZIPP y de tus datos personales, qué se borra y qué se conserva por ley.',
      path: '/eliminar-cuenta',
    });
  }, []);

  const sendOtp = async () => {
    if (!isValidPhone(phone)) {
      setErrors((e) => ({ ...e, phone: 'Escribe tu celular de 10 dígitos, el mismo de tu cuenta.' }));
      throw new Error('Primero escribe tu celular.');
    }
    setErrors((e) => ({ ...e, phone: undefined }));
    try {
      await requestDeletionOtp(phone);
    } catch (error) {
      throw new Error(error instanceof ApiError ? error.message : 'No pudimos enviar el código. Intenta de nuevo.', { cause: error });
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found: typeof errors = {};
    if (!isValidPhone(phone)) found.phone = 'Escribe tu celular de 10 dígitos, el mismo de tu cuenta.';
    if (!/^\d{6}$/.test(otp)) found.otp = 'Pide el código y escribe los 6 dígitos.';
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length > 0) return;

    setSending(true);
    try {
      await confirmDeletion({ phone, otp, reason: reason.trim() || undefined });
      setDone(true);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'No pudimos registrar tu solicitud. Inténtalo de nuevo.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-6 py-10 sm:px-10">
      <h1 className="text-2xl font-semibold text-text-main">Eliminar mi cuenta y mis datos</h1>
      <p className="mt-3 text-base text-text-secondary">
        Puedes pedir que eliminemos tu cuenta de ZIPP y tus datos personales. No necesitas abrir la app ni iniciar sesión:
        confirmamos que eres tú con un código por WhatsApp.
      </p>

      <h2 className="mt-8 text-xl font-semibold text-text-main">Qué se elimina</h2>
      <ul className="mt-2 list-disc pl-6 text-base text-text-main">
        <li className="py-1">Tu perfil: nombre, correo, celular, foto y datos de documento.</li>
        <li className="py-1">Tus direcciones, favoritos, notificaciones y tarjetas guardadas.</li>
        <li className="py-1">Tus sesiones, dispositivos de confianza y permisos de notificaciones.</li>
        <li className="py-1">El acceso con Google, Apple o Facebook. No se puede volver a entrar con esa cuenta.</li>
        <li className="py-1">Tu membresía Zipp Pro, si tienes una activa: se cancela y no vuelve a cobrarse.</li>
      </ul>

      <h2 className="mt-8 text-xl font-semibold text-text-main">Qué conservamos y por qué</h2>
      <p className="mt-2 text-base text-text-main">
        Los pedidos, pagos y asientos contables se conservan porque son registro financiero que la ley nos obliga a
        guardar. Quedan sin tu nombre ni tu contacto, y la ubicación de entrega se reduce a una zona de aproximadamente
        un kilómetro. No se usan para nada distinto al cumplimiento legal ni a resolver reclamos.
      </p>

      <h2 className="mt-8 text-xl font-semibold text-text-main">Cuándo no podemos cerrarla todavía</h2>
      <p className="mt-2 text-base text-text-main">
        Si tienes un pedido en curso o un saldo pendiente con ZIPP, te lo diremos y la cuenta se cierra cuando esté
        resuelto. La membresía Pro cancelada no se reembolsa automáticamente: un integrante del equipo revisa cada caso.
      </p>

      <h2 className="mt-8 text-xl font-semibold text-text-main">Cuánto tarda</h2>
      <p className="mt-2 text-base text-text-main">
        Respondemos dentro del plazo que fija la ley de protección de datos. Más detalles en la{' '}
        <Link to="/legal/habeas_data" className="font-semibold text-primary-text underline underline-offset-4">
          política de tratamiento de datos
        </Link>
        .
      </p>

      <p className="mt-6 text-base text-text-secondary">
        Si tienes la app, también puedes hacerlo desde ella: abre Mi cuenta y toca Eliminar mi cuenta.
      </p>

      {done ? (
        <div className="mt-10 border-t border-border pt-8">
          <FormStatus success="Si el número tiene una cuenta, registramos tu solicitud." />
          <p className="mt-2 max-w-md text-base text-text-secondary">
            Te escribiremos por WhatsApp cuando esté resuelta. Si no recibes respuesta en el plazo legal, escríbenos desde{' '}
            <Link to="/soporte" className="font-semibold text-primary-text underline underline-offset-4">Soporte</Link>.
          </p>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="mt-10 flex flex-col gap-6 border-t border-border pt-8">
          <h2 className="text-xl font-semibold text-text-main">Pedir la eliminación</h2>
          <TextField
            label="Celular de tu cuenta"
            name="phone"
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            maxLength={10}
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
            error={errors.phone}
          />
          <OtpField code={otp} onCodeChange={setOtp} onSend={sendOtp} error={errors.otp} />
          <TextAreaField label="Motivo (opcional)" maxLength={500} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          <FormStatus error={failure} />
          <div>
            <PlainButton type="submit" disabled={sending}>{sending ? 'Enviando…' : 'Pedir eliminación'}</PlainButton>
          </div>
        </form>
      )}
    </div>
  );
}
