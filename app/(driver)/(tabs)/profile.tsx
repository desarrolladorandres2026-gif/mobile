import { useState } from 'react';
import { View, ScrollView, StyleSheet, Pressable, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  Text, Icon, Card, Button, Badge, Notice, DetailRow, SectionHeader,
} from '../../../components/ui';
import { ContentIcon } from '../../../components/illustrations';
import { useAuthStore } from '../../../stores/authStore';
import { useDriverProfile } from '../../../hooks/useApi';
import { useTabContentPadding } from '../../../hooks/useBottomSpace';
import { useTheme } from '../../../hooks/useTheme';
import { BorderRadius, Spacing } from '../../../theme/tokens';
import { initials } from '../../../lib/format';
import { tap } from '../../../lib/haptics';
import { unregisterPush } from '../../../hooks/usePushNotifications';

export default function DriverProfileScreen() {
  const router = useRouter();
  const { c, isDark, toggleTheme } = useTheme();
  const bottomSpace = useTabContentPadding();
  const { user, logout } = useAuthStore();
  const { data: profile } = useDriverProfile();

  const handleLogout = () => {
    tap('warning');
    Alert.alert('Cerrar sesión', '¿Estás seguro de que deseas salir?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Cerrar sesión',
        style: 'destructive',
        onPress: async () => {
          await unregisterPush();
          logout();
          router.replace('/(auth)/login');
        },
      },
    ]);
  };

  const completedDeliveries = profile?.totalDeliveries || 0;
  const vehicleType = profile?.vehicleType === 'bicycle' ? 'Bicicleta' : 'Motocicleta';
  const licensePlate = profile?.licensePlate;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]} edges={['top']}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, { paddingBottom: bottomSpace }]}
      >
        <Text v="displayM">Mi Perfil</Text>

        {/* ── Tarjeta de Perfil ── */}
        <Animated.View entering={FadeIn.duration(280)}>
          <Card style={styles.profileCard}>
            <View style={styles.avatarRow}>
              <View style={[styles.avatar, { backgroundColor: c.primary }]}>
                <Text v="displayM" color={c.textOnPrimary}>
                  {initials(user?.name) || 'D'}
                </Text>
              </View>

              <View style={styles.flex}>
                <Text v="titleL" numberOfLines={1}>{user?.name || 'Repartidor ZIPP'}</Text>
                <Text v="bodyS" tone="textMuted">{user?.phone || 'Sin teléfono'}</Text>
                <View style={styles.vehicleRow}>
                  <Icon name="domiciliario" size="sm" color={c.primaryText} />
                  <Text v="strongS" tone="primaryText">
                    {vehicleType} {licensePlate ? `· ${licensePlate}` : ''}
                  </Text>
                </View>
              </View>
            </View>

            <View style={[styles.divider, { backgroundColor: c.border }]} />

            {/* Estadísticas clave */}
            <View style={styles.statsRow}>
              <View style={styles.statItem}>
                <View style={styles.ratingRow}>
                  <ContentIcon name="calificacion" size={20} />
                  <Text v="titleM">{(profile?.rating ?? 5).toFixed(1)}</Text>
                </View>
                <Text v="caption" tone="textMuted">Calificación</Text>
              </View>

              <View style={[styles.statDivider, { backgroundColor: c.border }]} />

              <View style={styles.statItem}>
                <Text v="titleM">{completedDeliveries}</Text>
                <Text v="caption" tone="textMuted">Entregas</Text>
              </View>
            </View>
          </Card>
        </Animated.View>

        {/* ── Preferencias y Tema ── */}
        <View style={styles.section}>
          <SectionHeader title="Preferencias de la aplicación" />
          <Card style={styles.menuCard}>
            <Pressable
              onPress={() => { tap('select'); toggleTheme(); }}
              style={styles.menuRow}
            >
              <View style={[styles.menuIcon, { backgroundColor: c.primarySoft }]}>
                <Icon name={isDark ? 'temaOscuro' : 'temaClaro'} size="md" color={c.primaryText} />
              </View>
              <View style={styles.flex}>
                <Text v="strongS">Tema visual</Text>
                <Text v="caption" tone="textMuted">
                  {isDark ? 'Modo oscuro activado' : 'Modo claro activado'}
                </Text>
              </View>
              <Badge label={isDark ? 'Oscuro' : 'Claro'} tone="neutral" />
            </Pressable>
          </Card>
        </View>

        {/* ── Soporte ── */}
        <View style={styles.section}>
          <SectionHeader title="Ayuda y Soporte" />
          <Card style={styles.menuCard}>
            <Pressable
              onPress={() => { tap('light'); router.push('/(client)/help'); }}
              style={styles.menuRow}
            >
              <View style={[styles.menuIcon, { backgroundColor: c.surfaceLight }]}>
                <ContentIcon name="soporte" size={26} />
              </View>
              <View style={styles.flex}>
                <Text v="strongS">Soporte ZIPP</Text>
                <Text v="caption" tone="textMuted">Asistencia directa con despachos</Text>
              </View>
              <Icon name="siguiente" size="sm" color={c.textMuted} />
            </Pressable>
          </Card>
        </View>

        {/* ── Botón Cerrar Sesión ── */}
        <Button
          title="Cerrar sesión"
          icon="salir"
          variant="danger"
          full
          onPress={handleLogout}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  content: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    gap: Spacing.xl,
  },
  profileCard: { padding: Spacing.xl, gap: Spacing.lg },
  avatarRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.lg },
  avatar: {
    width: 64, height: 64, borderRadius: 32,
    alignItems: 'center', justifyContent: 'center',
  },
  vehicleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    marginTop: 2,
  },
  divider: { height: StyleSheet.hairlineWidth },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  statItem: { alignItems: 'center', gap: 2 },
  statDivider: { width: StyleSheet.hairlineWidth, height: 28 },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },

  section: { gap: Spacing.sm },
  menuCard: { padding: 0, overflow: 'hidden' },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
  },
  menuIcon: {
    width: 40, height: 40, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center',
  },
});
