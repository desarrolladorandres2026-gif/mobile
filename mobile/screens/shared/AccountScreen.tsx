import { useState, useEffect, useCallback } from 'react';
import { View, ScrollView, Pressable, StyleSheet, Linking, Switch } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import {
  Text, Icon, Button, PlainField, PlainSelect, OtpInput, Sheet, Notice, Screen, Header, Chip,
} from '../../components/ui';
import { Avatar } from '../../components/domain/Avatar';
import { BirthDateSheet } from '../../components/domain/BirthDateSheet';
import { useAuthStore, type DocumentType, type MarketingChannel, type User } from '../../stores/authStore';
import { useAccount } from '../../hooks/useApi';
import { useTheme } from '../../hooks/useTheme';
import { useBottomInset } from '../../hooks/useBottomSpace';
import { authApi } from '../../services/endpoints';
import type { IconName } from '../../theme/icons';
import { Spacing } from '../../theme/tokens';
import { prepareAvatarForUpload } from '../../lib/avatarImage';
import { apiMessage, fieldMessage, validateEmail, validatePhone } from '../../lib/errors';
import { tap } from '../../lib/haptics';
import { ROUTES } from '../../lib/routing';
import { formatBirthDate } from '../../lib/birthDate';
import {
  DOCUMENT_TYPES, formatDocument, normalizeDocumentNumber, validateDocumentNumber,
} from '../../lib/identityDocument';
import { SUPPORT_PHONE, supportWhatsAppUrl } from '../../constants/config';

type SheetKind = 'name' | 'email' | 'phone' | 'document' | 'birthDate' | 'marketing';

const CHANNELS: { value: MarketingChannel; label: string }[] = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'sms', label: 'SMS' },
  { value: 'email', label: 'Correo' },
  { value: 'phone', label: 'Llamada' },
];

/** Soporte por WhatsApp con el mensaje ya escrito; si no hay WhatsApp, llamada. */
const askSupport = (text: string) => {
  Linking.openURL(supportWhatsAppUrl(text)).catch(() => {
    Linking.openURL(`tel:${SUPPORT_PHONE}`).catch(() => {});
  });
};

const isApplePrivateEmail = (email: string) => email.toLowerCase().endsWith('@privaterelay.appleid.com');

/** El nombre de pila: `firstName` en cuentas nuevas, `name` entero en las anteriores. */
const givenName = (u: User | null | undefined) => u?.firstName ?? u?.name ?? '';

/**
 * Mi cuenta: datos personales, seguridad y privacidad en un solo sitio.
 *
 * Reemplaza a la hoja "Editar perfil", que solo tocaba foto, nombre, correo y
 * celular. Casi todo lo demás —contraseña, sesiones, 2FA, promociones,
 * eliminar la cuenta— ya existía en el backend y no tenía pantalla.
 *
 * La comparten cliente y domiciliario (ver screens/shared).
 */
