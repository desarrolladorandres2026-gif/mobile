import { useState } from 'react';
import { ScrollView, StyleSheet, View, Pressable } from 'react-native';
import {
  Text, Icon, Button, Badge, Sheet, Input, Notice, Screen, Header, LoadingScreen,
} from '../../components/ui';
import { useDriverDocuments, useSubmitDriverDocument } from '../../hooks/useApi';
import type { DriverDocumentType, DriverDocumentRecord } from '../../services/endpoints';
import { apiMessage } from '../../lib/errors';
import { useTheme } from '../../hooks/useTheme';
import { Spacing, BorderRadius } from '../../theme/tokens';
import { tap } from '../../lib/haptics';

/**
 * Documentos del domiciliario: cédula, licencia, SOAT, tecnomecánica,
 * tarjeta de propiedad.
 *
 * El backend tenía la cola de revisión completa en el panel de admin
 * (`GET /drivers/documents/queue`) desde hacía tiempo, y **nunca tuvo
 * origen**: la app del domiciliario no tenía por dónde enviar un solo
 * documento. No es una subida de foto — `reference` es el número del
 * documento— así que el formulario es tan simple como el dato que pide.
 */

const TYPES: { type: DriverDocumentType; label: string; hint: string }[] = [
  { type: 'identity', label: 'Cédula', hint: 'Número de tu cédula de ciudadanía' },
  { type: 'license', label: 'Licencia de conducción', hint: 'Número de la licencia' },
  { type: 'soat', label: 'SOAT', hint: 'Número de la póliza' },
  { type: 'technical_review', label: 'Tecnomecánica', hint: 'Número del certificado' },
  { type: 'vehicle_registration', label: 'Tarjeta de propiedad', hint: 'Número de la tarjeta' },
];

const STATUS_LABEL: Record<DriverDocumentRecord['status'], string> = {
  pending: 'En revisión',
  approved: 'Aprobado',
  rejected: 'Rechazado',
  expired: 'Vencido',
};

const STATUS_TONE: Record<DriverDocumentRecord['status'], 'warning' | 'lime' | 'error' | 'neutral'> = {
  pending: 'warning',
  approved: 'lime',
  rejected: 'error',
  expired: 'error',
};

export default function DriverDocumentsScreen() {
  const { c } = useTheme();
  const { data: documents = [], isLoading } = useDriverDocuments();
  const [editing, setEditing] = useState<DriverDocumentType | null>(null);

  const byType = new Map(documents.map((d) => [d.type, d]));

  if (isLoading) return <LoadingScreen message="Buscando tus documentos…" />;

  return (
    <Screen>
      <Header title="Mis documentos" fallback="/(driver)/(tabs)/profile" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text v="bodyM" tone="textSecondary">
          Los revisamos antes de dejarte tomar pedidos. Un documento
          rechazado se puede volver a enviar.
        </Text>

        {TYPES.map(({ type, label }) => {
          const doc = byType.get(type);
          return (
            <Pressable
              key={type}
              onPress={() => { tap('light'); setEditing(type); }}
              accessibilityRole="button"
              accessibilityLabel={
                doc
                  ? `${label}: ${STATUS_LABEL[doc.status]}. Toca para editar`
                  : `${label}: sin enviar. Toca para enviarlo`
              }
              style={[styles.row, { backgroundColor: c.surface, borderColor: c.border }]}
            >
              <View style={[styles.rowIcon, { backgroundColor: c.surfaceLight }]}>
                <Icon name="documento" size="md" color={c.textMuted} />
              </View>
              <View style={styles.flex}>
                <Text v="strongS">{label}</Text>
                <Text v="caption" tone="textMuted">
                  {doc ? doc.reference : 'Sin enviar'}
                </Text>
              </View>
              {doc ? (
                <Badge label={STATUS_LABEL[doc.status]} tone={STATUS_TONE[doc.status]} />
              ) : (
                <Badge label="Falta" tone="warning" />
              )}
            </Pressable>
          );
        })}
      </ScrollView>

      <DocumentSheet
        visible={!!editing}
        onClose={() => setEditing(null)}
        type={editing}
        current={editing ? byType.get(editing) : undefined}
      />
    </Screen>
  );
}

function DocumentSheet({
  visible, onClose, type, current,
}: {
  visible: boolean;
  onClose: () => void;
  type: DriverDocumentType | null;
  current?: DriverDocumentRecord;
}) {
  const meta = TYPES.find((t) => t.type === type);
  const submit = useSubmitDriverDocument();

  const [reference, setReference] = useState(current?.reference ?? '');
  const [error, setError] = useState<string | null>(null);

  // Se resincroniza cada vez que se abre con un documento distinto: sin
  // esto, editar la SOAT después de haber editado la licencia mostraría el
  // texto de la licencia.
  const key = `${type}:${current?.reference ?? ''}`;
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setReference(current?.reference ?? '');
    setError(null);
  }

  const send = () => {
    if (!type) return;
    if (reference.trim().length < 3) {
      return setError('El número parece muy corto. Revísalo.');
    }
    setError(null);
    submit.mutate(
      { type, reference: reference.trim() },
      {
        onSuccess: () => { tap('success'); onClose(); },
        onError: (err) => {
          tap('error');
          setError(apiMessage(err, 'No pudimos enviar el documento. Intenta de nuevo.'));
        },
      }
    );
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={meta?.label ?? 'Documento'}
      height={0.55}
      scroll={false}
      footer={
        <Button
          title={submit.isPending ? 'Enviando…' : 'Enviar para revisión'}
          full
          loading={submit.isPending}
          onPress={send}
        />
      }
    >
      <View style={styles.sheetBody}>
        {current?.status === 'rejected' ? (
          <Notice tone="error">
            Este documento se rechazó. Revisa el número y vuelve a enviarlo.
          </Notice>
        ) : null}

        <Input
          label={meta?.hint ?? 'Número del documento'}
          value={reference}
          onChangeText={setReference}
          placeholder="Escribe el número"
          numeric
        />

        {error ? <Notice tone="error">{error}</Notice> : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.xl, gap: Spacing.md, paddingBottom: Spacing.huge },
  flex: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    minHeight: 60,
  },
  rowIcon: {
    width: 44, height: 44, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  sheetBody: { gap: Spacing.md },
});
