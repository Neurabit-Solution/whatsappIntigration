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

/** Same collection as `lightLeads/functions/whatsappcrm/upsertWhatsappInboundRouting.js` */
const WHATSAPP_CRM_INBOUND_ROUTING = 'whatsappCrmInboundRouting';

async function loadInboundRoutingDoc(db, mongoOrganizationId) {
  const id = String(mongoOrganizationId || '').trim();
  if (!id) return null;
  const snap = await db.collection(WHATSAPP_CRM_INBOUND_ROUTING).doc(id).get();
  if (!snap.exists) return null;
  return snap.data() || null;
}

function collectMongoOrganizationIdsForResolve(options = {}) {
  const ids = new Set();
  const single = options.mongoOrganizationId;
  if (single != null && String(single).trim()) {
    ids.add(String(single).trim());
  }
  const list = options.mongoOrganizationIds;
  if (Array.isArray(list)) {
    for (const x of list) {
      if (x != null && String(x).trim()) {
        ids.add(String(x).trim());
      }
    }
  }
  return [...ids];
}

/**
 * Prefer FIREBASE_SYNC_UID(s) from env; otherwise read routing doc written by Cloud Functions
 * when startWhatsAppCampaign / sendWhatsAppMessage runs (uses WHATSAPP_ORGANIZATION_ID).
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {string|string[]} mongoOrganizationIdOrIds
 */
async function resolveFirebaseUidsForInbound(db, mongoOrganizationIdOrIds) {
  const envUids = getFirebaseSyncUids();
  if (envUids.length > 0) {
    return { uids: envUids, source: 'env', routing: null };
  }
  const orgIds = Array.isArray(mongoOrganizationIdOrIds)
    ? mongoOrganizationIdOrIds.map((x) => String(x || '').trim()).filter(Boolean)
    : [String(mongoOrganizationIdOrIds || '').trim()].filter(Boolean);

  if (orgIds.length === 0) {
    return { uids: [], source: 'no_mongo_organization_id', routing: null, attemptedOrgIds: [] };
  }

  for (const orgId of orgIds) {
    const routing = await loadInboundRoutingDoc(db, orgId);
    if (routing && String(routing.firebaseUid || '').trim()) {
      return {
        uids: [String(routing.firebaseUid).trim()],
        source: 'firestore_routing',
        routing,
        routingOrgId: orgId,
      };
    }
  }
  return {
    uids: [],
    source: 'whatsapp_inbound_routing_missing',
    routing: null,
    attemptedOrgIds: orgIds,
  };
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

async function listCampaignDocsForUser(db, uid, routingDoc) {
  const campaignsCol = db.collection('users').doc(uid).collection('whatsappCampaigns');
  const byId = new Map();
  const preferredCampaignId = routingDoc && String(routingDoc.lastCampaignId || '').trim();
  if (preferredCampaignId) {
    const preferredSnap = await campaignsCol.doc(preferredCampaignId).get();
    if (preferredSnap.exists) {
      byId.set(preferredSnap.id, preferredSnap);
    }
  }

  const whitelist = getCampaignIdWhitelist();
  if (whitelist && whitelist.length > 0) {
    const snaps = await Promise.all(whitelist.map((id) => campaignsCol.doc(id).get()));
    for (const s of snaps) {
      if (s.exists) {
        byId.set(s.id, s);
      }
    }
    return [...byId.values()];
  }

  const limit = getCampaignScanLimit();
  const snap = await campaignsCol.orderBy('createdAt', 'desc').limit(limit).get();
  for (const d of snap.docs) {
    if (!byId.has(d.id)) {
      byId.set(d.id, d);
    }
  }
  return [...byId.values()];
}

/**
 * Resolves WhatsApp CRM conversation refs without collectionGroup when possible.
 * Collection-group queries can return FAILED_PRECONDITION if indexes / rules are not set up.
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {string} phoneDigits
 * @param {{ mongoOrganizationId?: string }} [options]
 */
async function resolveConversationRefsForPhone(db, phoneDigits, options = {}) {
  const digits = normalizePhone(phoneDigits);
  const variants = new Set(phoneVariants(digits));
  const convDocId = conversationDocId(digits);
  const mongoOrgIds = collectMongoOrganizationIdsForResolve(options);

  const uidResolution = await resolveFirebaseUidsForInbound(db, mongoOrgIds);
  const uids = uidResolution.uids;

  const result = {
    refs: [],
    strategy: null,
    uidSource: uidResolution.source,
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
        const campaignDocs = await listCampaignDocsForUser(db, uid, uidResolution.routing);
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
    if (uids.length === 0) {
      if (uidResolution.source === 'no_mongo_organization_id') {
        result.strategy = 'missing_mongo_organization_id';
      } else if (uidResolution.source === 'whatsapp_inbound_routing_missing') {
        result.strategy = 'whatsapp_inbound_routing_missing';
      } else {
        result.strategy = 'missing_firebase_sync_uid';
      }
    } else {
      result.strategy = 'conversation_not_found';
    }
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

  let resolved = null;
  if (recipientDigits) {
    resolved = await resolveConversationRefsForPhone(db, recipientDigits, {
      mongoOrganizationId: options.mongoOrganizationId,
      mongoOrganizationIds: options.mongoOrganizationIds,
    });
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
    const hasUid =
      resolved &&
      (resolved.uidSource === 'env' ||
        resolved.uidSource === 'firestore_routing' ||
        resolved.uidsConfigured);
    return {
      synced: false,
      reason: !recipientDigits
        ? 'missing_recipient_phone'
        : hasUid
          ? 'not_found'
          : 'missing_firebase_uid_for_org',
      matchedCount: 0,
      resolve: resolved,
      hint: !recipientDigits
        ? 'Meta status payload did not include recipient_id; cannot match messages without collectionGroup.'
        : resolved?.uidSource === 'whatsapp_inbound_routing_missing'
          ? 'Deploy LightLeads functions so startWhatsAppCampaign writes whatsappCrmInboundRouting/{WHATSAPP_ORGANIZATION_ID}, set FIREBASE_ROUTING_ORGANIZATION_IDS to extra Mongo org ids, or set FIREBASE_SYNC_UID on the WhatsApp server.'
          : 'Set FIREBASE_SYNC_UID or FIREBASE_USE_COLLECTION_GROUP=true after indexes exist.',
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
  const resolved = await resolveConversationRefsForPhone(db, digits, {
    mongoOrganizationId: message.organizationId,
    mongoOrganizationIds: message.mongoOrganizationIds,
  });
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
    const uidMissingStrategies = new Set([
      'missing_firebase_sync_uid',
      'whatsapp_inbound_routing_missing',
      'missing_mongo_organization_id',
    ]);
    if (uidMissingStrategies.has(resolved.strategy)) {
      return {
        synced: false,
        reason: resolved.strategy,
        matchedCount: 0,
        hint:
          resolved.strategy === 'whatsapp_inbound_routing_missing'
            ? 'LightLeads must write Firestore doc whatsappCrmInboundRouting/{mongoOrgId} when startWhatsAppCampaign runs (uses WHATSAPP_ORGANIZATION_ID). If webhook org id differs, set FIREBASE_ROUTING_ORGANIZATION_IDS, deploy updated functions, or set FIREBASE_SYNC_UID on the WhatsApp server.'
            : 'Set FIREBASE_SYNC_UID to the LightLeads Firebase Auth uid, or ensure routing doc / organizationId is present.',
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
