import { useState } from 'react';
import { ScrollView, StyleSheet, View, Pressable, Alert } from 'react-native';
import { Image } from 'expo-image';
import {
  Text, Icon, Button, Badge, Sheet, Input, Notice, Screen, Header, LoadingScreen,
} from '../../components/ui';
import { useDriverDocuments, useSubmitDriverDocument } from '../../hooks/useApi';
import type { DriverDocumentType, DriverDocumentRecord } from '../../services/endpoints';
import { apiMessage } from '../../lib/errors';
import { useTheme } from '../../hooks/useTheme';
import { Spacing, BorderRadius } from '../../theme/tokens';
import { tap } from '../../lib/haptics';
import { captureDocumentPhoto, type DocumentPhotoSource } from '../../lib/documentPhoto';

/**
 * Documentos del domiciliario: cédula, licencia, SOAT, tecnomecánica,
 * tarjeta de propiedad.
 *
 * El backend tenía la cola de revisión completa en el panel de admin
 * (`GET /drivers/documents/queue`) desde hacía tiempo, y **nunca tuvo
 * origen**: la app del domiciliario no tenía por dónde enviar un solo
 * documento.
 *
 * Van con foto, y no siempre fue así: durante un tiempo esto solo pedía el
 * número. Un número es un dato, no una prueba — nadie podía comprobar que
 * la cédula fuera de quien la teclea ni que la póliza existiera, y la cola
 * del admin era un trámite de aprobar cifras. La foto es lo único que
 * convierte esa revisión en una revisión.
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
                  {!doc
                    ? 'Sin enviar'
                    : doc.imageUrl
                      ? doc.reference
                      : `${doc.reference} · falta la foto`}
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
  const { c } = useTheme();
  const meta = TYPES.find((t) => t.type === type);
  const submit = useSubmitDriverDocument();

  const [reference, setReference] = useState(current?.reference ?? '');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Se resincroniza cada vez que se abre con un documento distinto: sin
  // esto, editar la SOAT después de haber editado la licencia mostraría el
  // texto de la licencia.
  const key = `${type}:${current?.reference ?? ''}`;
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setReference(current?.reference ?? '');
    setPhotoUri(null);
    setError(null);
  }

  /**
   * La foto que se va a enviar: la recién tomada, o la que ya estaba.
   *
   * Distinguirlas importa. `photoUri` es local y hay que subirla;
   * `current.imageUrl` ya vive en el servidor y solo se enseña. Sin la
   * segunda, corregir una errata en el número obligaría a volver a
   * fotografiar la cédula.
   */
  const shownPhoto = photoUri ?? current?.imageUrl ?? null;

  const pickPhoto = async (source: DocumentPhotoSource) => {
    try {
      const uri = await captureDocumentPhoto(source);
      if (!uri) return;
      setPhotoUri(uri);
      setError(null);
      tap('success');
    } catch (err) {
      tap('error');
      Alert.alert(
        'No pudimos tomar la foto',
        err instanceof Error ? err.message : 'Inténtalo de nuevo.'
      );
    }
  };

  const send = () => {
    if (!type) return;
    if (reference.trim().length < 3) {
      return setError('El número parece muy corto. Revísalo.');
    }
    if (!shownPhoto) {
      // El servidor también lo rechaza, pero decirlo aquí ahorra un viaje
      // y un mensaje de error genérico después de haber escrito todo.
      return setError('Falta la foto del documento.');
    }
    setError(null);
    submit.mutate(
      { type, reference: reference.trim(), imageUri: photoUri ?? undefined },
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
      height={0.82}
      scroll
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
            {current.rejectionReason
              ? `Este documento se rechazó: ${current.rejectionReason}. Corrígelo y envíalo de nuevo.`
              : 'Este documento se rechazó. Revisa el número, vuelve a tomar la foto y envíalo de nuevo.'}
          </Notice>
        ) : null}

        <Input
          label={meta?.hint ?? 'Número del documento'}
          value={reference}
          onChangeText={setReference}
          placeholder="Escribe el número"
          numeric
        />

        {/*
          La foto va debajo del número y no encima a propósito: el número
          es lo que el domiciliario tiene en la cabeza y puede escribir de
          memoria; la foto exige levantarse a buscar el documento. Pedir
          primero lo caro es la forma más segura de que nadie termine.
        */}
        <View style={styles.photoBlock}>
          <Text v="strongS" tone="textSecondary">Foto del documento</Text>

          {shownPhoto ? (
            <Image source={{ uri: shownPhoto }} style={styles.photo} contentFit="cover" />
          ) : (
            <View style={[styles.photoEmpty, { borderColor: c.border }]}>
              <Icon name="camara" size="lg" color={c.textMuted} />
              <Text v="caption" tone="textMuted">Que se lean bien los datos</Text>
            </View>
          )}

          {/*
            Cámara y galería, las dos. Un SOAT casi siempre llega al
            teléfono como captura del correo de la aseguradora, y obligar a
            fotografiar la pantalla del portátil empeoraría la prueba en
            nombre de la seguridad. Lo que ata el documento a quien conduce
            no es de dónde salió la foto, es la selfie de verificación en
            turno — ver `VerificationSheet`.
          */}
          <View style={styles.photoActions}>
            <Button
              title={shownPhoto ? 'Repetir foto' : 'Tomar foto'}
              icon="camara"
              variant="secondary"
              onPress={() => pickPhoto('camera')}
              style={styles.flex}
            />
            <Button
              title="Desde galería"
              icon="foto"
              variant="ghost"
              onPress={() => pickPhoto('library')}
              style={styles.flex}
            />
          </View>
        </View>

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
  sheetBody: { gap: Spacing.md, paddingBottom: Spacing.xl },

  photoBlock: { gap: Spacing.sm },
  photo: { width: '100%', height: 190, borderRadius: BorderRadius.lg },
  photoEmpty: {
    width: '100%',
    height: 190,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
  },
  photoActions: { flexDirection: 'row', gap: Spacing.sm },
});
