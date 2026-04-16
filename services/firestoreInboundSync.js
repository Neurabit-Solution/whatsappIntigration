const admin = require('firebase-admin');
const crypto = require('crypto');
const { Timestamp } = require('firebase-admin/firestore');
const { getFirestore } = require('./firebaseAdmin');

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function conversationDocId(digits) {
  const normalized = normalizePhone(digits);
  if (!normalized) return '';
  return normalized.length > 10 ? normalized.slice(-10) : normalized;
}

function phoneVariants(value) {
  const digits = normalizePhone(value);
  if (!digits) return [];

  const variants = new Set([digits, conversationDocId(digits)]);
  if (digits.length === 10) {
    variants.add(`91${digits}`);
    variants.add(`0${digits}`);
  }

  return [...variants].filter(Boolean);
}

function firestoreMessageKind(messageType) {
  const type = String(messageType || '').trim().toLowerCase();
  return type === 'text' ? 'text' : `whatsapp_${type || 'unsupported'}`;
}

function messageDocId(metaMessageId) {
  const value = String(metaMessageId || '').trim();
  if (!value) return null;
  return `meta_${crypto.createHash('sha1').update(value).digest('hex')}`;
}

function timestampToMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

async function getMatchingConversationRefs(db, phone) {
  const refs = new Map();
  const digits = normalizePhone(phone);
  const variants = phoneVariants(digits);
  if (variants.length === 0) {
    return [];
  }
  // NOTE:
  // For collectionGroup queries, FieldPath.documentId() requires a full document path.
  // Querying with only "7524807719" throws:
  // "value must result in a valid document path".
  // So we query by phone variants only and dedupe by full ref path.
  for (const variant of variants) {
    const snap = await db.collectionGroup('conversations').where('phone', '==', variant).get();
    for (const doc of snap.docs) {
      refs.set(doc.ref.path, doc.ref);
    }
  }

  return [...refs.values()];
}

async function syncMessageStatusToFirestore(metaMessageId, status) {
  const normalizedMetaMessageId = String(metaMessageId || '').trim();
  const normalizedStatus = String(status || '').trim();
  if (!normalizedMetaMessageId || !normalizedStatus) {
    return { synced: false, reason: 'missing_message_identity' };
  }

  const db = getFirestore();
  const matches = await db
    .collectionGroup('messages')
    .where('metaMessageId', '==', normalizedMetaMessageId)
    .get();

  if (matches.empty) {
    return { synced: false, reason: 'not_found', matchedCount: 0 };
  }

  const batch = db.batch();
  for (const doc of matches.docs) {
    batch.set(
      doc.ref,
      {
        status: normalizedStatus,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }
  await batch.commit();

  return { synced: true, matchedCount: matches.size };
}

async function syncInboundMessageToFirestore(message) {
  const digits = normalizePhone(message?.toPhone);
  if (!digits) {
    return { synced: false, reason: 'missing_phone' };
  }

  const db = getFirestore();
  const conversationRefs = await getMatchingConversationRefs(db, digits);
  if (conversationRefs.length === 0) {
    return { synced: false, reason: 'conversation_not_found', matchedCount: 0 };
  }

  const sentAtDate = message?.sentAt instanceof Date ? message.sentAt : new Date(message?.sentAt || Date.now());
  const eventTimestamp = Timestamp.fromDate(sentAtDate);
  const preview = String(message?.message || '').trim().slice(0, 280) || '[message]';
  const stableMessageId = messageDocId(message?.metaMessageId);

  for (const conversationRef of conversationRefs) {
    const messagesRef = conversationRef.collection('messages');
    const inboundMessageRef = stableMessageId ? messagesRef.doc(stableMessageId) : messagesRef.doc();

    await db.runTransaction(async (tx) => {
      const conversationSnap = await tx.get(conversationRef);
      const existingLastMessageMs = timestampToMillis(conversationSnap.get('lastMessageAt'));
      const incomingMessageMs = sentAtDate.getTime();

      tx.set(
        inboundMessageRef,
        {
          direction: 'inbound',
          messageKind: firestoreMessageKind(message?.messageType),
          text: String(message?.message || ''),
          status: String(message?.status || 'received'),
          metaMessageId: String(message?.metaMessageId || '').trim() || null,
          inReplyToMetaMessageId: String(message?.inReplyToMetaMessageId || '').trim() || null,
          customerName: String(message?.customerName || '').trim() || null,
          phone: digits,
          createdAt: eventTimestamp,
          sentAt: eventTimestamp,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          rawWebhookMessage: message?.rawWebhookMessage || null,
        },
        { merge: true }
      );

      const conversationPatch = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      const normalizedCustomerName = String(message?.customerName || '').trim();
      if (normalizedCustomerName) {
        conversationPatch.customerName = normalizedCustomerName;
      }
      if (existingLastMessageMs === null || incomingMessageMs >= existingLastMessageMs) {
        conversationPatch.lastMessageAt = eventTimestamp;
        conversationPatch.lastMessagePreview = preview;
      }

      tx.set(conversationRef, conversationPatch, { merge: true });
    });
  }

  return { synced: true, matchedCount: conversationRefs.length };
}

module.exports = {
  syncInboundMessageToFirestore,
  syncMessageStatusToFirestore,
};
