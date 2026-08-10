import { View, ScrollView, Pressable, StyleSheet, Switch, Alert, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { Text, Icon, Card, Button, Screen, Header } from '../../components/ui';
import { useThemeStore } from '../../stores/themeStore';
import { usePrefsStore } from '../../stores/prefsStore';
import { useAuthStore } from '../../stores/authStore';
import { useCartStore } from '../../stores/cartStore';
import { useTheme } from '../../hooks/useTheme';
import { socketService } from '../../services/socket';
import type { IconName } from '../../theme/icons';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { tap } from '../../lib/haptics';

export default function SettingsScreen() {
  const router = useRouter();
  const { c, isDark } = useTheme();
  const setTheme = useThemeStore((s) => s.setTheme);
  const resetPrefs = usePrefsStore((s) => s.reset);
  const logout = useAuthStore((s) => s.logout);
  const clearCart = useCartStore((s) => s.clearCart);

  const replayOnboarding = () => {
    tap('light');
    resetPrefs();
    router.replace('/(auth)/welcome');
  };

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
    <Screen>
      <Header title="Ajustes" fallback="/(client)/(tabs)/profile" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* ── Apariencia ── */}
        <View style={styles.group}>
          <Text v="label" tone="textMuted">Apariencia</Text>
          <Card padded={false}>
            <View style={styles.row}>
              <View style={[styles.rowIcon, { backgroundColor: c.primarySoft }]}>
                <Icon name={isDark ? 'temaOscuro' : 'temaClaro'} size="md" color={c.primaryText} />
              </View>
              <View style={styles.rowBody}>
                <Text v="bodyL">Tema oscuro</Text>
                <Text v="caption" tone="textMuted">
                  {isDark ? 'Más cómodo de noche' : 'Más legible con luz de día'}
                </Text>
              </View>
              <Switch
                value={isDark}
                onValueChange={(next) => { tap('select'); setTheme(next ? 'dark' : 'light'); }}
                trackColor={{ false: c.border, true: c.primary }}
                thumbColor={c.white}
                accessibilityLabel="Tema oscuro"
              />
            </View>
          </Card>
        </View>

        {/* ── Permisos del sistema ── */}
        <View style={styles.group}>
          <Text v="label" tone="textMuted">Permisos</Text>
          <Card padded={false}>
            <SettingLink
              icon="ubicacion"
              label="Ubicación"
              detail="Para calcular el envío"
              onPress={() => Linking.openSettings().catch(() => {})}
            />
            <SettingLink
              icon="notificaciones"
              label="Notificaciones"
              detail="Avisos de tu pedido"
              divider
              onPress={() => Linking.openSettings().catch(() => {})}
            />
          </Card>
          <Text v="caption" tone="textMuted">
            Los permisos se administran desde los ajustes del teléfono.
          </Text>
        </View>

        {/* ── Sobre Zipp ── */}
        <View style={styles.group}>
          <Text v="label" tone="textMuted">Sobre Zipp</Text>
          <Card padded={false}>
            <SettingLink
              icon="ayuda"
              label="Centro de ayuda"
              onPress={() => router.push('/(client)/help')}
            />
            <SettingLink
              icon="rayo"
              label="Ver la introducción otra vez"
              divider
              onPress={replayOnboarding}
            />
          </Card>
        </View>

        <Button title="Cerrar sesión" icon="salir" variant="danger" full onPress={confirmLogout} haptic="none" />

        <View style={styles.footer}>
          <Text v="dataS" tone="textMuted">ZIPP 1.0.0</Text>
          <Text v="caption" tone="textMuted" center>
            Hecho en Garzón, Huila.
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}

function SettingLink({
  icon, label, detail, divider, onPress,
}: {
  icon: IconName;
  label: string;
  detail?: string;
  divider?: boolean;
  onPress: () => void;
}) {
  const { c } = useTheme();

  return (
    <Pressable
      onPress={() => { tap('light'); onPress(); }}
      accessibilityRole="button"
      accessibilityLabel={detail ? `${label}. ${detail}` : label}
      style={[
        styles.row,
        divider && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
      ]}
    >
      <View style={[styles.rowIcon, { backgroundColor: c.primarySoft }]}>
        <Icon name={icon} size="md" color={c.primaryText} />
      </View>
      <View style={styles.rowBody}>
        <Text v="bodyL">{label}</Text>
        {detail ? <Text v="caption" tone="textMuted">{detail}</Text> : null}
      </View>
      <Icon name="siguiente" size="md" color={c.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.xl, gap: Spacing.xxl, paddingBottom: Spacing.huge },
  group: { gap: Spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.lg,
  },
  rowIcon: {
    width: 38, height: 38, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  rowBody: { flex: 1, gap: 1 },
  footer: { alignItems: 'center', gap: Spacing.xs, marginTop: Spacing.lg },
});
