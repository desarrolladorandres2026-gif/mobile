import * as Haptics from 'expo-haptics';

/**
 * Retroalimentación táctil.
 *
 * Un háptico que falla —emulador, dispositivo sin motor, permiso negado— no
 * puede tumbar la acción que lo disparó. Por eso todo se traga el error: el
 * toque siempre sigue su curso.
 */
type Feedback = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error' | 'select';

export function tap(kind: Feedback = 'light') {
  try {
    switch (kind) {
      case 'light':
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        break;
      case 'medium':
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        break;
      case 'heavy':
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
        break;
      case 'success':
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        break;
      case 'warning':
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        break;
      case 'error':
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        break;
      case 'select':
        Haptics.selectionAsync().catch(() => {});
        break;
    }
  } catch {
    // Sin motor háptico. No es un error que le importe al usuario.
  }
}
