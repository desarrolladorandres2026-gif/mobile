import { useState } from 'react';
import { Button, Notice, PageHeader, errorMessage, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { saveBlob } from '../lib/download.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

/**
 * Copia de los datos de la empresa. Solo el propietario. La exportación sale completa (asientos, documentos, terceros,
 * inventario, nómina, auditoría…), sin contraseñas, sesiones ni claves de API.
 */
export function CompanyDataScreen() {
  const base = useTenantApi();
  const { tenant } = useSession();
  const [done, setDone] = useState(null);

  const download = useSubmit(async () => {
    setDone(null);
    const { blob, name } = await api.download(`${base}/export`);
    const file = name ?? `lulubiz-${new Date().toISOString().slice(0, 10)}.ndjson`;
    saveBlob(file, blob);
    setDone({ file, size: blob.size });
  });

  return (
    <>
      <PageHeader title="Datos de la empresa" />
      <p className="mb-4 max-w-3xl text-sm text-tinta">
        Los datos de {tenant.name} son suyos. Desde aquí puedes descargar una copia completa en cualquier momento, por ejemplo para guardarla, para entregarla a tu contador o para llevártela si dejas de usar Lulubiz.
      </p>

      <h2 className="mb-2 mt-6 text-lg font-semibold text-tinta">Exportar todo</h2>
      <ul className="mb-4 max-w-3xl list-disc pl-5 text-sm text-tinta">
        <li>Un archivo de texto con un documento por línea (formato JSON), que cualquier programa puede leer.</li>
        <li>Incluye la contabilidad, las facturas y compras, los terceros, el inventario, la nómina, la configuración y el registro de auditoría.</li>
        <li>No incluye contraseñas, sesiones, claves de API ni datos de otras empresas. Los miembros salen con su nombre, su correo y su rol.</li>
        <li>La última línea resume cuántos documentos hay de cada tipo: si el archivo no termina en ella, la descarga se cortó y hay que repetirla.</li>
        <li>Se lee colección por colección: si alguien registra algo mientras se descarga, puede aparecer en una parte y no en otra. Para una copia exacta, hazla cuando no se esté trabajando.</li>
        <li>Solo se puede hacer una descarga a la vez, y cada una queda en la auditoría.</li>
      </ul>
      {download.error ? <Notice kind="error">{errorMessage(download.error)}</Notice> : null}
      {done ? (
        <Notice kind="success" title="Descarga lista">
          {done.file} ({(done.size / 1024 / 1024).toFixed(1)} MB). Guárdalo en un lugar seguro: contiene toda la información de la empresa.
        </Notice>
      ) : null}
      <Button variant="primary" busy={download.busy} onClick={() => download.run()}>
        {download.busy ? 'Preparando la descarga…' : 'Descargar los datos de la empresa'}
      </Button>

      <h2 className="mb-2 mt-10 text-lg font-semibold text-tinta">Borrar la empresa</h2>
      <p className="max-w-3xl text-sm text-tinta">
        El borrado definitivo no se hace desde la aplicación, a propósito: el libro contable y la auditoría no se pueden borrar con las credenciales con que funciona el sistema. Se pide al equipo que opera Lulubiz, que primero comprueba que recibiste tu exportación y que el nombre de la empresa coincide. Es irreversible.
      </p>
    </>
  );
}
