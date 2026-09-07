import { useState, useEffect } from 'react';
import { View, ScrollView, Pressable, StyleSheet, Alert, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import {
  Text, Icon, Button, Input, Sheet, Notice,
} from '../../../components/ui';
import {
  ContentIcon,
  type ContentIllustrationName,
} from '../../../components/illustrations';
import { Avatar } from '../../../components/domain/Avatar';
import { useAuthStore } from '../../../stores/authStore';
import { useCartStore } from '../../../stores/cartStore';
import { useFavoritesStore } from '../../../stores/favoritesStore';
import { useThemeStore } from '../../../stores/themeStore';
import { usePrefsStore } from '../../../stores/prefsStore';
import { useAddresses } from '../../../hooks/useApi';
import { useZippStats } from '../../../hooks/useUsual';
import { useTheme } from '../../../hooks/useTheme';
import { useTabContentPadding, CLIENT_DOCK_CLEARANCE } from '../../../hooks/useBottomSpace';
import { authApi } from '../../../services/endpoints';
import { socketService } from '../../../services/socket';
import { unregisterPush } from '../../../hooks/usePushNotifications';
import type { IconName } from '../../../theme/icons';
import { Spacing, FontSize, BorderRadius } from '../../../theme/tokens';
import { prepareAvatarForUpload } from '../../../lib/avatarImage';
import { apiMessage, validateName, validatePhone } from '../../../lib/errors';
import { tap } from '../../../lib/haptics';
import { SUPPORT_PHONE } from '../../../constants/config';


interface MenuLink {
  /** Ilustración de contenido (categorías, beneficios, módulos). */
  illustration?: ContentIllustrationName;
  /** Icono funcional lucide, para acciones simples como ajustes. */
  icon?: IconName;
  label: string;
  detail?: string;
  badge?: string;
  /** Navega a esta ruta al tocar la fila. */
  route?: string;
  /** Parámetros de la ruta, para pantallas que sirven a varias filas. */
  params?: Record<string, string>;
  /** O, en vez de navegar, ejecuta esta acción (permisos del sistema, etc.). */
  action?: () => void;
}

export default function ProfileScreen() {
  const router = useRouter();
  const { c, isDark } = useTheme();
  const bottomSpace = useTabContentPadding(CLIENT_DOCK_CLEARANCE);
  const { user, logout } = useAuthStore();

  const { data: addresses = [] } = useAddresses();
  const favorites = useFavoritesStore((s) => s.favorites);
  const clearCart = useCartStore((s) => s.clearCart);
  const stats = useZippStats();

  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const resetPrefs = usePrefsStore((s) => s.reset);

  const [editing, setEditing] = useState(false);

  const replayOnboarding = () => {
    tap('light');
    resetPrefs();
    router.replace('/(auth)/welcome');
  };

  /**
   * Abre WhatsApp con el mensaje ya escrito. Todavía no existe un registro de
   * aliados ni de domiciliarios dentro de la app, así que la postulación se
   * hace por el mismo canal que soporte, y no por un formulario que no lleva
   * a ninguna parte. Si WhatsApp no está instalado, cae a la llamada.
   */
  const writeToZipp = (text: string) => {
    const url = `whatsapp://send?phone=57${SUPPORT_PHONE}&text=${encodeURIComponent(text)}`;
    Linking.openURL(url).catch(() => {
      Linking.openURL(`tel:${SUPPORT_PHONE}`).catch(() => {});
    });
  };

  const accountLinks: MenuLink[] = [
    {
      illustration: 'ubicacion',
      label: 'Mis direcciones',
      detail: `${addresses.length} guardada${addresses.length === 1 ? '' : 's'}`,
      route: '/(client)/addresses',
    },
    {
      illustration: 'favorito',
      label: 'Negocios favoritos',
      detail: `${favorites.length} guardado${favorites.length === 1 ? '' : 's'}`,
      route: '/(client)/favorites',
    },
  ];

  const zippLinks: MenuLink[] = [
    {
      illustration: 'trofeo',
      label: 'Tus puntos Zipp y cupones',
      detail: `${stats.points} puntos acumulados`,
      badge: `${stats.points} pts`,
      route: '/(client)/rewards',
    },
  ];

  const joinLinks: MenuLink[] = [
    {
      illustration: 'negocio',
      label: 'Aliar mi negocio a Zipp',
      detail: 'Escríbenos para registrar tu comercio',
      action: () => writeToZipp('Hola, quiero aliar mi negocio a Zipp.'),
    },
    {
      illustration: 'domiciliario',
      label: 'Empezar a repartir con Zipp',
      detail: 'Escríbenos para postularte como domiciliario',
      action: () => writeToZipp('Hola, quiero empezar a repartir con Zipp.'),
    },
  ];

  const helpLinks: MenuLink[] = [
    {
      illustration: 'ayuda',
      label: 'Centro de ayuda',
      detail: 'Preguntas y soporte técnico',
      route: '/(client)/help',
    },
    {
      illustration: 'seguridad',
      label: 'Centro legal, datos y SIC',
      detail: 'Políticas de privacidad y términos del servicio',
      route: '/(client)/legal',
    },
    {
      illustration: 'soporte',
      label: 'PQRS y solicitudes de datos',
      detail: 'Radica consultas, quejas o reclamos',
      route: '/(client)/requests',
    },
  ];

  // Cada fila abre el mismo lector y le dice qué documento buscar.
  const legalLinks: MenuLink[] = [
    {
      illustration: 'documento',
      label: 'Términos y condiciones',
      route: '/(client)/legal-document',
      params: { kind: 'terms', title: 'Términos y condiciones' },
    },
    {
      illustration: 'documento',
      label: 'Políticas de privacidad',
      route: '/(client)/legal-document',
      params: { kind: 'privacy', title: 'Políticas de privacidad' },
    },
    {
      illustration: 'documento',
      label: 'Autorización de tratamiento de datos personales',
      route: '/(client)/legal-document',
      params: { kind: 'habeas_data', title: 'Autorización de datos' },
    },
  ];

  const systemLinks: MenuLink[] = [
    {
      illustration: 'ubicacion',
      label: 'Ubicación y GPS',
      detail: 'Permiso para calcular tiempos y rutas de entrega',
      action: () => Linking.openSettings().catch(() => {}),
    },
    {
      illustration: 'notificaciones',
      label: 'Notificaciones del sistema',
      detail: 'Avisos en vivo del estado de tus pedidos',
      action: () => Linking.openSettings().catch(() => {}),
    },
    {
      icon: 'rayo',
      label: 'Ver la introducción otra vez',
      detail: 'Reinicia el tutorial de bienvenida',
      action: replayOnboarding,
    },
  ];

  const confirmLogout = () => {
    tap('warning');
    Alert.alert('Cerrar sesión', '¿Seguro que quieres salir de tu cuenta Zipp?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Cerrar sesión',
        style: 'destructive',
        onPress: async () => {
          // Baja del push antes de soltar la sesión: después, la petición
          // fallaría y el backend seguiría notificando a este teléfono.
          await unregisterPush();
          socketService.disconnect();
          clearCart();
          logout();
          router.replace('/(auth)/login');
        },
      },
    ]);
  };

  return (
    <SafeAreaView
      style={[styles.screen, { backgroundColor: isDark ? '#0C101C' : '#F1F3F7' }]}
      edges={['top']}
    >
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomSpace }]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Encabezado ── */}
        <View style={styles.headerArea}>
          <Text v="displayM" style={styles.headerTitle}>
            Perfil
          </Text>
          <Text v="bodyS" tone="textMuted">
            Gestiona tu cuenta, direcciones y beneficios
          </Text>
        </View>

        {/* ── Cuenta: sin card, integrada al fondo de la pantalla ── */}
        <View style={styles.heroRow}>
          <Avatar uri={user?.avatar} name={user?.name} size={56} />

          <View style={styles.heroInfo}>
            <Text v="strongL" numberOfLines={1} style={styles.userName}>
              {user?.name ?? 'Tu cuenta Zipp'}
            </Text>
            <Text v="dataS" tone="textMuted">
              {user?.phone ? `+57 ${user.phone}` : 'Usuario Zipp'}
            </Text>
          </View>

          <Pressable
            onPress={() => {
              tap('light');
              setEditing(true);
            }}
            accessibilityRole="button"
            accessibilityLabel="Editar perfil"
            hitSlop={8}
            style={styles.editTouch}
          >
            <Icon name="editar" size="sm" color={c.textMuted} />
            <Text v="strongS" tone="textMuted">Editar</Text>
          </Pressable>
        </View>

        <View style={[styles.hairline, { backgroundColor: c.borderLight }]} />

        {/* ── Resumen de actividad Zipp: fila simple, sin caja pesada ── */}
        <Pressable
          onPress={() => {
            tap('light');
            router.push('/(client)/rewards');
          }}
          accessibilityRole="button"
          accessibilityLabel={`Tus puntos Zipp: ${stats.points} puntos, ${stats.orderCount} pedidos, racha de ${stats.streak} semanas`}
          style={({ pressed }) => [styles.statsRow, pressed && { opacity: 0.7 }]}
        >
          <View style={styles.statCol}>
            <ContentIcon name="trofeo" size={30} />
            <Text v="titleL" tone="primaryText">{stats.points}</Text>
            <Text v="caption" tone="textMuted">Puntos</Text>
          </View>

          <View style={styles.statCol}>
            <ContentIcon name="paquete" size={30} />
            <Text v="titleL" color={c.text}>{stats.orderCount}</Text>
            <Text v="caption" tone="textMuted">Pedidos</Text>
          </View>

          <View style={styles.statCol}>
            <ContentIcon name="racha" size={30} />
            <Text v="titleL" color={c.text}>{stats.streak}</Text>
            <Text v="caption" tone="textMuted">Semanas</Text>
          </View>
        </Pressable>

        {/* ── Grupo 1: Mi Cuenta ── */}
        <MenuGroup title="MI CUENTA" links={accountLinks} />

        {/* ── Grupo 2: Beneficios Zipp ── */}
        <MenuGroup title="BENEFICIOS Y PUNTOS" links={zippLinks} />

        {/* ── Grupo 3: Trabajar con Zipp ── */}
        <MenuGroup title="TRABAJA CON ZIPP" links={joinLinks} />

        {/* ── Pantalla y apariencia: mockups, sin caja alrededor ── */}
        <View style={styles.groupContainer}>
          <Text v="captionStrong" tone="textMuted" style={styles.groupTitle}>
            PANTALLA Y APARIENCIA
          </Text>
          <View style={styles.themeCardsRow}>
            <ThemePreviewCard
              mode="light"
              label="Claro"
              isSelected={theme === 'light'}
              onSelect={() => { tap('select'); setTheme('light'); }}
            />
            <ThemePreviewCard
              mode="dark"
              label="Oscuro"
              isSelected={theme === 'dark'}
              onSelect={() => { tap('select'); setTheme('dark'); }}
            />
            <ThemePreviewCard
              mode="auto"
              label="Sistema"
              isSelected={theme === 'auto'}
              onSelect={() => { tap('select'); setTheme('auto'); }}
            />
          </View>
        </View>

        {/* ── Grupo 4: Ayuda y legal ── */}
        <MenuGroup title="AYUDA Y LEGAL" links={helpLinks} />

        {/* ── Grupo 5: los documentos legales, cada uno por separado ── */}
        <MenuGroup title="TÉRMINOS Y PRIVACIDAD" links={legalLinks} />

        {/* ── Grupo 6: Permisos y sistema ── */}
        <MenuGroup title="PERMISOS Y SISTEMA" links={systemLinks} last />

        {/* ── Cerrar sesión ── */}
        <Pressable
          onPress={confirmLogout}
          accessibilityRole="button"
          accessibilityLabel="Cerrar sesión"
          accessibilityHint="Cierra tu sesión en este dispositivo"
          style={({ pressed }) => [
            styles.logoutButton,
            {
              backgroundColor: isDark ? 'rgba(239, 68, 68, 0.08)' : 'rgba(239, 68, 68, 0.05)',
              borderColor: isDark ? 'rgba(239, 68, 68, 0.22)' : 'rgba(239, 68, 68, 0.16)',
            },
            pressed && {
              backgroundColor: isDark ? 'rgba(239, 68, 68, 0.15)' : 'rgba(239, 68, 68, 0.10)',
              transform: [{ scale: 0.985 }],
            },
          ]}
        >
          <View
            style={[
              styles.logoutIconBadge,
              {
                backgroundColor: isDark ? 'rgba(239, 68, 68, 0.18)' : 'rgba(239, 68, 68, 0.12)',
              },
            ]}
          >
            <Icon name="salir" size="md" color={c.error} />
          </View>

          <View style={styles.logoutTextBody}>
            <Text v="strongM" color={c.error}>
              Cerrar sesión
            </Text>
            <Text v="caption" tone="textMuted">
              Desconectar tu cuenta de este dispositivo
            </Text>
          </View>

          <View style={styles.logoutArrow}>
            <Icon name="siguiente" size="sm" color={c.error} />
          </View>
        </Pressable>

        {/* ── Footer ── */}
        <View style={styles.footer}>
          <Text v="dataS" tone="textMuted">ZIPP</Text>
          <Text v="caption" tone="textMuted" center>
            Versión 1.0.0 • El Trazo OS
          </Text>
        </View>
      </ScrollView>

      {/* ── Edit Profile Sheet ── */}
      <EditProfileSheet visible={editing} onClose={() => setEditing(false)} />
    </SafeAreaView>
  );
}

