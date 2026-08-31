import { useState, useEffect } from 'react';
import { View, ScrollView, Pressable, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  Text, Icon, Button, Input, Sheet, Notice,
} from '../../../components/ui';
import { useAuthStore } from '../../../stores/authStore';
import { useCartStore } from '../../../stores/cartStore';
import { useFavoritesStore } from '../../../stores/favoritesStore';
import { useAddresses } from '../../../hooks/useApi';
import { useZippStats } from '../../../hooks/useUsual';
import { useTheme } from '../../../hooks/useTheme';
import { authApi } from '../../../services/endpoints';
import { socketService } from '../../../services/socket';
import type { IconName } from '../../../theme/icons';
import { BorderRadius, Spacing, FontSize } from '../../../theme/tokens';
import { initials } from '../../../lib/format';
import { apiMessage, validateName, validatePhone } from '../../../lib/errors';
import { tap } from '../../../lib/haptics';

const BOTTOM_SPACE = 190;

interface MenuLink {
  icon: IconName;
  iconBg: string;
  label: string;
  detail?: string;
  badge?: string;
  route: string;
}

export default function ProfileScreen() {
  const router = useRouter();
  const { c, isDark } = useTheme();
  const { user, logout } = useAuthStore();

  const { data: addresses = [] } = useAddresses();
  const favorites = useFavoritesStore((s) => s.favorites);
  const clearCart = useCartStore((s) => s.clearCart);
  const stats = useZippStats();

  const [editing, setEditing] = useState(false);

  const accountLinks: MenuLink[] = [
    {
      icon: 'ubicacion',
      iconBg: '#6268A0',
      label: 'Mis direcciones',
      detail: `${addresses.length} guardada${addresses.length === 1 ? '' : 's'}`,
      route: '/(client)/addresses',
    },
    {
      icon: 'favorito',
      iconBg: '#6268A0',
      label: 'Negocios favoritos',
      detail: `${favorites.length} guardado${favorites.length === 1 ? '' : 's'}`,
      route: '/(client)/favorites',
    },
    {
      icon: 'notificaciones',
      iconBg: '#6268A0',
      label: 'Avisos y notificaciones',
      route: '/(client)/notifications',
    },
  ];

  const zippLinks: MenuLink[] = [
    {
      icon: 'trofeo',
      iconBg: '#6268A0',
      label: 'Tus puntos Zipp y cupones',
      detail: `${stats.points} puntos acumulados`,
      badge: `${stats.points} pts`,
      route: '/(client)/rewards',
    },
  ];

  const supportLinks: MenuLink[] = [
    {
      icon: 'ayuda',
      iconBg: '#6268A0',
      label: 'Centro de ayuda',
      detail: 'Preguntas y soporte técnico',
      route: '/(client)/help',
    },
    {
      icon: 'ajustes',
      iconBg: '#6268A0',
      label: 'Ajustes y configuración',
      detail: 'Tema, permisos y cuenta',
      route: '/(client)/settings',
    },
  ];

  const confirmLogout = () => {
    tap('warning');
    Alert.alert('Cerrar sesión', '¿Seguro que quieres salir de tu cuenta Zipp?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Cerrar sesión',
        style: 'destructive',
        onPress: () => {
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
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* ── One UI Reachability Header ── */}
        <View style={styles.headerArea}>
          <Text v="displayM" style={styles.headerTitle}>
            Perfil
          </Text>
          <Text v="bodyS" tone="textMuted">
            Gestiona tu cuenta, direcciones y beneficios
          </Text>
        </View>

        {/* ── Hero / Samsung Account Profile Card ── */}
        <View
          style={[
            styles.heroCard,
            {
              backgroundColor: c.surface,
              borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
            },
          ]}
        >
          <View style={styles.heroTopRow}>
            <View style={[styles.avatar, { backgroundColor: c.primary }]}>
              <Text v="displayM" color="#FFFFFF">
                {initials(user?.name)}
              </Text>
            </View>

            <View style={styles.heroInfo}>
              <Text v="strongL" numberOfLines={1} style={styles.userName}>
                {user?.name ?? 'Tu cuenta Zipp'}
              </Text>
              <Text v="dataS" tone="textMuted">
                {user?.phone ? `+57 ${user.phone}` : 'Usuario Zipp'}
              </Text>

              <View style={styles.verificationRow}>
                <View
                  style={[
                    styles.verificationPill,
                    {
                      backgroundColor: user?.isVerified
                        ? isDark ? 'rgba(16, 185, 129, 0.16)' : '#E6F9F0'
                        : isDark ? 'rgba(245, 158, 11, 0.16)' : '#FEF3C7',
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.statusDot,
                      { backgroundColor: user?.isVerified ? '#10B981' : '#F59E0B' },
                    ]}
                  />
                  <Text
                    v="captionStrong"
                    color={
                      user?.isVerified
                        ? isDark ? '#34D399' : '#059669'
                        : isDark ? '#FBBF24' : '#D97706'
                    }
                  >
                    {user?.isVerified ? 'Verificado' : 'Sin verificar'}
                  </Text>
                </View>
              </View>
            </View>

            <Pressable
              onPress={() => {
                tap('light');
                setEditing(true);
              }}
              accessibilityRole="button"
              accessibilityLabel="Editar perfil"
              style={[
                styles.editPillButton,
                {
                  backgroundColor: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.05)',
                  borderColor: isDark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(0, 0, 0, 0.08)',
                },
              ]}
            >
              <Icon name="editar" size="sm" color={c.text} />
              <Text v="strongS">Editar</Text>
            </Pressable>
          </View>
        </View>

        {/* ── Resumen Zipp Activity Widget (Samsung One UI Widget Style) ── */}
        <Pressable
          onPress={() => {
            tap('light');
            router.push('/(client)/rewards');
          }}
          accessibilityRole="button"
          accessibilityLabel={`Tus puntos Zipp: ${stats.points} puntos, ${stats.orderCount} pedidos, racha de ${stats.streak} semanas`}
          style={({ pressed }) => [
            styles.statsWidget,
            {
              backgroundColor: c.surface,
              borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
            },
            pressed && { transform: [{ scale: 0.985 }] },
          ]}
        >
          <View style={styles.statCol}>
            <View style={[styles.statIconBadge, { backgroundColor: isDark ? 'rgba(245, 158, 11, 0.16)' : '#FEF3C7' }]}>
              <Icon name="trofeo" size="sm" color="#F59E0B" />
            </View>
            <Text v="titleL" tone="primaryText">
              {stats.points}
            </Text>
            <Text v="caption" tone="textMuted">Puntos</Text>
          </View>

          <View style={[styles.statDivider, { backgroundColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)' }]} />

          <View style={styles.statCol}>
            <View style={[styles.statIconBadge, { backgroundColor: isDark ? 'rgba(75, 59, 255, 0.16)' : '#EEF2FF' }]}>
              <Icon name="paquete" size="sm" color="#4B3BFF" />
            </View>
            <Text v="titleL" color={c.text}>
              {stats.orderCount}
            </Text>
            <Text v="caption" tone="textMuted">Pedidos</Text>
          </View>

          <View style={[styles.statDivider, { backgroundColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)' }]} />

          <View style={styles.statCol}>
            <View style={[styles.statIconBadge, { backgroundColor: isDark ? 'rgba(16, 185, 129, 0.16)' : '#E6F9F0' }]}>
              <Icon name="racha" size="sm" color="#10B981" />
            </View>
            <Text v="titleL" color={isDark ? '#34D399' : '#059669'}>
              {stats.streak}
            </Text>
            <Text v="caption" tone="textMuted">Semanas</Text>
          </View>
        </Pressable>

        {/* ── Grupo 1: Mi Cuenta ── */}
        <OneUiMenuGroup title="MI CUENTA" links={accountLinks} />

        {/* ── Grupo 2: Beneficios Zipp ── */}
        <OneUiMenuGroup title="BENEFICIOS Y PUNTOS" links={zippLinks} />

        {/* ── Grupo 3: Ayuda y Configuración ── */}
        <OneUiMenuGroup title="CONFIGURACIÓN Y ASISTENCIA" links={supportLinks} />

        {/* ── Cerrar Sesión (Samsung One UI Danger Action) ── */}
        <Pressable
          onPress={confirmLogout}
          accessibilityRole="button"
          accessibilityLabel="Cerrar sesión"
          style={[
            styles.logoutCard,
            {
              backgroundColor: isDark ? 'rgba(239, 68, 68, 0.10)' : 'rgba(239, 68, 68, 0.06)',
              borderColor: isDark ? 'rgba(239, 68, 68, 0.25)' : 'rgba(239, 68, 68, 0.15)',
            },
          ]}
        >
          <View style={styles.logoutCleanIcon}>
            <Icon name="salir" size="md" color="#EF4444" />
          </View>
          <Text v="strongM" color={isDark ? '#FCA5A5' : '#DC2626'} style={{ flex: 1 }}>
            Cerrar sesión
          </Text>
          <Icon name="siguiente" size="sm" color={isDark ? '#F87171' : '#EF4444'} />
        </Pressable>

        {/* ── Footer ── */}
        <View style={styles.footer}>
          <Text v="dataS" tone="textMuted">ZIPP • Garzón, Huila</Text>
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
// Componente de Grupo de Menú One UI
// ──────────────────────────────────────────────────────────────

function OneUiMenuGroup({ title, links }: { title: string; links: MenuLink[] }) {
  const { c, isDark } = useTheme();
  const router = useRouter();

  return (
    <View style={styles.groupContainer}>
      <Text v="captionStrong" tone="textMuted" style={styles.groupTitle}>
        {title}
      </Text>
      <View
        style={[
          styles.oneUiIsland,
          {
            backgroundColor: c.surface,
            borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
          },
        ]}
      >
        {links.map((link, idx) => (
          <View key={link.label} style={styles.rowWrapper}>
            <Pressable
              onPress={() => {
                tap('light');
                router.push(link.route as never);
              }}
              accessibilityRole="button"
              accessibilityLabel={link.detail ? `${link.label}. ${link.detail}` : link.label}
              style={({ pressed }) => [
                styles.linkPressable,
                pressed && {
                  backgroundColor: isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.03)',
                },
              ]}
            >
              {/* Clean Icon without Pill */}
              <View style={styles.cleanIconContainer}>
                <Icon name={link.icon} size="md" color="#6268A0" />
              </View>

              <View style={styles.linkTextBody}>
                <Text v="strongM" numberOfLines={1}>
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

              <Icon name="siguiente" size="md" color={c.textMuted} />
            </Pressable>

            {/* Indented Divider (Signature Samsung One UI) */}
            {idx < links.length - 1 ? (
              <View
                style={[
                  styles.indentedDivider,
                  { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(0, 0, 0, 0.05)' },
                ]}
              />
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}

// ──────────────────────────────────────────────────────────────
// Hoja para Editar Perfil
// ──────────────────────────────────────────────────────────────

function EditProfileSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const router = useRouter();
  const { user, setUser } = useAuthStore();

  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    setName(user.name);
    setEmail(user.email ?? '');
    setPhone(user.phone);
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
      />

      {phoneChanged ? (
        <Notice tone="warning">
          Si cambias tu número de celular deberás verificarlo nuevamente con un código SMS.
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
    paddingBottom: BOTTOM_SPACE,
    gap: Spacing.lg,
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

  // Hero Card (Samsung Account Profile Banner)
  heroCard: {
    padding: Spacing.lg,
    borderRadius: 24,
    borderWidth: 1,
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroInfo: {
    flex: 1,
    gap: 2,
  },
  userName: {
    fontSize: FontSize.lg,
  },
  verificationRow: {
    flexDirection: 'row',
    marginTop: 2,
  },
  verificationPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  editPillButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
  },

  // Stats Widget
  statsWidget: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.md,
    borderRadius: 24,
    borderWidth: 1,
  },
  statCol: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
  },
  statIconBadge: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  statDivider: {
    width: 1,
    height: 40,
  },

  // Grouped Islands
  groupContainer: {
    gap: 8,
  },
  groupTitle: {
    marginLeft: Spacing.md,
    letterSpacing: 0.8,
    fontSize: 11,
  },
  oneUiIsland: {
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1,
  },
  rowWrapper: {
    width: '100%',
  },
  linkPressable: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: 14,
    gap: Spacing.md,
  },
  cleanIconContainer: {
    width: 32,
    height: 32,
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
  indentedDivider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 56,
    marginRight: Spacing.lg,
  },

  // Logout Card
  logoutCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: 14,
    borderRadius: 22,
    borderWidth: 1,
    gap: Spacing.md,
  },
  logoutCleanIcon: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Footer
  footer: {
    alignItems: 'center',
    gap: 4,
    marginTop: Spacing.sm,
  },
});
