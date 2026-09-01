import { useState, useMemo } from 'react';
import { View, ScrollView, Pressable, StyleSheet, Alert, Linking, TextInput } from 'react-native';
import { useRouter } from 'expo-router';
import { Text, Icon, Screen } from '../../components/ui';
import { ZippMark } from '../../components/brand/ZippLogo';
import { useThemeStore, type Theme as ThemeMode } from '../../stores/themeStore';
import { usePrefsStore } from '../../stores/prefsStore';
import { useAuthStore } from '../../stores/authStore';
import { useCartStore } from '../../stores/cartStore';
import { useTheme } from '../../hooks/useTheme';
import { socketService } from '../../services/socket';
import type { IconName } from '../../theme/icons';
import { BorderRadius, Spacing, FontSize } from '../../theme/tokens';
import { initials } from '../../lib/format';
import { tap } from '../../lib/haptics';

interface SettingItemData {
  id: string;
  icon: IconName;
  label: string;
  detail?: string;
  badge?: string;
  action: () => void;
  section: 'permissions' | 'support' | 'system';
}

export default function SettingsScreen() {
  const router = useRouter();
  const { c, isDark } = useTheme();
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const resetPrefs = usePrefsStore((s) => s.reset);
  const { user, logout } = useAuthStore();
  const clearCart = useCartStore((s) => s.clearCart);

  const [searchQuery, setSearchQuery] = useState('');

  const replayOnboarding = () => {
    tap('light');
    resetPrefs();
    router.replace('/(auth)/welcome');
  };

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

  const allItems: SettingItemData[] = useMemo(
    () => [
      {
        id: 'location',
        icon: 'ubicacion',
        label: 'Ubicación y GPS',
        detail: 'Permiso para calcular tiempos y rutas de entrega',
        action: () => Linking.openSettings().catch(() => {}),
        section: 'permissions',
      },
      {
        id: 'notifications',
        icon: 'notificaciones',
        label: 'Notificaciones del sistema',
        detail: 'Avisos en vivo del estado de tus pedidos',
        action: () => Linking.openSettings().catch(() => {}),
        section: 'permissions',
      },
      {
        id: 'help',
        icon: 'ayuda',
        label: 'Centro de ayuda',
        detail: 'Preguntas frecuentes y cómo usar Zipp',
        action: () => router.push('/(client)/help'),
        section: 'support',
      },
      {
        id: 'legal',
        icon: 'seguridad',
        label: 'Centro legal, datos y SIC',
        detail: 'Políticas de privacidad y términos del servicio',
        action: () => router.push('/(client)/legal'),
        section: 'support',
      },
      {
        id: 'requests',
        icon: 'soporte',
        label: 'PQRS y solicitudes de datos',
        detail: 'Radica consultas, quejas o reclamos',
        action: () => router.push('/(client)/requests'),
        section: 'support',
      },
      {
        id: 'onboarding',
        icon: 'rayo',
        label: 'Ver la introducción otra vez',
        detail: 'Reinicia el tutorial de bienvenida',
        action: replayOnboarding,
        section: 'system',
      },
    ],
    []
  );

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return allItems;
    const q = searchQuery.toLowerCase().trim();
    return allItems.filter(
      (item) => item.label.toLowerCase().includes(q) || item.detail?.toLowerCase().includes(q)
    );
  }, [allItems, searchQuery]);

  const permissionItems = filteredItems.filter((i) => i.section === 'permissions');
  const supportItems = filteredItems.filter((i) => i.section === 'support');
  const systemItems = filteredItems.filter((i) => i.section === 'system');
  const isSearching = searchQuery.trim().length > 0;

  return (
    <Screen style={{ backgroundColor: isDark ? '#0C101C' : '#F1F3F7' }}>
      {/* ── One UI Top Bar ── */}
      <View style={styles.topBar}>
        <Pressable
          onPress={() => {
            tap('light');
            if (router.canGoBack()) router.back();
            else router.replace('/(client)/(tabs)/profile');
          }}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Volver"
          style={[
            styles.backButton,
            { backgroundColor: c.surface, borderColor: c.border },
          ]}
        >
          <Icon name="atras" size="md" color={c.text} />
        </Pressable>

        <View style={styles.topBarContent}>
          <Text v="titleM" numberOfLines={1}>Ajustes</Text>
        </View>

        <View style={styles.topBarSpacer} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── One UI Big Header Area ── */}
        <View style={styles.oneUiHeaderArea}>
          <Text v="displayM" style={styles.oneUiTitle}>
            Ajustes
          </Text>
          <Text v="bodyS" tone="textMuted">
            Personaliza y gestiona tu experiencia en Zipp
          </Text>

          {/* ── Search Bar (One UI Style) ── */}
          <View
            style={[
              styles.searchBar,
              {
                backgroundColor: c.surface,
                borderColor: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)',
              },
            ]}
          >
            <Icon name="explorar" size="md" color={c.textMuted} />
            <TextInput
              style={[styles.searchInput, { color: c.text }]}
              placeholder="Buscar en ajustes…"
              placeholderTextColor={c.textMuted}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCorrect={false}
              returnKeyType="search"
            />
            {searchQuery.length > 0 ? (
              <Pressable
                onPress={() => {
                  tap('light');
                  setSearchQuery('');
                }}
                hitSlop={8}
                style={styles.clearSearchBtn}
              >
                <Icon name="cerrar" size="sm" color={c.textMuted} />
              </Pressable>
            ) : null}
          </View>
        </View>

        {/* ── Profile / Samsung Account Card (Solo si no está buscando) ── */}
        {!isSearching ? (
          <Pressable
            onPress={() => {
              tap('light');
              router.push('/(client)/(tabs)/profile');
            }}
            accessibilityRole="button"
            accessibilityLabel="Ver perfil y cuenta Zipp"
            style={[
              styles.accountCard,
              {
                backgroundColor: c.surface,
                borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
              },
            ]}
          >
            <View style={[styles.accountAvatar, { backgroundColor: c.primary }]}>
              <Text v="titleL" color="#FFFFFF">
                {initials(user?.name)}
              </Text>
            </View>

            <View style={styles.accountBody}>
              <View style={styles.accountNameRow}>
                <Text v="strongL" numberOfLines={1} style={{ flex: 1 }}>
                  {user?.name ?? 'Mi Cuenta Zipp'}
                </Text>
              </View>
              <Text v="caption" tone="textMuted">
                {user?.phone ? `+57 ${user.phone}` : 'Usuario Zipp'}
              </Text>
              <View style={styles.accountBadgeRow}>
                <View
                  style={[
                    styles.accountPill,
                    {
                      backgroundColor: user?.isVerified
                        ? isDark ? 'rgba(16, 185, 129, 0.16)' : '#E6F9F0'
                        : isDark ? 'rgba(245, 158, 11, 0.16)' : '#FEF3C7',
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.accountDot,
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
                    {user?.isVerified ? 'Cuenta verificada' : 'Sin verificar'}
                  </Text>
                </View>
              </View>
            </View>

            <View style={[styles.chevronBubble, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}>
              <Icon name="siguiente" size="sm" color={c.textMuted} />
            </View>
          </Pressable>
        ) : null}

        {/* ── Apariencia / Pantalla (Visual One UI Display Selector) ── */}
        {!isSearching ? (
          <View style={styles.sectionBlock}>
            <Text v="captionStrong" tone="textMuted" style={styles.sectionTitle}>
              PANTALLA Y APARIENCIA
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
              <Text v="strongM" style={styles.displaySubheader}>
                Modo de pantalla
              </Text>

              {/* Miniaturas de teléfono interactivas estilo One UI */}
              <View style={styles.themeCardsRow}>
                {/* 1. MODO CLARO */}
                <ThemePreviewCard
                  mode="light"
                  label="Claro"
                  isSelected={theme === 'light'}
                  onSelect={() => {
                    tap('select');
                    setTheme('light');
                  }}
                />

                {/* 2. MODO OSCURO */}
                <ThemePreviewCard
                  mode="dark"
                  label="Oscuro"
                  isSelected={theme === 'dark'}
                  onSelect={() => {
                    tap('select');
                    setTheme('dark');
                  }}
                />

                {/* 3. MODO AUTOMÁTICO */}
                <ThemePreviewCard
                  mode="auto"
                  label="Sistema"
                  isSelected={theme === 'auto'}
                  onSelect={() => {
                    tap('select');
                    setTheme('auto');
                  }}
                />
              </View>
            </View>
          </View>
        ) : null}

        {/* ── Permisos del Dispositivo ── */}
        {permissionItems.length > 0 ? (
          <View style={styles.sectionBlock}>
            <Text v="captionStrong" tone="textMuted" style={styles.sectionTitle}>
              PERMISOS Y CONEXIONES
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
              {permissionItems.map((item, idx) => (
                <OneUiSettingRow
                  key={item.id}
                  item={item}
                  isFirst={idx === 0}
                  isLast={idx === permissionItems.length - 1}
                />
              ))}
            </View>
          </View>
        ) : null}

        {/* ── Soporte, Privacidad y Legal ── */}
        {supportItems.length > 0 ? (
          <View style={styles.sectionBlock}>
            <Text v="captionStrong" tone="textMuted" style={styles.sectionTitle}>
              AYUDA, SEGURIDAD Y PRIVACIDAD
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
              {supportItems.map((item, idx) => (
                <OneUiSettingRow
                  key={item.id}
                  item={item}
                  isFirst={idx === 0}
                  isLast={idx === supportItems.length - 1}
                />
              ))}
            </View>
          </View>
        ) : null}

        {/* ── Sistema y Tutorial ── */}
        {systemItems.length > 0 ? (
          <View style={styles.sectionBlock}>
            <Text v="captionStrong" tone="textMuted" style={styles.sectionTitle}>
              SISTEMA Y EXPERIENCIA
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
              {systemItems.map((item, idx) => (
                <OneUiSettingRow
                  key={item.id}
                  item={item}
                  isFirst={idx === 0}
                  isLast={idx === systemItems.length - 1}
                />
              ))}
            </View>
          </View>
        ) : null}

        {/* Si buscó y no hay nada */}
        {isSearching && filteredItems.length === 0 ? (
          <View style={styles.emptySearchContainer}>
            <View style={[styles.emptyIconCircle, { backgroundColor: c.surfaceLight }]}>
              <Icon name="explorar" size={28} color={c.textMuted} />
            </View>
            <Text v="strongL" center>No se encontraron resultados</Text>
            <Text v="bodyS" tone="textMuted" center>
              No hay ningún ajuste que coincida con "{searchQuery}".
            </Text>
          </View>
        ) : null}

        {/* ── Acerca de Zipp (Samsung "About Phone" style) ── */}
        {!isSearching ? (
          <View style={styles.sectionBlock}>
            <Text v="captionStrong" tone="textMuted" style={styles.sectionTitle}>
              ACERCA DE LA APLICACIÓN
            </Text>

            <View
              style={[
                styles.aboutCard,
                {
                  backgroundColor: c.surface,
                  borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
                },
              ]}
            >
              <View style={styles.aboutHeader}>
                <View style={styles.aboutCleanIcon}>
                  <ZippMark size={22} mono="#6268A0" />
                </View>
                <View style={styles.aboutHeaderText}>
                  <Text v="strongL">ZIPP Delivery</Text>
                  <Text v="dataS" tone="textMuted">Versión 1.0.0 (Build 2026.1)</Text>
                </View>
                <View style={[styles.aboutStatusPill, { backgroundColor: isDark ? 'rgba(16, 185, 129, 0.16)' : '#E6F9F0' }]}>
                  <Text v="captionStrong" color={isDark ? '#34D399' : '#059669'}>
                    Al día
                  </Text>
                </View>
              </View>

              <View style={[styles.aboutDivider, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]} />

              <View style={styles.aboutFooterRow}>
                <Text v="caption" tone="textMuted">
                  Hecho en Garzón, Huila
                </Text>
                <Text v="dataXS" tone="textMuted">
                  El Trazo OS
                </Text>
              </View>
            </View>
          </View>
        ) : null}

        {/* ── Cerrar Sesión (Samsung One UI Danger Action) ── */}
        {!isSearching ? (
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
        ) : null}
      </ScrollView>
    </Screen>
  );
}

// ──────────────────────────────────────────────────────────────
// Miniatura de Teléfono One UI para Selector de Tema
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
      style={[
        styles.themeCardWrapper,
        isSelected && {
          transform: [{ scale: 1.02 }],
        },
      ]}
    >
      {/* Marco de teléfono en miniatura */}
      <View
        style={[
          styles.phoneMockup,
          mode === 'light' && styles.phoneMockupLight,
          mode === 'dark' && styles.phoneMockupDark,
          mode === 'auto' && styles.phoneMockupAuto,
          {
            borderColor: isSelected
              ? c.primary
              : isDark
              ? 'rgba(255, 255, 255, 0.12)'
              : 'rgba(0, 0, 0, 0.10)',
            borderWidth: isSelected ? 2.5 : 1.5,
          },
        ]}
      >
        {/* Notch / Speaker bar */}
        <View
          style={[
            styles.mockupNotch,
            { backgroundColor: mode === 'light' ? '#D1D5DB' : '#374151' },
          ]}
        />

        {/* Mockup UI Elements */}
        {mode === 'auto' ? (
          // Split screen representation
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
            {/* Header pill */}
            <View
              style={[
                styles.mockupCardLine,
                {
                  backgroundColor: mode === 'light' ? '#4B3BFF' : '#7D72FF',
                  width: '60%',
                  marginTop: 2,
                },
              ]}
            />
            {/* Mockup Island 1 */}
            <View
              style={[
                styles.mockupContentBlock,
                {
                  backgroundColor: mode === 'light' ? '#E5E7EB' : '#262C40',
                },
              ]}
            >
              <View
                style={[
                  styles.mockupMiniLine,
                  { backgroundColor: mode === 'light' ? '#9CA3AF' : '#4B5563', width: '40%' },
                ]}
              />
            </View>
            {/* Mockup Island 2 */}
            <View
              style={[
                styles.mockupContentBlock,
                {
                  backgroundColor: mode === 'light' ? '#E5E7EB' : '#262C40',
                },
              ]}
            >
              <View
                style={[
                  styles.mockupMiniLine,
                  { backgroundColor: mode === 'light' ? '#9CA3AF' : '#4B5563', width: '55%' },
                ]}
              />
            </View>
          </View>
        )}
      </View>

      {/* Label and Radio indicator */}
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
        <Text
          v={isSelected ? 'strongS' : 'bodyS'}
          color={isSelected ? c.primaryText : c.textSecondary}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

// ──────────────────────────────────────────────────────────────
// Fila de Ajuste One UI con Squircle vibrante y divisor indentado
// ──────────────────────────────────────────────────────────────

function OneUiSettingRow({
  item,
  isFirst,
  isLast,
}: {
  item: SettingItemData;
  isFirst: boolean;
  isLast: boolean;
}) {
  const { c, isDark } = useTheme();

  return (
    <View style={styles.rowWrapper}>
      <Pressable
        onPress={() => {
          tap('light');
          item.action();
        }}
        accessibilityRole="button"
        accessibilityLabel={item.detail ? `${item.label}. ${item.detail}` : item.label}
        style={({ pressed }) => [
          styles.rowPressable,
          pressed && {
            backgroundColor: isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.03)',
          },
        ]}
      >
        {/* Clean Icon Container without Pill Background */}
        <View style={styles.cleanIconContainer}>
          <Icon name={item.icon} size="md" color="#6268A0" />
        </View>

        {/* Text Body */}
        <View style={styles.rowTextBody}>
          <Text v="strongM" numberOfLines={1}>
            {item.label}
          </Text>
          {item.detail ? (
            <Text v="caption" tone="textMuted" numberOfLines={2}>
              {item.detail}
            </Text>
          ) : null}
        </View>

        {/* Arrow / Right Action */}
        <View style={styles.rowRightAction}>
          {item.badge ? (
            <View style={[styles.itemBadge, { backgroundColor: c.primarySoft }]}>
              <Text v="captionStrong" tone="primaryText">{item.badge}</Text>
            </View>
          ) : null}
          <Icon name="siguiente" size="md" color={c.textMuted} />
        </View>
      </Pressable>

      {/* Indented Divider (Signature Samsung One UI) */}
      {!isLast ? (
        <View
          style={[
            styles.indentedDivider,
            { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(0, 0, 0, 0.05)' },
          ]}
        />
      ) : null}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────
// Estilos
// ──────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    height: 52,
  },
  backButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  topBarContent: {
    flex: 1,
    alignItems: 'center',
  },
  topBarSpacer: {
    width: 38,
  },

  scrollContent: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.huge,
    gap: Spacing.lg,
  },

  // One UI Header
  oneUiHeaderArea: {
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xs,
    gap: 4,
  },
  oneUiTitle: {
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: -0.8,
  },

  // Search Bar
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    height: 48,
    borderRadius: BorderRadius.full,
    paddingHorizontal: Spacing.lg,
    marginTop: Spacing.md,
    borderWidth: 1,
  },
  searchInput: {
    flex: 1,
    fontSize: FontSize.md,
    paddingVertical: 0,
  },
  clearSearchBtn: {
    padding: Spacing.xs,
  },

  // Account Card (Samsung Profile style)
  accountCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
    borderRadius: 24,
    borderWidth: 1,
    gap: Spacing.md,
  },
  accountAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  accountBody: {
    flex: 1,
    gap: 2,
  },
  accountNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  accountBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  accountPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: BorderRadius.full,
  },
  accountDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  chevronBubble: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // One UI Islands
  sectionBlock: {
    gap: 8,
  },
  sectionTitle: {
    marginLeft: Spacing.md,
    letterSpacing: 0.8,
    fontSize: 11,
  },
  oneUiIsland: {
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1,
  },

  // Display selector inside Island
  displaySubheader: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.xs,
  },
  themeCardsRow: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.lg,
    paddingTop: Spacing.sm,
    gap: Spacing.sm,
    justifyContent: 'space-between',
  },
  themeCardWrapper: {
    flex: 1,
    alignItems: 'center',
    gap: Spacing.xs + 2,
  },
  phoneMockup: {
    width: '100%',
    height: 94,
    borderRadius: 16,
    alignItems: 'center',
    paddingTop: 6,
    paddingHorizontal: 8,
    overflow: 'hidden',
  },
  phoneMockupLight: {
    backgroundColor: '#FFFFFF',
  },
  phoneMockupDark: {
    backgroundColor: '#121727',
  },
  phoneMockupAuto: {
    backgroundColor: '#F3F4F6',
  },
  mockupNotch: {
    width: 22,
    height: 3,
    borderRadius: 1.5,
    marginBottom: 6,
  },
  mockupContent: {
    width: '100%',
    gap: 4,
  },
  mockupCardLine: {
    height: 5,
    borderRadius: 2.5,
  },
  mockupContentBlock: {
    height: 18,
    borderRadius: 6,
    padding: 3,
    justifyContent: 'center',
  },
  mockupMiniLine: {
    height: 3,
    borderRadius: 1.5,
  },
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
    padding: 3,
    gap: 3,
  },
  splitDarkHalf: {
    flex: 1,
    backgroundColor: '#121727',
    borderRadius: 4,
    padding: 3,
    gap: 3,
  },
  themeLabelContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  radioIndicator: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioIndicatorDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFFFFF',
  },

  // One UI Rows
  rowWrapper: {
    width: '100%',
  },
  rowPressable: {
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
  rowTextBody: {
    flex: 1,
    gap: 2,
  },
  rowRightAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  itemBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  indentedDivider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 56,
    marginRight: Spacing.lg,
  },

  // About Zipp Card
  aboutCard: {
    borderRadius: 24,
    padding: Spacing.lg,
    borderWidth: 1,
    gap: Spacing.md,
  },
  aboutHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  aboutCleanIcon: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aboutHeaderText: {
    flex: 1,
    gap: 2,
  },
  aboutStatusPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: BorderRadius.full,
  },
  aboutDivider: {
    height: StyleSheet.hairlineWidth,
  },
  aboutFooterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
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

  // Empty search state
  emptySearchContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.xxxl,
    gap: Spacing.sm,
  },
  emptyIconCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.xs,
  },
});