// ──────────────────────────────────────────────────────────────
// Grupo de menú: título + filas con divisor delgado, sin caja
// ──────────────────────────────────────────────────────────────

function MenuGroup({ title, links, last }: { title: string; links: MenuLink[]; last?: boolean }) {
  const { c, isDark } = useTheme();
  const router = useRouter();

  return (
    <View style={styles.groupContainer}>
      <Text v="captionStrong" tone="textMuted" style={styles.groupTitle}>
        {title}
      </Text>

      {links.map((link, idx) => (
        <Pressable
          key={link.label}
          onPress={() => {
            tap('light');
            if (link.action) link.action();
            else if (link.route) {
              router.push(
                (link.params
                  ? { pathname: link.route, params: link.params }
                  : link.route) as never,
              );
            }
          }}
          accessibilityRole="button"
          accessibilityLabel={link.detail ? `${link.label}. ${link.detail}` : link.label}
          style={({ pressed }) => [
            styles.linkPressable,
            idx < links.length - 1 || !last
              ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)' }
              : null,
            pressed && { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.02)' },
          ]}
        >
          <View style={styles.linkIconSlot}>
            {link.illustration ? (
              <ContentIcon name={link.illustration} size={30} />
            ) : (
              <Icon name={link.icon ?? 'ajustes'} size="md" color={c.textMuted} />
            )}
          </View>

          <View style={styles.linkTextBody}>
            {/* Dos líneas: los nombres de los documentos legales son largos. */}
            <Text v="strongM" numberOfLines={2}>
              {link.label}
            </Text>
            {link.detail ? (
              <Text v="caption" tone="textMuted" numberOfLines={1}>
                {link.detail}
              </Text>
            ) : null}
          </View>

          {link.badge ? (
            <View style={[styles.badgePill, { backgroundColor: c.primarySoft }]}>
              <Text v="captionStrong" tone="primaryText">{link.badge}</Text>
            </View>
          ) : null}

          <Icon name="siguiente" size="sm" color={c.textMuted} />
        </Pressable>
      ))}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────
// Miniatura de teléfono para elegir tema (claro / oscuro / sistema)
// ──────────────────────────────────────────────────────────────

function ThemePreviewCard({
  mode,
  label,
  isSelected,
  onSelect,
}: {
  mode: 'light' | 'dark' | 'auto';
  label: string;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { c, isDark } = useTheme();

  return (
    <Pressable
      onPress={onSelect}
      accessibilityRole="radio"
      accessibilityState={{ selected: isSelected }}
      accessibilityLabel={`Seleccionar tema ${label}`}
      style={[styles.themeCardWrapper, isSelected && { transform: [{ scale: 1.02 }] }]}
    >
      <View
        style={[
          styles.phoneMockup,
          mode === 'light' && styles.phoneMockupLight,
          mode === 'dark' && styles.phoneMockupDark,
          mode === 'auto' && styles.phoneMockupAuto,
          {
            borderColor: isSelected ? c.primary : isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.10)',
            borderWidth: isSelected ? 2.5 : 1.5,
          },
        ]}
      >
        <View style={[styles.mockupNotch, { backgroundColor: mode === 'light' ? '#D1D5DB' : '#374151' }]} />

        {mode === 'auto' ? (
          <View style={styles.splitMockupContent}>
            <View style={styles.splitLightHalf}>
              <View style={[styles.mockupCardLine, { backgroundColor: '#4B3BFF', width: '70%' }]} />
              <View style={[styles.mockupContentBlock, { backgroundColor: '#E5E7EB' }]} />
            </View>
            <View style={styles.splitDarkHalf}>
              <View style={[styles.mockupCardLine, { backgroundColor: '#7D72FF', width: '70%' }]} />
              <View style={[styles.mockupContentBlock, { backgroundColor: '#262C40' }]} />
            </View>
          </View>
        ) : (
          <View style={styles.mockupContent}>
            <View
              style={[
                styles.mockupCardLine,
                { backgroundColor: mode === 'light' ? '#4B3BFF' : '#7D72FF', width: '60%', marginTop: 2 },
              ]}
            />
            <View style={[styles.mockupContentBlock, { backgroundColor: mode === 'light' ? '#E5E7EB' : '#262C40' }]}>
              <View
                style={[styles.mockupMiniLine, { backgroundColor: mode === 'light' ? '#9CA3AF' : '#4B5563', width: '40%' }]}
              />
            </View>
            <View style={[styles.mockupContentBlock, { backgroundColor: mode === 'light' ? '#E5E7EB' : '#262C40' }]}>
              <View
                style={[styles.mockupMiniLine, { backgroundColor: mode === 'light' ? '#9CA3AF' : '#4B5563', width: '55%' }]}
              />
            </View>
          </View>
        )}
      </View>

      <View style={styles.themeLabelContainer}>
        <View
          style={[
            styles.radioIndicator,
            {
              borderColor: isSelected ? c.primary : c.borderStrong,
              backgroundColor: isSelected ? c.primary : 'transparent',
            },
          ]}
        >
          {isSelected ? <View style={styles.radioIndicatorDot} /> : null}
        </View>
        <Text v={isSelected ? 'strongS' : 'bodyS'} color={isSelected ? c.primaryText : c.textSecondary}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

// ──────────────────────────────────────────────────────────────
// Hoja para Editar Perfil
// ──────────────────────────────────────────────────────────────

function EditProfileSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const router = useRouter();
  const { c } = useTheme();
  const { user, setUser } = useAuthStore();

  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  const pickAvatar = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setFormError('Necesitamos permiso para acceder a tus fotos.');
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

    setFormError('');
    setUploadingAvatar(true);
    try {
      const ready = await prepareAvatarForUpload(picked.assets[0].uri);
      const data = await authApi.uploadAvatar(ready);
      setUser(data.user);
      tap('success');
    } catch (error) {
      setFormError(apiMessage(error, 'No pudimos actualizar tu foto de perfil.'));
      tap('error');
    } finally {
      setUploadingAvatar(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    setName(user.name);
    setEmail(user.email ?? '');
    setPhone(user.phone ?? '');
  }, [user, visible]);

  const phoneChanged = phone.replace(/\D/g, '') !== user?.phone;

  const save = async () => {
    const nameError = validateName(name);
    const phoneError = validatePhone(phone);

    if (nameError || phoneError) {
      setErrors({ name: nameError ?? undefined, phone: phoneError ?? undefined });
      tap('error');
      return;
    }

    setErrors({});
    setFormError('');
    setSaving(true);

    try {
      const data = await authApi.updateProfile({
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.replace(/\D/g, ''),
      });
      setUser(data.user);
      tap('success');
      onClose();

      if (!data.user.isVerified) router.replace('/(auth)/otp');
    } catch (error) {
      setFormError(apiMessage(error, 'No pudimos guardar los cambios.'));
      tap('error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Editar perfil"
      height={0.8}
      footer={
        <Button
          title="Guardar cambios"
          size="lg"
          full
          loading={saving}
          onPress={save}
          haptic="medium"
        />
      }
    >
      <View style={styles.avatarEditRow}>
        <Avatar uri={user?.avatar} name={name} size={72} fontVariant="titleL" />
        <Pressable
          onPress={pickAvatar}
          disabled={uploadingAvatar}
          accessibilityRole="button"
          accessibilityLabel="Cambiar foto de perfil"
          style={({ pressed }) => [
            styles.avatarEditBtn,
            { borderColor: c.borderStrong },
            pressed && { opacity: 0.6 },
          ]}
        >
          <Icon name="editar" size="sm" color={c.primaryText} />
          <Text v="strongS" tone="primaryText">
            {uploadingAvatar ? 'Subiendo…' : 'Cambiar foto'}
          </Text>
        </Pressable>
      </View>

      <Input
        label="Nombre completo"
        icon="perfil"
        value={name}
        onChangeText={(t) => {
          setName(t);
          setErrors((e) => ({ ...e, name: undefined }));
        }}
        error={errors.name}
        autoCapitalize="words"
      />

      <Input
        label="Correo electrónico (opcional)"
        icon="correo"
        placeholder="tucorreo@ejemplo.com"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
        editable={!user?.emailVerified}
        hint={user?.emailVerified ? 'Correo verificado. Solo soporte puede cambiarlo.' : undefined}
      />

      <Input
        label="Número de celular"
        icon="celular"
        prefix="+57"
        value={phone}
        onChangeText={(t) => {
          setPhone(t);
          setErrors((e) => ({ ...e, phone: undefined }));
        }}
        error={errors.phone}
        keyboardType="phone-pad"
        maxLength={10}
        numeric
        editable={!user?.phoneVerified}
        hint={user?.phoneVerified ? 'Celular verificado. Solo soporte puede cambiarlo.' : undefined}
      />

      {phoneChanged ? (
        <Notice tone="warning">
          Si cambias tu número de celular deberás verificarlo nuevamente con un código de WhatsApp.
        </Notice>
      ) : null}

      {formError ? <Notice tone="error">{formError}</Notice> : null}
    </Sheet>
  );
}

// ──────────────────────────────────────────────────────────────
// Estilos
// ──────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    gap: Spacing.xxl,
  },

  // Header
  headerArea: {
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.xs,
    gap: 4,
  },
  headerTitle: {
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: -0.8,
  },

  // Cuenta (sin card)
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Editar foto de perfil (dentro de la hoja)
  avatarEditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginBottom: Spacing.md,
  },
  avatarEditBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  heroInfo: {
    flex: 1,
    gap: 2,
  },
  userName: {
    fontSize: FontSize.lg,
  },
  editTouch: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  hairline: {
    height: StyleSheet.hairlineWidth,
    marginTop: -Spacing.md,
  },

  // Resumen de actividad (fila simple)
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: -Spacing.md,
  },
  statCol: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },

  // Grupos de menú
  groupContainer: {
    gap: 0,
  },
  groupTitle: {
    letterSpacing: 0.8,
    fontSize: 11,
    marginBottom: Spacing.sm,
  },
  linkPressable: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: Spacing.md,
  },
  linkIconSlot: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkTextBody: {
    flex: 1,
    gap: 2,
  },
  badgePill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },

  // Selector de tema (miniaturas de teléfono)
  themeCardsRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    justifyContent: 'space-between',
  },
  themeCardWrapper: {
    flex: 1,
    alignItems: 'center',
    gap: Spacing.xs + 1,
  },
  phoneMockup: {
    width: '100%',
    height: 70,
    borderRadius: 13,
    alignItems: 'center',
    paddingTop: 5,
    paddingHorizontal: 6,
    overflow: 'hidden',
  },
  phoneMockupLight: { backgroundColor: '#FFFFFF' },
  phoneMockupDark: { backgroundColor: '#121727' },
  phoneMockupAuto: { backgroundColor: '#F3F4F6' },
  mockupNotch: {
    width: 18,
    height: 2.5,
    borderRadius: 1.25,
    marginBottom: 5,
  },
  mockupContent: { width: '100%', gap: 3 },
  mockupCardLine: { height: 4, borderRadius: 2 },
  mockupContentBlock: {
    height: 13,
    borderRadius: 5,
    padding: 2.5,
    justifyContent: 'center',
  },
  mockupMiniLine: { height: 2.5, borderRadius: 1.25 },
  splitMockupContent: {
    flexDirection: 'row',
    width: '100%',
    height: '100%',
    gap: 2,
  },
  splitLightHalf: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 4,
    padding: 2.5,
    gap: 2.5,
  },
  splitDarkHalf: {
    flex: 1,
    backgroundColor: '#121727',
    borderRadius: 4,
    padding: 2.5,
    gap: 2.5,
  },
  themeLabelContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  radioIndicator: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioIndicatorDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#FFFFFF',
  },

  // Cerrar sesión
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    gap: Spacing.md,
    marginTop: Spacing.xs,
  },
  logoutIconBadge: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoutTextBody: {
    flex: 1,
    gap: 2,
  },
  logoutArrow: {
    opacity: 0.45,
  },

  // Footer
  footer: {
    alignItems: 'center',
    gap: 4,
    marginTop: Spacing.sm,
  },
});
