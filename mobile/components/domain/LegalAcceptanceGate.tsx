import { useState } from 'react';
import { Modal, ScrollView, View, StyleSheet, Pressable } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Text, Button, Screen, ScreenFooter } from '../ui';
import { legalApi } from '../../services/endpoints';
import { useAuthStore } from '../../stores/authStore';
import { useTheme } from '../../hooks/useTheme';
import { Spacing } from '../../theme/tokens';
import { tap } from '../../lib/haptics';
import { apiMessage } from '../../lib/errors';

/**
 * Términos y privacidad, aceptados de verdad.
 *
 * Antes el registro decía "al crear tu cuenta aceptas…" y no guardaba nada:
 * `LegalAcceptance` estaba vacía y no había forma de probar quién aceptó qué
 * versión. Esto pide aceptar la versión vigente de términos y privacidad
 * (`GET /legal/pending`) después de registrarse —también con Google o
 * Apple— y otra vez cuando Zipp publica una versión nueva.
 *
 * Bloquea la app hasta aceptar (decidido con el dueño el 2026-09-25). Es un
 * `Modal` encima de la navegación y no una ruta: así el GPS, la hoja de
 * ofertas y el SOS del domiciliario siguen montados debajo, y un domiciliario
 * a mitad de entrega solo pierde un toque. La única salida es cerrar sesión.
 *
 * Sin documentos publicados, el servidor devuelve vacío y no aparece nada.
 */

interface PendingDocument {
  _id: string;
  kind: string;
  version: string;
  title: string;
  content: string;
  isUpdate: boolean;
}

export const LEGAL_PENDING_KEY = ['legal-pending'] as const;

export function LegalAcceptanceGate() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isVerified = useAuthStore((s) => !!s.user?.isVerified);
  const logout = useAuthStore((s) => s.logout);
  const queryClient = useQueryClient();
  const { c } = useTheme();

  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const { data: pending = [] } = useQuery<PendingDocument[]>({
    queryKey: LEGAL_PENDING_KEY,
    queryFn: legalApi.pending,
    enabled: isAuthenticated && isVerified,
    // Al volver a la app se revisa otra vez: así una versión publicada con
    // la app abierta se pide sin tener que reiniciarla.
    refetchOnWindowFocus: true,
    staleTime: 5 * 60_000,
  });

  if (!isAuthenticated || pending.length === 0) return null;

  const isUpdate = pending.some((d) => d.isUpdate);

  const accept = async () => {
    tap('light');
    setBusy(true);
    setError('');
    try {
      // Uno por documento: cada aceptación queda atada a su versión exacta.
      for (const doc of pending) await legalApi.accept(doc._id);
      tap('success');
      await queryClient.invalidateQueries({ queryKey: LEGAL_PENDING_KEY });
    } catch (err) {
      setError(apiMessage(err, 'No pudimos guardar tu aceptación. Inténtalo de nuevo.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible animationType="fade" onRequestClose={() => {}} statusBarTranslucent>
      <Screen edges={['top']}>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <Text v="titleL">{isUpdate ? 'Actualizamos nuestras condiciones' : 'Antes de empezar'}</Text>
          <Text v="bodyM" tone="textSecondary">
            {isUpdate
              ? 'Para seguir usando Zipp necesitamos que aceptes la versión nueva. Puedes leerla completa aquí abajo.'
              : 'Para usar Zipp necesitamos que aceptes estos documentos. Puedes leerlos completos aquí abajo.'}
          </Text>

          <View style={styles.list}>
            {pending.map((doc) => {
              const expanded = open === doc._id;
              return (
                <View key={doc._id} style={[styles.row, { borderBottomColor: c.borderLight }]}>
                  <Pressable
                    onPress={() => { tap('light'); setOpen(expanded ? null : doc._id); }}
                    accessibilityRole="button"
                    accessibilityState={{ expanded }}
                    style={styles.rowHead}
                  >
                    <View style={styles.flex}>
                      <Text v="strongM">{doc.title}</Text>
                      <Text v="caption" tone="textMuted">Versión {doc.version}</Text>
                    </View>
                    <Text v="strongS" tone="primary">{expanded ? 'Ocultar' : 'Leer'}</Text>
                  </Pressable>
                  {expanded ? (
                    <Text v="bodyS" tone="textSecondary" style={styles.docText}>{doc.content}</Text>
                  ) : null}
                </View>
              );
            })}
          </View>

          {error ? <Text v="bodyS" tone="error">{error}</Text> : null}
        </ScrollView>

        <ScreenFooter>
          <Button title="Aceptar y continuar" full pill loading={busy} onPress={accept} />
          <Button
            title="Cerrar sesión"
            variant="ghost"
            full
            onPress={() => { tap('light'); logout(); }}
          />
        </ScreenFooter>
      </Screen>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xl,
    paddingBottom: Spacing.xl,
    gap: Spacing.md,
  },
  list: { marginTop: Spacing.md },
  row: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: Spacing.md,
    gap: Spacing.sm,
  },
  rowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  docText: { lineHeight: 20 },
});
