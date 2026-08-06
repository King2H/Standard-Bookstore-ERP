/**
 * Inventory Reconciliation Script
 *
 * Rebuilds inventory.quantity for each (book_id, location_id) from the
 * canonical inventory_history ledger and repairs any inconsistencies.
 * Also releases stale inventory_reservations for orders that are already
 * FULFILLED, COMPLETED, or CANCELLED.
 *
 * Usage:
 *   node scripts/reconcile-inventory.mjs          # apply fixes
 *   node scripts/reconcile-inventory.mjs --dry-run # log only, no writes
 */

import pg from 'pg';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

const DRY_RUN = process.argv.includes('--dry-run');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(obj) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));
}

// ── Step 1: Rebuild inventory.quantity from inventory_history ledger ──────────

async function reconcileQuantities(client) {
  log({ step: 1, msg: 'Reconciling inventory.quantity from history ledger' });

  // Sum all deltas from history for each (book_id, location_id)
  const ledgerRes = await client.query(`
    SELECT
      book_id,
      location_id,
      SUM(delta)::int AS computed_qty
    FROM inventory_history
    WHERE movement_type IN ('stock_in', 'stock_out', 'transfer_in', 'transfer_out', 'adjustment')
    GROUP BY book_id, location_id
  `);

  let checked = 0;
  let mismatches = 0;
  let repaired = 0;

  for (const row of ledgerRes.rows) {
    const { book_id, location_id, computed_qty } = row;

    // Read current stored quantity
    const invRes = await client.query(
      `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`,
      [book_id, location_id],
    );

    if (!invRes.rows.length) {
      log({ step: 1, warn: 'no_inventory_row', book_id, location_id, computed_qty });
      checked++;
      continue;
    }

    const stored_qty = Number(invRes.rows[0].quantity);
    checked++;

    if (stored_qty !== computed_qty) {
      mismatches++;
      log({
        step: 1,
        mismatch: true,
        book_id,
        location_id,
        stored_qty,
        computed_qty,
        delta: computed_qty - stored_qty,
        dry_run: DRY_RUN,
      });

      if (!DRY_RUN) {
        await client.query(
          `UPDATE inventory SET quantity = $1, updated_at = now() WHERE book_id = $2 AND location_id = $3`,
          [Math.max(0, computed_qty), book_id, location_id],
        );
        repaired++;
      }
    }
  }

  log({ step: 1, done: true, checked, mismatches, repaired });
  return { checked, mismatches, repaired };
}

// ── Step 2: Release stale reservations for terminal-state orders ──────────────

async function releaseStaleReservations(client) {
  log({ step: 2, msg: 'Releasing stale reservations for FULFILLED/COMPLETED/CANCELLED orders' });

  // Check if inventory_reservations table exists
  const tableCheck = await client.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'inventory_reservations' LIMIT 1
  `);

  if (!tableCheck.rows.length) {
    log({ step: 2, skipped: true, reason: 'inventory_reservations table does not exist' });
    return { staleFound: 0, released: 0 };
  }

  // Find stale reservations — status='reserved' but order is in a terminal state
  const staleRes = await client.query(`
    SELECT ir.id, ir.order_id, ir.book_id, ir.location_id, ir.quantity, ir.status, o.status AS order_status
    FROM inventory_reservations ir
    JOIN orders o ON o.id = ir.order_id
    WHERE ir.status = 'reserved'
      AND o.status IN ('FULFILLED', 'COMPLETED', 'CANCELLED', 'Fulfilled', 'Completed', 'Cancelled')
    ORDER BY ir.order_id
  `);

  const staleFound = staleRes.rows.length;
  let released = 0;

  for (const row of staleRes.rows) {
    log({
      step: 2,
      stale_reservation: true,
      reservation_id: row.id,
      order_id: row.order_id,
      order_status: row.order_status,
      book_id: row.book_id,
      location_id: row.location_id,
      quantity: row.quantity,
      dry_run: DRY_RUN,
    });

    if (!DRY_RUN) {
      // For fulfilled/completed orders, mark as 'deducted'; for cancelled, mark as 'released'
      const newStatus = ['CANCELLED', 'Cancelled'].includes(row.order_status) ? 'released' : 'deducted';
      await client.query(
        `UPDATE inventory_reservations SET status = $1, updated_at = now() WHERE id = $2`,
        [newStatus, row.id],
      );
      released++;
    }
  }

  log({ step: 2, done: true, staleFound, released });
  return { staleFound, released };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log({ msg: 'Inventory reconciliation started', dry_run: DRY_RUN });

  const client = await pool.connect();
  try {
    if (!DRY_RUN) {
      await client.query('BEGIN');
    }

    const step1 = await reconcileQuantities(client);
    const step2 = await releaseStaleReservations(client);

    if (!DRY_RUN) {
      await client.query('COMMIT');
    }

    log({
      msg: 'Reconciliation complete',
      dry_run: DRY_RUN,
      summary: {
        inventory_rows_checked: step1.checked,
        quantity_mismatches_found: step1.mismatches,
        quantities_repaired: step1.repaired,
        stale_reservations_found: step2.staleFound,
        reservations_released: step2.released,
      },
    });

    process.exit(0);
  } catch (err) {
    if (!DRY_RUN) {
      await client.query('ROLLBACK');
    }
    log({ msg: 'Reconciliation failed', error: err.message });
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
