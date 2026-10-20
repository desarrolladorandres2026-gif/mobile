# Siigo: inventario de funciones, conexiones y planes

Investigación del 2026-10-19. Fuente principal: el portal de clientes de Siigo (`*.portaldeclientes.siigo.com`), que tiene una guía por cada función, más siigo.com, el portal de desarrolladores y búsquedas. Se leyeron los índices de todas las categorías de Siigo Nube y de nómina; no se abrió el contenido de cada guía individual.

**Cómo leer este documento.** Cada afirmación sale del título de una guía o de una página oficial de Siigo. Lo que está marcado *(sin verificar)* viene de terceros o de una fuente vieja. Al final hay una sección de lo que no se pudo confirmar.

---

## 1. Familia de productos

| Producto | Qué es | Dónde se instala |
|---|---|---|
| **Siigo Nube** | ERP contable y administrativo | Nube |
| **Siigo Facturación (24 y 120)** | Solo facturación electrónica, con cobranza | Nube |
| **Siigo Facturación PRO** | Facturación, seguimiento comercial y cobranzas | Nube |
| **Nómina electrónica** (Lite 24/120/300, Plus, Pro) | Nómina y envío a la DIAN | Nube |
| **Siigo POS** (Esencial, Inicio, Avanzado) | Punto de venta para tiendas | Nube |
| **POS Gastrobar** (PRO, PRO + Premium) | Punto de venta para restaurantes y bares | Nube |
| **Siigo Contador** (gratis e ilimitado) | Contabilidad multiempresa para contadores | Nube |
| **Contador Windows** | Versión local para contadores | Instalado |
| **Siigo Pyme** | ERP | Instalado en Windows |
| **Ilimitada** | Módulos Contai, Nóminal y SCi | Instalado |
| **Divulgación Académica** | Licencias para estudiantes | Nube |
| **Siigo Auditor** | Revisión y configuración contable asistida | Nube, dentro de Nube |
| **Siigo Pay** | Recaudo en línea | Dentro de Nube |
| **Siigo App** | Aplicación móvil | Móvil |
| **Siigo API** | API REST pública | Nube |

Siigo opera en Colombia, Ecuador, México, Perú, Uruguay y Chile. En México aparece bajo el portal de Aspel.

## 2. Planes y precios (siigo.com, pago anual, descuentos solo para cliente nuevo)

**Siigo Nube**

| Plan | Anual | Usuarios | Destacado |
|---|---|---|---|
| Profesional independiente | $1.751.920 | 1 | Cotizaciones y CRM |
| Emprendedor | $2.295.920 | 3 | Contabilidad |
| Premium | $2.660.720 | 5 | Contabilidad |
| Nube independiente + Nómina 120 | $1.991.840 | 1 admin, hasta 10 empleados | Nómina |

Todos con documentos electrónicos ilimitados.

**Facturación:** 24 documentos al año por $119.900. 120 documentos por $269.910. Incluyen 1 usuario, Siigo Pay, cobranza por WhatsApp y el Agente IA.

**Nómina electrónica**

| Plan | Empleados | Anual |
|---|---|---|
| Lite 24 | 1–2 | $119.900 |
| Lite 120 | 3–10 | $239.920 |
| Lite 300 | 11–25 | $449.925 |
| Plus | Ilimitados | $749.925 |
| Pro | Ilimitados | $1.402.425 |

Plus agrega liquidación automática de contratos, contabilización automática y archivos bancarios. Pro agrega cesantías, PILA y seguridad social.

**Siigo POS**

| Plan | Anual | Facturas electrónicas | Inventario |
|---|---|---|---|
| Esencial | $345.000 | 240 al año | Consulta de saldos |
| Inicio | $527.310 | Ilimitadas | Consulta de saldos |
| Avanzado | $809.910 | Ilimitadas | Control de saldos |
| Avanzado + Emprendedor | $2.827.350 | Ilimitadas | Inventario, costeo y stock |
| Avanzado + Premium | $3.169.350 | Ilimitadas | Inventario, costeo y stock |

