/**
 * Mirrors lightLeads/functions/whatsappcrm/conversationCrm.js for webhook-side updates.
 */

const VALID = new Set(['pending', 'failed', 'sent', 'seen', 'replied', 'converted']);

const RANK = {
  pending: 0,
  failed: -1,
  sent: 1,
  seen: 2,
  replied: 3,
  converted: 4,
};

function normalizeConversationCrmStage(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (VALID.has(s)) return s;
  return 'sent';
}

function crmStageRank(stage) {
  return RANK[stage] ?? 0;
}

function nextStageFromReadReceipt(current) {
  const c = normalizeConversationCrmStage(current);
  if (c === 'converted' || c === 'failed' || c === 'replied') return c;
  if (crmStageRank(c) >= crmStageRank('seen')) return c;
  return 'seen';
}

function nextStageFromInbound(current) {
  const c = normalizeConversationCrmStage(current);
  if (c === 'converted' || c === 'failed') return c;
  if (crmStageRank(c) >= crmStageRank('replied')) return c;
  return 'replied';
}

function crmSummaryIncrements(FieldValue, oldStage, newStage) {
  if (oldStage === newStage) return {};
  const patch = {};
  patch[`crmSummary.${oldStage}`] = FieldValue.increment(-1);
  patch[`crmSummary.${newStage}`] = FieldValue.increment(1);
  return patch;
}

function bootstrapCrmSummaryForStage(newStage) {
  const base = { pending: 0, failed: 0, sent: 0, seen: 0, replied: 0, converted: 0 };
  base[newStage] = 1;
  return base;
}

/**
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {import('firebase-admin').firestore.DocumentReference} conversationRef
 * @param {'read'|'inbound'} reason
 * @param {typeof import('firebase-admin').firestore.FieldValue} FieldValue
 */
async function applyConversationCrmTransition(db, conversationRef, reason, FieldValue) {
  const nextFn = reason === 'read' ? nextStageFromReadReceipt : nextStageFromInbound;

  await db.runTransaction(async (tx) => {
    const convSnap = await tx.get(conversationRef);
    if (!convSnap.exists) return;

    const campRef = conversationRef.parent.parent;
    if (!campRef || campRef.id === '') return;

    const campSnap = await tx.get(campRef);
    if (!campSnap.exists) return;

    const oldStage = normalizeConversationCrmStage(convSnap.get('crmStage'));
    const newStage = nextFn(oldStage);
    if (oldStage === newStage) return;

    const hadSummary =
      campSnap.get('crmSummary') != null && typeof campSnap.get('crmSummary') === 'object';

    const convPatch = {
      crmStage: newStage,
      crmStageUpdatedAt: FieldValue.serverTimestamp(),
    };
    if (newStage === 'seen') {
      convPatch.crmSeenAt = FieldValue.serverTimestamp();
    }
    if (newStage === 'replied') {
      convPatch.crmRepliedAt = FieldValue.serverTimestamp();
    }

    tx.set(conversationRef, convPatch, { merge: true });

    if (!hadSummary) {
      const legacyPatch = {};
      if (newStage === 'seen') legacyPatch.read = FieldValue.increment(1);
      if (newStage === 'replied') legacyPatch.replied = FieldValue.increment(1);
      tx.set(
        campRef,
        {
          crmSummary: bootstrapCrmSummaryForStage(newStage),
          ...legacyPatch,
        },
        { merge: true }
      );
      return;
    }

    const summaryPatch = crmSummaryIncrements(FieldValue, oldStage, newStage);
    const legacyPatch = {};
    if (newStage === 'seen') {
      legacyPatch.read = FieldValue.increment(1);
    }
    if (newStage === 'replied') {
      legacyPatch.replied = FieldValue.increment(1);
    }
    tx.set(campRef, { ...summaryPatch, ...legacyPatch }, { merge: true });
  });
}

module.exports = {
  normalizeConversationCrmStage,
  nextStageFromReadReceipt,
  nextStageFromInbound,
  crmSummaryIncrements,
  bootstrapCrmSummaryForStage,
  applyConversationCrmTransition,
};
