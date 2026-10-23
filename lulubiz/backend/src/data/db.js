export const COLLECTIONS = {
  tenants: 'tenants',
  users: 'users',
  memberships: 'memberships',
  sessions: 'sessions',
  tokens: 'tokens',
  accounts: 'accounts',
  parties: 'parties',
  audit: 'audit',
  periods: 'periods',
  settings: 'settings',
  resolutions: 'resolutions',
  invoices: 'invoices',
  creditNotes: 'creditNotes',
  receipts: 'receipts',
  purchases: 'purchases',
  supplierNotes: 'supplierNotes',
  payments: 'payments',
  items: 'items',
  warehouses: 'warehouses',
  stock: 'stock',
  movements: 'movements',
  stockDocs: 'stockDocs',
  posRegisters: 'posRegisters',
  posShifts: 'posShifts',
  posSales: 'posSales',
  apiKeys: 'apiKeys',
  advances: 'advances',
  costCenters: 'costCenters',
  dimBalances: 'dimBalances',
  bankLines: 'bankLines',
  quotes: 'quotes',
  fixedAssets: 'fixedAssets',
  budgets: 'budgets',
  employees: 'employees',
  payrollConfig: 'payrollConfig',
  payrollRuns: 'payrollRuns',
  payrollBenefits: 'payrollBenefits',
  payrollTerminations: 'payrollTerminations',
  taxCloses: 'taxCloses',
  depreciationRuns: 'depreciationRuns',
  purchaseOrders: 'purchaseOrders',
  recurringInvoices: 'recurringInvoices',
  docCounters: 'docCounters',
  bankMatches: 'bankMatches',
  bankReconciliations: 'bankReconciliations',
  advanceApplications: 'advanceApplications',
  journals: 'journals',
  balances: 'balances',
  counters: 'counters',
};

/**
 * Índices del libro. Todos empiezan por `tenantId`: es lo que permite fragmentar por
 * empresa y evita recorridos completos. Los únicos garantizan idempotencia, reversión
 * única y consecutivo sin repetidos.
 */
