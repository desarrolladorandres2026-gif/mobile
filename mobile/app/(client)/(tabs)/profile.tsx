import { useState, type ReactNode } from 'react';
import { View, ScrollView, Pressable, StyleSheet, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Text, Icon, ConfirmDialog } from '../../../components/ui';
import {
  ContentIcon,
  type ContentIllustrationName,
} from '../../../components/illustrations';
import { MapboxLogo, WhatsAppLogo } from '../../../components/brand/PaymentMethodLogos';
import { Avatar } from '../../../components/domain/Avatar';
import { useAuthStore } from '../../../stores/authStore';
import { useCartStore } from '../../../stores/cartStore';
import { useFavorites } from '../../../hooks/useFavorites';
import { useThemeStore } from '../../../stores/themeStore';
import { useAddresses } from '../../../hooks/useApi';
import { useTheme } from '../../../hooks/useTheme';
import { useTabContentPadding } from '../../../hooks/useBottomSpace';
import { socketService } from '../../../services/socket';
import { unregisterPush } from '../../../hooks/usePushNotifications';
import type { IconName } from '../../../theme/icons';
import { Spacing, FontSize } from '../../../theme/tokens';
import { FontFamily } from '../../../theme/typography';
import { tap } from '../../../lib/haptics';
import { ROUTES } from '../../../lib/routing';
import { SUPPORT_PHONE, supportWhatsAppUrl } from '../../../constants/config';


interface MenuLink {
  /** Logo de marca (Mapbox, WhatsApp...). Tiene prioridad sobre la ilustración. */
  logo?: ReactNode;
  /** Ilustración de contenido (categorías, beneficios, módulos). */
  illustration?: ContentIllustrationName;
  /** Icono funcional lucide, para acciones simples como ajustes. */
  icon?: IconName;
  label: string;
  badge?: string;
  /** Navega a esta ruta al tocar la fila. */
  route?: string;
  /** Parámetros de la ruta, para pantallas que sirven a varias filas. */
  params?: Record<string, string>;
  /** O, en vez de navegar, ejecuta esta acción (permisos del sistema, etc.). */
  action?: () => void;
}

/** Perfil va sin negrillas: fuerza Medium sobre cualquier variante de Text. */
const PText = (props: React.ComponentProps<typeof Text>) => (
  <Text {...props} style={[props.style, { fontFamily: FontFamily.medium, fontWeight: '500', fontSize: props.v==='titleL'?16:props.v==='displayM'?24:props.v==='strongL'?19:props.v==='strongM'||props.v==='bodyM'?13:props.v==='strongS'||props.v==='bodyS'?12:undefined }]} />
);

