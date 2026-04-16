const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

let initializedApp = null;
let initError = null;
let loggedInitError = false;

function normalizeMultilineSecret(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

function explicitServiceAccount() {
  const rawJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (rawJson) {
    let parsed;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      return null;
    }
    return {
      projectId: String(parsed.project_id || parsed.projectId || '').trim() || undefined,
      clientEmail: String(parsed.client_email || parsed.clientEmail || '').trim() || undefined,
      privateKey: normalizeMultilineSecret(parsed.private_key || parsed.privateKey || ''),
    };
  }

  const projectId = String(process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKey = normalizeMultilineSecret(process.env.FIREBASE_PRIVATE_KEY || '');
  if (projectId && clientEmail && privateKey) {
    return { projectId, clientEmail, privateKey };
  }

  return null;
}

function googleApplicationCredentialsPath() {
  const p = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  return p ? p : '';
}

function googleApplicationCredentialsExists() {
  const p = googleApplicationCredentialsPath();
  if (!p) return false;
  try {
    return fs.existsSync(path.resolve(p));
  } catch {
    return false;
  }
}

function privateKeyLooksValid(key) {
  const k = String(key || '');
  const pkcs8 = k.includes('BEGIN PRIVATE KEY') && k.includes('END PRIVATE KEY');
  const pkcs1 = k.includes('BEGIN RSA PRIVATE KEY') && k.includes('END RSA PRIVATE KEY');
  return pkcs8 || pkcs1;
}

/**
 * Validates env/credential shape before calling Admin SDK (no network calls).
 * Does not log secrets.
 * @returns {{ ok: true } | { ok: false, code: string, message: string, missing: string[], diagnostics: Record<string, unknown> }}
 */
function validateFirebaseAdminConfig() {
  const rawJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  const projectId = String(process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKey = normalizeMultilineSecret(process.env.FIREBASE_PRIVATE_KEY || '');
  const gac = googleApplicationCredentialsPath();
  const gacExists = googleApplicationCredentialsExists();

  const diagnostics = {
    hasFirebaseServiceAccountJson: Boolean(rawJson),
    hasFirebaseProjectId: Boolean(projectId),
    hasFirebaseClientEmail: Boolean(clientEmail),
    hasFirebasePrivateKey: Boolean(privateKey),
    hasGoogleApplicationCredentials: Boolean(gac),
    googleApplicationCredentialsExists: gacExists,
  };

  if (rawJson) {
    let parsed;
    try {
      parsed = JSON.parse(rawJson);
    } catch (err) {
      return {
        ok: false,
        code: 'firebase_service_account_json_invalid',
        message: 'FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON.',
        missing: [],
        diagnostics: { ...diagnostics, jsonError: String(err.message || err) },
      };
    }
    const pid = String(parsed.project_id || parsed.projectId || '').trim();
    const email = String(parsed.client_email || parsed.clientEmail || '').trim();
    const pk = normalizeMultilineSecret(parsed.private_key || parsed.privateKey || '');
    const missing = [];
    if (!pid) missing.push('project_id');
    if (!email) missing.push('client_email');
    if (!pk) missing.push('private_key');
    if (missing.length) {
      return {
        ok: false,
        code: 'firebase_service_account_json_incomplete',
        message: 'FIREBASE_SERVICE_ACCOUNT_JSON is missing required fields after parse.',
        missing,
        diagnostics: { ...diagnostics },
      };
    }
    if (!privateKeyLooksValid(pk)) {
      return {
        ok: false,
        code: 'firebase_private_key_malformed',
        message: 'Service account private_key in JSON does not look like a PEM private key.',
        missing: [],
        diagnostics: { ...diagnostics },
      };
    }
    return {
      ok: true,
      diagnostics: { ...diagnostics, credentialSource: 'FIREBASE_SERVICE_ACCOUNT_JSON' },
    };
  }

  const missing = [];
  if (!projectId) missing.push('FIREBASE_PROJECT_ID');
  if (!clientEmail) missing.push('FIREBASE_CLIENT_EMAIL');
  if (!privateKey) missing.push('FIREBASE_PRIVATE_KEY');

  if (missing.length) {
    if (gac && gacExists) {
      return { ok: true, diagnostics: { ...diagnostics, credentialSource: 'GOOGLE_APPLICATION_CREDENTIALS' } };
    }
    if (gac && !gacExists) {
      return {
        ok: false,
        code: 'google_application_credentials_missing',
        message:
          'GOOGLE_APPLICATION_CREDENTIALS is set but that path does not exist inside the container (or is unreadable). Fix the path or mount the JSON file.',
        missing: [...missing, 'GOOGLE_APPLICATION_CREDENTIALS'],
        diagnostics: { ...diagnostics, googleApplicationCredentialsPath: gac },
      };
    }
    return {
      ok: false,
      code: 'firebase_credentials_missing',
      message:
        'No usable Firebase Admin credentials found. Set FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY, or FIREBASE_SERVICE_ACCOUNT_JSON, or GOOGLE_APPLICATION_CREDENTIALS pointing to a service account JSON file.',
      missing,
      diagnostics: { ...diagnostics },
    };
  }

  if (!privateKeyLooksValid(privateKey)) {
    return {
      ok: false,
      code: 'firebase_private_key_malformed',
      message:
        'FIREBASE_PRIVATE_KEY does not look like a PEM private key (expected BEGIN PRIVATE KEY / END PRIVATE KEY). Check quoting and \\n escapes in .env.',
      missing: [],
      diagnostics: { ...diagnostics },
    };
  }

  return { ok: true, diagnostics: { ...diagnostics, credentialSource: 'FIREBASE_*_ENV' } };
}

function initializeFirebaseAdmin() {
  if (initializedApp) {
    return initializedApp;
  }
  if (initError) {
    throw initError;
  }

  try {
    initializedApp = admin.apps.length > 0 ? admin.app() : admin.initializeApp(buildOptions());
    return initializedApp;
  } catch (err) {
    initError = err;
    if (!loggedInitError) {
      loggedInitError = true;
      console.warn('Firebase Admin initialization skipped:', err.message || err);
    }
    throw err;
  }
}

function buildOptions() {
  const serviceAccount = explicitServiceAccount();
  if (!serviceAccount) {
    return {};
  }

  return {
    credential: admin.credential.cert(serviceAccount),
    ...(serviceAccount.projectId ? { projectId: serviceAccount.projectId } : {}),
  };
}

function getFirestore() {
  const app = initializeFirebaseAdmin();
  return app.firestore();
}

module.exports = {
  getFirestore,
  validateFirebaseAdminConfig,
  googleApplicationCredentialsPath,
};
