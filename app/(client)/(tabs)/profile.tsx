import { useState, useEffect } from 'react';
import { View, ScrollView, Pressable, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  Text, Icon, Button, Card, Input, Sheet, Notice, Badge,
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
import { BorderRadius, Spacing } from '../../../theme/tokens';
import { initials } from '../../../lib/format';
import { apiMessage, validateName, validatePhone } from '../../../lib/errors';
import { tap } from '../../../lib/haptics';

const BOTTOM_SPACE = 190;

interface MenuLink {
  icon: IconName;
  label: string;
  detail?: string;
  route: string;
}

export default function ProfileScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const { user, logout } = useAuthStore();

  const { data: addresses = [] } = useAddresses();
  const favorites = useFavoritesStore((s) => s.favorites);
  const clearCart = useCartStore((s) => s.clearCart);
  const stats = useZippStats();

  const [editing, setEditing] = useState(false);

  const account: MenuLink[] = [
    {
      icon: 'ubicacion',
      label: 'Mis direcciones',
      detail: `${addresses.length} guardada${addresses.length === 1 ? '' : 's'}`,
      route: '/(client)/addresses',
    },
    {
      icon: 'favorito',
      label: 'Favoritos',
      detail: `${favorites.length} negocio${favorites.length === 1 ? '' : 's'}`,
      route: '/(client)/favorites',
    },
    {
      icon: 'notificaciones',
      label: 'Avisos',
      route: '/(client)/notifications',
    },
  ];

  const zipp: MenuLink[] = [
    {
      icon: 'trofeo',
      label: 'Tus puntos Zipp',
      detail: `${stats.points} puntos`,
      route: '/(client)/rewards',
    },
  ];

  const support: MenuLink[] = [
    { icon: 'ayuda', label: 'Centro de ayuda', route: '/(client)/help' },
    { icon: 'ajustes', label: 'Ajustes', route: '/(client)/settings' },
  ];

  const confirmLogout = () => {
    Alert.alert('Cerrar sesión', '¿Seguro que quieres salir de tu cuenta?', [
      { text: 'Quedarme', style: 'cancel' },
      {
        text: 'Salir',
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
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* ── Identidad ── */}
        <View style={styles.hero}>
          <View style={[styles.avatar, { backgroundColor: c.primary }]}>
            <Text v="displayM" color={c.textOnPrimary}>{initials(user?.name)}</Text>
          </View>

          <View style={styles.heroBody}>
            <Text v="displayM" numberOfLines={1}>{user?.name ?? 'Tu cuenta'}</Text>
            <Text v="dataS" tone="textMuted">+57 {user?.phone}</Text>
            {user?.isVerified ? (
              <Badge label="Verificado" tone="lime" icon="seguridad" />
            ) : (
              <Badge label="Sin verificar" tone="warning" icon="alerta" />
            )}
          </View>

          <Button
            title="Editar"
            icon="editar"
            variant="secondary"
            size="sm"
            onPress={() => { tap('light'); setEditing(true); }}
          />
        </View>

        {/* ── Resumen Zipp ── */}
        <Pressable
          onPress={() => { tap('light'); router.push('/(client)/rewards'); }}
          accessibilityRole="button"
          accessibilityLabel={`Tus puntos Zipp: ${stats.points} puntos, ${stats.orderCount} pedidos, racha de ${stats.streak} semanas`}
        >
          <Card tone="accent" style={styles.stats}>
            <View style={styles.stat}>
              <Text v="dataL" tone="primaryText">{stats.points}</Text>
              <Text v="caption" tone="textMuted">Puntos</Text>
            </View>
            <View style={[styles.statLine, { backgroundColor: c.primarySoftBorder }]} />
            <View style={styles.stat}>
              <Text v="dataL" tone="primaryText">{stats.orderCount}</Text>
              <Text v="caption" tone="textMuted">Pedidos</Text>
            </View>
            <View style={[styles.statLine, { backgroundColor: c.primarySoftBorder }]} />
            <View style={styles.stat}>
              <View style={styles.streak}>
                <Icon name="racha" size="sm" color={c.limeText} />
                <Text v="dataL" tone="primaryText">{stats.streak}</Text>
              </View>
              <Text v="caption" tone="textMuted">Semanas</Text>
            </View>
          </Card>
        </Pressable>

        <MenuGroup title="Mi cuenta" links={account} />
        <MenuGroup title="Zipp" links={zipp} />
        <MenuGroup title="Ayuda" links={support} />

        <Button
          title="Cerrar sesión"
          icon="salir"
          variant="danger"
          full
          onPress={confirmLogout}
          haptic="none"
        />

        <Text v="caption" tone="textMuted" center>
          Zipp · Garzón, Huila · versión 1.0.0
        </Text>
      </ScrollView>

      <EditProfileSheet visible={editing} onClose={() => setEditing(false)} />
    </SafeAreaView>
  );
}

function MenuGroup({ title, links }: { title: string; links: MenuLink[] }) {
  const { c } = useTheme();
  const router = useRouter();

  return (
    <View style={styles.group}>
      <Text v="label" tone="textMuted">{title}</Text>
      <Card padded={false}>
        {links.map((link, index) => (
          <Pressable
            key={link.label}
            onPress={() => { tap('light'); router.push(link.route as never); }}
            accessibilityRole="button"
            accessibilityLabel={link.detail ? `${link.label}. ${link.detail}` : link.label}
            style={[
              styles.link,
              index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
            ]}
          >
            <View style={[styles.linkIcon, { backgroundColor: c.primarySoft }]}>
              <Icon name={link.icon} size="md" color={c.primaryText} />
            </View>
            <Text v="bodyL" style={styles.flex}>{link.label}</Text>
            {link.detail ? <Text v="dataS" tone="textMuted">{link.detail}</Text> : null}
            <Icon name="siguiente" size="md" color={c.textMuted} />
          </Pressable>
        ))}
      </Card>
    </View>
  );
}

/** Editar los datos básicos. Cambiar el celular obliga a verificar de nuevo. */
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

      // Un número nuevo deja la cuenta sin verificar: hay que confirmarlo.
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
        <Button title="Guardar cambios" size="lg" full loading={saving} onPress={save} haptic="medium" />
      }
    >
      <Input
        label="Nombre"
        icon="perfil"
        value={name}
        onChangeText={(t) => { setName(t); setErrors((e) => ({ ...e, name: undefined })); }}
        error={errors.name}
        autoCapitalize="words"
      />

      <Input
        label="Correo (opcional)"
        icon="correo"
        placeholder="tucorreo@ejemplo.com"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
      />

      <Input
        label="Celular"
        icon="celular"
        prefix="+57"
        value={phone}
        onChangeText={(t) => { setPhone(t); setErrors((e) => ({ ...e, phone: undefined })); }}
        error={errors.phone}
        keyboardType="phone-pad"
        maxLength={10}
        numeric
      />

      {phoneChanged ? (
        <Notice tone="warning">
          Si cambias el celular te pedimos verificarlo otra vez con un código.
        </Notice>
      ) : null}

      {formError ? <Notice tone="error">{formError}</Notice> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  content: { padding: Spacing.xl, gap: Spacing.xxl, paddingBottom: BOTTOM_SPACE },

  hero: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  avatar: {
    width: 68, height: 68, borderRadius: 34,
    alignItems: 'center', justifyContent: 'center',
  },
  heroBody: { flex: 1, gap: Spacing.xs, alignItems: 'flex-start' },

  stats: { flexDirection: 'row', alignItems: 'center' },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  statLine: { width: 1, height: 32 },
  streak: { flexDirection: 'row', alignItems: 'center', gap: 4 },

  group: { gap: Spacing.sm },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.lg,
  },
  linkIcon: {
    width: 38, height: 38, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center',
  },
});
