/**
 * CoinDate — Firebase Configuration
 * ─────────────────────────────────
 * WHAT WAS BROKEN:
 *   1. Only Analytics was initialized — Auth, Firestore, Storage, Functions were missing
 *   2. No persistence configured for offline support
 *   3. No environment separation (dev vs prod)
 *   4. Emulator support missing for local development
 */

import { initializeApp } from "firebase/app";
import { getAnalytics }  from "firebase/analytics";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  connectAuthEmulator,
} from "firebase/auth";
import {
  getFirestore,
  connectFirestoreEmulator,
  enableIndexedDbPersistence,
} from "firebase/firestore";
import {
  getStorage,
  connectStorageEmulator,
} from "firebase/storage";
import {
  getFunctions,
  connectFunctionsEmulator,
} from "firebase/functions";

// ─── Config ───────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyA37YlnE373wqjHfQAN6oDFa-XYRGC_mvo",
  authDomain:        "coin-date.firebaseapp.com",
  projectId:         "coin-date",
  storageBucket:     "coin-date.firebasestorage.app",
  messagingSenderId: "252730012634",
  appId:             "1:252730012634:web:969f252080e20e126346e3",
  measurementId:     "G-P6W5MJ38BQ",
};

// ─── Initialize Core App ──────────────────────────────────────────────────────
const app = initializeApp(firebaseConfig);

// ─── Services ─────────────────────────────────────────────────────────────────
export const analytics = getAnalytics(app);
export const auth      = getAuth(app);
export const db        = getFirestore(app);
export const storage   = getStorage(app);
export const functions = getFunctions(app, "asia-south1"); // Mumbai region — closest to Kerala

// ─── Auth Persistence (keep user logged in across refreshes) ─────────────────
setPersistence(auth, browserLocalPersistence).catch(console.error);

// ─── Offline Firestore Persistence ───────────────────────────────────────────
enableIndexedDbPersistence(db).catch((err) => {
  if (err.code === "failed-precondition") {
    console.warn("Firestore persistence: multiple tabs open");
  } else if (err.code === "unimplemented") {
    console.warn("Firestore persistence: browser not supported");
  }
});

// ─── Local Emulator Setup (development only) ─────────────────────────────────
if (import.meta.env?.DEV || process.env.NODE_ENV === "development") {
  const USE_EMULATORS = import.meta.env?.VITE_USE_EMULATORS === "true";
  if (USE_EMULATORS) {
    connectAuthEmulator(auth,      "http://localhost:9099",  { disableWarnings: true });
    connectFirestoreEmulator(db,   "localhost", 8080);
    connectStorageEmulator(storage,"localhost", 9199);
    connectFunctionsEmulator(functions, "localhost", 5001);
    console.info("🔧 Firebase Emulators connected");
  }
}

export default app;
