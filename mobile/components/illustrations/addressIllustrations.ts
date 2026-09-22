import type { ComponentType } from 'react';
import { LOGOS } from '../../lib/logos';
import { pngIllustration } from './pngIllustration';
import { ContentIllustrationRegistry } from './contentIllustrations';
import type { IllustrationProps } from './types';

export const HomeAddressIllustration = pngIllustration(LOGOS.casa);
export const WorkAddressIllustration = pngIllustration(LOGOS.trabajo);
export const FamilyAddressIllustration = pngIllustration(LOGOS.familia);
export const PinAddressIllustration = ContentIllustrationRegistry.ubicacion;

export type AddressCategory = 'home' | 'work' | 'family' | 'other';

export interface AddressVisualConfig {
  category: AddressCategory;
  illustration: ComponentType<IllustrationProps>;
  tintColor: string;
  glowColor: string;
  badgeLabel: string;
  accentGradient: [string, string];
}

export function resolveAddressCategory(label?: string): AddressCategory {
  if (!label) return 'other';
  const clean = label.toLowerCase().trim();

  if (
    clean.includes('casa') ||
    clean.includes('hogar') ||
    clean.includes('apto') ||
    clean.includes('apartamento') ||
    clean.includes('depa') ||
    clean.includes('piso') ||
    clean.includes('home')
  ) {
    return 'home';
  }

  if (
    clean.includes('trabajo') ||
    clean.includes('oficina') ||
    clean.includes('work') ||
    clean.includes('office') ||
    clean.includes('negocio') ||
    clean.includes('empresa') ||
    clean.includes('local') ||
    clean.includes('bodega') ||
    clean.includes('estudio') ||
    clean.includes('taller')
  ) {
    return 'work';
  }

  if (
    clean.includes('mamá') ||
    clean.includes('mama') ||
    clean.includes('papá') ||
    clean.includes('papa') ||
    clean.includes('familia') ||
    clean.includes('abuela') ||
    clean.includes('abuelo') ||
    clean.includes('novi') ||
    clean.includes('pareja') ||
    clean.includes('amor') ||
    clean.includes('tía') ||
    clean.includes('tia') ||
    clean.includes('tío') ||
    clean.includes('tio') ||
    clean.includes('suegr')
  ) {
    return 'family';
  }

  return 'other';
}

export function getAddressVisualConfig(label?: string): AddressVisualConfig {
  const category = resolveAddressCategory(label);

  switch (category) {
    case 'home':
      return {
        category: 'home',
        illustration: HomeAddressIllustration,
        tintColor: '#D97706',
        glowColor: 'rgba(245, 158, 11, 0.16)',
        badgeLabel: 'Hogar',
        accentGradient: ['#F59E0B', '#D97706'],
      };
    case 'work':
      return {
        category: 'work',
        illustration: WorkAddressIllustration,
        tintColor: '#2563EB',
        glowColor: 'rgba(59, 130, 246, 0.16)',
        badgeLabel: 'Oficina',
        accentGradient: ['#3B82F6', '#1D4ED8'],
      };
    case 'family':
      return {
        category: 'family',
        illustration: FamilyAddressIllustration,
        tintColor: '#E11D48',
        glowColor: 'rgba(244, 63, 94, 0.16)',
        badgeLabel: 'Familia',
        accentGradient: ['#FB7185', '#E11D48'],
      };
    case 'other':
    default:
      return {
        category: 'other',
        illustration: PinAddressIllustration,
        tintColor: '#059669',
        glowColor: 'rgba(16, 185, 129, 0.16)',
        badgeLabel: 'Punto Zipp',
        accentGradient: ['#10B981', '#047857'],
      };
  }
}
