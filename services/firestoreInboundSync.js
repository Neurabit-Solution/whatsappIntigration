const admin = require('firebase-admin');
const crypto = require('crypto');
const { Timestamp } = require('firebase-admin/firestore');
const { getFirestore, validateFirebaseAdminConfig } = require('./firebaseAdmin');

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

function parseListEnv(value) {
  return String(value || '')
    .split(/[,;\s]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function getFirebaseSyncUids() {
  const combined = `${process.env.FIREBASE_SYNC_UIDS || ''} ${process.env.FIREBASE_SYNC_UID || ''}`;
  return parseListEnv(combined);
}

function getCampaignIdWhitelist() {
  const raw = String(process.env.FIREBASE_SYNC_CAMPAIGN_IDS || '').trim();
  if (!raw) return null;
  return parseListEnv(raw);
}

function getCampaignScanLimit() {
  const n = Number(process.env.FIREBASE_SYNC_CAMPAIGN_SCAN_LIMIT || 50);
  if (!Number.isFinite(n)) return 50;
  return Math.min(200, Math.max(1, Math.floor(n)));
}

function useCollectionGroupFallback() {
  const v = String(process.env.FIREBASE_USE_COLLECTION_GROUP || '')
    .trim()
    .toLowerCase();
  if (!v) return false;
  return v === '1' || v === 'true' || v === 'yes';
}

function summarizeFirestoreError(err) {
  if (!err) return null;
  const out = {
    message: String(err.message || err),
    code: err.code != null ? String(err.code) : null,
    details: err.details != null ? err.details : null,
  };
  if (err.metadata && typeof err.metadata.getMap === 'function') {
    try {
      out.metadata = err.metadata.getMap();
    } catch {
      /* ignore */
    }
  }
  return out;
}

function connectFirestoreOrError() {
  const cfg = validateFirebaseAdminConfig();
  if (!cfg.ok) {
    return {
      ok: false,
      result: {
        synced: false,
        reason: cfg.code,
        matchedCount: 0,
        credentials: {
          code: cfg.code,
          message: cfg.message,
          missing: cfg.missing,
          diagnostics: cfg.diagnostics,
        },
      },
    };
  }

  try {
    return { ok: true, db: getFirestore(), credentialsDiagnostics: cfg.diagnostics || null };
  } catch (err) {
    return {
      ok: false,
      result: {
        synced: false,
        reason: 'firebase_admin_init_failed',
        matchedCount: 0,
        credentials: {
          code: 'firebase_admin_init_failed',
          diagnostics: cfg.diagnostics || null,
        },
        error: summarizeFirestoreError(err),
      },
    };
  }
}

async function listCampaignDocsForUser(db, uid) {
  const campaignsCol = db.collection('users').doc(uid).collection('whatsappCampaigns');
  const whitelist = getCampaignIdWhitelist();
  if (whitelist && whitelist.length > 0) {
    const snaps = await Promise.all(whitelist.map((id) => campaignsCol.doc(id).get()));
    return snaps.filter((s) => s.exists);
  }
  const limit = getCampaignScanLimit();
  const snap = await campaignsCol.orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs;
}

/**
 * Resolves WhatsApp CRM conversation refs without collectionGroup when possible.
 * Collection-group queries can return FAILED_PRECONDITION if indexes / rules are not set up.
 */
async function resolveConversationRefsForPhone(db, phoneDigits) {
  const digits = normalizePhone(phoneDigits);
  const variants = new Set(phoneVariants(digits));
  const convDocId = conversationDocId(digits);
  const uids = getFirebaseSyncUids();

  const result = {
    refs: [],
    strategy: null,
    uidsConfigured: uids.length > 0,
    collectionGroupAttempted: false,
    collectionGroupError: null,
  };

  if (!digits) {
    result.strategy = 'missing_phone';
    return result;
  }

  if (uids.length > 0 && convDocId) {
    const refs = new Map();
    for (const uid of uids) {
      try {
        const campaignDocs = await listCampaignDocsForUser(db, uid);
        for (const cDoc of campaignDocs) {
          const convRef = cDoc.ref.collection('conversations').doc(convDocId);
          const convSnap = await convRef.get();
          if (!convSnap.exists) continue;
          const stored = normalizePhone(convSnap.get('phone'));
          if (!stored || variants.has(stored)) {
            refs.set(convRef.path, convRef);
          }
        }
      } catch (err) {
        result.pathScanError = summarizeFirestoreError(err);
        result.strategy = 'path_scan_failed';
        result.refs = [];
        return result;
      }
    }
    result.refs = [...refs.values()];
    result.strategy = 'user_campaign_path';
    if (result.refs.length > 0) {
      return result;
    }
  }

  if (!useCollectionGroupFallback()) {
    result.strategy = uids.length ? 'conversation_not_found' : 'missing_firebase_sync_uid';
    return result;
  }

  result.collectionGroupAttempted = true;
  const refs = new Map();
  try {
    for (const variant of phoneVariants(digits)) {
      const snap = await db.collectionGroup('conversations').where('phone', '==', variant).get();
      for (const doc of snap.docs) {
        refs.set(doc.ref.path, doc.ref);
      }
    }
    result.refs = [...refs.values()];
    result.strategy = 'collection_group';
  } catch (err) {
    result.collectionGroupError = summarizeFirestoreError(err);
    result.strategy = 'collection_group_failed';
    result.refs = [];
  }

  return result;
}

async function syncMessageStatusToFirestore(metaMessageId, status, options = {}) {
  const normalizedMetaMessageId = String(metaMessageId || '').trim();
  const normalizedStatus = String(status || '').trim();
  if (!normalizedMetaMessageId || !normalizedStatus) {
    return { synced: false, reason: 'missing_message_identity' };
  }

  const recipientDigits = normalizePhone(
    options.recipientPhone || options.recipientId || options.recipient_id || ''
  );

  const conn = connectFirestoreOrError();
  if (!conn.ok) {
    return conn.result;
  }
  const db = conn.db;
  const uids = getFirebaseSyncUids();

  if (uids.length > 0 && recipientDigits) {
    const resolved = await resolveConversationRefsForPhone(db, recipientDigits);
    const messageRefs = [];
    if (resolved.refs.length > 0) {
      for (const convRef of resolved.refs) {
        const snap = await convRef
          .collection('messages')
          .where('metaMessageId', '==', normalizedMetaMessageId)
          .limit(25)
          .get();
        for (const doc of snap.docs) {
          messageRefs.push(doc.ref);
        }
      }
    }

    if (messageRefs.length > 0) {
      const batch = db.batch();
      for (const ref of messageRefs) {
        batch.set(
          ref,
          {
            status: normalizedStatus,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
      await batch.commit();
      return {
        synced: true,
        matchedCount: messageRefs.length,
        strategy: 'user_campaign_messages_query',
        conversationStrategy: resolved.strategy,
      };
    }
  }

  if (!useCollectionGroupFallback()) {
    return {
      synced: false,
      reason: uids.length ? 'not_found' : 'missing_firebase_sync_uid',
      matchedCount: 0,
      hint:
        uids.length && !recipientDigits
          ? 'Status webhook is missing recipient phone; cannot resolve messages without collectionGroup.'
          : 'Set FIREBASE_SYNC_UID (Firebase Auth uid) and optionally FIREBASE_SYNC_CAMPAIGN_IDS, or set FIREBASE_USE_COLLECTION_GROUP=true after creating required Firestore indexes.',
    };
  }

  try {
    const matches = await db
      .collectionGroup('messages')
      .where('metaMessageId', '==', normalizedMetaMessageId)
      .get();

    if (matches.empty) {
      return { synced: false, reason: 'not_found', matchedCount: 0, strategy: 'collection_group' };
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

    return { synced: true, matchedCount: matches.size, strategy: 'collection_group' };
  } catch (err) {
    return {
      synced: false,
      reason: 'firestore_query_failed',
      matchedCount: 0,
      strategy: 'collection_group',
      error: summarizeFirestoreError(err),
    };
  }
}

async function syncInboundMessageToFirestore(message) {
  const digits = normalizePhone(message?.toPhone);
  if (!digits) {
    return { synced: false, reason: 'missing_phone' };
  }

  const conn = connectFirestoreOrError();
  if (!conn.ok) {
    return conn.result;
  }
  const db = conn.db;
  const resolved = await resolveConversationRefsForPhone(db, digits);
  const conversationRefs = resolved.refs;
  if (conversationRefs.length === 0) {
    if (resolved.collectionGroupError || resolved.pathScanError) {
      return {
        synced: false,
        reason: 'firestore_query_failed',
        matchedCount: 0,
        resolve: resolved,
      };
    }
    return {
      synced: false,
      reason: 'conversation_not_found',
      matchedCount: 0,
      resolve: resolved,
    };
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