export default function AccountScreen() {
  const router = useRouter();
  const { c, isDark } = useTheme();
  const bottomInset = useBottomInset();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const { data: account, refetch } = useAccount();

  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState('');

  // Lo del servidor manda: el 2FA o las promociones pudieron cambiar desde
  // otro teléfono, y el `user` guardado es el de cuando se inició sesión.
  useEffect(() => {
    if (account?.user) setUser(account.user);
  }, [account?.user, setUser]);

  // Al volver de cambiar contraseña, 2FA o confirmar el celular.
  useFocusEffect(useCallback(() => { void refetch(); }, [refetch]));

  const hasPassword = account?.hasPassword;

  const pickAvatar = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setAvatarError('Necesitamos permiso para acceder a tus fotos.');
      tap('error');
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
    });
    if (picked.canceled) return;

    setAvatarError('');
    setUploadingAvatar(true);
    try {
      const ready = await prepareAvatarForUpload(picked.assets[0].uri);
      const data = await authApi.uploadAvatar(ready);
      setUser(data.user);
      tap('success');
    } catch (error) {
      setAvatarError(apiMessage(error, 'No pudimos actualizar tu foto de perfil.'));
      tap('error');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const open = (kind: SheetKind) => {
    tap('light');
    setSheet(kind);
  };

  const fullName = [givenName(user), user?.lastName].filter(Boolean).join(' ');

  // ── Celular ──
  const phoneRow: RowProps = user?.pendingPhone
    ? {
        icon: 'celular',
        label: 'Celular',
        value: user.phone ? `+57 ${user.phone}` : 'Sin celular',
        detail: `Falta confirmar +57 ${user.pendingPhone}`,
        badge: 'Confirmar',
        onPress: () => { tap('light'); router.push(ROUTES.verifyPhone(false) as never); },
      }
    : user?.phoneVerified
      ? {
          icon: 'celular',
          label: 'Celular',
          value: `+57 ${user.phone}`,
          detail: 'Verificado. Para cambiarlo, escríbenos',
          verified: true,
          onPress: () => askSupport('Hola, necesito cambiar el celular de mi cuenta Zipp.'),
        }
      : {
          icon: 'celular',
          label: 'Celular',
          value: user?.phone ? `+57 ${user.phone}` : 'Agregar celular',
          detail: 'Sin verificar',
          badge: 'Verificar',
          onPress: () => open('phone'),
        };

  // ── Correo ──
  const emailRow: RowProps = !user?.email
    ? { icon: 'correo', label: 'Correo', value: 'Agregar correo', onPress: () => open('email') }
    : user.emailVerified
      ? {
          icon: 'correo',
          label: 'Correo',
          value: user.email,
          // "Ocultar mi correo" de Apple: la dirección es de Apple y reenvía
          // al correo real, así que sin rótulo parece un error.
          detail: isApplePrivateEmail(user.email)
            ? 'Correo privado de Apple: te reenvía a tu correo real'
            : 'Verificado. Para cambiarlo, escríbenos',
          verified: true,
          onPress: () => askSupport('Hola, necesito cambiar el correo de mi cuenta Zipp.'),
        }
      : {
          icon: 'correo',
          label: 'Correo',
          value: user.email,
          detail: 'Sin verificar',
          badge: 'Verificar',
          onPress: () => open('email'),
        };

  // ── Fecha de nacimiento: una sola vez ──
  const birthRow: RowProps = user?.birthDate
    ? {
        icon: 'celebracion',
        label: 'Fecha de nacimiento',
        value: formatBirthDate(user.birthDate),
        detail: 'Para corregirla, escríbenos',
        locked: true,
        onPress: () => askSupport('Hola, necesito corregir la fecha de nacimiento de mi cuenta Zipp.'),
      }
    : {
        icon: 'celebracion',
        label: 'Fecha de nacimiento',
        value: 'Agregar',
        detail: 'Te la pedimos para productos +18',
        onPress: () => open('birthDate'),
      };

  const channelsLabel = (user?.marketingChannels ?? [])
    .map((ch) => CHANNELS.find((x) => x.value === ch)?.label)
    .filter(Boolean)
    .join(', ');

  return (
    <Screen>
      <Header title="Mi cuenta" fallback={ROUTES.profile} />

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset + Spacing.xxl }]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Foto ── */}
        <View style={styles.avatarRow}>
          <Avatar uri={user?.avatar} name={fullName || user?.name} size={72} fontVariant="titleL" />
          <View style={styles.flex}>
            <Text v="strongL" numberOfLines={1}>{fullName || 'Tu cuenta'}</Text>
            <Pressable
              onPress={pickAvatar}
              disabled={uploadingAvatar}
              accessibilityRole="button"
              accessibilityLabel="Cambiar foto de perfil"
              hitSlop={8}
              style={({ pressed }) => [styles.avatarAction, pressed && { opacity: 0.6 }]}
            >
              <Icon name="camara" size="sm" color={c.primaryText} />
              <Text v="strongS" tone="primaryText">
                {uploadingAvatar ? 'Subiendo…' : 'Cambiar foto'}
              </Text>
            </Pressable>
          </View>
        </View>
        {avatarError ? <Notice tone="error">{avatarError}</Notice> : null}

        {/* ── Datos personales ── */}
        <Group title="DATOS PERSONALES">
          <Row
            icon="perfil"
            label="Nombre y apellido"
            value={fullName || 'Agregar'}
            detail={user?.lastName ? undefined : 'Falta tu apellido'}
            badge={user?.lastName ? undefined : 'Completar'}
            onPress={() => open('name')}
          />
          <Row {...phoneRow} />
          <Row {...emailRow} />
          <Row
            icon="documento"
            label="Documento de identidad"
            value={formatDocument(user?.documentType, user?.documentNumber) || 'Agregar'}
            detail="Para facturar a tu nombre (opcional)"
            onPress={() => open('document')}
          />
          <Row {...birthRow} last />
        </Group>

        {/* ── Seguridad ── */}
        <Group title="SEGURIDAD">
          {hasPassword === false ? (
            <Row
              icon="clave"
              label="Contraseña"
              value="Entras con Google o Apple"
              detail="Tu cuenta no usa contraseña"
            />
          ) : (
            <Row
              icon="clave"
              label="Cambiar contraseña"
              detail="Cierra la sesión en todos tus dispositivos"
              onPress={() => { tap('light'); router.push(ROUTES.accountPassword as never); }}
            />
          )}
          <Row
            icon="celular"
            label="Sesiones activas"
            detail="Dónde está abierta tu cuenta"
            onPress={() => { tap('light'); router.push(ROUTES.accountSessions as never); }}
          />
          <Row
            icon="candado"
            label="Verificación en dos pasos"
            value={user?.twoFactorEnabled ? 'Activada' : 'Desactivada'}
            detail="Un código de tu app autenticadora al entrar"
            verified={user?.twoFactorEnabled}
            onPress={() => { tap('light'); router.push(ROUTES.accountTwoFactor as never); }}
            last
          />
        </Group>

        {/* ── Privacidad ── */}
        <Group title="PRIVACIDAD">
          <Row
            icon="notificaciones"
            label="Promociones y novedades"
            value={user?.marketingConsent ? channelsLabel || 'Activadas' : 'Desactivadas'}
            detail="Por dónde te escribimos ofertas"
            onPress={() => open('marketing')}
            last
          />
        </Group>

        {/* ── Eliminar cuenta ── */}
        <Pressable
          onPress={() => { tap('warning'); router.push(ROUTES.accountDelete as never); }}
          accessibilityRole="button"
          accessibilityLabel="Eliminar mi cuenta"
          style={({ pressed }) => [
            styles.deleteRow,
            pressed && { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)' },
          ]}
        >
          <View style={styles.iconSlot}>
            <Icon name="eliminar" size={24} color={c.error} />
          </View>
          <View style={styles.flex}>
            <Text v="strongM" color={c.error}>Eliminar mi cuenta</Text>
            <Text v="caption" tone="textMuted">Borra tus datos personales de Zipp</Text>
          </View>
          <Icon name="siguiente" size="sm" color={c.error} />
        </Pressable>
      </ScrollView>

      <NameSheet visible={sheet === 'name'} onClose={() => setSheet(null)} />
      <PhoneSheet visible={sheet === 'phone'} onClose={() => setSheet(null)} />
      <EmailSheet visible={sheet === 'email'} onClose={() => setSheet(null)} />
      <DocumentSheet visible={sheet === 'document'} onClose={() => setSheet(null)} />
      <BirthDateSheet visible={sheet === 'birthDate'} onClose={() => setSheet(null)} />
      <MarketingSheet visible={sheet === 'marketing'} onClose={() => setSheet(null)} />
    </Screen>
  );
}

