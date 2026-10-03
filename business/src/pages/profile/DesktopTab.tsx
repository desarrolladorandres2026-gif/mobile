import { useEffect, useState } from 'react';
import { Laptop } from 'lucide-react';
import {
  isDesktop, desktopSettings, listDesktopPrinters, printTicketOnDesktop, type DesktopPrinter,
} from '../../lib/desktop';

/**
 * "Este equipo": ajustes que son del PC donde corre Zipp Negocios, no de la
 * cuenta ni del negocio. Por eso no está en `my-permissions` ni se ve en el
 * navegador — `canSee` en `lib/permissions.ts` ya la oculta fuera de
 * escritorio, pero esta comprobación es la segunda red por si algún día esa
 * regla cambia.
 */
export default function DesktopTab() {
  const [printers, setPrinters] = useState<DesktopPrinter[] | null>(null);
  const [printerName, setPrinterName] = useState('');
  const [paperWidthMm, setPaperWidthMm] = useState(80);
  const [launchAtLogin, setLaunchAtLogin] = useState(true);
  const [testStatus, setTestStatus] = useState<'idle' | 'printing' | 'ok' | 'error'>('idle');
  const [testError, setTestError] = useState('');

  useEffect(() => {
    if (!isDesktop()) return;
    listDesktopPrinters().then(setPrinters);
    desktopSettings.get('printerName').then((r) => setPrinterName((r.ok ? (r as { value?: unknown }).value as string : '') || ''));
    desktopSettings.get('paperWidthMm').then((r) => setPaperWidthMm((r.ok ? (r as { value?: unknown }).value as number : 80) || 80));
    desktopSettings.get('launchAtLogin').then((r) => setLaunchAtLogin(r.ok ? ((r as { value?: unknown }).value as boolean) !== false : true));
  }, []);

  if (!isDesktop()) {
    return (
      <p className="text-xs text-[var(--color-text-secondary)]">
        Esta pestaña solo existe en Zipp Negocios, la app de escritorio para Windows.
      </p>
    );
  }

  const testPrint = async () => {
    setTestStatus('printing');
    setTestError('');
    const result = await printTicketOnDesktop({
      orderNumber: '0000',
      businessName: 'Prueba de impresión',
      items: [{ name: 'Línea de prueba', quantity: 1, price: 0 }],
      total: 0,
      paperWidthMm,
    });
    if (result.ok) setTestStatus('ok');
    else {
      setTestStatus('error');
      setTestError(result.error ?? 'No se pudo imprimir');
    }
  };

  return (
    <div className="cols3">
      <section className="space-y-3 pb-6">
        <div className="space-y-1.5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-main)]">
            <Laptop className="w-4 h-4" strokeWidth={1.8} />
            Este equipo
          </h2>
          <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
            Ajustes del PC donde corre Zipp Negocios, no de tu cuenta: si cambias de equipo, se configuran aparte.
          </p>
        </div>
        <div className="min-w-0 space-y-5">
          <label className="flex items-center justify-between gap-3 text-xs font-semibold text-[var(--color-text-main)]">
            Iniciar con Windows
            <input
              type="checkbox"
              checked={launchAtLogin}
              onChange={(e) => {
                setLaunchAtLogin(e.target.checked);
                desktopSettings.set('launchAtLogin', e.target.checked);
              }}
              className="h-4 w-4 accent-[var(--color-primary)]"
            />
          </label>
        </div>
      </section>

      <section className="space-y-3 pb-6">
        <div className="space-y-1.5">
          <h2 className="text-sm font-semibold text-[var(--color-text-main)]">Impresora de comandas</h2>
          <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
            La comanda se imprime sola, sin diálogo, en la impresora que elijas aquí.
          </p>
        </div>
        <div className="min-w-0 space-y-4">
          <select
            value={printerName}
            onChange={(e) => {
              setPrinterName(e.target.value);
              desktopSettings.set('printerName', e.target.value);
            }}
            className="w-full border-b border-[var(--color-border)] bg-transparent pb-1.5 text-xs text-[var(--color-text-main)] focus:outline-none"
          >
            <option value="">Sin impresora configurada</option>
            {(printers ?? []).map((p) => (
              <option key={p.name} value={p.name}>
                {p.displayName || p.name}{p.isDefault ? ' (predeterminada)' : ''}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-4 text-xs font-semibold text-[var(--color-text-main)]">
            Ancho del papel
            {[58, 80].map((mm) => (
              <label key={mm} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="paperWidthMm"
                  checked={paperWidthMm === mm}
                  onChange={() => {
                    setPaperWidthMm(mm);
                    desktopSettings.set('paperWidthMm', mm);
                  }}
                  className="accent-[var(--color-primary)]"
                />
                {mm} mm
              </label>
            ))}
          </div>

          <button
            type="button"
            onClick={testPrint}
            disabled={!printerName || testStatus === 'printing'}
            className="text-xs font-semibold text-[var(--color-primary)] underline underline-offset-2 disabled:opacity-50 disabled:no-underline"
          >
            {testStatus === 'printing' ? 'Imprimiendo…' : 'Imprimir una prueba'}
          </button>
          {testStatus === 'ok' && <p className="text-xs font-semibold text-[var(--color-success)]">Comanda de prueba enviada.</p>}
          {testStatus === 'error' && <p className="text-xs font-semibold text-[var(--color-danger)]">{testError}</p>}
        </div>
      </section>
    </div>
  );
}