export default function ProfileScreen() {
  const [logoutDialogVisible, setLogoutDialogVisible] = useState(false);

  const router = useRouter();
  const { c, isDark } = useTheme();
  // Sin reserva mínima "por si acaso": esta pantalla no invita a agregar al
  // carrito, así que basta con el alto real del dock cuando está visible.
  const bottomSpace = useTabContentPadding();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const { data: addresses = [] } = useAddresses();
  const { businessIds: favorites } = useFavorites();
  const clearCart = useCartStore((s) => s.clearCart);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  /**
   * Abre WhatsApp con el mensaje ya escrito. Todavía no existe un registro de
   * aliados ni de domiciliarios dentro de la app, así que la postulación se
   * hace por el mismo canal que soporte, y no por un formulario que no lleva
   * a ninguna parte. Si WhatsApp no está instalado, cae a la llamada.
   */
  const writeToZipp = (text: string) => {
    const url = supportWhatsAppUrl(text);
    Linking.openURL(url).catch(() => {
      Linking.openURL(`tel:${SUPPORT_PHONE}`).catch(() => {});
    });
  };

  const accountLinks: MenuLink[] = [
    {
      icon: 'pedidos',
      label: 'Mis pedidos',
      route: '/(client)/orders',
    },
    {
      logo: <MapboxLogo size={20} color={c.text} />,
      label: 'Mis direcciones',
      route: '/(client)/addresses',
    },
    {
      icon: 'favorito',
      label: 'Negocios favoritos',
      route: '/(client)/favorites',
    },
    {
      icon: 'tarjeta',
      label: 'Métodos de pago',
      route: '/(client)/payment-methods',
    },
    {
      icon: 'seguridad',
      label: 'Mi cuenta',
      route: ROUTES.account,
    },
  ];

  const joinLinks: MenuLink[] = [
    {
      logo: <WhatsAppLogo size={20} />,
      label: 'Aliar mi negocio a Zipp',
      action: () => writeToZipp('Hola, quiero aliar mi negocio a Zipp.'),
    },
    {
      logo: <WhatsAppLogo size={20} />,
      label: 'Empezar a repartir con Zipp',
      action: () => writeToZipp('Hola, quiero empezar a repartir con Zipp.'),
    },
  ];

  const helpLinks: MenuLink[] = [
    {
      icon: 'ayuda',
      label: 'Centro de ayuda',
      route: '/(client)/help',
    },
    {
      icon: 'seguridad',
      label: 'Centro legal, datos y SIC',
      route: '/(client)/legal',
    },
    {
      icon: 'soporte',
      label: 'PQRS y solicitudes de datos',
      route: '/(client)/requests',
    },
  ];

  // Cada fila abre el mismo lector y le dice qué documento buscar.
  const legalLinks: MenuLink[] = [
    {
      icon: 'documento',
      label: 'Términos y condiciones',
      route: '/(client)/legal-document',
      params: { kind: 'terms', title: 'Términos y condiciones' },
    },
    {
      icon: 'privacidad',
      label: 'Políticas de privacidad',
      route: '/(client)/legal-document',
      params: { kind: 'privacy', title: 'Políticas de privacidad' },
    },
    {
      icon: 'consentimiento',
      label: 'Autorización de tratamiento de datos personales',
      route: '/(client)/legal-document',
      params: { kind: 'habeas_data', title: 'Autorización de datos' },
    },
  ];

  const systemLinks: MenuLink[] = [
    {
      logo: <MapboxLogo size={20} color={c.text} />,
      label: 'Ubicación y GPS',
      action: () => Linking.openSettings().catch(() => {}),
    },
    {
      icon: 'notificaciones',
      label: 'Notificaciones del sistema',
      action: () => Linking.openSettings().catch(() => {}),
    },
  ];

  const confirmLogout = () => {
    tap('warning');
    setLogoutDialogVisible(true);
  };

  const doLogout = async () => {
    setLogoutDialogVisible(false);
    // Baja del push antes de soltar la sesión: después, la petición
    // fallaría y el backend seguiría notificando a este teléfono.
    await unregisterPush();
    socketService.disconnect();
    clearCart();
    logout();
    router.replace('/(auth)/login');
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
          <PText v="displayM" style={styles.headerTitle}>
            Perfil
          </PText>
          <PText v="bodyS" tone="textMuted">
            Gestiona tu cuenta, direcciones y beneficios
          </PText>
        </View>

        {/* ── Cuenta: sin card, integrada al fondo de la pantalla ── */}
        <View style={styles.heroRow}>
          <Pressable
            onPress={() => { tap('light'); router.push(ROUTES.account as never); }}
            accessibilityRole="button"
            accessibilityLabel="Mi cuenta"
            hitSlop={4}
          >
            <Avatar uri={user?.avatar} name={user?.name} size={44} />
          </Pressable>

          <View style={styles.heroInfo}>
            <PText v="strongL" numberOfLines={1} style={styles.userName}>
              {user?.name ?? 'Tu cuenta Zipp'}
            </PText>
            <Pressable
              onPress={() => {
                tap('light');
                router.push(ROUTES.account as never);
              }}
              accessibilityRole="button"
              accessibilityLabel="Editar perfil"
              hitSlop={8}
              style={styles.editTouch}
            >
              <PText v="strongS" tone="textMuted">Editar perfil</PText>
              <Icon name="siguiente" size="sm" color={c.textMuted} />
            </Pressable>
          </View>
        </View>

        <View style={[styles.hairline, { backgroundColor: c.borderLight }]} />

        {/* ── Grupo 1: Mi Cuenta ── */}
        <MenuGroup title="MI CUENTA" links={accountLinks} />

        {/* ── Grupo 3: Trabajar con Zipp ── */}
        <MenuGroup title="TRABAJA CON ZIPP" links={joinLinks} />

        {/* ── Pantalla y apariencia: mockups, sin caja alrededor ── */}
        <View style={styles.groupContainer}>
          <PText v="captionStrong" tone="textMuted" style={styles.groupTitle}>
            PANTALLA Y APARIENCIA
          </PText>
          <View style={styles.themeOptionsRow}>
            <ThemeOption
              icon="temaClaro"
              label="Claro"
              isSelected={theme === 'light'}
              onSelect={() => { tap('select'); setTheme('light'); }}
            />
            <ThemeOption
              icon="temaOscuro"
              label="Oscuro"
              isSelected={theme === 'dark'}
              onSelect={() => { tap('select'); setTheme('dark'); }}
            />
            <ThemeOption
              icon="celular"
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
            pressed && { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.02)' },
          ]}
        >
          <View style={styles.linkIconSlot}>
            <Icon name="salir" size={20} color={c.error} />
          </View>

          <View style={styles.logoutTextBody}>
            <PText v="strongM" color={c.error}>
              Cerrar sesión
            </PText>
            <PText v="caption" tone="textMuted">
              Desconectar tu cuenta de este dispositivo
            </PText>
          </View>

          <View style={styles.logoutArrow}>
            <Icon name="siguiente" size="sm" color={c.error} />
          </View>
        </Pressable>
      </ScrollView>

      {/* ── Confirmar cierre de sesión ── */}
      <ConfirmDialog
        visible={logoutDialogVisible}
        onCancel={() => setLogoutDialogVisible(false)}
        onConfirm={doLogout}
        icon="salir"
        title="Cerrar sesión"
        message="¿Seguro que quieres salir de tu cuenta Zipp?"
        confirmText="Cerrar sesión"
        cancelText="Cancelar"
        tone="danger"
      />
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
      <PText v="captionStrong" tone="textMuted" style={styles.groupTitle}>
        {title}
      </PText>

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
          accessibilityLabel={link.label}
          style={({ pressed }) => [
            styles.linkPressable,
            idx < links.length - 1 || !last
              ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)' }
              : null,
            pressed && { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.02)' },
          ]}
        >
          <View style={styles.linkIconSlot}>
            {link.logo ? (
              link.logo
            ) : link.illustration ? (
              <ContentIcon name={link.illustration} size={22} />
            ) : (
              <Icon name={link.icon ?? 'ajustes'} size={20} color={c.text} />
            )}
          </View>

          <View style={styles.linkTextBody}>
            {/* Dos líneas: los nombres de los documentos legales son largos. */}
            <PText v="strongM" numberOfLines={2}>
              {link.label}
            </PText>
          </View>

          {link.badge ? (
            <View style={[styles.badgePill, { backgroundColor: c.primarySoft }]}>
              <PText v="captionStrong" tone="primaryText">{link.badge}</PText>
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

function ThemeOption({
  icon,
  label,
  isSelected,
  onSelect,
}: {
  icon: IconName;
  label: string;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { c } = useTheme();

  return (
    <Pressable
      onPress={onSelect}
      accessibilityRole="radio"
      accessibilityState={{ selected: isSelected }}
      accessibilityLabel={`Seleccionar tema ${label}`}
      style={styles.themeOption}
    >
      <Icon name={icon} size={22} color={isSelected ? c.primary : c.textMuted} />
      <PText v={isSelected ? 'strongS' : 'bodyS'} color={isSelected ? c.primary : c.textSecondary}>
        {label}
      </PText>
    </Pressable>
  );
}

// ──────────────────────────────────────────────────────────────
// Estilos
// ──────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xl,
    gap: Spacing.xxl,
  },

  // Header
  headerArea: {
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.xs,
    gap: 4,
  },
  headerTitle: {
    fontSize: 24,
    letterSpacing: -0.5,
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

  heroInfo: {
    flex: 1,
    gap: 2,
  },
  userName: {
    fontSize: 19,
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
    paddingVertical: 7,
    gap: Spacing.md,
  },
  linkIconSlot: {
    width: 24,
    height: 24,
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
  themeOptionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  themeOption: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    gap: Spacing.xs,
  },
  // Cerrar sesión
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
    gap: Spacing.md,
    marginTop: Spacing.xs,
  },
  logoutTextBody: {
    flex: 1,
    gap: 2,
  },
  logoutArrow: {
    opacity: 0.45,
  },
});
