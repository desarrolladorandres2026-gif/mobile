import { useState } from 'react';
import { ScrollView, TextInput, View, StyleSheet, Pressable } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Header, Screen, Text, Icon, EmptyState } from '../../components/ui';
import { legalApi, pqrsApi } from '../../services/endpoints';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing, FontSize } from '../../theme/tokens';
import { tap } from '../../lib/haptics';
import { ROUTES } from '../../lib/routing';

const TYPES = [
  ['petition', 'Petición'],
  ['complaint', 'Queja'],
  ['claim', 'Reclamo'],
  ['suggestion', 'Sugerencia'],
] as const;

const DATA_TYPES = [
  ['access', 'Consultar datos'],
  ['rectify', 'Corregir'],
  ['update', 'Actualizar'],
  ['delete', 'Suprimir'],
  ['revoke', 'Revocar'],
] as const;

export default function RequestsScreen() {
  const { c, isDark } = useTheme();
  const qc = useQueryClient();
  const [kind, setKind] = useState<'pqrs' | 'data'>('pqrs');
  const [type, setType] = useState('petition');
  const [subject, setSubject] = useState('');
  const [detail, setDetail] = useState('');

  const { data: pqrs = [] } = useQuery({ queryKey: ['pqrs'], queryFn: pqrsApi.mine });
  const { data: dataRequests = [] } = useQuery({ queryKey: ['data-requests'], queryFn: legalApi.dataRequests });

  const save = useMutation({
    mutationFn: () =>
      kind === 'pqrs'
        ? pqrsApi.create(type, subject, detail)
        : legalApi.createDataRequest(type, detail),
    onSuccess: () => {
      setSubject('');
      setDetail('');
      tap('success');
      qc.invalidateQueries({ queryKey: [kind === 'pqrs' ? 'pqrs' : 'data-requests'] });
    },
  });

  const options = kind === 'pqrs' ? TYPES : DATA_TYPES;

  return (
    <Screen style={{ backgroundColor: isDark ? '#0C101C' : '#F1F3F7' }}>
      <Header title="PQRS y solicitudes de datos" fallback={ROUTES.profile} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* ── Segment Selector One UI ── */}
        <View
          style={[
            styles.segmentTrack,
            {
              backgroundColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.05)',
            },
          ]}
        >
          <Pressable
            onPress={() => {
              tap('select');
              setKind('pqrs');
              setType('petition');
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: kind === 'pqrs' }}
            accessibilityLabel="PQRS: peticiones, quejas y reclamos"
            style={[
              styles.segmentTab,
              kind === 'pqrs' && {
                backgroundColor: c.surface,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: 0.1,
                shadowRadius: 3,
                elevation: 2,
              },
            ]}
          >
            <Text v={kind === 'pqrs' ? 'strongM' : 'bodyM'} color={kind === 'pqrs' ? c.primaryText : c.textSecondary}>
              PQRS
            </Text>
          </Pressable>

          <Pressable
            onPress={() => {
              tap('select');
              setKind('data');
              setType('access');
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: kind === 'data' }}
            accessibilityLabel="Protección de datos: habeas data"
            style={[
              styles.segmentTab,
              kind === 'data' && {
                backgroundColor: c.surface,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: 0.1,
                shadowRadius: 3,
                elevation: 2,
              },
            ]}
          >
            <Text v={kind === 'data' ? 'strongM' : 'bodyM'} color={kind === 'data' ? c.primaryText : c.textSecondary}>
              Protección de datos
            </Text>
          </Pressable>
        </View>

        {/* ── Tarjeta de Nueva Solicitud ── */}
        <View
          style={[
            styles.formCard,
            {
              backgroundColor: c.surface,
              borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
            },
          ]}
        >
          <View style={styles.formHeader}>
            <View style={styles.cleanIcon}>
              <Icon name="soporte" size="lg" color="#6268A0" />
            </View>
            <View style={styles.flex}>
              <Text v="strongL">Radicar nueva solicitud</Text>
              <Text v="caption" tone="textMuted">
                {kind === 'pqrs' ? 'Peticiones, quejas y reclamos' : 'Gestión de habeas data'}
              </Text>
            </View>
          </View>

          {/* Chips de tipo */}
          <View style={styles.chipsRow}>
            {options.map(([value, label]) => {
              const active = type === value;
              return (
                <Pressable
                  key={value}
                  onPress={() => { tap('select'); setType(value); }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={label}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: active
                        ? isDark ? 'rgba(98, 104, 160, 0.25)' : 'rgba(98, 104, 160, 0.12)'
                        : isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.04)',
                      borderColor: active
                        ? isDark ? 'rgba(98, 104, 160, 0.60)' : 'rgba(98, 104, 160, 0.40)'
                        : 'transparent',
                    },
                  ]}
                >
                  <Text
                    v={active ? 'strongS' : 'bodyS'}
                    color={active ? '#6268A0' : c.textSecondary}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {kind === 'pqrs' && (
            <TextInput
              value={subject}
              onChangeText={setSubject}
              placeholder="Asunto breve de tu solicitud"
              placeholderTextColor={c.textMuted}
              style={[
                styles.textInput,
                {
                  color: c.text,
                  borderColor: isDark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(0, 0, 0, 0.08)',
                  backgroundColor: isDark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.02)',
                },
              ]}
            />
          )}

          <TextInput
            placeholder={
              kind === 'pqrs'
                ? 'Describe claramente tu petición, queja o reclamo…'
                : 'Detalla qué información requieres actualizar o suprimir…'
            }
            placeholderTextColor={c.textMuted}
            value={detail}
            onChangeText={setDetail}
            multiline
            numberOfLines={4}
            style={[
              styles.textInput,
              styles.multilineInput,
              {
                backgroundColor: isDark ? 'rgba(255, 255, 255, 0.04)' : '#FFFFFF',
                borderColor: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)',
                color: c.text,
              },
            ]}
          />

          <Button
            title="Enviar radicado"
            full
            loading={save.isPending}
            disabled={detail.trim().length < 10 || (kind === 'pqrs' && subject.trim().length < 3)}
            onPress={() => save.mutate()}
          />
        </View>

        {/* ── Historial de Radicados ── */}
        <View style={styles.sectionBlock}>
          <Text v="captionStrong" tone="textMuted" style={styles.sectionTitle}>
            HISTORIAL DE RADICADOS
          </Text>

          {((kind === 'pqrs' ? pqrs : dataRequests) as any[]).length === 0 ? (
            <View
              style={[
                styles.emptyCard,
                {
                  backgroundColor: c.surface,
                  borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
                },
              ]}
            >
              <EmptyState
                icon="soporte"
                title="Sin solicitudes previas"
                message="Aquí podrás hacer seguimiento a tus PQRS o peticiones de datos."
                compact
              />
            </View>
          ) : (
            ((kind === 'pqrs' ? pqrs : dataRequests) as any[]).map((x: any) => (
              <View
                key={x._id}
                style={[
                  styles.historyCard,
                  {
                    backgroundColor: c.surface,
                    borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
                  },
                ]}
              >
                <View style={styles.historyTop}>
                  <Text v="strongM" style={styles.flex}>
                    {x.subject || x.type}
                  </Text>
                  <View style={[styles.statusBadge, { backgroundColor: isDark ? 'rgba(16, 185, 129, 0.16)' : '#E6F9F0' }]}>
                    <Text v="captionStrong" color={isDark ? '#34D399' : '#059669'}>
                      {x.status ?? 'En trámite'}
                    </Text>
                  </View>
                </View>

                <Text v="bodyS" tone="textSecondary">
                  {x.response || x.detail}
                </Text>

                {x.responses?.map((r: any, i: number) => (
                  <View
                    key={i}
                    style={[
                      styles.responseBox,
                      {
                        backgroundColor: isDark ? 'rgba(75, 59, 255, 0.12)' : 'rgba(75, 59, 255, 0.06)',
                      },
                    ]}
                  >
                    <Text v="captionStrong" tone="primaryText">Respuesta ZIPP:</Text>
                    <Text v="bodyS">{r.message}</Text>
                  </View>
                ))}
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.huge,
    gap: Spacing.lg,
  },

  segmentTrack: {
    flexDirection: 'row',
    padding: 4,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
  },
  segmentTab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: BorderRadius.full,
  },

  formCard: {
    padding: Spacing.lg,
    borderRadius: 24,
    borderWidth: 1,
    gap: Spacing.md,
  },
  formHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  cleanIcon: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },

  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.xs,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
  },

  textInput: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    fontSize: FontSize.md,
  },
  multilineInput: {
    minHeight: 90,
    textAlignVertical: 'top',
  },

  sectionBlock: {
    gap: 8,
  },
  sectionTitle: {
    marginLeft: Spacing.md,
    letterSpacing: 0.8,
    fontSize: 11,
  },

  emptyCard: {
    padding: Spacing.xl,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
  },
  historyCard: {
    padding: Spacing.lg,
    borderRadius: 22,
    borderWidth: 1,
    gap: Spacing.sm,
  },
  historyTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  responseBox: {
    padding: Spacing.md,
    borderRadius: 14,
    gap: 2,
    marginTop: Spacing.xs,
  },
});
