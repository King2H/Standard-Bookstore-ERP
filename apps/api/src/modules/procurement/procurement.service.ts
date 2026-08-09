import { db } from '../../db/index.js';
import { BusinessError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { validateSupplierForProcurement } from '../supplier/supplier.service.js';
import { getPOApprovalThreshold } from '../config/config.service.js';
import { insertOutbox } from '../../lib/outbox.js';
import * as invTxSvc from '../inventory/inventoryTransaction.service.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type POStatus = 'draft' | 'pending_approval' | 'approved' | 'ordered' | 'partially_received' | 'received' | 'closed' | 'cancelled';

export interface StaffCtx { staffId: number; role: string; branchId: number; }

export interface POLineItemInput {
  bookId: number;
  formatId?: number | null;
  editionId?: number | null;
  quantity: number;
  unitCost: number;
}

export interface PORow {
  id: string;
  branchId: number;
  supplierId: number;
  supplierName: string;
  status: POStatus;
  totalAmount: number;
  currency: string;
  expectedDeliveryDate: string | null;
  notes: string | null;
  receivingBranchId: number | null;
  receivingLocationId: number | null;
  receivingLocationName: string | null;
  financialStatus: 'unpaid' | 'partial' | 'paid';
  paymentTerms: 'cash' | 'credit';
  createdBy: number;
  approvedBy: number | null;
  createdAt: string;
  updatedAt: string;
  lineItems?: POLineItemRow[];
  receipts?: POReceiptRow[];
  payments?: SupplierPaymentRow[];
}

export interface SupplierPaymentRow {
  id: string;
  poId: string;
  amount: number;
  paymentMethod: string;
  source: 'manual' | 'auto_on_receipt';
  notes: string | null;
  createdBy: number;
  createdAt: string;
}

export interface POLineItemRow {
  id: string;
  poId: string;
  bookId: number;
  bookTitle: string;
  bookIsbn: string;
  formatId: number | null;
  editionId: number | null;
  quantity: number;
  unitCost: number;
  receivedQuantity: number;
  remaining: number;
}

export interface POReceiptRow {
  id: string;
  poId: string;
  locationId: number;
  locationName: string;
  receivedBy: number;
  receivedAt: string;
  notes: string | null;
  items: POReceiptItemRow[];
}

export interface POReceiptItemRow {
  id: string;
  receiptId: string;
  poLineItemId: string;
  bookTitle: string;
  quantityReceived: number;
}

export interface ReceiveItemInput {
  poLineItemId: number;
  quantityReceived: number;
}

// ── Row mappers ───────────────────────────────────────────────────────────────

// expected_delivery_date is a plain DATE column (no time, no timezone) — but
// the pg driver still hands it back as a JS Date built from that date's
// year/month/day in the server process's *local* timezone. Reading it back
// out with .toISOString() (always UTC) is the bug: whenever the server's
// local offset is ahead of UTC (e.g. Africa/Addis_Ababa, UTC+3), that local
// midnight falls on the *previous* UTC day, so toISOString() silently
// returns the day before what was actually stored — a book selected/saved
// as 2026-08-08 came back as 2026-08-07. Reading the same Date object back
// with its *local* getters instead of toISOString() reverses exactly the
// conversion pg-types applied, so it reconstructs the original calendar
// date regardless of what the server's local timezone happens to be — no
// hardcoded offset, no dependency on server TZ configuration.
function dateOnlyToString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function mapPORow(row: Record<string, unknown>): PORow {
  return {
    id: String(row.id),
    branchId: row.branch_id as number,
    supplierId: row.supplier_id as number,
    supplierName: row.supplier_name as string,
    status: row.status as POStatus,
    totalAmount: parseFloat(row.total_amount as string),
    currency: row.currency as string,
    expectedDeliveryDate: row.expected_delivery_date
      ? (row.expected_delivery_date instanceof Date
          ? dateOnlyToString(row.expected_delivery_date)
          : String(row.expected_delivery_date))
      : null,
    notes: (row.notes as string | null) ?? null,
    receivingBranchId: (row.receiving_branch_id as number | null) ?? null,
    receivingLocationId: (row.receiving_location_id as number | null) ?? null,
    receivingLocationName: (row.receiving_location_name as string | null) ?? null,
    financialStatus: (row.financial_status as 'unpaid' | 'partial' | 'paid') ?? 'unpaid',
    paymentTerms: (row.payment_terms as 'cash' | 'credit') ?? 'credit',
    createdBy: row.created_by as number,
    approvedBy: (row.approved_by as number | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function mapLineItemRow(row: Record<string, unknown>): POLineItemRow {
  const qty = row.quantity as number;
  const received = row.received_quantity as number;
  return {
    id: String(row.id),
    poId: String(row.po_id),
    bookId: row.book_id as number,
    bookTitle: row.book_title as string,
    bookIsbn: row.book_isbn as string,
    formatId: (row.format_id as number | null) ?? null,
    editionId: (row.edition_id as number | null) ?? null,
    quantity: qty,
    unitCost: parseFloat(row.unit_cost as string),
    receivedQuantity: received,
    remaining: qty - received,
  };
}

function mapReceiptRow(row: Record<string, unknown>, items: POReceiptItemRow[]): POReceiptRow {
  return {
    id: String(row.id),
    poId: String(row.po_id),
    locationId: row.location_id as number,
    locationName: row.location_name as string,
    receivedBy: row.received_by as number,
    receivedAt: (row.received_at as Date).toISOString(),
    notes: (row.notes as string | null) ?? null,
    items,
  };
}

function mapReceiptItemRow(row: Record<string, unknown>): POReceiptItemRow {
  return {
    id: String(row.id),
    receiptId: String(row.receipt_id),
    poLineItemId: String(row.po_line_item_id),
    bookTitle: row.book_title as string,
    quantityReceived: row.quantity_received as number,
  };
}

function mapSupplierPaymentRow(row: Record<string, unknown>): SupplierPaymentRow {
  return {
    id: String(row.id),
    poId: String(row.po_id),
    amount: parseFloat(row.amount as string),
    paymentMethod: row.payment_method as string,
    source: row.source as 'manual' | 'auto_on_receipt',
    notes: (row.notes as string | null) ?? null,
    createdBy: row.created_by as number,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchLineItems(poId: string | number): Promise<POLineItemRow[]> {
  const result = await db.query(
    `SELECT li.id, li.po_id, li.book_id, b.title AS book_title, b.isbn AS book_isbn,
            li.format_id, li.edition_id, li.quantity, li.unit_cost, li.received_quantity
     FROM po_line_items li
     JOIN books b ON b.id = li.book_id
     WHERE li.po_id = $1
     ORDER BY li.id ASC`,
    [poId],
  );
  return result.rows.map(mapLineItemRow);
}

async function fetchReceipts(poId: string | number): Promise<POReceiptRow[]> {
  const receiptsRes = await db.query(
    `SELECT r.id, r.po_id, r.location_id, l.name AS location_name,
            r.received_by, r.received_at, r.notes
     FROM po_receipts r
     JOIN locations l ON l.id = r.location_id
     WHERE r.po_id = $1
     ORDER BY r.received_at ASC`,
    [poId],
  );
  const receipts: POReceiptRow[] = [];
  for (const row of receiptsRes.rows) {
    const itemsRes = await db.query(
      `SELECT ri.id, ri.receipt_id, ri.po_line_item_id, b.title AS book_title, ri.quantity_received
       FROM po_receipt_items ri
       JOIN po_line_items li ON li.id = ri.po_line_item_id
       JOIN books b ON b.id = li.book_id
       WHERE ri.receipt_id = $1
       ORDER BY ri.id ASC`,
      [row.id],
    );
    receipts.push(mapReceiptRow(row, itemsRes.rows.map(mapReceiptItemRow)));
  }
  return receipts;
}

async function fetchSupplierPayments(poId: string | number): Promise<SupplierPaymentRow[]> {
  const result = await db.query(
    `SELECT id, po_id, amount, payment_method, source, notes, created_by, created_at
     FROM supplier_payments
     WHERE po_id = $1
     ORDER BY created_at ASC`,
    [poId],
  );
  return result.rows.map(mapSupplierPaymentRow);
}

// ── getById ───────────────────────────────────────────────────────────────────

export async function getById(id: number | string): Promise<PORow> {
  const result = await db.query(
    `SELECT po.id, po.branch_id, po.supplier_id, s.name AS supplier_name,
            po.status, po.total_amount, po.currency, po.expected_delivery_date,
            po.notes, po.receiving_branch_id, po.receiving_location_id,
            rl.name AS receiving_location_name,
            po.financial_status, po.payment_terms, po.created_by, po.approved_by, po.created_at, po.updated_at
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN locations rl ON rl.id = po.receiving_location_id
     WHERE po.id = $1`,
    [id],
  );
  if (!result.rows.length) throw new NotFoundError('Purchase Order');
  const po = mapPORow(result.rows[0]);
  po.lineItems = await fetchLineItems(po.id);
  po.receipts = await fetchReceipts(po.id);
  po.payments = await fetchSupplierPayments(po.id);
  return po;
}

// ── list ──────────────────────────────────────────────────────────────────────

export async function list(opts: {
  branchId?: number;
  status?: string;
  supplierId?: number;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ items: PORow[]; total: number; page: number; totalPages: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, opts.pageSize ?? 25);
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const filterParams: unknown[] = [];
  let p = 1;

  if (opts.branchId) { conditions.push(`po.branch_id = $${p++}`); filterParams.push(opts.branchId); }
  if (opts.status) { conditions.push(`po.status = $${p++}`); filterParams.push(opts.status); }
  if (opts.supplierId) { conditions.push(`po.supplier_id = $${p++}`); filterParams.push(opts.supplierId); }
  if (opts.dateFrom) { conditions.push(`po.created_at >= $${p++}`); filterParams.push(opts.dateFrom); }
  if (opts.dateTo) { conditions.push(`po.created_at <= $${p++}`); filterParams.push(opts.dateTo); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitParam = p;
  const offsetParam = p + 1;

  const [countRes, dataRes] = await Promise.all([
    db.query(
      `SELECT COUNT(*) FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id ${where}`,
      filterParams,
    ),
    db.query(
      `SELECT po.id, po.branch_id, po.supplier_id, s.name AS supplier_name,
              po.status, po.total_amount, po.currency, po.expected_delivery_date,
              po.notes, po.receiving_branch_id, po.receiving_location_id,
              rl.name AS receiving_location_name,
              po.financial_status, po.payment_terms, po.created_by, po.approved_by, po.created_at, po.updated_at
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN locations rl ON rl.id = po.receiving_location_id
       ${where}
       ORDER BY po.created_at DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...filterParams, pageSize, offset],
    ),
  ]);

  return {
    items: dataRes.rows.map(mapPORow),
    total: parseInt(countRes.rows[0].count as string, 10),
    page,
    totalPages: Math.ceil(parseInt(countRes.rows[0].count as string, 10) / pageSize),
  };
}

// ── createPO ──────────────────────────────────────────────────────────────────

export async function createPO(
  data: {
    supplierId: number;
    branchId: number;
    receivingBranchId?: number | null;
    receivingLocationId?: number | null;
    currency?: string;
    expectedDeliveryDate?: string | null;
    notes?: string | null;
    /** 'cash' auto-settles on receipt; 'credit' (default) stays unpaid until a supplier payment is recorded. */
    paymentTerms?: 'cash' | 'credit';
    lineItems: POLineItemInput[];
  },
  staffCtx: StaffCtx,
): Promise<PORow> {
  if (!data.lineItems || data.lineItems.length === 0) {
    throw new ValidationError('At least one line item is required');
  }

  await validateSupplierForProcurement(data.supplierId);

  // Validate each book is active
  for (const item of data.lineItems) {
    const bookRes = await db.query(
      `SELECT id FROM books WHERE id = $1 AND is_active = true`,
      [item.bookId],
    );
    if (!bookRes.rows.length) {
      throw new NotFoundError(`Book ${item.bookId}`);
    }
    if (item.quantity <= 0) throw new ValidationError('Quantity must be positive');
    if (item.unitCost < 0) throw new ValidationError('Unit cost cannot be negative');
  }

  const effectiveReceivingBranchId = data.receivingBranchId ?? data.branchId;

  // Validate or auto-resolve receiving location
  let resolvedLocationId: number | null = null;
  if (data.receivingLocationId != null) {
    const locRes = await db.query(
      `SELECT id FROM locations WHERE id = $1 AND branch_id = $2`,
      [data.receivingLocationId, effectiveReceivingBranchId],
    );
    if (!locRes.rows.length) {
      throw new ValidationError('Receiving location does not exist or does not belong to the receiving branch');
    }
    resolvedLocationId = data.receivingLocationId;
  } else {
    const locRes = await db.query(
      `SELECT id FROM locations WHERE branch_id = $1 AND is_default_fulfillment = true LIMIT 1`,
      [effectiveReceivingBranchId],
    );
    resolvedLocationId = locRes.rows.length ? (locRes.rows[0].id as number) : null;
  }

  const totalAmount = data.lineItems.reduce((sum, li) => sum + li.quantity * li.unitCost, 0);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const poRes = await client.query(
      `INSERT INTO purchase_orders (branch_id, supplier_id, status, total_amount, currency, expected_delivery_date, notes, created_by, receiving_branch_id, receiving_location_id, payment_terms)
       VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        data.branchId,
        data.supplierId,
        totalAmount.toFixed(2),
        data.currency ?? 'USD',
        data.expectedDeliveryDate ?? null,
        data.notes ?? null,
        staffCtx.staffId,
        data.receivingBranchId ?? null,
        resolvedLocationId,
        data.paymentTerms ?? 'credit',
      ],
    );
    const poId: string = String(poRes.rows[0].id);

    for (const item of data.lineItems) {
      await client.query(
        `INSERT INTO po_line_items (po_id, book_id, format_id, edition_id, quantity, unit_cost)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [poId, item.bookId, item.formatId ?? null, item.editionId ?? null, item.quantity, item.unitCost.toFixed(2)],
      );
    }

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'CREATE', 'purchase_order', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, poId, staffCtx.branchId, JSON.stringify({ supplierId: data.supplierId, totalAmount })],
    );

    // Emit PO notification
    const supplierRes = await client.query('SELECT name FROM suppliers WHERE id = $1', [data.supplierId]);
    const supplierName = supplierRes.rows[0]?.name ?? String(data.supplierId);
    await insertOutbox(client, 'po.created', {
      poId, poNumber: poRes.rows[0].id, supplierName, total: totalAmount, branchId: data.branchId,
    });

    await client.query('COMMIT');
    return getById(poId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── updatePO ──────────────────────────────────────────────────────────────────

export async function updatePO(
  id: number | string,
  data: {
    supplierId?: number;
    currency?: string;
    expectedDeliveryDate?: string | null;
    notes?: string | null;
    receivingBranchId?: number | null;
    receivingLocationId?: number | null;
    paymentTerms?: 'cash' | 'credit';
    lineItems?: POLineItemInput[];
  },
  staffCtx: StaffCtx,
): Promise<PORow> {
  const existing = await db.query(
    `SELECT status, branch_id FROM purchase_orders WHERE id = $1`,
    [id],
  );
  if (!existing.rows.length) throw new NotFoundError('Purchase Order');
  if (existing.rows[0].status !== 'draft') {
    throw new BusinessError('PO_NOT_EDITABLE', 'Purchase Order can only be edited in draft status');
  }

  if (data.supplierId) {
    await validateSupplierForProcurement(data.supplierId);
  }

  // Validate/resolve receiving location if being changed
  if (data.receivingBranchId !== undefined || data.receivingLocationId !== undefined) {
    const effectiveReceivingBranchId = data.receivingBranchId ?? (existing.rows[0].branch_id as number);
    if (data.receivingLocationId != null) {
      const locRes = await db.query(
        `SELECT id FROM locations WHERE id = $1 AND branch_id = $2`,
        [data.receivingLocationId, effectiveReceivingBranchId],
      );
      if (!locRes.rows.length) {
        throw new ValidationError('Receiving location does not exist or does not belong to the receiving branch');
      }
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let totalAmount: number | undefined;

    if (data.lineItems && data.lineItems.length > 0) {
      for (const item of data.lineItems) {
        const bookRes = await client.query(
          `SELECT id FROM books WHERE id = $1 AND is_active = true`,
          [item.bookId],
        );
        if (!bookRes.rows.length) throw new NotFoundError(`Book ${item.bookId}`);
        if (item.quantity <= 0) throw new ValidationError('Quantity must be positive');
        if (item.unitCost < 0) throw new ValidationError('Unit cost cannot be negative');
      }
      totalAmount = data.lineItems.reduce((sum, li) => sum + li.quantity * li.unitCost, 0);

      await client.query(`DELETE FROM po_line_items WHERE po_id = $1`, [id]);
      for (const item of data.lineItems) {
        await client.query(
          `INSERT INTO po_line_items (po_id, book_id, format_id, edition_id, quantity, unit_cost)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, item.bookId, item.formatId ?? null, item.editionId ?? null, item.quantity, item.unitCost.toFixed(2)],
        );
      }
    }

    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [];
    let p = 1;

    if (data.supplierId !== undefined) { sets.push(`supplier_id = $${p++}`); params.push(data.supplierId); }
    if (data.currency !== undefined) { sets.push(`currency = $${p++}`); params.push(data.currency); }
    if (data.expectedDeliveryDate !== undefined) { sets.push(`expected_delivery_date = $${p++}`); params.push(data.expectedDeliveryDate); }
    if (data.notes !== undefined) { sets.push(`notes = $${p++}`); params.push(data.notes); }
    if (data.receivingBranchId !== undefined) { sets.push(`receiving_branch_id = $${p++}`); params.push(data.receivingBranchId); }
    if (data.receivingLocationId !== undefined) { sets.push(`receiving_location_id = $${p++}`); params.push(data.receivingLocationId); }
    if (data.paymentTerms !== undefined) { sets.push(`payment_terms = $${p++}`); params.push(data.paymentTerms); }
    if (totalAmount !== undefined) { sets.push(`total_amount = $${p++}`); params.push(totalAmount.toFixed(2)); }

    params.push(id);
    await client.query(
      `UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = $${p}`,
      params,
    );

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'UPDATE', 'purchase_order', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId, JSON.stringify({ action: 'update', ...data })],
    );

    await client.query('COMMIT');
    return getById(id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── submitForApproval ─────────────────────────────────────────────────────────

export async function submitForApproval(id: number | string, staffCtx: StaffCtx): Promise<PORow> {
  const existing = await db.query(
    `SELECT status, total_amount FROM purchase_orders WHERE id = $1`,
    [id],
  );
  if (!existing.rows.length) throw new NotFoundError('Purchase Order');
  if (existing.rows[0].status !== 'draft') {
    throw new BusinessError('PO_INVALID_STATUS', 'Purchase Order must be in draft status to submit for approval');
  }

  const totalAmount = parseFloat(existing.rows[0].total_amount as string);
  const threshold = await getPOApprovalThreshold();

  const newStatus: POStatus = totalAmount > threshold ? 'pending_approval' : 'approved';
  const approvedBy = newStatus === 'approved' ? staffCtx.staffId : null;

  await db.query(
    `UPDATE purchase_orders SET status = $1, approved_by = $2, updated_at = now() WHERE id = $3`,
    [newStatus, approvedBy, id],
  );

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1, $2, 'UPDATE', 'purchase_order', $3, $4, $5)`,
    [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId,
     JSON.stringify({ action: 'submit_for_approval', newStatus, totalAmount, threshold })],
  );

  // Emit notification if approval required
  if (newStatus === 'pending_approval') {
    try {
      const notifClient = await db.connect();
      try {
        await notifClient.query('BEGIN');
        const poRes = await notifClient.query('SELECT po.id, s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1', [id]);
        const supplierName = poRes.rows[0]?.supplier_name ?? '';
        const poNumber = `PO-${String(id).padStart(6, '0')}`;
        await insertOutbox(notifClient, 'po.approval_required', {
          poId: String(id), poNumber, supplierName, total: totalAmount, branchId: staffCtx.branchId,
        });
        await notifClient.query('COMMIT');
      } catch { await notifClient.query('ROLLBACK'); } finally { notifClient.release(); }
    } catch { /* non-fatal */ }
  }

  return getById(id);
}

// ── approvePO ─────────────────────────────────────────────────────────────────

export async function approvePO(id: number | string, staffCtx: StaffCtx): Promise<PORow> {
  const existing = await db.query(
    `SELECT status FROM purchase_orders WHERE id = $1`,
    [id],
  );
  if (!existing.rows.length) throw new NotFoundError('Purchase Order');
  if (existing.rows[0].status !== 'pending_approval') {
    throw new BusinessError('PO_INVALID_STATUS', 'Purchase Order must be in pending_approval status to approve');
  }

  await db.query(
    `UPDATE purchase_orders SET status = 'approved', approved_by = $1, updated_at = now() WHERE id = $2`,
    [staffCtx.staffId, id],
  );

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1, $2, 'UPDATE', 'purchase_order', $3, $4, $5)`,
    [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId, JSON.stringify({ action: 'approve' })],
  );

  try {
    const notifClient = await db.connect();
    try {
      await notifClient.query('BEGIN');
      const poNumber = `PO-${String(id).padStart(6, '0')}`;
      await insertOutbox(notifClient, 'po.approved', { poId: String(id), poNumber, branchId: staffCtx.branchId });
      await notifClient.query('COMMIT');
    } catch { await notifClient.query('ROLLBACK'); } finally { notifClient.release(); }
  } catch { /* non-fatal */ }

  return getById(id);
}

// ── markAsOrdered ─────────────────────────────────────────────────────────────

export async function markAsOrdered(id: number | string, staffCtx: StaffCtx): Promise<PORow> {
  const existing = await db.query(
    `SELECT status FROM purchase_orders WHERE id = $1`,
    [id],
  );
  if (!existing.rows.length) throw new NotFoundError('Purchase Order');
  if (existing.rows[0].status !== 'approved') {
    throw new BusinessError('PO_INVALID_STATUS', 'Purchase Order must be in approved status to mark as ordered');
  }

  await db.query(
    `UPDATE purchase_orders SET status = 'ordered', updated_at = now() WHERE id = $1`,
    [id],
  );

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1, $2, 'UPDATE', 'purchase_order', $3, $4, $5)`,
    [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId, JSON.stringify({ action: 'mark_as_ordered' })],
  );

  try {
    const notifClient = await db.connect();
    try {
      await notifClient.query('BEGIN');
      const poRes = await notifClient.query('SELECT s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1', [id]);
      const supplierName = poRes.rows[0]?.supplier_name ?? '';
      const poNumber = `PO-${String(id).padStart(6, '0')}`;
      await insertOutbox(notifClient, 'po.ordered', { poId: String(id), poNumber, supplierName, branchId: staffCtx.branchId });
      await notifClient.query('COMMIT');
    } catch { await notifClient.query('ROLLBACK'); } finally { notifClient.release(); }
  } catch { /* non-fatal */ }

  return getById(id);
}

// ── closePO ───────────────────────────────────────────────────────────────────

export async function closePO(id: number | string, staffCtx: StaffCtx): Promise<PORow> {
  const existing = await db.query(
    `SELECT status FROM purchase_orders WHERE id = $1`,
    [id],
  );
  if (!existing.rows.length) throw new NotFoundError('Purchase Order');
  if (existing.rows[0].status !== 'received') {
    throw new BusinessError('PO_INVALID_STATUS', 'Purchase Order must be in received status to close');
  }

  await db.query(
    `UPDATE purchase_orders SET status = 'closed', updated_at = now() WHERE id = $1`,
    [id],
  );

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1, $2, 'UPDATE', 'purchase_order', $3, $4, $5)`,
    [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId, JSON.stringify({ action: 'close' })],
  );

  return getById(id);
}

// ── cancelPO ──────────────────────────────────────────────────────────────────

export async function cancelPO(id: number | string, staffCtx: StaffCtx): Promise<PORow> {
  const existing = await db.query(
    `SELECT status FROM purchase_orders WHERE id = $1`,
    [id],
  );
  if (!existing.rows.length) throw new NotFoundError('Purchase Order');

  const cancellableStatuses: POStatus[] = ['draft', 'pending_approval', 'approved'];
  if (!cancellableStatuses.includes(existing.rows[0].status as POStatus)) {
    throw new BusinessError('PO_INVALID_STATUS', 'Purchase Order cannot be cancelled in its current status');
  }

  const receiptCheck = await db.query(
    `SELECT COUNT(*) FROM po_receipts WHERE po_id = $1`,
    [id],
  );
  if (parseInt(receiptCheck.rows[0].count as string, 10) > 0) {
    throw new BusinessError('CANNOT_CANCEL_WITH_RECEIPTS', 'Cannot cancel a Purchase Order that has receipts');
  }

  await db.query(
    `UPDATE purchase_orders SET status = 'cancelled', updated_at = now() WHERE id = $1`,
    [id],
  );

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1, $2, 'UPDATE', 'purchase_order', $3, $4, $5)`,
    [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId, JSON.stringify({ action: 'cancel' })],
  );

  try {
    const notifClient = await db.connect();
    try {
      await notifClient.query('BEGIN');
      const poNumber = `PO-${String(id).padStart(6, '0')}`;
      await insertOutbox(notifClient, 'po.cancelled', { poId: String(id), poNumber, branchId: staffCtx.branchId });
      await notifClient.query('COMMIT');
    } catch { await notifClient.query('ROLLBACK'); } finally { notifClient.release(); }
  } catch { /* non-fatal */ }

  return getById(id);
}

// ── Payment lifecycle (Module 1 — stabilization sprint) ────────────────────────
//
// purchase_orders.financial_status is the source of truth for "has this PO
// been paid" and is derived -- never set directly by callers -- from the sum
// of supplier_payments against the PO vs. its total_amount. PO operational
// status (draft -> ... -> closed) never implies payment: closePO() does not
// touch financial_status, and only recomputeFinancialStatus() (called from
// createSupplierPayment() and, for cash terms, from receivePO()) may write it.

async function recomputeFinancialStatus(
  poId: number | string,
  client: import('pg').PoolClient,
): Promise<void> {
  const poRes = await client.query(
    `SELECT total_amount FROM purchase_orders WHERE id = $1 FOR UPDATE`,
    [poId],
  );
  if (!poRes.rows.length) return;
  const totalAmount = parseFloat(poRes.rows[0].total_amount as string);

  const paidRes = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS paid FROM supplier_payments WHERE po_id = $1`,
    [poId],
  );
  const totalPaid = parseFloat(paidRes.rows[0].paid as string);

  let financialStatus: 'unpaid' | 'partial' | 'paid';
  if (totalPaid <= 0.01) financialStatus = 'unpaid';
  else if (totalPaid >= totalAmount - 0.01) financialStatus = 'paid';
  else financialStatus = 'partial';

  await client.query(
    `UPDATE purchase_orders SET financial_status = $1, updated_at = now() WHERE id = $2`,
    [financialStatus, poId],
  );
}

