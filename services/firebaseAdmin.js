const admin = require('firebase-admin');

let initializedApp = null;
let initError = null;
let loggedInitError = false;

function normalizeMultilineSecret(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

function explicitServiceAccount() {
  const rawJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (rawJson) {
    const parsed = JSON.parse(rawJson);
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
};