**POS Gastrobar PRO + Premium:** $2.895.480 al año. Otra fuente de hace unos 70 días (*sin verificar*) da $1.199.920 al año para Pro.

**Siigo Contador:** gratis para 1 empresa. Ilimitado: $535.900 al año.

## 3. Siigo Nube, función por función

### 3.1 Acceso, usuarios y generalidades
- Ingreso, usuario y clave, cambio y restablecimiento de contraseña, autenticación multifactor.
- Verificación de datos personales, creación rápida, buscador general y filtros de búsqueda.
- Historial de actividades e informe de roles por usuario.
- Cambio entre empresas, notificaciones, centro de ayuda, tienda Siigo y consulta de facturas de Siigo.
- Usuarios: administrador, con acceso, contador y cajero POS o Lite. Roles y permisos editables, activar, inactivar y borrar.
- Requisitos mínimos, prueba de velocidad de internet y soporte virtual para Mac.

### 3.2 Configuración
- Perfil de la organización y logo para documentos.
- Terceros (clientes y proveedores), incluidos los de otro país, con sucursales y campos libres. Contactos de terceros.
- Plan de cuentas contables. Crear, editar, inactivar y borrar.
- Impuestos: autorretención, IVA, retefuente, reteICA, impuesto al consumo, bolsa, saludables, bebidas azucaradas y ad valorem.
- Formas de pago, centros de costo y ciudades.
- Configuración de cada tipo de documento: cotización, remisión, factura, recibo de caja, nota crédito, nota débito, orden de compra y comprobante.
- Moneda extranjera y manejo de decimales.
- Contrato de Siigo Nube consultable.

### 3.3 Ventas y cartera
- Cotizaciones: crear, copiar, editar, anular y borrar. Estados aprobada, descartada, sin aprobar y facturada.
- Remisiones, y cruce de cotización o remisión con la factura.
- Factura electrónica de venta, con descuentos, cargos, obsequios, anticipos, ReteICA, ReteIVA, retención en la fuente, autorretención y dos impuestos.
- Facturas recurrentes: frecuencia, repeticiones, envío por correo y auditoría. El envío a la DIAN es aparte.
- Recibos de caja, documento de ingreso, otros ingresos, anticipos de clientes y ajustes de cartera.
- Seguimiento comercial y seguimiento de cobranza.
- Recordatorios automáticos de recaudo y estado de cuenta del cliente.
- Informes de ventas por cliente, producto, vendedor y mes, comparativos, rentabilidad y cotizaciones.
- Informes de cartera: edades, detallada por documento, general por cliente y saldos.

### 3.4 Compras, gastos y proveedores
- Orden de compra, y factura de compra desde la orden.
- Factura de compra desde un XML o ZIP.
- Factura de compra con AIU, impuesto al consumo, IVA como mayor valor, impuestos saludables, ReteICA y ReteIVA.
- Registrar gastos, gastos frecuentes, gastos de importación y gastos por legalizar.
- Comprobante de pago o egreso, anticipos a proveedores, nota débito y ajustes de proveedores.
- Documento soporte físico y electrónico, con nota de ajuste.
- Causación automática de compras con la DIAN: importa las facturas de los proveedores, sugiere el vínculo con compras existentes y deja la decisión al usuario. Estados por revisar, registrada y descartada. Rango máximo de 90 días.
- Informes de compras por proveedor y producto, cuentas por pagar, estado de cuenta del proveedor y cruce de orden con factura.

### 3.5 Inventarios
- Productos y servicios: crear, duplicar, editar, inactivar y borrar. Categorías preimplementadas.
- Combos y su gestión. Ensambles, con nota de ensamble y su informe.
- Bodegas, notas de traslado entre bodegas, listas de precios y cambio masivo de precios.
- Ajustes de inventario y conteo físico. Control de stock al facturar o remitir.
- Costeo mensual, con informe y reverso.
- Kardex, saldos, valoración, rentabilidad por producto, movimiento por bodega y remisiones cruzadas.

