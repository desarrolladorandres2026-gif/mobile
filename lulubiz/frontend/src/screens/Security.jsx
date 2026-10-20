import QRCode from 'qrcode';
import { useMemo, useState } from 'react';
import { Button, Notice, PageHeader, TextField, errorMessage, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';

/** Código QR dibujado con elementos de React a partir de la matriz de módulos: sin HTML inyectado. */
export function QrCode({ value, label }) {
  const path = useMemo(() => {
    const { size, data } = QRCode.create(value, { errorCorrectionLevel: 'M' }).modules;
    const cells = [];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) if (data[y * size + x]) cells.push(`M${x} ${y}h1v1h-1z`);
    }
    return { d: cells.join(''), size };
  }, [value]);
  return (
    <svg viewBox={`-2 -2 ${path.size + 4} ${path.size + 4}`} role="img" aria-label={label} className="mb-3 w-48" shapeRendering="crispEdges">
      <rect x="-2" y="-2" width={path.size + 4} height={path.size + 4} fill="#ffffff" />
      <path d={path.d} fill="#1a2230" />
    </svg>
  );
}

function RecoveryCodes({ codes, onDone }) {
  const [saved, setSaved] = useState(false);
  return (
    <div>
      <Notice kind="info" title="Guarda estos códigos de recuperación">
        Cada uno sirve una sola vez si pierdes el acceso a tu aplicación de autenticación. No volverán a mostrarse.
      </Notice>
      <ul className="mb-4 grid max-w-md grid-cols-2 gap-x-6 gap-y-1 text-sm tabular-nums tracking-wide text-tinta">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <label className="mb-4 flex items-center gap-2 text-sm text-tinta">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="size-4 accent-azul" />
        Ya guardé los códigos en un lugar seguro
      </label>
      <Button variant="primary" onClick={onDone} disabled={!saved}>
        Listo
      </Button>
    </div>
  );
}

function CredentialsForm({ title, action, confirmLabel, danger = false, onDone }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const submit = useSubmit(async () => {
    const result = await action({ password, code });
    setPassword('');
    setCode('');
    onDone(result);
  });
  return (
    <form
      className="mb-6 max-w-md"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h3 className="mb-2 font-semibold text-tinta">{title}</h3>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <TextField label="Tu contraseña" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      <TextField label="Código de tu aplicación o de recuperación" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" required />
      <Button type="submit" variant={danger ? 'danger' : 'primary'} busy={submit.busy}>
        {confirmLabel}
      </Button>
    </form>
  );
}

