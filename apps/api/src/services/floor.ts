/**
 * The two operations that move tools on and off the floor. Both the web API
 * and the RFID stations go through these, so the rules are identical whichever
 * way a tool is issued or returned.
 */
import type { TxSql } from '../db.js';
import { conflict, notFound } from '../lib/errors.js';

export type ReturnCondition = 'ok' | 'damaged' | 'needs_calibration';

export interface CheckoutRow {
  id: string;
  toolId: string;
  holderId: string;
  issuedBy: string;
  checkedOutAt: Date;
  dueBackAt: Date;
}

export async function checkOutTool(
  tx: TxSql,
  input: {
    tool: { id: string } | { assetTag: string };
    holderId: string;
    issuedBy: string;
    dueBackAt: Date;
    stationId?: string;
  },
): Promise<CheckoutRow & { assetTag: string }> {
  const [holder] = await tx<{ isActive: boolean; role: string }[]>`
    SELECT is_active, role FROM users WHERE id = ${input.holderId}`;
  if (!holder || !holder.isActive) throw notFound('Holder');
  if (holder.role === 'auditor') throw conflict('invalid_holder', 'Auditors cannot hold tools');

  // Lock the tool row so concurrent checkouts are serialized.
  const [tool] = await tx<{ id: string; assetTag: string; status: string; calibrationExpired: boolean }[]>`
    SELECT id, asset_tag, status,
           (requires_calibration AND calibration_due_on < current_date) AS calibration_expired
    FROM tools
    WHERE ${'id' in input.tool ? tx`id = ${input.tool.id}` : tx`asset_tag = ${input.tool.assetTag.toUpperCase()}`}
    FOR UPDATE`;
  if (!tool) throw notFound('Tool');
  if (tool.status !== 'available') {
    throw conflict('tool_unavailable', `Tool ${tool.assetTag} is not available (${tool.status})`);
  }
  if (tool.calibrationExpired) {
    throw conflict('calibration_expired', `Tool ${tool.assetTag} is past its calibration date and is locked`);
  }

  const [row] = await tx<CheckoutRow[]>`
    INSERT INTO checkouts (tool_id, holder_id, issued_by, due_back_at, issued_via_station_id)
    VALUES (${tool.id}, ${input.holderId}, ${input.issuedBy}, ${input.dueBackAt}, ${input.stationId ?? null})
    RETURNING id, tool_id, holder_id, issued_by, checked_out_at, due_back_at`;
  await tx`UPDATE tools SET status = 'checked_out' WHERE id = ${tool.id}`;
  return { ...row!, assetTag: tool.assetTag };
}

export async function returnCheckout(
  tx: TxSql,
  input: {
    checkoutId: string;
    receivedBy: string;
    condition: ReturnCondition;
    notes?: string | null;
    stationId?: string;
  },
) {
  const [row] = await tx<{ id: string; toolId: string }[]>`
    UPDATE checkouts
    SET returned_at = now(), received_by = ${input.receivedBy},
        condition_on_return = ${input.condition}, notes = ${input.notes ?? null},
        returned_via_station_id = ${input.stationId ?? null}
    WHERE id = ${input.checkoutId} AND returned_at IS NULL
    RETURNING id, tool_id, holder_id, checked_out_at, due_back_at, returned_at, condition_on_return`;
  if (!row) {
    const [exists] = await tx`SELECT 1 FROM checkouts WHERE id = ${input.checkoutId}`;
    if (exists) throw conflict('already_returned', 'This checkout was already returned');
    throw notFound('Checkout');
  }
  // Anything not returned in good condition is quarantined until inspected.
  await tx`
    UPDATE tools SET status = ${input.condition === 'ok' ? 'available' : 'quarantined'}::tool_status
    WHERE id = ${row.toolId}`;
  return row;
}
