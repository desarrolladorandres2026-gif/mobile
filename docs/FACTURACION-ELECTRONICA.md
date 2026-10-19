# Facturación electrónica: dónde está ZIPP hoy

**Estado: no integrada.** ZIPP no emite facturas electrónicas. Nada en el sistema
está validado ante la DIAN, y ninguna pantalla debe decir lo contrario.

## Tres clases de documento

| Clase | Qué es | Ejemplos hoy | ¿Factura? |
|---|---|---|---|
| `internal_voucher` | Soporte de gestión con consecutivo propio (`INT-000123`). Foto de lo que se pagó. | Comprobante de liquidación a comercio, comprobante de pago a domiciliario (`FiscalDocument`) | **No** |
| `commercial_document` | Registro interno de un cobro. | Cobro de publicidad (`AdInvoice`, el nombre del modelo se conserva por compatibilidad) | **No** |
| `electronic_invoice` | Factura electrónica de venta (y notas) con número autorizado, firma, CUFE y validación de la DIAN. | Ninguno | Sí, cuando exista |

Cada documento interno lleva su aviso (`notice`) y la interfaz lo presenta como
«comprobante» o «cobro», nunca como «factura». El mapa de qué es cada documento está
en `backend/src/services/electronicInvoicing.service.ts` (`ZIPP_DOCUMENT_KINDS`): un
documento nuevo se declara ahí o no se emite.

## Límite arquitectónico

`electronicInvoicing.service.ts` es el único sitio donde se enchufará el proveedor:

- `status()` dice si hay integración y qué falta (`ELECTRONIC_INVOICING_MISSING`).
- `issue()` sin proveedor responde **501** y no deja nada marcado como emitido.
- Con proveedor, un documento solo cuenta como emitido si el proveedor devuelve **número,
  CUFE y fecha de validación**. ZIPP no fabrica ninguno de los tres ni simula respuestas de
  la DIAN.

## Qué falta para integrarla (lista de trabajo, no opinión legal)

Todo esto lo confirma el contador de ZIPP:

1. NIT y RUT con las responsabilidades tributarias registradas.
2. Habilitación como facturador electrónico ante la DIAN.
3. Resolución de numeración (prefijo y rango).
4. Proveedor tecnológico autorizado —o software propio habilitado—, contrato y credenciales.
5. Certificado de firma digital.
6. Qué documento se emite en cada flujo: factura de venta (comisión, publicidad, Zipp Pro,
   servicio de plataforma), documento soporte en adquisiciones a quien no está obligado a
   facturar (pagos a domiciliarios), notas crédito para reembolsos.
7. Datos del adquirente: los comercios tienen ficha legal; el cliente final no se pide hoy.
8. Reglas tributarias validadas por concepto (panel Impuestos): la factura lleva el
   impuesto que esas reglas definan.

## Qué NO hacer mientras no exista

- Llamar «factura» a un `INT-` o a un cobro de publicidad en pantallas, correos o PDFs.
- Marcar un documento como «validado» o «emitido» sin la confirmación del proveedor.
- Presentar un total tributario como definitivo si algún concepto está «pendiente»
  (`GET /finance/tax-reconciliation` lo dice con `definitive: false`).
