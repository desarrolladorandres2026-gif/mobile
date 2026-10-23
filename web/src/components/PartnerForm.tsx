import { useState, type FormEvent } from 'react';
import { PlainButton } from './Button';
import { FormStatus, Honeypot, OtpField, SelectField, TextAreaField, TextField } from './Form';
import { CATEGORIES } from '../lib/format';
import { DEFAULT_CITY } from '../lib/api';
import { ApiError } from '../lib/http';
import { isValidPhone } from '../lib/validate';
import { requestPartnerOtp, submitPartnerApplication, type PartnerInput, type PartnerType } from '../lib/publicApi';

const VEHICLES = [
  { value: 'moto', label: 'Moto' },
  { value: 'bicicleta', label: 'Bicicleta' },
  { value: 'carro', label: 'Carro' },
  { value: 'a_pie', label: 'A pie' },
];

type Field = 'name' | 'phone' | 'email' | 'city' | 'businessName' | 'category' | 'address' | 'otp';
type Errors = Partial<Record<Field, string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Solicitud pública de comercio o repartidor. El celular se verifica con un
 * código por WhatsApp antes de aceptar la solicitud: sin eso, cualquiera
 * podría inundar la bandeja de administración con números ajenos.
 */
export function PartnerForm({ type, cities }: { type: PartnerType; cities: string[] }) {
  const isBusiness = type === 'business';
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [city, setCity] = useState(DEFAULT_CITY);
  const [businessName, setBusinessName] = useState('');
  const [category, setCategory] = useState<string>(CATEGORIES[0].key);
  const [address, setAddress] = useState('');
  const [vehicleType, setVehicleType] = useState<PartnerInput['vehicleType']>('moto');
  const [experience, setExperience] = useState('');
  const [notes, setNotes] = useState('');
  const [otp, setOtp] = useState('');
  const [website, setWebsite] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const cityOptions = (cities.includes(city) ? cities : [city, ...cities]).map((c) => ({ value: c, label: c }));

  const sendOtp = async () => {
    if (!isValidPhone(phone)) {
      setErrors((e) => ({ ...e, phone: 'Escribe un celular de 10 dígitos que empiece por 3.' }));
      throw new Error('Primero escribe tu celular.');
    }
    setErrors((e) => ({ ...e, phone: undefined }));
    try {
      await requestPartnerOtp(phone);
    } catch (error) {
      throw new Error(error instanceof ApiError ? error.message : 'No pudimos enviar el código. Intenta de nuevo.', { cause: error });
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found: Errors = {};
    if (name.trim().length < 2) found.name = 'Escribe tu nombre completo.';
    if (!isValidPhone(phone)) found.phone = 'Escribe un celular de 10 dígitos que empiece por 3.';
    if (email && !EMAIL.test(email)) found.email = 'Ese correo no parece válido.';
    if (isBusiness && businessName.trim().length < 2) found.businessName = 'Escribe el nombre del negocio.';
    if (isBusiness && address.trim().length < 5) found.address = 'Escribe la dirección del local.';
    if (!/^\d{6}$/.test(otp)) found.otp = 'Pide el código y escribe los 6 dígitos.';
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length > 0) return;

    setSending(true);
    try {
      await submitPartnerApplication({
        type,
        name: name.trim(),
        phone,
        otp,
        email: email.trim() || undefined,
        city,
        businessName: isBusiness ? businessName.trim() : undefined,
        category: isBusiness ? category : undefined,
        address: isBusiness ? address.trim() : undefined,
        vehicleType: isBusiness ? undefined : vehicleType,
        experience: !isBusiness && experience.trim() ? experience.trim() : undefined,
        notes: notes.trim() || undefined,
        website,
      });
      setDone(true);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'No pudimos enviar tu solicitud. Inténtalo de nuevo.');
    } finally {
      setSending(false);
    }
  };

  if (done) {
    return (
      <div className="mt-10 border-t border-border pt-8">
        <FormStatus success="Recibimos tu solicitud." />
        <p className="mt-2 max-w-md text-base text-text-secondary">
          Te contactaremos por WhatsApp al número que dejaste. Para pedir y seguir tu cuenta, regístrate como cliente
          con ese mismo celular.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="relative mt-10 flex flex-col gap-6 border-t border-border pt-8">
      <TextField label="Tu nombre" name="name" autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
      <TextField
        label="Celular"
        hint="Te enviaremos un código por WhatsApp para confirmarlo."
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
      <TextField label="Correo (opcional)" name="email" type="email" autoComplete="email" maxLength={120} value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
      <SelectField label="Ciudad" value={city} onChange={(e) => setCity(e.target.value)} options={cityOptions} />

      {isBusiness ? (
        <>
          <TextField label="Nombre del negocio" maxLength={80} value={businessName} onChange={(e) => setBusinessName(e.target.value)} error={errors.businessName} />
          <SelectField
            label="Tipo de negocio"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            options={CATEGORIES.map((c) => ({ value: c.key, label: c.label }))}
          />
          <TextField label="Dirección del local" maxLength={160} value={address} onChange={(e) => setAddress(e.target.value)} error={errors.address} />
        </>
      ) : (
        <>
          <SelectField
            label="Cómo repartes"
            value={vehicleType}
            onChange={(e) => setVehicleType(e.target.value as PartnerInput['vehicleType'])}
            options={VEHICLES}
          />
          <TextAreaField label="Experiencia (opcional)" hint="Si ya has repartido, cuéntanos dónde y por cuánto tiempo." maxLength={500} rows={3} value={experience} onChange={(e) => setExperience(e.target.value)} />
        </>
      )}

      <TextAreaField label="Algo más que debamos saber (opcional)" maxLength={500} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      <Honeypot value={website} onChange={setWebsite} />
      <FormStatus error={failure} />
      <div>
        <PlainButton type="submit" disabled={sending}>{sending ? 'Enviando…' : 'Enviar solicitud'}</PlainButton>
      </div>
    </form>
  );
}
