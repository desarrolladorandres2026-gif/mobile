import { ViewLink, DataTable, Notice, PageHeader, errorMessage, useLoad } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useTenantApi } from '../lib/session.jsx';

const state = (step) => (step.done ? 'Hecho' : step.required ? 'Pendiente · obligatorio' : 'Pendiente · recomendado');

export function GettingStartedScreen() {
  const base = useTenantApi();
  const data = useLoad(() => api.get(`${base}/onboarding`), [base]);

  const columns = [
    { key: 'title', title: 'Paso', render: (s) => s.title },
    { key: 'state', title: 'Estado', nowrap: true, render: state },
    { key: 'detail', title: 'Qué hay', render: (s) => s.detail },
    { key: 'go', title: 'Ir a', nowrap: true, render: (s) => <ViewLink href={`/app/${s.path}`}>{s.done ? 'Revisar' : 'Hacerlo ahora'}</ViewLink> },
  ];

  return (
    <>
      <PageHeader title="Primeros pasos" />
      <p className="mb-4 text-sm text-tinta">Lo que hay que dejar listo para operar con esta empresa. Se calcula con lo que ya está configurado, así que se actualiza solo.</p>
      {data.error ? <Notice kind="error">{errorMessage(data.error)}</Notice> : null}
      {data.loading && !data.data ? <p className="text-sm text-tinta">Revisando la configuración…</p> : null}
      {data.data ? (
        <>
          {data.data.ready ? (
            <Notice kind="success" title="Todo lo obligatorio está configurado">Ya se puede facturar. Faltan solo los pasos recomendados que te sirvan.</Notice>
          ) : (
            <Notice kind="info" title={`Faltan ${data.data.requiredPending} ${data.data.requiredPending === 1 ? 'paso obligatorio' : 'pasos obligatorios'}`}>
              Hasta completarlos no se puede facturar de verdad.
            </Notice>
          )}
          {data.data.sandbox ? (
            <Notice kind="error" title="Modo de pruebas: los documentos no tienen validez ante la DIAN">
              Se emiten con un proveedor simulado. Sirven para ensayar el flujo, no para facturar de verdad.
            </Notice>
          ) : null}
          <DataTable caption="Primeros pasos" columns={columns} rows={data.data.steps} rowKey={(s) => s.key} />
        </>
      ) : null}
    </>
  );
}