// ── createSupplierPayment ────────────────────────────────────────────────────
// Records a manual supplier payment against a PO and recomputes financial_status.
// Reuses the same PO-existence / status checks as the rest of this module
// rather than introducing a parallel payment pipeline.

export async function createSupplierPayment(
  poId: number | string,
  data: { amount: number; paymentMethod?: string; notes?: string | null },
  staffCtx: StaffCtx,
): Promise<PORow> {
  if (!(data.amount > 0)) throw new ValidationError('Payment amount must be positive');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const poRes = await client.query(
      `SELECT status, branch_id, supplier_id FROM purchase_orders WHERE id = $1 FOR UPDATE`,
      [poId],
    );
    if (!poRes.rows.length) throw new NotFoundError('Purchase Order');
    const po = poRes.rows[0] as { status: string; branch_id: number; supplier_id: number };

    const unpayableStatuses = ['draft', 'pending_approval', 'cancelled'];
    if (unpayableStatuses.includes(po.status)) {
      throw new BusinessError(
        'PO_NOT_PAYABLE',
        `Cannot record a payment against a Purchase Order in status '${po.status}'`,
      );
    }

    await client.query(
      `INSERT INTO supplier_payments (po_id, branch_id, supplier_id, amount, payment_method, source, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7)`,
      [
        poId, po.branch_id, po.supplier_id,
        data.amount.toFixed(2), data.paymentMethod ?? 'cash',
        data.notes ?? null, staffCtx.staffId,
      ],
    );

    await recomputeFinancialStatus(poId, client);

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'CREATE', 'supplier_payment', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, String(poId), staffCtx.branchId,
       JSON.stringify({ amount: data.amount, paymentMethod: data.paymentMethod ?? 'cash' })],
    );

    await client.query('COMMIT');
    return getById(poId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── receivePO ─────────────────────────────────────────────────────────────────

export async function receivePO(
  id: number | string,
  locationId: number | null,
  items: ReceiveItemInput[],
  notes: string | null,
  staffCtx: StaffCtx,
): Promise<PORow> {
  if (!items || items.length === 0) {
    throw new ValidationError('At least one item must be received');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Fetch PO — must be in receivable status
    const poRes = await client.query(
      `SELECT id, status, receiving_location_id, branch_id, supplier_id, payment_terms FROM purchase_orders WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!poRes.rows.length) throw new NotFoundError('Purchase Order');

    const receivableStatuses = ['approved', 'ordered', 'partially_received'];
    if (!receivableStatuses.includes(poRes.rows[0].status as string)) {
      throw new BusinessError('PO_INVALID_STATUS', 'Purchase Order must be approved, ordered, or partially_received to receive goods');
    }
    const paymentTerms = poRes.rows[0].payment_terms as 'cash' | 'credit';

    // Resolve effective location: use provided locationId or fall back to PO's receiving_location_id
    const effectiveLocationId = locationId ?? (poRes.rows[0].receiving_location_id as number | null);
    if (!effectiveLocationId) {
      throw new ValidationError('No receiving location specified and PO has no default receiving location');
    }

    // 2. Validate location exists
    const locRes = await client.query(`SELECT id FROM locations WHERE id = $1`, [effectiveLocationId]);
    if (!locRes.rows.length) throw new NotFoundError('Location');

    // 3. Process each item
    let cashValueReceived = 0; // SUM(quantityReceived * unit_cost) this event — for cash-terms auto-pay
    for (const item of items) {
      if (item.quantityReceived <= 0) {
        throw new ValidationError('Quantity received must be positive');
      }

      const lineRes = await client.query(
        `SELECT id, po_id, book_id, quantity, received_quantity, unit_cost FROM po_line_items WHERE id = $1 FOR UPDATE`,
        [item.poLineItemId],
      );
      if (!lineRes.rows.length) throw new NotFoundError(`PO Line Item ${item.poLineItemId}`);

      const line = lineRes.rows[0] as {
        id: number; po_id: string; book_id: number; quantity: number; received_quantity: number; unit_cost: string;
      };
      cashValueReceived += item.quantityReceived * parseFloat(line.unit_cost);

      if (String(line.po_id) !== String(id)) {
        throw new BusinessError('LINE_ITEM_MISMATCH', `Line item ${item.poLineItemId} does not belong to this PO`);
      }

      const newReceived = line.received_quantity + item.quantityReceived;
      if (newReceived > line.quantity) {
        throw new BusinessError(
          'OVER_RECEIPT',
          `Cannot receive more than ordered. Ordered: ${line.quantity}, Already received: ${line.received_quantity}, Attempting: ${item.quantityReceived}`,
        );
      }

      // Update received_quantity on line item
      await client.query(
        `UPDATE po_line_items SET received_quantity = received_quantity + $1 WHERE id = $2`,
        [item.quantityReceived, item.poLineItemId],
      );

      // Inline inventory update (within transaction)
      const bookId = line.book_id;

      // Initialize inventory row if missing
      await client.query(
        `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
         VALUES ($1, $2, 0, 5, 0) ON CONFLICT DO NOTHING`,
        [bookId, effectiveLocationId],
      );

      // Increase inventory via centralized service (Requirements 2.1, 2.11)
      await invTxSvc.stockIn(
        {
          bookId,
          locationId: effectiveLocationId,
          quantity: item.quantityReceived,
          referenceType: 'purchase_order',
          referenceId: String(id),
          reasonCode: 'initial',
          // stockIn's `notes` is string | undefined (it does `notes ?? null`
          // internally before the INSERT), so null and undefined already
          // collapse to the same DB value — pass undefined to match the
          // declared param type instead of widening it for one caller.
          notes: notes ?? undefined,
          staffCtx,
        },
        client,
      );
    }

    // 4. Insert po_receipts
    const receiptRes = await client.query(
      `INSERT INTO po_receipts (po_id, location_id, received_by, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [id, effectiveLocationId, staffCtx.staffId, notes ?? null],
    );
    const receiptId = receiptRes.rows[0].id as string;

    // 5. Insert po_receipt_items
    for (const item of items) {
      await client.query(
        `INSERT INTO po_receipt_items (receipt_id, po_line_item_id, quantity_received)
         VALUES ($1, $2, $3)`,
        [receiptId, item.poLineItemId, item.quantityReceived],
      );
    }

    // 6. Re-fetch all line items to determine new PO status
    const allLinesRes = await client.query(
      `SELECT quantity, received_quantity FROM po_line_items WHERE po_id = $1`,
      [id],
    );
    const allReceived = allLinesRes.rows.every(
      (r: { quantity: number; received_quantity: number }) => r.received_quantity >= r.quantity,
    );
    const newStatus: POStatus = allReceived ? 'received' : 'partially_received';

    // 7. Update PO status
    await client.query(
      `UPDATE purchase_orders SET status = $1, updated_at = now() WHERE id = $2`,
      [newStatus, id],
    );

    // 7b. Cash procurement auto-settles on receipt (COD-style): the value of
    // goods actually received in THIS event is recorded as a supplier
    // payment, so a partial receipt only pays for what arrived, not the
    // full PO total. Credit procurement (the default) is untouched here —
    // it stays 'unpaid'/'partial' until createSupplierPayment() is called
    // explicitly at settlement. financial_status is only ever written by
    // recomputeFinancialStatus(); this receipt path never sets it directly.
    if (paymentTerms === 'cash' && cashValueReceived > 0) {
      await client.query(
        `INSERT INTO supplier_payments (po_id, branch_id, supplier_id, amount, payment_method, source, notes, created_by)
         VALUES ($1, $2, $3, $4, 'cash', 'auto_on_receipt', $5, $6)`,
        [
          id, poRes.rows[0].branch_id, poRes.rows[0].supplier_id,
          cashValueReceived.toFixed(2),
          `Auto-settled on receipt #${receiptId}`,
          staffCtx.staffId,
        ],
      );
      await recomputeFinancialStatus(id, client);
    }

    // 8. Audit log
    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'UPDATE', 'purchase_order', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId,
       JSON.stringify({ action: 'receive', locationId: effectiveLocationId, itemCount: items.length, newStatus })],
    );

    // 9. Emit receiving notification
    const poNumber = `PO-${String(id).padStart(6, '0')}`;
    const totalQtyReceived = items.reduce((s, i) => s + i.quantityReceived, 0);
    const totalQtyOrdered = allLinesRes.rows.reduce((s: number, r: { quantity: number }) => s + r.quantity, 0);
    if (newStatus === 'received') {
      await insertOutbox(client, 'po.fully_received', { poId: String(id), poNumber, branchId: staffCtx.branchId });
    } else {
      await insertOutbox(client, 'po.partially_received', {
        poId: String(id), poNumber, qtyReceived: totalQtyReceived, qtyOrdered: totalQtyOrdered, branchId: staffCtx.branchId,
      });
    }

    await client.query('COMMIT');
    return getById(id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
