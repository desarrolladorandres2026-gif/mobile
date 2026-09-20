import { useState } from 'react';
import { View, ScrollView, StyleSheet, Pressable, RefreshControl } from 'react-native';
import { Text, Icon, Button, Notice, Screen, Header, ConfirmDialog, Skeleton } from '../../components/ui';
import { useActiveSessions, useRevokeSession, useRevokeOtherSessions } from '../../hooks/useApi';
import { useAuthStore } from '../../stores/authStore';
import { useTheme } from '../../hooks/useTheme';
import { useBottomInset } from '../../hooks/useBottomSpace';
import type { ActiveSession } from '../../services/endpoints';
import { Spacing } from '../../theme/tokens';
import { apiMessage } from '../../lib/errors';
import { tap } from '../../lib/haptics';
import { ROUTES } from '../../lib/routing';
import { describeSession, lastSeen } from '../../lib/sessionLabels';

export default function SessionsScreen() {
  const { c, isDark } = useTheme();
  const bottomInset = useBottomInset();
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const { data: sessions, isPending, isError, error, refetch, isRefetching } = useActiveSessions();
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();

  const [target, setTarget] = useState<ActiveSession | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [message, setMessage] = useState<{ tone: 'lime' | 'error'; text: string } | null>(null);

  const others = (sessions ?? []).filter((s) => !s.current);

  const doRevoke = () => {
    const session = target;
    setTarget(null);
    if (!session) return;
    setMessage(null);
    revoke.mutate(session._id, {
      onSuccess: () => { tap('success'); setMessage({ tone: 'lime', text: `Cerramos la sesión de ${describeSession(session)}.` }); },
      onError: (err) => { tap('error'); setMessage({ tone: 'error', text: apiMessage(err, 'No pudimos cerrar esa sesión.') }); },
    });
  };

  const doRevokeOthers = () => {
    setConfirmAll(false);
    setMessage(null);
    revokeOthers.mutate(refreshToken ?? undefined, {
      onSuccess: ({ revokedCount }) => {
        tap('success');
        setMessage({
          tone: 'lime',
          text: revokedCount === 1 ? 'Cerramos 1 sesión.' : `Cerramos ${revokedCount} sesiones.`,
        });
      },
      onError: (err) => { tap('error'); setMessage({ tone: 'error', text: apiMessage(err, 'No pudimos cerrar las sesiones.') }); },
    });
  };

  return (
    <Screen>
      <Header title="Sesiones activas" fallback={ROUTES.account} />

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset + Spacing.xxl }]}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={c.primary} />}
      >
        <Text v="bodyM" tone="textSecondary">
          Estos son los dispositivos donde tu cuenta está abierta. Si no reconoces alguno, ciérralo y cambia tu contraseña.
        </Text>

        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

        {isPending ? (
          <View style={styles.list}>
            <Skeleton height={64} />
            <Skeleton height={64} />
          </View>
        ) : isError ? (
          <Notice tone="error">{apiMessage(error, 'No pudimos cargar tus sesiones.')}</Notice>
        ) : (
          <View style={styles.list}>
            {(sessions ?? []).map((s, idx) => (
              <View
                key={s._id}
                style={[
                  styles.row,
                  idx < (sessions?.length ?? 0) - 1 && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)',
                  },
                ]}
              >
                <View style={styles.iconSlot}>
                  <Icon name="celular" size={24} color={s.current ? c.primaryText : c.text} />
                </View>
                <View style={styles.flex}>
                  <Text v="strongM" numberOfLines={1}>{describeSession(s)}</Text>
                  <Text v="caption" tone={s.current ? 'primaryText' : 'textMuted'}>
                    {s.current ? 'Este dispositivo' : lastSeen(s.lastActivity)}
                  </Text>
                </View>
                {!s.current ? (
                  <Pressable
                    onPress={() => { tap('warning'); setTarget(s); }}
                    accessibilityRole="button"
                    accessibilityLabel={`Cerrar sesión en ${describeSession(s)}`}
                    hitSlop={8}
                    style={({ pressed }) => [styles.close, pressed && { opacity: 0.6 }]}
                  >
                    <Text v="strongS" color={c.error}>Cerrar</Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
          </View>
        )}

        {others.length > 1 ? (
          <Button
            title="Cerrar todas las demás"
            variant="secondary"
            size="lg"
            full
            loading={revokeOthers.isPending}
            onPress={() => { tap('warning'); setConfirmAll(true); }}
          />
        ) : null}
      </ScrollView>

      <ConfirmDialog
        visible={!!target}
        onCancel={() => setTarget(null)}
        onConfirm={doRevoke}
        icon="salir"
        title="Cerrar esa sesión"
        message={target ? `${describeSession(target)} tendrá que volver a iniciar sesión.` : ''}
        confirmText="Cerrar sesión"
      />
      <ConfirmDialog
        visible={confirmAll}
        onCancel={() => setConfirmAll(false)}
        onConfirm={doRevokeOthers}
        icon="salir"
        title="Cerrar las demás sesiones"
        message={`Se cerrarán ${others.length} sesiones. Este dispositivo sigue abierto.`}
        confirmText="Cerrar todas"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg, gap: Spacing.lg },
  list: { gap: 0 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: Spacing.md },
  iconSlot: { width: 32, alignItems: 'center' },
  close: { paddingVertical: 6, paddingHorizontal: 4 },
});
