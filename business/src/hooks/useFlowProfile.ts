import { useAuthStore } from '../stores/authStore';
import { flowProfileOf, type FlowProfile } from '../lib/orderFlow';

/**
 * Cómo se llama el paso del medio en el local seleccionado: se cocina o se
 * alista. Sale de la categoría del negocio (ver `FlowProfile`).
 */
export function useFlowProfile(): FlowProfile {
  return useAuthStore((s) => flowProfileOf(s.selectedBusiness?.category));
}
