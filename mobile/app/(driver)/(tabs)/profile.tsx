import { useState, useEffect } from 'react';
import { View, ScrollView, StyleSheet, Pressable, Alert, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import * as ImagePicker from 'expo-image-picker';
import {
  Text, Icon, Card, Badge, Notice, SectionHeader, DetailRow,
} from '../../../components/ui';
import { EmergencyContactSheet } from '../../../components/domain/EmergencyContactSheet';
import { SosButton } from '../../../components/domain/SosButton';
import { ContentIcon, type ContentIllustrationName } from '../../../components/illustrations';
import { Avatar } from '../../../components/domain/Avatar';
import { useAuthStore } from '../../../stores/authStore';
import { useDriverProfile, useDriverMetrics } from '../../../hooks/useApi';
import { useTabContentPadding } from '../../../hooks/useBottomSpace';
import { useTheme } from '../../../hooks/useTheme';
import { BorderRadius, Spacing } from '../../../theme/tokens';
import { prepareAvatarForUpload } from '../../../lib/avatarImage';
import { apiMessage } from '../../../lib/errors';
import { tap } from '../../../lib/haptics';
import { authApi } from '../../../services/endpoints';
import { unregisterPush } from '../../../hooks/usePushNotifications';
import { pushPermissionGranted } from '../../../lib/push';
import { socketService } from '../../../services/socket';
import { ROUTES } from '../../../lib/routing';

export default function DriverProfileScreen() {
  const [pushGranted, setPushGranted] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    void pushPermissionGranted().then((granted) => {
      if (alive) setPushGranted(granted);
    });
    return () => { alive = false; };
  }, []);

  const router = useRouter();
  const { c, isDark, toggleTheme } = useTheme();
  const bottomSpace = useTabContentPadding();
  const { user, logout, setUser } = useAuthStore();
  const { data: profile } = useDriverProfile();
  const { data: metrics } = useDriverMetrics();
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [avatarError, setAvatarError] = useState('');

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

  const handleLogout = () => {
    tap('warning');
    Alert.alert('Cerrar sesión', '¿Estás seguro de que deseas salir de tu cuenta de repartidor?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Cerrar sesión',
        style: 'destructive',
        onPress: async () => {
          await unregisterPush();
          socketService.disconnect();
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
              <Pressable
                onPress={pickAvatar}
                disabled={uploadingAvatar}
                accessibilityRole="button"
                accessibilityLabel="Cambiar foto de perfil"
                style={({ pressed }) => [styles.avatarTouch, pressed && { opacity: 0.7 }]}
              >
                <Avatar uri={user?.avatar} name={user?.name} size={64} />
                <View style={[styles.avatarEditBadge, { backgroundColor: c.primary, borderColor: c.background }]}>
                  <Icon name="editar" size={12} color={c.textOnPrimary} />
                </View>
              </Pressable>

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
                <Text v="caption" tone="textMuted">
                  {profile?.totalReviews ? `${profile.totalReviews} calificaciones` : 'Calificación'}
                </Text>
              </View>

              <View style={[styles.statDivider, { backgroundColor: c.border }]} />

              <View style={styles.statItem}>
                <Text v="titleM">{completedDeliveries}</Text>
                <Text v="caption" tone="textMuted">Entregas</Text>
              </View>
            </View>
          </Card>
        </Animated.View>

        {avatarError ? <Notice tone="error">{avatarError}</Notice> : null}

        {/* ── Cómo te está yendo ── */}
        {metrics ? (
          <View style={styles.section}>
            <SectionHeader title="Tus últimos 30 días" />
            <Card style={styles.metricsCard}>
              <View style={styles.metricsTop}>
                <View style={styles.flex}>
                  <Text v="caption" tone="textMuted">PEDIDOS QUE ACEPTASTE</Text>
                  <Text v="displayM">
                    {metrics.acceptanceRate === null ? '—' : `${metrics.acceptanceRate}%`}
                  </Text>
                </View>
                {metrics.avgResponseSeconds !== null ? (
                  <View>
                    <Text v="caption" tone="textMuted">RESPONDES EN</Text>
                    <Text v="titleL">{metrics.avgResponseSeconds}s</Text>
                  </View>
                ) : null}
              </View>

              <View style={[styles.divider, { backgroundColor: c.border }]} />

              <DetailRow label="Aceptados" value={String(metrics.offers.accepted)} />
              <DetailRow label="Rechazados" value={String(metrics.offers.declined)} />
              <DetailRow label="Se te pasaron" value={String(metrics.offers.expired)} />
              {metrics.offers.takenByOther > 0 ? (
                <DetailRow
                  label="Se los llevó otro (no cuentan)"
                  value={String(metrics.offers.takenByOther)}
                />
              ) : null}

              {/*
                La promesa, al lado del número y no en unos términos que
                nadie lee. Es el motivo de que este bloque se pueda enseñar
                sin hacer daño: en las plataformas donde la aceptación pesa
                en el reparto —y el peso es secreto— la gente acaba
                aceptando pedidos que no le convienen por miedo a caer. Aquí
                no hay nada que temer, y decirlo es la mitad del trabajo.

                Sale de `affectsDispatch` del servidor y no de una constante
                local: si algún día deja de ser verdad, este texto
                desaparece solo en vez de quedarse mintiendo.
              */}
              {metrics.affectsDispatch === false ? (
                <Notice tone="info" icon="info">
                  Estos números no cambian los pedidos que te llegan. El reparto
                  va por cercanía: rechazar uno no te baja en ninguna lista.
                </Notice>
              ) : null}
            </Card>
          </View>
        ) : null}

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

            {/* Un domiciliario depende de esto mas que nadie: si la app
                esta en segundo plano, la push es como se entera de que le
                ofrecieron un pedido. Antes esta pantalla no tenia ni
                mencion a las notificaciones. */}
            <Pressable
              onPress={() => { tap('light'); Linking.openSettings().catch(() => {}); }}
              accessibilityRole="button"
              accessibilityLabel={
                pushGranted === false
                  ? 'Notificaciones desactivadas. Toca para ir a los ajustes'
                  : 'Notificaciones del sistema'
              }
              style={styles.menuRow}
            >
              <View style={[styles.menuIcon, { backgroundColor: c.surfaceLight }]}>
                <ContentIcon name="notificaciones" size={26} />
              </View>
              <View style={styles.flex}>
                <Text v="strongS">Notificaciones del sistema</Text>
                <Text v="caption" tone="textMuted">
                  {pushGranted === false
                    ? 'Desactivadas: no sabrás cuándo te ofrecen un pedido'
                    : 'Avisos de nuevos pedidos y del estado de tus entregas'}
                </Text>
              </View>
              {pushGranted === false ? <Badge label="Desactivadas" tone="warning" /> : null}
            </Pressable>
          </Card>
        </View>

        {/* ── Soporte ── */}
        <View style={styles.section}>
          <SectionHeader title="Ayuda y Soporte" />
          <Card style={styles.menuCard}>
            <Pressable
              onPress={() => { tap('light'); router.push(ROUTES.help as never); }}
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

            {/* El boton de panico ya pedia esto ("Agregalo en tu perfil") y
                no habia donde ponerlo. Va en Soporte y no en Preferencias
                porque no es un ajuste: es a quien llamamos si algo va mal. */}
            <Pressable
              onPress={() => { tap('light'); setEmergencyOpen(true); }}
              accessibilityRole="button"
              accessibilityLabel={
                profile?.emergencyContact?.phone
                  ? `Contacto de emergencia: ${profile.emergencyContact.name}. Toca para cambiarlo`
                  : 'Agregar contacto de emergencia'
              }
              style={styles.menuRow}
            >
              <View style={[styles.menuIcon, { backgroundColor: c.surfaceLight }]}>
                <ContentIcon name="seguridad" size={26} />
              </View>
              <View style={styles.flex}>
                <Text v="strongS">Contacto de emergencia</Text>
                <Text v="caption" tone="textMuted">
                  {profile?.emergencyContact?.phone
                    ? profile.emergencyContact.name
                    : 'Nadie a quien avisar si usas el botón de emergencia'}
                </Text>
              </View>
              {!profile?.emergencyContact?.phone ? (
                <Badge label="Falta" tone="warning" />
              ) : (
                <Icon name="siguiente" size="sm" color={c.textMuted} />
              )}
            </Pressable>

            {/* El admin ya tenia la cola de revision de documentos
                (GET /drivers/documents/queue) y ningun documento le llegaba
                nunca: la app no tenia por donde enviarlos. */}
            <Pressable
              onPress={() => { tap('light'); router.push('/(driver)/documents'); }}
              accessibilityRole="button"
              accessibilityLabel="Mis documentos: cédula, licencia, SOAT, tecnomecánica y tarjeta de propiedad"
              style={styles.menuRow}
            >
              <View style={[styles.menuIcon, { backgroundColor: c.surfaceLight }]}>
                <ContentIcon name="documento" size={26} />
              </View>
              <View style={styles.flex}>
                <Text v="strongS">Mis documentos</Text>
                <Text v="caption" tone="textMuted">Cédula, licencia, SOAT y más</Text>
              </View>
              <Icon name="siguiente" size="sm" color={c.textMuted} />
            </Pressable>
          </Card>
        </View>

        {/* ── Ayuda y legal: mismos derechos que ve el cliente, para el repartidor ── */}
        <View style={styles.section}>
          <SectionHeader title="Ayuda y legal" />
          <Card style={styles.menuCard}>
            {/* El botón de pánico vivía como un FAB flotante sobre toda la
                app; se movió aquí para que no esté siempre a la vista ni se
                active por accidente. Lleva su propio borde inferior porque
                es un componente aparte, no un MenuRow más. */}
            <View style={[styles.bordered, { borderBottomColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)' }]}>
              <SosButton />
            </View>
            <MenuRow
              illustration="seguridad"
              label="Centro legal, datos y SIC"
              detail="Políticas de privacidad y términos del servicio"
              onPress={() => { tap('light'); router.push('/(driver)/legal'); }}
            />
            <MenuRow
              illustration="soporte"
              label="PQRS y solicitudes de datos"
              detail="Radica consultas, quejas o reclamos"
              onPress={() => { tap('light'); router.push('/(driver)/requests'); }}
              last
            />
          </Card>
        </View>

        {/* ── Términos y privacidad: cada documento por separado ── */}
        <View style={styles.section}>
          <SectionHeader title="Términos y privacidad" />
          <Card style={styles.menuCard}>
            <MenuRow
              illustration="documento"
              label="Términos y condiciones"
              onPress={() => {
                tap('light');
                router.push({ pathname: '/(driver)/legal-document', params: { kind: 'terms', title: 'Términos y condiciones' } } as never);
              }}
            />
            <MenuRow
              illustration="documento"
              label="Políticas de privacidad"
              onPress={() => {
                tap('light');
                router.push({ pathname: '/(driver)/legal-document', params: { kind: 'privacy', title: 'Políticas de privacidad' } } as never);
              }}
            />
            <MenuRow
              illustration="documento"
              label="Autorización de tratamiento de datos personales"
              onPress={() => {
                tap('light');
                router.push({ pathname: '/(driver)/legal-document', params: { kind: 'habeas_data', title: 'Autorización de datos' } } as never);
              }}
              last
            />
          </Card>
        </View>

        {/* ── Botón Cerrar Sesión ── */}
        <Pressable
          onPress={handleLogout}
          accessibilityRole="button"
          accessibilityLabel="Cerrar sesión"
          accessibilityHint="Cierra tu sesión de repartidor"
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
              Desconectar tu cuenta de repartidor
            </Text>
          </View>

          <View style={styles.logoutArrow}>
            <Icon name="siguiente" size="sm" color={c.error} />
          </View>
        </Pressable>

        {/* ── Footer ── */}
        <View style={styles.footer}>
          <Text v="dataS" tone="textMuted">ZIPP</Text>
        </View>
      </ScrollView>

      <EmergencyContactSheet
        visible={emergencyOpen}
        onClose={() => setEmergencyOpen(false)}
        current={profile?.emergencyContact}
      />
    </SafeAreaView>
  );
}

// ──────────────────────────────────────────────────────────────
// Fila de menú con ilustración de contenido, para las secciones
// de ayuda/legal (mismo patrón que usa el perfil del cliente).
// ──────────────────────────────────────────────────────────────

function MenuRow({
  illustration,
  label,
  detail,
  onPress,
  last,
}: {
  illustration: ContentIllustrationName;
  label: string;
  detail?: string;
  onPress: () => void;
  last?: boolean;
}) {
  const { c, isDark } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={detail ? `${label}. ${detail}` : label}
      style={({ pressed }) => [
        styles.menuRow,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)' },
        pressed && { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.02)' },
      ]}
    >
      <View style={[styles.menuIcon, { backgroundColor: c.surfaceLight }]}>
        <ContentIcon name={illustration} size={26} />
      </View>
      <View style={styles.flex}>
        <Text v="strongS" numberOfLines={2}>{label}</Text>
        {detail ? <Text v="caption" tone="textMuted">{detail}</Text> : null}
      </View>
      <Icon name="siguiente" size="sm" color={c.textMuted} />
    </Pressable>
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
  avatarTouch: { width: 64, height: 64, position: 'relative' },
  avatarEditBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
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
  metricsCard: { gap: Spacing.sm, padding: Spacing.lg },
  metricsTop: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.md },
  menuCard: { padding: 0, overflow: 'hidden' },
  bordered: { borderBottomWidth: StyleSheet.hairlineWidth },
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
  footer: {
    alignItems: 'center',
    gap: 4,
    marginTop: Spacing.xs,
    marginBottom: Spacing.md,
  },
});
