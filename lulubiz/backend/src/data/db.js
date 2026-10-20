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
    { key: { tenantId: 1, number: 1 }, name: 'tenant_purchase_number', unique: true },
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