// ──────────────────────────────────────────────────────────────
// Filas
// ──────────────────────────────────────────────────────────────

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View>
      <Text v="captionStrong" tone="textMuted" style={styles.groupTitle}>{title}</Text>
      {children}
    </View>
  );
}

interface RowProps {
  icon: IconName;
  label: string;
  value?: string;
  detail?: string;
  badge?: string;
  /** Marca de verificado junto al valor. */
  verified?: boolean;
  /** Se guardó una sola vez: el toque lleva a soporte, no a editar. */
  locked?: boolean;
  onPress?: () => void;
  last?: boolean;
}

function Row({ icon, label, value, detail, badge, verified, locked, onPress, last }: RowProps) {
  const { c, isDark } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={[label, value, detail].filter(Boolean).join('. ')}
      style={({ pressed }) => [
        styles.row,
        !last && {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)',
        },
        pressed && { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)' },
      ]}
    >
      <View style={styles.iconSlot}>
        <Icon name={icon} size={24} color={c.text} />
      </View>

      <View style={styles.flex}>
        <Text v="caption" tone="textMuted">{label}</Text>
        {value ? (
          <View style={styles.valueLine}>
            <Text v="strongM" numberOfLines={1} style={styles.flexShrink}>{value}</Text>
            {verified ? <Icon name="checkCirculo" size={16} color={c.success} /> : null}
            {locked ? <Icon name="candado" size={14} color={c.textMuted} /> : null}
          </View>
        ) : null}
        {detail ? <Text v="caption" tone="textMuted" numberOfLines={2}>{detail}</Text> : null}
      </View>

      {badge ? (
        <View style={[styles.badge, { backgroundColor: c.primarySoft }]}>
          <Text v="captionStrong" tone="primaryText">{badge}</Text>
        </View>
      ) : null}

      {onPress ? <Icon name="siguiente" size="sm" color={c.textMuted} /> : null}
    </Pressable>
  );
}