### 3.6 Activos fijos
- Grupos y activos, compra y venta, baja, inactivación, depreciación y listado.

### 3.7 Contabilidad
- Comprobantes contables: crear, copiar, favoritos, buscar, anular, borrar, modificar, imprimir y borrado masivo.
- Reclasificación de cuentas, cuentas por cobrar y por pagar contables, CDT, gastos bancarios, traslado de dinero, pérdidas y caja menor.
- Viáticos y gastos por legalizar, diferidos, diferencia en cambio y diferencia fiscal NIIF.
- Cierre de año y su reverso, cierre de cuentas de impuestos, bloqueo y desbloqueo de fechas, y bloqueo por período.
- Verificar y bloquear comprobantes. Auditoría de borrado de comprobantes.
- Saldos iniciales de cartera, proveedores, inventarios, activos y otras cuentas, por comprobante o desde Excel.
- Migrar información desde ADM.
- Presupuesto contable.

### 3.8 Informes financieros y fiscales
- Estado de situación financiera, resultado integral (también por función del gasto), flujos de efectivo por método indirecto y cambios en el patrimonio. Versiones configurables.
- Balance de prueba general, por tercero y por centro de costo, también en Excel y TXT.
- Libro oficial de ventas y de compras, libro diario (también resumido), libro mayor y balance, y libro de inventarios.
- Auxiliares por cuenta, tercero y centro de costo, y comprobantes detallados, consecutivos y no contabilizados.
- Informe de impuestos detallados y certificado de retenciones.
- Informes personalizados de movimiento contable. Reportes asíncronos e historial de reportes descargados.
- Medios magnéticos (exógena): asistente anual 2021 a 2025, acumulados, normatividad y auxiliar distrital o municipal. Formato 2669 en 2020.

### 3.9 Facturación electrónica y DIAN
- Habilitación guiada en 6 pasos: perfil, certificado digital, set de pruebas, numeración, prefijos y sincronización de la resolución.
- Documentos: factura de venta, de exportación, de transporte de carga, del sector cambiario, para consorcios, con moneda extranjera, con ingresos para terceros y con orden de compra.
- Sector salud: SS-CUFE, SS-SinAporte, SS-Recaudo, CUCON y copagos. Integración con SIIF de la Nación.
- Notas crédito y débito electrónicas, con las mismas variantes de sector salud.
- Envío o reenvío a la DIAN, por correo o WhatsApp, y envío masivo. Estados del documento y seguimiento de comprobantes en la DIAN.
- Descarga de XML, ZIP y PDF. Cambio de fecha de vencimiento.
- Informes: recepción y envío a la DIAN, seguimiento por cliente, movimiento histórico en la DIAN y seguimiento de emails.
- Soluciones guiadas para rechazos de la DIAN, con reglas como DAJ41, DAJ48, FAX02, FAU02, FAK21, FAK24, DSAJ14 y regla 90, y para facturas sin CUFE o QR.
- Cambio o adición de proveedor tecnológico.
- Factura como título valor (Resolución 85): registro de eventos en facturas de proveedores (acuse, recepción de mercancía, aceptación expresa), reclamo, aceptación tácita y consulta de eventos en la DIAN.
- Documento soporte electrónico: habilitación en 6 pasos, nota de ajuste, ReteICA y reporte.
- Factura de talonario o papel. Facturación electrónica desde el POS.

### 3.10 Formatos de impresión
- 16 formatos: nota crédito, nota débito, traslado, tres de cotización, ocho de factura (Básico 1 y 2, Elegante, Cuenta de Cobro 1 y 2, Simétrico, Fresco, Espontáneo y Tirilla) y recibo de caja.

### 3.11 Interfaces con Excel
- Subir productos, terceros, contactos, facturas de venta, ajustes de inventario, conteo físico, comprobantes contables y activos fijos.

### 3.12 Indicadores
- Ventas, compras, disponible, ventas contra compras, top 5 de productos, edades de cartera, cuentas por pagar y gastos.