function MfaSection({ account, onChanged }) {
  const [stage, setStage] = useState('idle'); // idle | enrolling | codes
  const [enrollment, setEnrollment] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState([]);
  const [mode, setMode] = useState(null); // null | 'regenerate' | 'disable'
  const [notice, setNotice] = useState(null);

  const start = useSubmit(async () => {
    setEnrollment(await api.post('/v1/auth/mfa/enroll'));
    setStage('enrolling');
    setNotice(null);
  });
  const confirm = useSubmit(async () => {
    const result = await api.post('/v1/auth/mfa/confirm', { code: code.trim() });
    setCodes(result.recoveryCodes);
    setStage('codes');
    setEnrollment(null);
    setCode('');
  });

  if (stage === 'codes') {
    return (
      <RecoveryCodes
        codes={codes}
        onDone={() => {
          setStage('idle');
          setCodes([]);
          onChanged();
        }}
      />
    );
  }

  if (stage === 'enrolling' && enrollment) {
    return (
      <div className="max-w-md">
        <p className="mb-3 text-sm text-tinta">
          1. Escanea este código con tu aplicación de autenticación (Google Authenticator, Authy, 1Password…), o escribe la clave a mano.
        </p>
        <QrCode value={enrollment.otpauthUri} label="Código QR para la aplicación de autenticación" />
        <p className="mb-4 text-sm text-tinta">
          Clave: <span className="font-semibold tracking-wide">{enrollment.secret}</span>
        </p>
        <p className="mb-3 text-sm text-tinta">2. Escribe el código de 6 dígitos que muestra la aplicación.</p>
        {confirm.error ? <Notice kind="error">{errorMessage(confirm.error)}</Notice> : null}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            confirm.run();
          }}
        >
          <TextField label="Código de 6 dígitos" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required />
          <Button type="submit" variant="primary" busy={confirm.busy}>
            Activar
          </Button>
          <Button className="ml-2" onClick={() => { setStage('idle'); setEnrollment(null); }}>
            Cancelar
          </Button>
        </form>
      </div>
    );
  }

  if (!account.mfaEnabled) {
    return (
      <div>
        <p className="mb-3 max-w-xl text-sm text-tinta">
          Pide un código de tu teléfono además de la contraseña al iniciar sesión. Es la mejor defensa si alguien consigue tu contraseña.
        </p>
        {start.error ? <Notice kind="error">{errorMessage(start.error)}</Notice> : null}
        <Button variant="primary" busy={start.busy} onClick={start.run}>
          Activar verificación en dos pasos
        </Button>
      </div>
    );
  }

  return (
    <div>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      <p className="mb-3 text-sm text-tinta">
        Activada. Te quedan {account.recoveryCodesLeft} códigos de recuperación sin usar.
      </p>
      <div className="mb-4 flex gap-2">
        <Button onClick={() => setMode(mode === 'regenerate' ? null : 'regenerate')}>Generar códigos nuevos</Button>
        <Button variant="danger" onClick={() => setMode(mode === 'disable' ? null : 'disable')}>Desactivar</Button>
      </div>
      {mode === 'regenerate' ? (
        <CredentialsForm
          title="Generar códigos de recuperación nuevos"
          confirmLabel="Generar códigos"
          action={(body) => api.post('/v1/auth/mfa/recovery-codes', body)}
          onDone={(result) => {
            setMode(null);
            setCodes(result.recoveryCodes);
            setStage('codes');
          }}
        />
      ) : null}
      {mode === 'disable' ? (
        <CredentialsForm
          title="Desactivar la verificación en dos pasos"
          confirmLabel="Desactivar"
          danger
          action={(body) => api.post('/v1/auth/mfa/disable', body)}
          onDone={() => {
            setMode(null);
            setNotice('Desactivaste la verificación en dos pasos.');
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

export function SecurityScreen() {
  const { account, refresh } = useSession();
  const [message, setMessage] = useState(null);
  const resend = useSubmit(async () => {
    const result = await api.post('/v1/auth/resend-verification');
    setMessage(
      result.sent
        ? `Enviamos un enlace nuevo a ${account.email}.`
        : result.reason === 'TOO_SOON'
          ? 'Ya enviamos un enlace hace un momento. Revisa tu correo y espera un minuto antes de pedir otro.'
          : 'Tu correo ya está confirmado.',
    );
  });

  return (
    <>
      <PageHeader title="Mi cuenta" />
      <h2 className="mb-2 text-lg font-semibold text-tinta">Datos</h2>
      <dl className="mb-8 grid max-w-md grid-cols-[8rem_1fr] gap-y-1 text-sm text-tinta">
        <dt className="font-semibold">Nombre</dt>
        <dd>{account.name || '—'}</dd>
        <dt className="font-semibold">Correo</dt>
        <dd>{account.email}</dd>
        <dt className="font-semibold">Confirmación</dt>
        <dd>{account.emailVerified ? 'Correo confirmado' : 'Correo sin confirmar'}</dd>
      </dl>
      {!account.emailVerified ? (
        <div className="mb-8">
          {message ? <Notice kind="info">{message}</Notice> : null}
          {resend.error ? <Notice kind="error">{errorMessage(resend.error)}</Notice> : null}
          <Button busy={resend.busy} onClick={resend.run}>
            Enviarme el enlace de confirmación
          </Button>
        </div>
      ) : null}

      <h2 className="mb-2 text-lg font-semibold text-tinta">Verificación en dos pasos</h2>
      <MfaSection account={account} onChanged={refresh} />
    </>
  );
}
