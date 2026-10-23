import { useEffect, useState, type FormEvent } from 'react';
import { PlainButton } from '../components/Button';
import { FormStatus, Honeypot, SelectField, TextAreaField, TextField } from '../components/Form';
import { ApiError } from '../lib/http';
import { isValidPhone } from '../lib/validate';
import { SUPPORT_PHONE, SUPPORT_PHONE_DISPLAY, supportWhatsAppUrl } from '../lib/contact';
import { setPageMeta } from '../lib/meta';
import { sendContact, type ContactType } from '../lib/publicApi';

const TYPES: { value: ContactType; label: string }[] = [
  { value: 'question', label: 'Pregunta' },
  { value: 'complaint', label: 'Queja' },
  { value: 'claim', label: 'Reclamo' },
  { value: 'suggestion', label: 'Sugerencia' },
  { value: 'other', label: 'Otro' },
];

type Errors = Partial<Record<'name' | 'contact' | 'detail', string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(name: string, contact: string, detail: string): Errors {
  const errors: Errors = {};
  if (name.trim().length < 2) errors.name = 'Escribe tu nombre.';
  if (!isValidPhone(contact) && !EMAIL.test(contact)) errors.contact = 'Escribe un celular de 10 dígitos o un correo válido.';
  if (detail.trim().length < 10) errors.detail = 'Cuéntanos un poco más (mínimo 10 caracteres).';
  return errors;
}

export default function Soporte() {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [type, setType] = useState<ContactType>('question');
  const [subject, setSubject] = useState('');
  const [detail, setDetail] = useState('');
  const [website, setWebsite] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    setPageMeta({
      title: 'Soporte | ZIPP',
      description: 'Escríbenos tu pregunta, queja, reclamo o sugerencia. Respondemos por el medio de contacto que nos dejes.',
      path: '/soporte',
    });
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = validate(name, contact.trim(), detail);
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length > 0) return;

    setSending(true);
    try {
      const res = await sendContact({
        name: name.trim(),
        contact: contact.trim(),
        type,
        subject: subject.trim() || undefined,
        detail: detail.trim(),
        website,
      });
      setDone(res?.message ?? 'Recibimos tu mensaje. Te responderemos por el medio que nos dejaste.');
    } catch (error) {
      setFailure(
        error instanceof ApiError && error.status === 429
          ? error.message
          : 'No pudimos enviar tu mensaje. Inténtalo de nuevo o escríbenos por WhatsApp.',
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-6 py-10 sm:px-10">
      <h1 className="text-2xl font-semibold text-text-main">Soporte</h1>
      <p className="mt-3 text-base text-text-secondary">
        Para un pedido en curso, lo más rápido es WhatsApp o una llamada. Para todo lo demás, usa el formulario.
      </p>
      <p className="mt-3 flex flex-wrap gap-x-6">
        <a
          href={supportWhatsAppUrl('Hola, necesito ayuda con ZIPP.')}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center text-base font-semibold text-primary-text underline underline-offset-4"
        >
          WhatsApp
        </a>
        <a href={`tel:${SUPPORT_PHONE}`} className="inline-flex min-h-11 items-center text-base font-semibold text-primary-text underline underline-offset-4">
          {SUPPORT_PHONE_DISPLAY}
        </a>
      </p>

      {done ? (
        <div className="mt-10 border-t border-border pt-8">
          <FormStatus success={done} />
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="relative mt-10 flex flex-col gap-6 border-t border-border pt-8">
          <TextField label="Nombre" name="name" autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
          <TextField
            label="Celular o correo"
            hint="Por aquí te respondemos."
            name="contact"
            autoComplete="email"
            maxLength={120}
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            error={errors.contact}
          />
          <SelectField label="Tipo de mensaje" value={type} onChange={(e) => setType(e.target.value as ContactType)} options={TYPES} />
          <TextField label="Asunto (opcional)" maxLength={120} value={subject} onChange={(e) => setSubject(e.target.value)} />
          <TextAreaField label="Mensaje" maxLength={2000} value={detail} onChange={(e) => setDetail(e.target.value)} error={errors.detail} />
          <Honeypot value={website} onChange={setWebsite} />
          <FormStatus error={failure} />
          <div>
            <PlainButton type="submit" disabled={sending}>{sending ? 'Enviando…' : 'Enviar mensaje'}</PlainButton>
          </div>
        </form>
      )}
    </div>
  );
}
