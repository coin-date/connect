/**
 * CoinDate — Frontend API Service
 * ─────────────────────────────────
 * Clean wrappers around every Cloud Function and Firestore query
 * the frontend needs. Import from here, never call Firebase directly
 * from UI components.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  updateDoc,
  addDoc,
  serverTimestamp,
} from "firebase/firestore";
import { ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import { httpsCallable } from "firebase/functions";
import { db, storage, functions, auth } from "../config/firebase.js";

// ── Callables ─────────────────────────────────────────────────────────────────
const fnSwipe          = httpsCallable(functions, "onSwipe");
const fnInitiateCall   = httpsCallable(functions, "initiateCall");
const fnEndCall        = httpsCallable(functions, "endCall");
const fnPurchaseMedia  = httpsCallable(functions, "purchaseMedia");
const fnSendCoins      = httpsCallable(functions, "sendCoins");
const fnRecharge       = httpsCallable(functions, "initiateUpiRecharge");
const fnWithdraw       = httpsCallable(functions, "initiateWithdraw");
const fnSignedUrl      = httpsCallable(functions, "getSignedMediaUrl");


// ═══════════════════════════════════════════════════════════════════════
// PROFILE
// ═══════════════════════════════════════════════════════════════════════

export async function updateProfile(fields) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("Not authenticated");

  const allowed = [
    "displayName","bio","occupation","age","gender","lookingFor",
    "intentions","hobbies","callRateVoice","callRateVideo",
    "photoPrice","videoPrice","profileComplete","setupStep",
  ];

  const safe = Object.fromEntries(
    Object.entries(fields).filter(([k]) => allowed.includes(k))
  );

  safe.updatedAt = serverTimestamp();
  await updateDoc(doc(db, "users", uid), safe);
}

export async function getProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

// Listen to own profile in real-time (coin balance updates, etc.)
export function listenToMyProfile(callback) {
  const uid = auth.currentUser?.uid;
  if (!uid) return () => {};
  return onSnapshot(doc(db, "users", uid), (snap) => {
    callback(snap.exists() ? snap.data() : null);
  });
}


// ═══════════════════════════════════════════════════════════════════════
// DISCOVER / SWIPE
// ═══════════════════════════════════════════════════════════════════════

// Fetch the next page of potential matches.
// Excludes: self, already-swiped users, banned users.
// NOTE: "exclude already swiped" at scale should be done with a
//       Cloud Function that pre-builds a candidate pool. For MVP,
//       client-side filtering is acceptable.
export async function fetchDiscoverProfiles(lastDoc = null) {
  const uid = auth.currentUser?.uid;
  const me  = await getProfile(uid);

  let q = query(
    collection(db, "users"),
    where("profileComplete", "==", true),
    where("isActive",        "==", true),
    where("isBanned",        "==", false),
    where("gender",          "==", me.lookingFor === "any" ? me.lookingFor : me.lookingFor),
    orderBy("lastActiveAt", "desc"),
    limit(20)
  );

  if (lastDoc) q = query(q, startAfter(lastDoc));

  const snap = await getDocs(q);
  const profiles = snap.docs
    .map((d) => ({ id: d.id, ...d.data(), _snap: d }))
    .filter((p) => p.uid !== uid);            // exclude self

  return { profiles, lastDoc: snap.docs[snap.docs.length - 1] };
}

export async function swipe(targetUid, decision) {
  const { data } = await fnSwipe({ targetUid, decision });
  return data; // { matched: bool, matchId?: string }
}


// ═══════════════════════════════════════════════════════════════════════
// MATCHES & MESSAGES
// ═══════════════════════════════════════════════════════════════════════

export function listenToMatches(callback) {
  const uid = auth.currentUser?.uid;
  const q = query(
    collection(db, "matches"),
    where("users", "array-contains", uid),
    where("active", "==", true),
    orderBy("lastMessageAt", "desc"),
    limit(50)
  );
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export function listenToMessages(matchId, callback) {
  const q = query(
    collection(db, "matches", matchId, "messages"),
    orderBy("timestamp", "asc"),
    limit(100)
  );
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export async function sendMessage(matchId, text) {
  const uid = auth.currentUser?.uid;
  const msgRef = collection(db, "matches", matchId, "messages");

  await addDoc(msgRef, {
    senderId:  uid,
    type:      "text",
    text:      text.trim().slice(0, 1000),
    read:      false,
    timestamp: serverTimestamp(),
  });

  // Update match preview (denormalized)
  await updateDoc(doc(db, "matches", matchId), {
    lastMessage:   text.slice(0, 60),
    lastMessageAt: serverTimestamp(),
    lastMessageBy: uid,
  });
}

export async function requestMedia(matchId, receiverId, type, price) {
  const uid    = auth.currentUser?.uid;
  const mediaRef = await addDoc(collection(db, "media"), {
    ownerId:     receiverId,
    requesterId: uid,
    matchId,
    type,                        // "photo" | "video"
    price,
    storagePath: null,
    url:         null,
    status:      "pending",
    ownerEarns:  0,
    appEarns:    0,
    createdAt:   serverTimestamp(),
  });

  // Send a message in the chat about this request
  await addDoc(collection(db, "matches", matchId, "messages"), {
    senderId:  uid,
    type:      "mediaRequest",
    text:      null,
    mediaId:   mediaRef.id,
    read:      false,
    timestamp: serverTimestamp(),
  });

  return mediaRef.id;
}

export async function purchaseMedia(mediaId) {
  const { data } = await fnPurchaseMedia({ mediaId });
  return data;  // { success, url }
}

export async function getMediaUrl(mediaId) {
  const { data } = await fnSignedUrl({ mediaId });
  return data.url;
}


// ═══════════════════════════════════════════════════════════════════════
// CALLS
// ═══════════════════════════════════════════════════════════════════════

export async function initiateCall(receiverId, matchId, callType) {
  const { data } = await fnInitiateCall({ receiverId, matchId, callType });
  return data;  // { callId, ratePerMin }
}

export async function endCall(callId, durationSeconds) {
  const { data } = await fnEndCall({ callId, durationSeconds });
  return data;  // { success, totalCoins, receiverEarns }
}


// ═══════════════════════════════════════════════════════════════════════
// WALLET
// ═══════════════════════════════════════════════════════════════════════

export function listenToWallet(callback) {
  const uid = auth.currentUser?.uid;
  return onSnapshot(doc(db, "wallets", uid), (snap) => {
    callback(snap.exists() ? snap.data() : null);
  });
}

export function listenToTransactions(callback, pageSize = 20) {
  const uid = auth.currentUser?.uid;
  const q = query(
    collection(db, "wallets", uid, "transactions"),
    orderBy("timestamp", "desc"),
    limit(pageSize)
  );
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export async function sendCoins(receiverId, amount, matchId) {
  const { data } = await fnSendCoins({ receiverId, amount, matchId });
  return data;
}

export async function rechargeCoins(coinsPackage, upiId) {
  const { data } = await fnRecharge({ coinsPackage, upiId });
  return data;  // { txId, amountINR, coins }
  // → then open Razorpay checkout with the returned orderId
}

export async function withdrawCoins(coins, upiId) {
  const { data } = await fnWithdraw({ coins, upiId });
  return data;
}


// ═══════════════════════════════════════════════════════════════════════
// PHOTO UPLOAD (profile photos)
// ═══════════════════════════════════════════════════════════════════════

// Returns a promise that resolves to the download URL.
// onProgress(percent) is called during upload.
export function uploadProfilePhoto(file, onProgress) {
  const uid  = auth.currentUser?.uid;
  const ext  = file.name.split(".").pop();
  const path = `profilePhotos/${uid}/${Date.now()}.${ext}`;
  const ref_ = ref(storage, path);

  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(ref_, file, {
      contentType: file.type,
    });

    task.on(
      "state_changed",
      (snap) => onProgress?.(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
      reject,
      async () => {
        const url = await getDownloadURL(task.snapshot.ref);
        // Update Firestore profile
        await updateDoc(doc(db, "users", uid), {
          photoURL:  url,
          updatedAt: serverTimestamp(),
        });
        resolve(url);
      }
    );
  });
}

// Upload paid media (photo/video that will be sold)
export function uploadPaidMedia(file, mediaId, onProgress) {
  const uid  = auth.currentUser?.uid;
  const ext  = file.name.split(".").pop();
  const path = `paidMedia/${uid}/${mediaId}.${ext}`;
  const ref_ = ref(storage, path);

  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(ref_, file, { contentType: file.type });
    task.on(
      "state_changed",
      (snap) => onProgress?.(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
      reject,
      async () => {
        // Update the media doc with the storage path
        await updateDoc(doc(db, "media", mediaId), { storagePath: path });
        resolve(path);
      }
    );
  });
}


// ═══════════════════════════════════════════════════════════════════════
// REPORTING
// ═══════════════════════════════════════════════════════════════════════

export async function reportUser(reportedId, reason) {
  const uid = auth.currentUser?.uid;
  await addDoc(collection(db, "reports"), {
    reporterId: uid,
    reportedId,
    reason:     reason.slice(0, 500),
    status:     "open",
    createdAt:  serverTimestamp(),
  });
}


// ═══════════════════════════════════════════════════════════════════════
// ONLINE PRESENCE (Realtime Database)
// ═══════════════════════════════════════════════════════════════════════
// Separate import needed — add to firebase.js:
// export const rtdb = getDatabase(app);

import { getDatabase, ref as rtRef, set, onValue, onDisconnect, serverTimestamp as rtServerTimestamp } from "firebase/database";
import { getApp } from "firebase/app";

export function initPresence() {
  const uid  = auth.currentUser?.uid;
  if (!uid) return;

  const rtdb        = getDatabase(getApp());
  const presenceRef = rtRef(rtdb, `/presence/${uid}`);
  const connRef     = rtRef(rtdb, ".info/connected");

  onValue(connRef, (snap) => {
    if (snap.val() === false) return;

    // When disconnected, set offline
    onDisconnect(presenceRef).set({ online: false, lastSeen: rtServerTimestamp() });

    // When connected, set online
    set(presenceRef, { online: true, lastSeen: rtServerTimestamp() });
  });
}

export function listenToPresence(uid, callback) {
  const rtdb        = getDatabase(getApp());
  const presenceRef = rtRef(rtdb, `/presence/${uid}`);
  return onValue(presenceRef, (snap) => callback(snap.val()));
}