### 3.13 Informes de control
- Historial de actividades y de reportes descargados, saldos de cuentas bancarias, facturación de obsequios, seguimiento de facturas recurrentes y recibos de caja por factura.
- Búsqueda avanzada de tareas y de documentos. Reporte de países, departamentos y ciudades.

### 3.14 App móvil
- Facturación electrónica y nota crédito electrónica.
- Cotizaciones y facturar una cotización. Documento de ingreso.
- Crear y consultar clientes y su estado de cuenta.
- Indicadores y reportes de ventas por mes, día, producto, saldos, vendedor y cliente.

### 3.15 Siigo Pay
- El cliente paga facturas y cotizaciones por Nequi, PSE o Bancolombia.
- Gestión en Ventas, con estado del pago, del desembolso y de la contabilización.
- Desembolso a la cuenta bancaria, con reintento si falla. Recibo de caja automático y exportación a Excel.
- Cobro por WhatsApp hasta 3 veces por documento. Indicadores propios.
- Activarlo desactiva la integración de Mercado Pago.
- La fuente no da comisión, plazo ni límites de monto.

### 3.16 Siigo Auditor
- Configura cuentas contables por rubro (clientes, proveedores, inventarios, ingresos, gastos, pasivos, activos, depreciación, prestaciones y parafiscales).
- Genera auditoría contable, informes y estados financieros.
- Liquidador de renta y calendario tributario. Consulta de documentos electrónicos.

### 3.17 Inteligencia artificial
- **Agente IA Actualícese:** consultas tributarias, contables, laborales y financieras. Viene con 5 contenidos premium.
- **Facturación por WhatsApp con IA:** se factura escribiendo o con notas de voz, con IVA incluido o no. Se elige la forma de pago y se envía a la DIAN. La fuente no da límites ni costo.
- **Causación asistida** de facturas de la DIAN, y creación de menú con IA en POS Gastrobar PRO + Premium.

## 4. Nómina electrónica

- **Configuración:** empleados y contratos (por Excel también), cargos, fondos, grupos, conceptos, parámetros contables, prefijos, acumulados iniciales y aumento de salarios, por Excel también.
- **Liquidación:**
  - Nómina quincenal o mensual, copia de nóminas y novedades.
  - Liquidación de contrato, prima de servicios, cesantías anuales e intereses.
  - Vacaciones tomadas en dos meses y préstamos a empleados.
  - Horas extras y recargos con reducción de jornada. Contrato por obra o labor.
- **Contabilización y pago:** asientos automáticos y pago electrónico de nómina, de liquidación de contrato y de prima, con archivos planos bancarios. Desprendibles por correo.
- **DIAN:** transmisión de nómina, provisiones, cesantías y notas de ajuste. Habilitación guiada con certificado y set de pruebas. Verificación de identidad.
- **Seguridad social:** planilla integrada de aportes (PILA) en Pro, con comparativo de valores. Cálculo de IBC con vacaciones, incapacidad y licencias. Retención en la fuente por salarios.
- **Reportes:** aportes de seguridad social, parafiscales, provisiones y ARL por empleado. Acumulados, prima, libro de vacaciones, pagos consolidados y datos de ley.
- **Normatividad:** Resolución 13 de 2021 y 151 de 2021.

## 5. POS

- **Siigo POS:** facturación electrónica desde el POS en modo touch o teclado, precuentas, turnos, apertura y cierre de caja con quién abrió y cerró, productos favoritos con fotos, reportes de ventas diarias, existencias y movimiento, y cualquier lector de código de barras. Resolución 165 de 2023.
- **POS Gastrobar** *(fuentes de terceros, sin verificar en siigo.com)*:
  - Vista de mesas y meseros en tiempo real, división de cuentas y propinas.
  - Comandas digitales o impresas, con impresora en caja y otra en cocina. App "A la Orden" para meseros.
  - Combos y recetas, informes avanzados.
  - Integración con Rappi, solo en el plan Premium.

## 6. Siigo Contador