// ──────────────────────────────────────────────────────────────
// Hojas de edición
// ──────────────────────────────────────────────────────────────

interface SheetProps {
  visible: boolean;
  onClose: () => void;
}

/** Guarda en el servidor y deja el `user` del store con lo que respondió. */
function useSaveProfile() {
  const setUser = useAuthStore((s) => s.setUser);
  return async (data: Parameters<typeof authApi.updateProfile>[0]) => {
    const result = await authApi.updateProfile(data);
    setUser(result.user);
    return result;
  };
}

function NameSheet({ visible, onClose }: SheetProps) {
  const user = useAuthStore((s) => s.user);
  const save = useSaveProfile();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [errors, setErrors] = useState<{ first?: string; last?: string }>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setFirstName(givenName(user));
    setLastName(user?.lastName ?? '');
    setErrors({});
    setFormError('');
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const first = firstName.trim().replace(/\s+/g, ' ');
    const last = lastName.trim().replace(/\s+/g, ' ');
    const next = {
      first: first.length < 2 ? 'Escribe tu nombre' : undefined,
      last: last.length < 2 ? 'Escribe tu apellido' : undefined,
    };
    if (next.first || next.last) {
      setErrors(next);
      tap('error');
      return;
    }

    setSaving(true);
    setFormError('');
    try {
      await save({ firstName: first, lastName: last });
      tap('success');
      onClose();
    } catch (error) {
      setFormError(fieldMessage(error, 'No pudimos guardar tu nombre.'));
      tap('error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Nombre y apellido"
      height={0.65}
      footer={<Button title="Guardar" size="lg" full loading={saving} onPress={submit} haptic="medium" />}
    >
      {!user?.lastName ? (
        <Notice tone="info">
          Antes guardábamos tu nombre completo en un solo campo. Revisa que en "Nombres" quede solo tu nombre.
        </Notice>
      ) : null}
      <PlainField
        label="Nombres"
        icon="perfil"
        value={firstName}
        onChangeText={(t) => { setFirstName(t); setErrors((e) => ({ ...e, first: undefined })); }}
        error={errors.first}
        autoCapitalize="words"
        maxLength={60}
      />
      <PlainField
        label="Apellidos"
        icon="perfil"
        value={lastName}
        onChangeText={(t) => { setLastName(t); setErrors((e) => ({ ...e, last: undefined })); }}
        error={errors.last}
        autoCapitalize="words"
        maxLength={60}
      />
      {formError ? <Notice tone="error">{formError}</Notice> : null}
    </Sheet>
  );
}

function PhoneSheet({ visible, onClose }: SheetProps) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const save = useSaveProfile();
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setPhone(user?.pendingPhone ?? user?.phone ?? '');
    setError(undefined);
    setFormError('');
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const problem = validatePhone(phone);
    if (problem) { setError(problem); tap('error'); return; }

    setSaving(true);
    setFormError('');
    try {
      const { user: updated, phoneVerificationSent } = await save({ phone: phone.replace(/\D/g, '') });
      onClose();
      if (updated.pendingPhone) router.push(ROUTES.verifyPhone(phoneVerificationSent) as never);
    } catch (err) {
      setFormError(fieldMessage(err, 'No pudimos guardar tu celular.'));
      tap('error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Celular"
      height={0.55}
      footer={<Button title="Enviar código" size="lg" full loading={saving} onPress={submit} haptic="medium" />}
    >
      <PlainField
        label="Número de celular"
        icon="celular"
        prefix="+57"
        value={phone}
        onChangeText={(t) => { setPhone(t); setError(undefined); }}
        error={error}
        keyboardType="phone-pad"
        maxLength={10}
        numeric
        hint="Te mandamos un código por WhatsApp. Hasta confirmarlo, tu número no cambia."
      />
      {formError ? <Notice tone="error">{formError}</Notice> : null}
    </Sheet>
  );
}

/**
 * Correo: escribirlo y verificarlo en la misma hoja.
 *
 * El envío de correos del servidor puede estar apagado (`EMAIL_OTP_DISABLED`).
 * Entonces se dice tal cual y se ofrece soporte, en vez de un botón que no
 * lleva a ninguna parte.
 */
function EmailSheet({ visible, onClose }: SheetProps) {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const save = useSaveProfile();
  const [email, setEmail] = useState('');
  const [stage, setStage] = useState<'edit' | 'code'>('edit');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setEmail(user?.email ?? '');
    setStage('edit');
    setCode('');
    setError(undefined);
    setFormError('');
    setUnavailable(false);
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const sendCode = async () => {
    try {
      await authApi.sendEmailVerification();
      setStage('code');
      tap('light');
    } catch (err) {
      if ((err as any)?.response?.data?.code === 'EMAIL_OTP_DISABLED') {
        setUnavailable(true);
        return;
      }
      throw err;
    }
  };

  const submitEmail = async () => {
    const problem = validateEmail(email);
    if (problem) { setError(problem); tap('error'); return; }

    setBusy(true);
    setFormError('');
    try {
      const clean = email.trim().toLowerCase();
      if (clean !== (user?.email ?? '')) await save({ email: clean });
      await sendCode();
    } catch (err) {
      setFormError(fieldMessage(err, 'No pudimos guardar tu correo.'));
      tap('error');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value: string) => {
    if (value.length !== 6 || busy) return;
    setBusy(true);
    setFormError('');
    try {
      const data = await authApi.verifyEmail(value);
      setUser(data.user);
      tap('success');
      onClose();
    } catch (err) {
      setFormError(apiMessage(err, 'Ese código no es correcto.'));
      setCode('');
      tap('error');
    } finally {
      setBusy(false);
    }
  };

  const footer = unavailable
    ? (
      <Button
        title="Escribir a soporte"
        size="lg"
        full
        onPress={() => askSupport(`Hola, quiero verificar mi correo ${email.trim()} en Zipp.`)}
      />
    )
    : stage === 'edit'
      ? <Button title="Guardar y verificar" size="lg" full loading={busy} onPress={submitEmail} haptic="medium" />
      : <Button title="Verificar" size="lg" full loading={busy} onPress={() => verify(code)} haptic="medium" />;

  return (
    <Sheet visible={visible} onClose={onClose} title="Correo" height={0.65} footer={footer}>
      {stage === 'edit' ? (
        <PlainField
          label="Correo electrónico"
          icon="correo"
          placeholder="tucorreo@ejemplo.com"
          value={email}
          onChangeText={(t) => { setEmail(t); setError(undefined); setUnavailable(false); }}
          error={error}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
        />
      ) : (
        <>
          <Text v="bodyM" tone="textSecondary">
            Te mandamos un código de 6 dígitos a {user?.email}.
          </Text>
          <OtpInput
            value={code}
            onChange={(next) => {
              setCode(next);
              setFormError('');
              if (next.length === 6) verify(next);
            }}
            error={!!formError}
            autoFocus
          />
        </>
      )}

      {unavailable ? (
        <Notice tone="info">
          La verificación por correo todavía no está disponible. Tu correo quedó guardado; si necesitas
          verificarlo ya, escríbenos y lo hacemos por ti.
        </Notice>
      ) : null}
      {formError ? <Notice tone="error">{formError}</Notice> : null}
    </Sheet>
  );
}

function DocumentSheet({ visible, onClose }: SheetProps) {
  const user = useAuthStore((s) => s.user);
  const save = useSaveProfile();
  const [type, setType] = useState<DocumentType>('CC');
  const [number, setNumber] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setType(user?.documentType ?? 'CC');
    setNumber(user?.documentNumber ?? '');
    setError(undefined);
    setFormError('');
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const persist = async (data: { documentType: DocumentType | null; documentNumber: string | null }) => {
    setSaving(true);
    setFormError('');
    try {
      await save(data);
      tap('success');
      onClose();
    } catch (err) {
      setFormError(fieldMessage(err, 'No pudimos guardar tu documento.'));
      tap('error');
    } finally {
      setSaving(false);
    }
  };

  const submit = () => {
    const clean = normalizeDocumentNumber(type, number);
    const problem = clean ? validateDocumentNumber(type, clean) : 'Escribe el número de tu documento';
    if (problem) { setError(problem); tap('error'); return; }
    void persist({ documentType: type, documentNumber: clean });
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Documento de identidad"
      height={0.75}
      footer={<Button title="Guardar" size="lg" full loading={saving} onPress={submit} haptic="medium" />}
    >
      <Text v="bodyM" tone="textSecondary">
        Es opcional. Lo usamos solo para que las facturas salgan a tu nombre.
      </Text>

      <PlainSelect
        label="Tipo de documento"
        icon="identificacion"
        options={DOCUMENT_TYPES}
        value={type}
        onChange={(next) => { setType(next); setError(undefined); }}
      />

      <PlainField
        label="Número"
        icon="documento"
        value={number}
        onChangeText={(t) => { setNumber(t); setError(undefined); }}
        error={error}
        keyboardType={type === 'PASAPORTE' ? 'default' : 'number-pad'}
        autoCapitalize="characters"
        maxLength={20}
        numeric={type !== 'PASAPORTE'}
      />

      {formError ? <Notice tone="error">{formError}</Notice> : null}

      {user?.documentNumber ? (
        <Pressable
          onPress={() => persist({ documentType: null, documentNumber: null })}
          accessibilityRole="button"
          hitSlop={8}
          style={styles.centered}
        >
          <Text v="strongS" tone="textMuted">Quitar documento</Text>
        </Pressable>
      ) : null}
    </Sheet>
  );
}

function MarketingSheet({ visible, onClose }: SheetProps) {
  const { c } = useTheme();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [consent, setConsent] = useState(false);
  const [channels, setChannels] = useState<MarketingChannel[]>([]);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setConsent(!!user?.marketingConsent);
    setChannels(user?.marketingChannels ?? []);
    setFormError('');
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleChannel = (ch: MarketingChannel) => {
    tap('select');
    setChannels((list) => (list.includes(ch) ? list.filter((x) => x !== ch) : [...list, ch]));
  };

  const submit = async () => {
    // Aceptar sin ningún canal sería decir "sí" a nada: se trata como no.
    const finalConsent = consent && channels.length > 0;
    setSaving(true);
    setFormError('');
    try {
      const prefs = await authApi.updateMarketingPreferences(finalConsent, finalConsent ? channels : []);
      if (user) setUser({ ...user, ...prefs });
      tap('success');
      onClose();
    } catch (err) {
      setFormError(apiMessage(err, 'No pudimos guardar tus preferencias.'));
      tap('error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Promociones y novedades"
      height={0.7}
      footer={<Button title="Guardar" size="lg" full loading={saving} onPress={submit} haptic="medium" />}
    >
      <View style={styles.switchRow}>
        <View style={styles.flex}>
          <Text v="strongM">Quiero recibir ofertas</Text>
          <Text v="caption" tone="textMuted">
            Cupones, descuentos y novedades de Zipp. Lo del estado de tus pedidos te llega igual.
          </Text>
        </View>
        <Switch
          value={consent}
          onValueChange={(v) => { tap('select'); setConsent(v); if (v && channels.length === 0) setChannels(['whatsapp']); }}
          trackColor={{ true: c.primary, false: c.borderStrong }}
          accessibilityLabel="Recibir ofertas"
        />
      </View>

      {consent ? (
        <>
          <Text v="captionStrong" tone="textMuted">POR DÓNDE</Text>
          <View style={styles.chips}>
            {CHANNELS.map((ch) => (
              <Chip
                key={ch.value}
                label={ch.label}
                active={channels.includes(ch.value)}
                onPress={() => toggleChannel(ch.value)}
              />
            ))}
          </View>
        </>
      ) : null}

      <Text v="caption" tone="textMuted">
        Puedes cambiar esto cuando quieras. Es tu derecho según la Ley 1581 de 2012.
      </Text>

      {formError ? <Notice tone="error">{formError}</Notice> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg, gap: Spacing.xxl },
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1 },
  avatarRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.lg },
  avatarAction: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
  groupTitle: { letterSpacing: 0.8, fontSize: 11, marginBottom: Spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: Spacing.md },
  iconSlot: { width: 32, alignItems: 'center', justifyContent: 'center' },
  valueLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  deleteRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: Spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  centered: { alignItems: 'center', paddingVertical: Spacing.sm },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
});
