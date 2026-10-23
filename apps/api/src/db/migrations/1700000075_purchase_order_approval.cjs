'use strict';

// How and when a purchase order was approved (#164, owner decisions 1a, 2a).
//
// An order records who approved it, but not when or how: on submit, under the
// approval threshold (automatic); by an Admin or Manager other than its
// creator (approver); or by its creator as the branch's only approver, with a
// reason (sole_approver, the way out for a shop with one approver).
//
// Orders approved before this migration take their kind and date from the
// audit log (a submit that approved, or an approve), else from who approved
// them: the creator approved on submit, anyone else as approver. The down
// migration drops the columns.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE purchase_orders
      ADD COLUMN approved_at timestamptz,
      ADD COLUMN approval_kind text CHECK (approval_kind IN ('automatic', 'approver', 'sole_approver')),
      ADD COLUMN approval_reason text,
      ADD CONSTRAINT purchase_orders_sole_approval_reason CHECK (approval_kind IS DISTINCT FROM 'sole_approver' OR approval_reason IS NOT NULL)
  `);

  pgm.sql(`
    UPDATE purchase_orders po
       SET approval_kind = COALESCE(a.kind, CASE WHEN po.approved_by = po.created_by THEN 'automatic' ELSE 'approver' END),
           approved_at = COALESCE(a.at, po.updated_at)
      FROM (
        SELECT p.id, last.kind, last.at
        FROM purchase_orders p
        LEFT JOIN LATERAL (
          SELECT CASE WHEN l.meta->>'action' = 'approve' THEN 'approver' ELSE 'automatic' END AS kind, l.created_at AS at
          FROM audit_logs l
          WHERE l.tenant_id = p.tenant_id AND l.entity_type = 'purchase_order' AND l.entity_id = p.id::text
            AND (l.meta->>'action' = 'approve' OR (l.meta->>'action' = 'submit_for_approval' AND l.meta->>'newStatus' = 'approved'))
          ORDER BY l.created_at DESC, l.id DESC
          LIMIT 1
        ) last ON true
        WHERE p.approved_by IS NOT NULL AND p.approval_kind IS NULL
      ) a
     WHERE po.id = a.id
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE purchase_orders
      DROP CONSTRAINT purchase_orders_sole_approval_reason,
      DROP COLUMN approval_reason,
      DROP COLUMN approval_kind,
      DROP COLUMN approved_at
  `);
};