export async function ensureIndexes(db) {
  // Identidad global (usuarios y sesiones): no pertenece a una empresa.
  await db.collection(COLLECTIONS.users).createIndexes([
    { key: { email: 1 }, name: 'email_unique', unique: true },
  ]);
  await db.collection(COLLECTIONS.sessions).createIndexes([
    { key: { tokenHash: 1 }, name: 'token_hash_unique', unique: true },
    { key: { userId: 1 }, name: 'session_user' },
    { key: { expiresAt: 1 }, name: 'session_ttl', expireAfterSeconds: 0 },
  ]);
  await db.collection(COLLECTIONS.tokens).createIndexes([
    { key: { tokenHash: 1 }, name: 'token_hash_unique', unique: true },
    { key: { purpose: 1, userId: 1, createdAt: -1 }, name: 'token_purpose_user' },
    { key: { purpose: 1, tenantId: 1, email: 1 }, name: 'token_invite_lookup' },
    { key: { expiresAt: 1 }, name: 'token_ttl', expireAfterSeconds: 0 },
  ]);
  await db.collection(COLLECTIONS.apiKeys).createIndexes([
    // El prefijo identifica la clave al autenticar, sin saber todavía de qué empresa es.
    { key: { prefix: 1 }, name: 'apikey_prefix', unique: true },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_apikey_recent' },
  ]);
  await db.collection(COLLECTIONS.memberships).createIndexes([
    { key: { tenantId: 1, userId: 1 }, name: 'tenant_user', unique: true },
    { key: { userId: 1 }, name: 'membership_user' },
  ]);
  await db.collection(COLLECTIONS.accounts).createIndexes([
    { key: { tenantId: 1, code: 1 }, name: 'tenant_code', unique: true },
    { key: { tenantId: 1, parentCode: 1 }, name: 'tenant_parent' },
  ]);
  await db.collection(COLLECTIONS.audit).createIndexes([
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_recent' },
    { key: { tenantId: 1, action: 1, _id: -1 }, name: 'tenant_action_recent' },
  ]);
  await db.collection(COLLECTIONS.parties).createIndexes([
    { key: { tenantId: 1, taxIdType: 1, taxId: 1 }, name: 'tenant_taxid', unique: true },
    { key: { tenantId: 1, nameKey: 1 }, name: 'tenant_name' },
  ]);
  await db.collection(COLLECTIONS.journals).createIndexes([
    { key: { tenantId: 1, idempotencyKey: 1 }, name: 'tenant_idempotency', unique: true },
    { key: { tenantId: 1, docType: 1, number: 1 }, name: 'tenant_doctype_number', unique: true },
    {
      key: { tenantId: 1, reversesJournalId: 1 },
      name: 'tenant_reverses_once',
      unique: true,
      partialFilterExpression: { reversesJournalId: { $exists: true } },
    },
    { key: { tenantId: 1, period: 1, date: 1 }, name: 'tenant_period_date' },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_recent' },
    { key: { tenantId: 1, period: 1, _id: -1 }, name: 'tenant_period_recent' },
    { key: { tenantId: 1, 'lines.accountId': 1, _id: -1 }, name: 'tenant_account_recent' },
    { key: { tenantId: 1, 'lines.accountId': 1, period: 1, date: 1, _id: 1 }, name: 'tenant_account_chronological' },
  ]);
  await db.collection(COLLECTIONS.settings).createIndexes([
    { key: { tenantId: 1 }, name: 'tenant_settings', unique: true },
  ]);
  await db.collection(COLLECTIONS.resolutions).createIndexes([
    { key: { tenantId: 1, docType: 1, prefix: 1, from: 1 }, name: 'tenant_resolution', unique: true },
    { key: { tenantId: 1, docType: 1, active: 1, validTo: 1 }, name: 'tenant_resolution_active' },
  ]);
  await db.collection(COLLECTIONS.invoices).createIndexes([
    { key: { tenantId: 1, idempotencyKey: 1 }, name: 'tenant_invoice_idempotency', unique: true },
    { key: { tenantId: 1, prefix: 1, number: 1 }, name: 'tenant_invoice_number', unique: true },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_invoice_recent' },
    { key: { tenantId: 1, status: 1, _id: -1 }, name: 'tenant_invoice_status' },
    { key: { tenantId: 1, 'customer.partyId': 1, _id: -1 }, name: 'tenant_invoice_customer' },
    // Cartera: solo las facturas con saldo por cobrar. El filtro de la consulta debe repetir estas condiciones.
    {
      key: { tenantId: 1, currency: 1, 'customer.partyId': 1, dueDate: 1 },
      name: 'tenant_invoice_open',
      partialFilterExpression: { status: 'issued', collectible: true, balance: { $gt: 0 } },
    },
  ]);
  await db.collection(COLLECTIONS.purchases).createIndexes([
    { key: { tenantId: 1, idempotencyKey: 1 }, name: 'tenant_purchase_idempotency', unique: true },
    // El número completo (FC1, NDP1): las facturas y las notas débito del proveedor llevan series propias.
    { key: { tenantId: 1, fullNumber: 1 }, name: 'tenant_purchase_fullnumber', unique: true },
    // La misma factura del proveedor no se registra dos veces, salvo que la anterior se haya anulado.
    {
      key: { tenantId: 1, 'supplier.partyId': 1, supplierDocNumber: 1 },
      name: 'tenant_purchase_supplier_doc',
      unique: true,
      partialFilterExpression: { status: 'posted' },
    },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_purchase_recent' },
    { key: { tenantId: 1, 'supplier.partyId': 1, _id: -1 }, name: 'tenant_purchase_party' },
    {
      key: { tenantId: 1, currency: 1, 'supplier.partyId': 1, dueDate: 1 },
      name: 'tenant_purchase_open',
      partialFilterExpression: { status: 'posted', balance: { $gt: 0 } },
    },
  ]);
  // Índice anterior, sustituido por el de número completo: solo servía mientras había una serie de compras.
  await db.collection(COLLECTIONS.purchases).dropIndex('tenant_purchase_number').catch((err) => {
    if (err?.codeName !== 'IndexNotFound') throw err;
  });
  await db.collection(COLLECTIONS.supplierNotes).createIndexes([
    { key: { tenantId: 1, idempotencyKey: 1 }, name: 'tenant_supplier_note_idempotency', unique: true },
    { key: { tenantId: 1, number: 1 }, name: 'tenant_supplier_note_number', unique: true },
    {
      key: { tenantId: 1, 'supplier.partyId': 1, supplierDocNumber: 1 },
      name: 'tenant_supplier_note_doc',
      unique: true,
      partialFilterExpression: { status: 'posted' },
    },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_supplier_note_recent' },
    { key: { tenantId: 1, purchaseId: 1, _id: -1 }, name: 'tenant_supplier_note_purchase' },
  ]);
  await db.collection(COLLECTIONS.payments).createIndexes([
    { key: { tenantId: 1, idempotencyKey: 1 }, name: 'tenant_payment_idempotency', unique: true },
    { key: { tenantId: 1, number: 1 }, name: 'tenant_payment_number', unique: true },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_payment_recent' },
    { key: { tenantId: 1, partyId: 1, _id: -1 }, name: 'tenant_payment_party' },
  ]);
  await db.collection(COLLECTIONS.items).createIndexes([
    { key: { tenantId: 1, sku: 1 }, name: 'tenant_item_sku', unique: true },
    { key: { tenantId: 1, nameKey: 1 }, name: 'tenant_item_name' },
    { key: { tenantId: 1, active: 1, type: 1, _id: 1 }, name: 'tenant_item_active' },
  ]);
  await db.collection(COLLECTIONS.warehouses).createIndexes([
    { key: { tenantId: 1, code: 1 }, name: 'tenant_warehouse_code', unique: true },
  ]);
  await db.collection(COLLECTIONS.stock).createIndexes([
    { key: { tenantId: 1, itemId: 1, warehouseId: 1 }, name: 'tenant_stock_item_warehouse', unique: true },
    { key: { tenantId: 1, warehouseId: 1 }, name: 'tenant_stock_warehouse' },
  ]);
  // Kardex: solo se agrega. Se ordena por _id (orden de aplicación), que es el orden de los saldos que guarda cada movimiento.
  await db.collection(COLLECTIONS.movements).createIndexes([
    { key: { tenantId: 1, itemId: 1, warehouseId: 1, _id: 1 }, name: 'tenant_movement_item' },
    { key: { tenantId: 1, 'source.kind': 1, 'source.id': 1 }, name: 'tenant_movement_source' },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_movement_recent' },
  ]);
  await db.collection(COLLECTIONS.stockDocs).createIndexes([
    { key: { tenantId: 1, idempotencyKey: 1 }, name: 'tenant_stockdoc_idempotency', unique: true },
    { key: { tenantId: 1, kind: 1, number: 1 }, name: 'tenant_stockdoc_number', unique: true },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_stockdoc_recent' },
  ]);
  await db.collection(COLLECTIONS.posRegisters).createIndexes([
    { key: { tenantId: 1, code: 1 }, name: 'tenant_register_code', unique: true },
  ]);
  await db.collection(COLLECTIONS.posShifts).createIndexes([
    // Una caja tiene a lo sumo un turno abierto: dos aperturas simultáneas no pueden coexistir.
    { key: { tenantId: 1, registerId: 1 }, name: 'tenant_shift_open', unique: true, partialFilterExpression: { status: 'open' } },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_shift_recent' },
    { key: { tenantId: 1, registerId: 1, _id: -1 }, name: 'tenant_shift_register' },
  ]);
  await db.collection(COLLECTIONS.posSales).createIndexes([
    { key: { tenantId: 1, idempotencyKey: 1 }, name: 'tenant_possale_idempotency', unique: true },
    { key: { tenantId: 1, registerId: 1, number: 1 }, name: 'tenant_possale_number', unique: true },
    { key: { tenantId: 1, shiftId: 1, _id: -1 }, name: 'tenant_possale_shift' },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_possale_recent' },
  ]);
  // Libros y estados de cuenta: documentos de una empresa por fecha.
  await db.collection(COLLECTIONS.invoices).createIndexes([
    { key: { tenantId: 1, currency: 1, issueDate: 1 }, name: 'tenant_invoice_date' },
    { key: { tenantId: 1, 'customer.partyId': 1, issueDate: 1 }, name: 'tenant_invoice_customer_date' },
  ]);
  await db.collection(COLLECTIONS.purchases).createIndexes([
    { key: { tenantId: 1, currency: 1, issueDate: 1 }, name: 'tenant_purchase_date' },
    { key: { tenantId: 1, 'supplier.partyId': 1, issueDate: 1 }, name: 'tenant_purchase_supplier_date' },
  ]);
  await db.collection(COLLECTIONS.creditNotes).createIndexes([{ key: { tenantId: 1, currency: 1, issueDate: 1 }, name: 'tenant_note_date' }]);
  await db.collection(COLLECTIONS.supplierNotes).createIndexes([{ key: { tenantId: 1, currency: 1, issueDate: 1 }, name: 'tenant_supplier_note_date' }]);
  await db.collection(COLLECTIONS.advances).createIndexes([
    { key: { tenantId: 1, idempotencyKey: 1 }, name: 'tenant_advance_idempotency', unique: true },
    { key: { tenantId: 1, kind: 1, _id: -1 }, name: 'tenant_advance_recent' },
    { key: { tenantId: 1, kind: 1, partyId: 1, _id: -1 }, name: 'tenant_advance_party' },
    { key: { tenantId: 1, kind: 1, currency: 1, partyId: 1 }, name: 'tenant_advance_open', partialFilterExpression: { status: 'posted', balance: { $gt: 0 } } },
  ]);
  await db.collection(COLLECTIONS.advanceApplications).createIndexes([
    { key: { tenantId: 1, idempotencyKey: 1 }, name: 'tenant_advance_application_idempotency', unique: true },
    { key: { tenantId: 1, advanceId: 1, _id: 1 }, name: 'tenant_advance_application_advance' },
  ]);
  await db.collection(COLLECTIONS.costCenters).createIndexes([{ key: { tenantId: 1, code: 1 }, name: 'tenant_costcenter_code', unique: true }]);
  // Saldos por centro de costo o por tercero, con la misma forma que los saldos por cuenta: los actualiza el libro en la transacción del asiento.
  await db.collection(COLLECTIONS.dimBalances).createIndexes([
    { key: { tenantId: 1, dimension: 1, key: 1, accountId: 1, period: 1, currency: 1 }, name: 'tenant_dim_balance', unique: true },
    { key: { tenantId: 1, dimension: 1, period: 1, currency: 1 }, name: 'tenant_dim_period' },
  ]);
  await db.collection(COLLECTIONS.journals).createIndexes([{ key: { tenantId: 1, 'lines.partyId': 1, date: 1 }, name: 'tenant_journal_party', partialFilterExpression: { 'lines.partyId': { $exists: true } } }]);
  // Conciliación bancaria. Los índices únicos parciales son los que impiden conciliar dos veces la misma línea.
  await db.collection(COLLECTIONS.bankLines).createIndexes([
    { key: { tenantId: 1, accountId: 1, dedupeKey: 1 }, name: 'tenant_bankline_dedupe', unique: true, partialFilterExpression: { status: 'active' } },
    { key: { tenantId: 1, accountId: 1, currency: 1, date: 1 }, name: 'tenant_bankline_account_date' },
  ]);
  await db.collection(COLLECTIONS.bankMatches).createIndexes([
    { key: { tenantId: 1, journalId: 1, lineIndex: 1 }, name: 'tenant_bankmatch_book', unique: true, partialFilterExpression: { active: true } },
    { key: { tenantId: 1, bankLineId: 1 }, name: 'tenant_bankmatch_line', unique: true, partialFilterExpression: { active: true, bankLineId: { $type: 'objectId' } } },
  ]);
  await db.collection(COLLECTIONS.bankReconciliations).createIndexes([
    { key: { tenantId: 1, accountId: 1, currency: 1, asOf: 1 }, name: 'tenant_bankrec_closed', unique: true, partialFilterExpression: { status: 'closed' } },
  ]);
  await db.collection(COLLECTIONS.budgets).createIndexes([{ key: { tenantId: 1, year: 1, currency: 1, accountId: 1, costCenter: 1 }, name: 'tenant_budget_line', unique: true }]);
  // Nómina: empleados, configuración (cuentas y parámetros del año) y corridas mensuales.
  await db.collection(COLLECTIONS.employees).createIndexes([
    { key: { tenantId: 1, documentType: 1, documentNumber: 1 }, name: 'tenant_employee_document', unique: true },
    { key: { tenantId: 1, active: 1, name: 1 }, name: 'tenant_employee_active' },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_employee_recent' },
  ]);
  await db.collection(COLLECTIONS.payrollConfig).createIndexes([{ key: { tenantId: 1 }, name: 'tenant_payroll_config', unique: true }]);
  await db.collection(COLLECTIONS.payrollRuns).createIndexes([
    { key: { tenantId: 1, idempotencyKey: 1 }, name: 'tenant_payroll_idempotency', unique: true },
    { key: { tenantId: 1, period: 1 }, name: 'tenant_payroll_period', unique: true, partialFilterExpression: { status: 'posted' } },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_payroll_recent' },
  ]);
  await db.collection(COLLECTIONS.payrollBenefits).createIndexes([
    { key: { tenantId: 1, kind: 1, label: 1 }, name: 'tenant_benefit_period', unique: true, partialFilterExpression: { status: 'posted' } },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_benefit_recent' },
  ]);
  await db.collection(COLLECTIONS.payrollTerminations).createIndexes([
    { key: { tenantId: 1, employeeId: 1 }, name: 'tenant_termination_employee', unique: true, partialFilterExpression: { status: 'posted' } },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_termination_recent' },
  ]);
  await db.collection(COLLECTIONS.taxCloses).createIndexes([
    { key: { tenantId: 1, currency: 1, from: 1, to: 1 }, name: 'tenant_taxclose_range', unique: true, partialFilterExpression: { status: 'posted' } },
    { key: { tenantId: 1, to: -1 }, name: 'tenant_taxclose_recent' },
  ]);
  // Activos fijos y sus corridas de depreciación.
  await db.collection(COLLECTIONS.fixedAssets).createIndexes([
    { key: { tenantId: 1, code: 1 }, name: 'tenant_fixedasset_code', unique: true },
    { key: { tenantId: 1, status: 1, depreciationStart: 1 }, name: 'tenant_fixedasset_status' },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_fixedasset_recent' },
  ]);
  await db.collection(COLLECTIONS.depreciationRuns).createIndexes([{ key: { tenantId: 1, period: 1, _id: 1 }, name: 'tenant_depreciation_period' }]);
  // Documentos comerciales sin efecto contable: cotizaciones, órdenes de compra y plantillas de facturas recurrentes.
  await db.collection(COLLECTIONS.docCounters).createIndexes([{ key: { tenantId: 1, kind: 1 }, name: 'tenant_doc_counter', unique: true }]);
  await db.collection(COLLECTIONS.quotes).createIndexes([
    { key: { tenantId: 1, number: 1 }, name: 'tenant_quote_number', unique: true },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_quote_recent' },
    { key: { tenantId: 1, 'customer.partyId': 1, _id: -1 }, name: 'tenant_quote_customer' },
  ]);
  await db.collection(COLLECTIONS.purchaseOrders).createIndexes([
    { key: { tenantId: 1, number: 1 }, name: 'tenant_order_number', unique: true },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_order_recent' },
    { key: { tenantId: 1, 'supplier.partyId': 1, _id: -1 }, name: 'tenant_order_supplier' },
  ]);
  await db.collection(COLLECTIONS.recurringInvoices).createIndexes([
    { key: { tenantId: 1, active: 1, nextDate: 1 }, name: 'tenant_recurring_due' },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_recurring_recent' },
  ]);
  await db.collection(COLLECTIONS.receipts).createIndexes([
    { key: { tenantId: 1, idempotencyKey: 1 }, name: 'tenant_receipt_idempotency', unique: true },
    { key: { tenantId: 1, number: 1 }, name: 'tenant_receipt_number', unique: true },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_receipt_recent' },
    { key: { tenantId: 1, partyId: 1, _id: -1 }, name: 'tenant_receipt_party' },
  ]);
  await db.collection(COLLECTIONS.creditNotes).createIndexes([
    { key: { tenantId: 1, idempotencyKey: 1 }, name: 'tenant_note_idempotency', unique: true },
    { key: { tenantId: 1, prefix: 1, number: 1 }, name: 'tenant_note_number', unique: true },
    { key: { tenantId: 1, _id: -1 }, name: 'tenant_note_recent' },
    { key: { tenantId: 1, invoiceId: 1, _id: -1 }, name: 'tenant_note_invoice' },
  ]);
  await db.collection(COLLECTIONS.periods).createIndexes([
    { key: { tenantId: 1, period: 1 }, name: 'tenant_period', unique: true },
  ]);
  await db.collection(COLLECTIONS.balances).createIndexes([
    { key: { tenantId: 1, accountId: 1, period: 1, currency: 1 }, name: 'tenant_account_period', unique: true },
  ]);
  await db.collection(COLLECTIONS.counters).createIndexes([
    { key: { tenantId: 1, docType: 1 }, name: 'tenant_doctype', unique: true },
  ]);
}
