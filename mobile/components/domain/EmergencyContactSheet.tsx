import { useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Text, Button, Sheet, Input, Notice } from '../ui';
import { driverApi } from '../../services/endpoints';
import { apiMessage, validatePhone } from '../../lib/errors';
import { tap } from '../../lib/haptics';
import { Spacing } from '../../theme/tokens';

/**
 * A quién avisar si algo va mal.
 *
 * El botón de pánico ya decía "No tienes contacto de emergencia. Agrégalo en
 * tu perfil"… y **esa pantalla no existía**. `driverApi.setEmergencyContact`
 * llevaba escrito desde siempre sin un solo llamador.
 *
 * El proyecto aplicó bien su propia regla —no deshabilitar la acción
 * principal, encadenarla al paso que falta— pero encadenó a un paso
 * imposible. Una instrucción que no se puede cumplir es peor que un botón
 * gris: el gris al menos no miente.
 *
 * El SOS funciona igual sin esto; lo que cambia es si además de avisar al
 * equipo se puede avisar a alguien suyo.
 */
export function EmergencyContactSheet({
  visible,
  onClose,
  current,
}: {
  visible: boolean;
  onClose: () => void;
  current?: { name?: string; phone?: string; relationship?: string } | null;
}) {
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [relationship, setRelationship] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Se rellena con lo que ya hubiera al abrir: editar es el caso normal una
  // vez está puesto, y obligar a reescribirlo entero invita a dejarlo mal.
  useEffect(() => {
    if (!visible) return;
    setName(current?.name ?? '');
    setPhone(current?.phone ?? '');
    setRelationship(current?.relationship ?? '');
    setError(null);
  }, [visible, current]);

  const save = useMutation({
    mutationFn: () =>
      driverApi.setEmergencyContact({
        name: name.trim(),
        phone: phone.trim(),
        relationship: relationship.trim() || undefined,
      }),
    onSuccess: () => {
      // El botón de pánico lee el perfil para saber si hay contacto: sin
      // invalidar, seguiría avisando de que falta justo después de ponerlo.
      queryClient.invalidateQueries({ queryKey: ['driver', 'profile'] });
      tap('success');
      onClose();
    },
    onError: (err) => {
      tap('error');
      setError(apiMessage(err, 'No pudimos guardar el contacto. Intenta de nuevo.'));
    },
  });

  const submit = () => {
    if (!name.trim()) return setError('Escribe el nombre de tu contacto.');

    // `validatePhone` devuelve el motivo concreto ("tiene 10 dígitos",
    // "empiezan por 3") en vez de un "no es válido" genérico: quien se
    // equivoca al teclear necesita saber qué corregir.
    const phoneError = validatePhone(phone);
    if (phoneError) return setError(phoneError);

    setError(null);
    save.mutate();
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Contacto de emergencia"
      height={0.7}
      footer={
        <Button
          title={save.isPending ? 'Guardando…' : 'Guardar contacto'}
          full
          loading={save.isPending}
          onPress={submit}
        />
      }
    >
      <View style={styles.body}>
        <Text v="bodyM" tone="textSecondary">
          Si usas el botón de emergencia, además de avisarnos a nosotros
          podremos decirle a esta persona dónde estás.
        </Text>

        <Input
          label="Nombre"
          value={name}
          onChangeText={setName}
          placeholder="María Rodríguez"
          autoCapitalize="words"
        />

        <Input
          label="Celular"
          value={phone}
          onChangeText={setPhone}
          placeholder="300 000 0000"
          keyboardType="phone-pad"
          numeric
        />

        <Input
          label="Parentesco (opcional)"
          value={relationship}
          onChangeText={setRelationship}
          placeholder="Mamá, hermano, pareja…"
        />

        <Notice tone="info">
          Solo lo usamos si tú activas el botón de emergencia. Nunca lo
          compartimos con clientes ni con comercios.
        </Notice>

        {error ? <Notice tone="error">{error}</Notice> : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: Spacing.md, paddingBottom: Spacing.md },
});
