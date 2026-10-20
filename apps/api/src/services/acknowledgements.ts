/**
 * "Did you get it?" When crib staff issue something to someone else (a tool, a
 * kit, PPE or consumables), that person confirms it in the app or with the
 * single-use link in their email, or says they didn't receive it.
 */
import type { Sql, TxSql } from '../db.js';
import { hashToken, newToken } from '../lib/crypto.js';
import type { Notifier } from './notify.js';

export type AckSubject = 'checkout' | 'stock_issue' | 'kit_issue';
export type AckAnswer = 'received' | 'not_received';

export async function requestAcknowledgement(
  tx: TxSql,
  notifier: Notifier,
  a: { subjectType: AckSubject; subjectId: string; userId: string; requestedBy: { id: string; displayName: string }; summary: string; facts?: [string, string][] },
) {
  const token = newToken();
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO acknowledgements (subject_type, subject_id, user_id, requested_by, summary, token_hash)
    VALUES (${a.subjectType}, ${a.subjectId}, ${a.userId}, ${a.requestedBy.id}, ${a.summary.slice(0, 200)}, ${hashToken(token)})
    RETURNING id`;
  await notifier.send(tx, [a.userId], {
    kind: 'issue.confirm',
    title: `${a.requestedBy.displayName} issued you ${a.summary}`,
    body: 'Please confirm you received it, or say if you did not.',
    link: '/',
    dedupe: `ack:${row!.id}`,
    email: {
      lines: [`${a.requestedBy.displayName} issued you ${a.summary}.`, 'Please confirm you have it. If you did not get it, say so, and the crib will look into it.'],
      facts: a.facts,
      url: notifier.url(`/ack#token=${token}`),
      action: 'Confirm, or report a problem',
    },
  });
  return row!.id;
}

/** Records the answer and, if it was "not received", tells whoever issued it and the crib. */
export async function answerAcknowledgement(
  tx: Sql | TxSql,
  notifier: Notifier,
  ack: { id: string; userId: string; requestedBy: string; summary: string; subjectType: AckSubject; subjectId: string },
  answer: AckAnswer,
  note: string | undefined,
  via: 'app' | 'email',
) {
  const status = answer === 'received' ? 'acknowledged' : 'disputed';
  await tx`
    UPDATE acknowledgements SET status = ${status}, token_hash = NULL, responded_at = now(), responded_via = ${via},
           note = ${note || null}
    WHERE id = ${ack.id} AND status = 'pending'`;
  if (status === 'disputed') {
    const [who] = await tx<{ displayName: string }[]>`SELECT display_name FROM users WHERE id = ${ack.userId}`;
    const link = await subjectLink(tx, ack.subjectType, ack.subjectId);
    await notifier.send(tx, [ack.requestedBy, ...(await notifier.staff(tx, [ack.userId]))], {
      kind: 'issue.disputed',
      title: `${who?.displayName ?? 'Someone'} says they did not receive ${ack.summary}`,
      body: note ? `Their note: “${note}”` : 'Check what happened at the crib.',
      link,
      dedupe: `disputed:${ack.id}`,
    });
  }
  return status;
}

export async function subjectLink(tx: Sql | TxSql, type: AckSubject, id: string): Promise<string> {
  if (type === 'checkout') {
    const [c] = await tx<{ toolId: string }[]>`SELECT tool_id FROM checkouts WHERE id = ${id}`;
    return c ? `/tools/${c.toolId}` : '/checkouts';
  }
  if (type === 'kit_issue') {
    const [k] = await tx<{ kitId: string }[]>`SELECT kit_id FROM kit_issues WHERE id = ${id}`;
    return k ? `/kits/${k.kitId}` : '/kits';
  }
  const [m] = await tx<{ itemId: string }[]>`SELECT item_id FROM stock_movements WHERE id = ${id}`;
  return m ? `/stock?item=${m.itemId}` : '/stock';
}
