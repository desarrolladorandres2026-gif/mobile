import { app } from 'electron';
import { isDev } from './config';

/**
 * Iniciar con Windows. `app.setLoginItemSettings` ya escribe la entrada
 * correcta para un instalador NSIS (apunta al `.exe` instalado, no a este
 * proceso de desarrollo) — en desarrollo se ignora para no ensuciar el
 * inicio de sesión del equipo de quien está probando esto.
 */
export function setAutoStart(enabled: boolean): void {
  if (isDev) return;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    // La app abre en pantalla completa: que lo haga oculta en la bandeja
    // al iniciar sesión sería invisible y confuso. Mejor que se vea una vez
    // y el propio usuario decida minimizarla.
    args: [],
  });
}

export function isAutoStartEnabled(): boolean {
  if (isDev) return false;
  return app.getLoginItemSettings().openAtLogin;
}
