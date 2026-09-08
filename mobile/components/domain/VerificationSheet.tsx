import { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, Alert } from 'react-native';
import { Text, Button, Sheet, Notice } from '../ui';
import { ContentIcon } from '../illustrations';
import { useTheme } from '../../hooks/useTheme';
import { socketService, type VerificationRequest } from '../../services/socket';
import { driverApi } from '../../services/endpoints';
import { captureEvidence } from '../../lib/evidence';
import { tap } from '../../lib/haptics';
import { Spacing } from '../../theme/tokens';

/**
 * La selfie que la plataforma pide en mitad del turno.
 *
 * Responde a una pregunta que la verificación del alta no puede: la cuenta
 * se aprobó una vez, pero quién conduce la moto hoy. Prestar la cuenta a un
 * tercero sin documentos ni antecedentes es el fraude más fácil de esta
 * operación, y el único momento de detectarlo es mientras está pasando.
 *
 * No se puede cerrar sin responder. No es una molestia gratuita: mientras
 * el plazo corre el domiciliario sigue trabajando con normalidad, y solo
 * cuando vence deja de recibir pedidos. Cerrar la hoja y olvidarla sería
 * justo el camino que lleva al bloqueo sin entender por qué.
 */
export function VerificationSheet() {
  const { c } = useTheme();
  const [request, setRequest] = useState<VerificationRequest | null>(null);
  const [minutesLeft, setMinutesLeft] = useState(0);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    const handle = (incoming: VerificationRequest) => {
      tap('warning');
      setRequest(incoming);
    };

    socketService.onVerificationRequested(handle);
    return () => socketService.offVerificationRequested(handle);
  }, []);

  useEffect(() => {
    if (!request) return;

    const update = () => {
      const left = Math.max(
        0,
        Math.ceil((new Date(request.dueAt).getTime() - Date.now()) / 60_000)
      );
      setMinutesLeft(left);
    };

    update();
    const timer = setInterval(update, 30_000);
    return () => clearInterval(timer);
  }, [request]);

  const handleTakeSelfie = useCallback(async () => {
    if (!request) return;

    try {
      setWorking(true);
      // Misma captura que la evidencia de entrega: siempre cámara, nunca
      // galería. Una selfie elegida del carrete no prueba quién conduce.
      const uri = await captureEvidence();
      if (!uri) {
        setWorking(false);
        return;
      }

      await driverApi.submitVerification(uri, request.type);
      tap('success');
      setRequest(null);
      Alert.alert(
        'Selfie enviada',
        'Gracias. Sigues disponible mientras la revisamos.'
      );
    } catch (err: any) {
      Alert.alert(
        'No pudimos enviarla',
        err?.response?.data?.message ?? err?.message ?? 'Inténtalo de nuevo.'
      );
    } finally {
      setWorking(false);
    }
  }, [request]);

  if (!request) return null;

  const urgent = minutesLeft <= 5;

  return (
    <Sheet
      visible
      // Sin `onClose` que la descarte: la única salida es responder. Ver el
      // comentario de arriba — cerrarla y olvidarla lleva al bloqueo.
      onClose={() => {}}
      title="Verifica que eres tú"
      height={0.56}
      scroll={false}
      footer={
        <Button
          title={working ? 'Abriendo cámara…' : 'Tomarme la selfie'}
          icon="camara"
          onPress={handleTakeSelfie}
          style={styles.action}
        />
      }
    >
      <View style={styles.body}>
        <View style={styles.art}>
          <ContentIcon name="seguridad" size={88} />
        </View>

        <Text v="bodyM" tone="textSecondary" center>
          Necesitamos una selfie para confirmar que eres tú quien está
          repartiendo. Es rápido y solo la ve nuestro equipo de seguridad.
        </Text>

        <Notice tone={urgent ? 'error' : 'warning'}>
          {minutesLeft <= 0
            ? 'El plazo venció. Envía la selfie para volver a recibir pedidos.'
            : `Tienes ${minutesLeft} minuto${minutesLeft === 1 ? '' : 's'} para responder. Mientras tanto sigues trabajando con normalidad.`}
        </Notice>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: Spacing.lg, paddingTop: Spacing.sm, alignItems: 'center' },
  art: { paddingVertical: Spacing.md },
  action: { width: '100%' },
});