- Panel multiempresa, usuarios con roles y permisos, plantillas de comprobantes frecuentes.
- Conciliación bancaria automática, estados financieros en PDF y Excel, cálculo de impuestos habituales.
- Bloqueo de comprobantes por fecha y exógena en XML listo para el prevalidador.
- Cálculo de IVA, renta, industria y comercio y retención en la fuente.
- Portal del contador con formación y beneficios. Siigo Partners.

## 7. Conexiones

**API REST pública** (solo Siigo Nube, no Pyme)
- Recursos: `/products`, `/customers`, `/invoices`, `/purchases`, `/credit-notes`, `/vouchers`, `/payment-receipts`, `/journals`, `/quotations` y `/purchase-support-documents`. Además, reportes (balance de prueba, por tercero y cuentas por pagar).
- Crear lote de facturas de venta, enviar a la DIAN, consultar PDF, enviar por correo, anular y borrar.
- Sector salud: modos de operación y ajustes normativos.
- Requisitos: plan Profesional, Emprendedor o Premium. Credenciales generadas por un administrador, hasta 5 aplicaciones. Header obligatorio `Partner-Id`.
- Límite de 100 peticiones por minuto por empresa. Token con vigencia de 24 horas.
- Secciones de la documentación: manejo de errores, códigos HTTP, idempotencia y bloqueo de usuarios.
- Guías con Postman. Soporte en `soporteapi@siigo.com`.

**Alianzas dentro del producto**
- Mercado Pago: botón de pago en la factura, con tarifa de 2,8% + $400 + IVA por transacción *(sin verificar vigencia)*.
- Payana: pagos a proveedores y empleados.
- Davivienda: crédito de capital de trabajo.
- Plurall: crédito de capital productivo.

**Comercio electrónico**
- Siigo Link Ecommerce, anunciado en el sitio. No hallé una página con el detalle.
- Astroselling (*sin verificar*): conecta Siigo con Mercado Libre, Shopify, WooCommerce, Falabella, Rappi, Amazon y PrestaShop.
- Tiendanube: factura electrónica automática por orden y sincronización de clientes, productos y stock.
- Terceros: plugin de WooCommerce, Zapier, iFactory y Nuvaprod para Siigo Pyme.

**Otras**
- Siigo Pay opera con Cobre como pasarela aliada *(dato de una consulta anterior)*.
- Integración con SIIF de la Nación para entidades públicas.

## 8. Servicios alrededor del software

- Soporte por teléfono, chat y correo. Asesor por Teams. Horas de implementación con costo.
- Capacitaciones gratuitas, eventos mensuales, podcast, blog y canal de Telegram.
- Programa Siigo Partners para contadores.
- Fundación Siigo.
- Actualizaciones mensuales, publicadas en video en el portal colombiano.

## 9. Qué no se pudo confirmar

- El contenido de cada guía individual. Solo se leyeron los índices y títulos.
- Algunas páginas segundas de nómina (procesos y reportes de Pro y Plus) quedaron sin leer.
- Las guías de POS por plan, y el detalle de POS Gastrobar en siigo.com. El enlace `/sistema-pos-gastrobar/` devolvió 404.
- Las actualizaciones mensuales del portal colombiano son videos. No tienen texto.
- Comisión, plazos y límites de Siigo Pay.
- Costos de la API, de la facturación por WhatsApp y de Siigo Link.
- Cualquier medición de calidad de uso, rapidez o soporte. Eso requiere reseñas de clientes o uso real.
- El navegador no estaba conectado. Todo se hizo con lectura de páginas y búsqueda, sin ver la interfaz.

## 10. Lectura para Lulubiz

- **Hecho:** la mayor parte de lo que hace Siigo es contabilidad, impuestos y nómina colombianos. Es normativa más que producto.
- **Inferencia:** Siigo vende por separado facturación, nómina, POS y contabilidad, con planes distintos. Un solo producto integrado es una ventaja posible.
- **Recomendación:** delegar la conexión con la DIAN a un proveedor tecnológico autorizado, construir el resto por fases y dejar nómina y sector salud para el final.
