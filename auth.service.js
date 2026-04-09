/**
 * CoinDate — Authentication Service
 * ──────────────────────────────────
 * Handles:
 *   • Telegram login (via custom token from Cloud Function)
 *   • Google / Gmail OAuth
 *   • Profile creation on first login
 *   • Logout + cleanup
 */

import {
  signInWithPopup,
  GoogleAuthProvider,
  signInWithCustomToken,
  signOut,
  onAuthStateChanged,
  updateProfile,
  deleteUser,
} from "firebase/auth";
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  runTransaction,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { auth, db, functions } from "../config/firebase.js";

// ─── Providers ────────────────────────────────────────────────────────────────
const googleProvider = new GoogleAuthProvider();
googleProvider.addScope("email");
googleProvider.addScope("profile");
googleProvider.setCustomParameters({ prompt: "select_account" });

// ─── Google / Gmail Login ─────────────────────────────────────────────────────
export async function loginWithGoogle() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const user   = result.user;

    await ensureUserDocument(user, "gmail");
    return { success: true, user };
  } catch (error) {
    return handleAuthError(error);
  }
}

// ─── Telegram Login ───────────────────────────────────────────────────────────
// Flow:
//   1. Frontend opens Telegram OAuth widget → gets telegramData object
//   2. Send telegramData to Cloud Function `telegramAuth`
//   3. Function verifies hash, mints a Firebase custom token
//   4. Frontend signs in with that token
export async function loginWithTelegram(telegramData) {
  try {
    // Validate telegramData shape before sending
    const required = ["id", "first_name", "auth_date", "hash"];
    for (const field of required) {
      if (!telegramData[field]) throw new Error(`Missing Telegram field: ${field}`);
    }

    // Cloud Function mints a custom token after verifying Telegram hash
    const mintToken = httpsCallable(functions, "telegramAuth");
    const { data }  = await mintToken({ telegramData });

    if (!data.token) throw new Error("No custom token returned");

    const result = await signInWithCustomToken(auth, data.token);
    await ensureUserDocument(result.user, "telegram", telegramData);
    return { success: true, user: result.user };
  } catch (error) {
    return handleAuthError(error);
  }
}

// ─── Ensure User Document Exists ─────────────────────────────────────────────
// Called after every login. Creates the Firestore profile on first login only.
async function ensureUserDocument(firebaseUser, provider, telegramData = null) {
  const userRef  = doc(db, "users", firebaseUser.uid);
  const snapshot = await getDoc(userRef);

  if (!snapshot.exists()) {
    // First login — create profile skeleton
    const baseProfile = {
      uid:            firebaseUser.uid,
      email:          firebaseUser.email || null,
      displayName:    firebaseUser.displayName || telegramData?.first_name || "User",
      photoURL:       firebaseUser.photoURL || null,
      provider,                         // "gmail" | "telegram"
      profileComplete: false,           // set true after setup wizard
      coins:          100,              // welcome bonus
      coinsEarned:    0,                // lifetime earnings
      coinsSpent:     0,                // lifetime spend
      callRateVoice:  10,               // coins/min
      callRateVideo:  20,               // coins/min
      photoPrice:     50,
      videoPrice:     100,
      isActive:       true,
      isBanned:       false,
      isVerified:     false,            // live-camera verified
      setupStep:      1,
      intentions:     [],
      hobbies:        [],
      occupation:     "",
      bio:            "",
      age:            null,
      gender:         null,
      lookingFor:     null,
      photos:         [],               // Storage paths
      telegramId:     telegramData?.id?.toString() || null,
      telegramUsername: telegramData?.username || null,
      createdAt:      serverTimestamp(),
      updatedAt:      serverTimestamp(),
      lastActiveAt:   serverTimestamp(),
    };

    // Use a transaction to also initialize the wallet subcollection atomically
    await runTransaction(db, async (tx) => {
      tx.set(userRef, baseProfile);

      const walletRef = doc(db, "wallets", firebaseUser.uid);
      tx.set(walletRef, {
        uid:       firebaseUser.uid,
        balance:   100,                 // welcome coins
        currency:  "COIN",
        upiId:     null,
        upiVerified: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });

    // Record welcome bonus transaction
    await recordTransaction(firebaseUser.uid, {
      type:        "bonus",
      amount:      100,
      description: "Welcome bonus",
      counterpartyId: null,
    });

  } else {
    // Existing user — just update lastActiveAt
    await setDoc(userRef, { lastActiveAt: serverTimestamp() }, { merge: true });
  }
}

// ─── Logout ───────────────────────────────────────────────────────────────────
export async function logout() {
  try {
    const uid = auth.currentUser?.uid;
    if (uid) {
      await setDoc(doc(db, "users", uid), { lastActiveAt: serverTimestamp() }, { merge: true });
    }
    await signOut(auth);
    return { success: true };
  } catch (error) {
    return handleAuthError(error);
  }
}

// ─── Auth State Observer ──────────────────────────────────────────────────────
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, async (user) => {
    if (user) {
      // Fetch full Firestore profile (not just the Firebase Auth object)
      const snap = await getDoc(doc(db, "users", user.uid));
      callback(snap.exists() ? { ...user, profile: snap.data() } : user);
    } else {
      callback(null);
    }
  });
}

// ─── Record Transaction Helper (also used by Cloud Functions) ─────────────────
export async function recordTransaction(uid, { type, amount, description, counterpartyId }) {
  const txRef = doc(db, "wallets", uid, "transactions", crypto.randomUUID());
  await setDoc(txRef, {
    uid,
    type,           // "bonus" | "earn" | "spend" | "recharge" | "withdraw"
    amount,         // positive = credit, negative = debit
    description,
    counterpartyId: counterpartyId || null,
    timestamp:      serverTimestamp(),
  });
}

// ─── Error Handler ────────────────────────────────────────────────────────────
function handleAuthError(error) {
  const map = {
    "auth/popup-closed-by-user":   "Login cancelled.",
    "auth/network-request-failed": "Network error. Check connection.",
    "auth/user-disabled":          "This account has been banned.",
    "auth/invalid-custom-token":   "Authentication failed. Try again.",
  };
  const message = map[error.code] || error.message;
  console.error("[Auth]", error.code, error.message);
  return { success: false, error: message };
}
