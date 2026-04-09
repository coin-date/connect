/**
 * CoinDate — Cloud Functions
 * ══════════════════════════
 * Region: asia-south1 (Mumbai) — closest to Kerala/India
 *
 * Functions:
 *   1.  telegramAuth         — verify Telegram OAuth, mint custom token
 *   2.  onSwipe              — detect mutual likes, create matches
 *   3.  initiateCall         — deduct caller's coins, create call doc
 *   4.  endCall              — finalize billing, credit receiver 60%
 *   5.  purchaseMedia        — transfer coins for photo/video
 *   6.  sendCoins            — peer-to-peer coin transfer
 *   7.  initiateUpiRecharge  — create UPI order via gateway
 *   8.  upiWebhook           — handle gateway callback, credit coins
 *   9.  initiateWithdraw     — validate + queue UPI payout
 *   10. getSignedMediaUrl    — serve paid media via signed Storage URL
 *   11. onUserBanned         — cleanup when admin bans a user
 */

const functions  = require("firebase-functions");
const admin      = require("firebase-admin");
const crypto     = require("crypto");
const { v4: uuid } = require("uuid");

admin.initializeApp();

const db      = admin.firestore();
const auth    = admin.auth();
const storage = admin.storage();

// ── Region shorthand ──────────────────────────────────────────────────────────
const region = functions.region("asia-south1");

// ── Constants ─────────────────────────────────────────────────────────────────
const APP_CUT        = 0.40;   // 40% platform fee
const USER_CUT       = 0.60;   // 60% to the earning user
const COIN_TO_INR    = 0.60;   // 1 coin = ₹0.60
const INR_TO_COIN    = 1 / COIN_TO_INR;  // ₹1 = ~1.67 coins

// ─────────────────────────────────────────────────────────────────────────────
// 1. TELEGRAM AUTH
//    Verifies Telegram's HMAC hash and mints a Firebase custom token.
// ─────────────────────────────────────────────────────────────────────────────
exports.telegramAuth = region.https.onCall(async (data, context) => {
  const { telegramData } = data;

  if (!telegramData || !telegramData.hash) {
    throw new functions.https.HttpsError("invalid-argument", "Missing Telegram data");
  }

  // Verify Telegram hash
  const BOT_TOKEN = functions.config().telegram.bot_token;
  const secretKey = crypto.createHash("sha256").update(BOT_TOKEN).digest();

  const checkString = Object.keys(telegramData)
    .filter((k) => k !== "hash")
    .sort()
    .map((k) => `${k}=${telegramData[k]}`)
    .join("\n");

  const hmac = crypto
    .createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");

  if (hmac !== telegramData.hash) {
    throw new functions.https.HttpsError("unauthenticated", "Invalid Telegram signature");
  }

  // Check auth_date freshness (max 1 hour old)
  const age = Math.floor(Date.now() / 1000) - parseInt(telegramData.auth_date, 10);
  if (age > 3600) {
    throw new functions.https.HttpsError("unauthenticated", "Telegram auth expired");
  }

  // Use Telegram ID as Firebase UID prefix to ensure uniqueness
  const uid = `telegram_${telegramData.id}`;

  // Mint custom token
  const token = await auth.createCustomToken(uid, {
    telegramId:       String(telegramData.id),
    telegramUsername: telegramData.username || null,
    provider:         "telegram",
  });

  return { token };
});


// ─────────────────────────────────────────────────────────────────────────────
// 2. ON SWIPE — detect mutual likes and create matches
// ─────────────────────────────────────────────────────────────────────────────
exports.onSwipe = region.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Login required");
  }

  const swiperUid  = context.auth.uid;
  const { targetUid, decision } = data;

  if (!targetUid || !["like","pass","superlike"].includes(decision)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid swipe data");
  }
  if (swiperUid === targetUid) {
    throw new functions.https.HttpsError("invalid-argument", "Cannot swipe yourself");
  }

  // Check swiper is not banned
  const swiperDoc = await db.collection("users").doc(swiperUid).get();
  if (!swiperDoc.exists || swiperDoc.data().isBanned) {
    throw new functions.https.HttpsError("permission-denied", "Account restricted");
  }

  // Write this swipe decision
  await db
    .collection("swipes").doc(swiperUid)
    .collection("decisions").doc(targetUid)
    .set({ uid: swiperUid, targetUid, decision, timestamp: admin.firestore.FieldValue.serverTimestamp() });

  // Check if target already liked swiper (mutual like)
  if (decision === "like" || decision === "superlike") {
    const reverseSnap = await db
      .collection("swipes").doc(targetUid)
      .collection("decisions").doc(swiperUid)
      .get();

    const theyLikedUs = reverseSnap.exists &&
      ["like","superlike"].includes(reverseSnap.data().decision);

    if (theyLikedUs) {
      // Create match
      const matchId = [swiperUid, targetUid].sort().join("_");
      const matchRef = db.collection("matches").doc(matchId);
      const matchSnap = await matchRef.get();

      if (!matchSnap.exists) {
        const [swiperData, targetData] = await Promise.all([
          db.collection("users").doc(swiperUid).get(),
          db.collection("users").doc(targetUid).get(),
        ]);

        const pick = (d) => ({
          uid:         d.uid,
          displayName: d.displayName,
          photoURL:    d.photoURL,
        });

        await matchRef.set({
          users:         [swiperUid, targetUid],
          user1:         pick(swiperData.data()),
          user2:         pick(targetData.data()),
          lastMessage:   null,
          lastMessageAt: null,
          lastMessageBy: null,
          unreadCount:   { [swiperUid]: 0, [targetUid]: 0 },
          active:        true,
          createdAt:     admin.firestore.FieldValue.serverTimestamp(),
        });

        return { matched: true, matchId };
      }
    }
  }

  return { matched: false };
});


// ─────────────────────────────────────────────────────────────────────────────
// 3. INITIATE CALL
//    Validates caller has enough coins, creates the call document,
//    and returns callId so the frontend can open WebRTC/TURN session.
// ─────────────────────────────────────────────────────────────────────────────
exports.initiateCall = region.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const callerId   = context.auth.uid;
  const { receiverId, matchId, callType } = data;

  if (!receiverId || !matchId || !["voice","video"].includes(callType)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid call data");
  }

  // Fetch receiver's rate
  const [callerWallet, receiverDoc] = await Promise.all([
    db.collection("wallets").doc(callerId).get(),
    db.collection("users").doc(receiverId).get(),
  ]);

  if (!callerWallet.exists || !receiverDoc.exists) {
    throw new functions.https.HttpsError("not-found", "User not found");
  }

  const rate = callType === "voice"
    ? receiverDoc.data().callRateVoice
    : receiverDoc.data().callRateVideo;

  // Require at least 1 minute of coins upfront
  const minRequired = rate;
  if (callerWallet.data().balance < minRequired) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      `Need at least ${minRequired} coins to start a call`
    );
  }

  const callId  = uuid();
  const callRef = db.collection("calls").doc(callId);

  await callRef.set({
    callerId,
    receiverId,
    matchId,
    type:           callType,
    status:         "ringing",
    ratePerMin:     rate,
    totalCoins:     0,
    callerEarns:    0,
    receiverEarns:  0,
    appEarns:       0,
    startedAt:      null,
    endedAt:        null,
    duration:       null,
    createdAt:      admin.firestore.FieldValue.serverTimestamp(),
  });

  return { callId, ratePerMin: rate };
});


// ─────────────────────────────────────────────────────────────────────────────
// 4. END CALL — billing finalization
//    Called when either party ends the call.
//    Deducts coins from caller, credits 60% to receiver, 40% stays in app.
// ─────────────────────────────────────────────────────────────────────────────
exports.endCall = region.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const uid     = context.auth.uid;
  const { callId, durationSeconds } = data;

  if (!callId || typeof durationSeconds !== "number" || durationSeconds < 0) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid call data");
  }

  const callRef  = db.collection("calls").doc(callId);
  const callSnap = await callRef.get();

  if (!callSnap.exists) throw new functions.https.HttpsError("not-found", "Call not found");

  const call = callSnap.data();
  if (call.status === "ended") return { alreadyEnded: true };

  if (call.callerId !== uid && call.receiverId !== uid) {
    throw new functions.https.HttpsError("permission-denied", "Not your call");
  }

  // Calculate billing
  const durationMinutes = durationSeconds / 60;
  const totalCoins      = Math.ceil(durationMinutes * call.ratePerMin);
  const receiverEarns   = Math.floor(totalCoins * USER_CUT);
  const appEarns        = totalCoins - receiverEarns;

  // Run as a transaction to keep wallet balances consistent
  await db.runTransaction(async (tx) => {
    const callerWalletRef   = db.collection("wallets").doc(call.callerId);
    const receiverWalletRef = db.collection("wallets").doc(call.receiverId);

    const callerWallet   = await tx.get(callerWalletRef);
    const receiverWallet = await tx.get(receiverWalletRef);

    if (!callerWallet.exists || !receiverWallet.exists) {
      throw new functions.https.HttpsError("not-found", "Wallet not found");
    }

    const callerBalance = callerWallet.data().balance;
    const actualCharge  = Math.min(totalCoins, callerBalance); // can't charge more than balance
    const actualReceiver = Math.floor(actualCharge * USER_CUT);

    // Deduct from caller
    tx.update(callerWalletRef, {
      balance:   admin.firestore.FieldValue.increment(-actualCharge),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Credit receiver
    tx.update(receiverWalletRef, {
      balance:   admin.firestore.FieldValue.increment(actualReceiver),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update call doc
    tx.update(callRef, {
      status:        "ended",
      totalCoins:    actualCharge,
      receiverEarns: actualReceiver,
      appEarns:      actualCharge - actualReceiver,
      duration:      durationSeconds,
      endedAt:       admin.firestore.FieldValue.serverTimestamp(),
    });

    // Sync denormalized coins on user docs
    tx.update(db.collection("users").doc(call.callerId), {
      coins:      callerBalance - actualCharge,
      coinsSpent: admin.firestore.FieldValue.increment(actualCharge),
      updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.update(db.collection("users").doc(call.receiverId), {
      coins:        admin.firestore.FieldValue.increment(actualReceiver),
      coinsEarned:  admin.firestore.FieldValue.increment(actualReceiver),
      updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
    });

    // Write transaction logs
    const txIdCaller   = uuid();
    const txIdReceiver = uuid();

    tx.set(db.collection("wallets").doc(call.callerId).collection("transactions").doc(txIdCaller), {
      uid:           call.callerId,
      type:          "spend",
      amount:        -actualCharge,
      description:   `${call.type === "voice" ? "Voice" : "Video"} call (${Math.round(durationSeconds / 60)} min)`,
      counterpartyId: call.receiverId,
      callId,
      appCut:        actualCharge - actualReceiver,
      timestamp:     admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.set(db.collection("wallets").doc(call.receiverId).collection("transactions").doc(txIdReceiver), {
      uid:           call.receiverId,
      type:          "earn",
      amount:        actualReceiver,
      description:   `Earned from ${call.type} call`,
      counterpartyId: call.callerId,
      callId,
      appCut:        actualCharge - actualReceiver,
      timestamp:     admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return { success: true, totalCoins, receiverEarns, appEarns };
});


// ─────────────────────────────────────────────────────────────────────────────
// 5. PURCHASE MEDIA — photo/video unlock
// ─────────────────────────────────────────────────────────────────────────────
exports.purchaseMedia = region.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const buyerId   = context.auth.uid;
  const { mediaId } = data;

  if (!mediaId) throw new functions.https.HttpsError("invalid-argument", "mediaId required");

  await db.runTransaction(async (tx) => {
    const mediaRef  = db.collection("media").doc(mediaId);
    const mediaSnap = await tx.get(mediaRef);

    if (!mediaSnap.exists) throw new functions.https.HttpsError("not-found", "Media not found");

    const media = mediaSnap.data();
    if (media.status === "purchased") throw new functions.https.HttpsError("already-exists", "Already purchased");
    if (media.requesterId !== buyerId) throw new functions.https.HttpsError("permission-denied", "Not authorized");

    const price       = media.price;
    const sellerEarns = Math.floor(price * USER_CUT);
    const appEarns    = price - sellerEarns;

    const buyerWalletRef  = db.collection("wallets").doc(buyerId);
    const sellerWalletRef = db.collection("wallets").doc(media.ownerId);

    const [buyerWallet] = await Promise.all([tx.get(buyerWalletRef)]);
    if (buyerWallet.data().balance < price) {
      throw new functions.https.HttpsError("resource-exhausted", "Insufficient coins");
    }

    tx.update(buyerWalletRef, {
      balance:   admin.firestore.FieldValue.increment(-price),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.update(sellerWalletRef, {
      balance:   admin.firestore.FieldValue.increment(sellerEarns),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.update(mediaRef, {
      status:      "purchased",
      ownerEarns:  sellerEarns,
      appEarns,
    });

    // Tx logs
    tx.set(db.collection("wallets").doc(buyerId).collection("transactions").doc(uuid()), {
      uid: buyerId, type: "spend", amount: -price,
      description: `Unlocked ${media.type}`, counterpartyId: media.ownerId,
      mediaId, appCut: appEarns, timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(db.collection("wallets").doc(media.ownerId).collection("transactions").doc(uuid()), {
      uid: media.ownerId, type: "earn", amount: sellerEarns,
      description: `${media.type} purchase`, counterpartyId: buyerId,
      mediaId, appCut: appEarns, timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Sync user.coins
    tx.update(db.collection("users").doc(buyerId), {
      coins: admin.firestore.FieldValue.increment(-price), coinsSpent: admin.firestore.FieldValue.increment(price),
    });
    tx.update(db.collection("users").doc(media.ownerId), {
      coins: admin.firestore.FieldValue.increment(sellerEarns), coinsEarned: admin.firestore.FieldValue.increment(sellerEarns),
    });
  });

  // Generate a signed URL (1-hour expiry) for the purchased media
  const mediaSnap = await db.collection("media").doc(mediaId).get();
  const [signedUrl] = await storage
    .bucket()
    .file(mediaSnap.data().storagePath)
    .getSignedUrl({ action: "read", expires: Date.now() + 3600 * 1000 });

  return { success: true, url: signedUrl };
});


// ─────────────────────────────────────────────────────────────────────────────
// 6. SEND COINS (peer-to-peer)
// ─────────────────────────────────────────────────────────────────────────────
exports.sendCoins = region.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const senderId   = context.auth.uid;
  const { receiverId, amount, matchId } = data;

  if (!receiverId || !amount || amount < 1 || amount > 50000) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid amount (1–50,000)");
  }
  if (senderId === receiverId) {
    throw new functions.https.HttpsError("invalid-argument", "Cannot send to yourself");
  }

  const receiverEarns = Math.floor(amount * USER_CUT);
  const appEarns      = amount - receiverEarns;

  await db.runTransaction(async (tx) => {
    const senderRef   = db.collection("wallets").doc(senderId);
    const receiverRef = db.collection("wallets").doc(receiverId);
    const senderSnap  = await tx.get(senderRef);

    if (senderSnap.data().balance < amount) {
      throw new functions.https.HttpsError("resource-exhausted", "Insufficient coins");
    }

    tx.update(senderRef,   { balance: admin.firestore.FieldValue.increment(-amount),       updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(receiverRef, { balance: admin.firestore.FieldValue.increment(receiverEarns), updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    const desc = `Coins sent`;
    tx.set(db.collection("wallets").doc(senderId).collection("transactions").doc(uuid()), {
      uid: senderId, type: "spend", amount: -amount, description: desc,
      counterpartyId: receiverId, appCut: appEarns, timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(db.collection("wallets").doc(receiverId).collection("transactions").doc(uuid()), {
      uid: receiverId, type: "earn", amount: receiverEarns, description: "Coins received",
      counterpartyId: senderId, appCut: appEarns, timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.update(db.collection("users").doc(senderId), {
      coins: admin.firestore.FieldValue.increment(-amount), coinsSpent: admin.firestore.FieldValue.increment(amount),
    });
    tx.update(db.collection("users").doc(receiverId), {
      coins: admin.firestore.FieldValue.increment(receiverEarns), coinsEarned: admin.firestore.FieldValue.increment(receiverEarns),
    });
  });

  return { success: true, sent: amount, receiverGets: receiverEarns };
});


// ─────────────────────────────────────────────────────────────────────────────
// 7. INITIATE UPI RECHARGE
//    Creates a Razorpay order and returns the order details to the frontend.
//    Replace Razorpay calls with Cashfree if preferred.
// ─────────────────────────────────────────────────────────────────────────────
exports.initiateUpiRecharge = region.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const uid = context.auth.uid;
  const { coinsPackage, upiId } = data;

  const packages = {
    100:   60,
    500:   300,
    1000:  600,
    2500:  1400,
    5000:  2700,
    10000: 5000,
  };

  if (!packages[coinsPackage]) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid coin package");
  }
  if (!upiId || !upiId.includes("@")) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid UPI ID");
  }

  const amountINR   = packages[coinsPackage];
  const amountPaise = amountINR * 100;

  // Razorpay order creation (replace with your actual Razorpay SDK call)
  // const Razorpay = require("razorpay");
  // const razorpay = new Razorpay({
  //   key_id:     functions.config().razorpay.key_id,
  //   key_secret: functions.config().razorpay.key_secret,
  // });
  // const order = await razorpay.orders.create({
  //   amount:   amountPaise,
  //   currency: "INR",
  //   receipt:  uuid(),
  //   notes:    { uid, coins: coinsPackage },
  // });

  // For now — create a pending UPI tx doc (webhook will credit coins)
  const txId  = uuid();
  const txRef = db.collection("upiTransactions").doc(txId);

  await txRef.set({
    uid,
    direction:        "in",
    upiId,
    amountINR,
    coins:            coinsPackage,
    status:           "pending",
    gateway:          "razorpay",
    gatewayOrderId:   txId,               // replace with order.id from Razorpay
    gatewayPaymentId: null,
    createdAt:        admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    txId,
    amountINR,
    amountPaise,
    coins: coinsPackage,
    // orderId: order.id,  // return to frontend for Razorpay checkout
  };
});


// ─────────────────────────────────────────────────────────────────────────────
// 8. UPI WEBHOOK — called by Razorpay/Cashfree after payment success
//    This is an HTTPS function (not callable) — hit by the payment gateway.
// ─────────────────────────────────────────────────────────────────────────────
exports.upiWebhook = region.https.onRequest(async (req, res) => {
  // Verify webhook signature
  const gatewaySecret = functions.config().razorpay.webhook_secret;
  const signature     = req.headers["x-razorpay-signature"];
  const body          = JSON.stringify(req.body);

  const expectedSig = crypto
    .createHmac("sha256", gatewaySecret)
    .update(body)
    .digest("hex");

  if (signature !== expectedSig) {
    console.error("Webhook signature mismatch");
    return res.status(401).send("Unauthorized");
  }

  const event = req.body.event;
  if (event !== "payment.captured") return res.status(200).send("Ignored");

  const payment  = req.body.payload.payment.entity;
  const orderId  = payment.order_id;
  const paymentId = payment.id;

  // Find the pending UPI tx
  const snap = await db
    .collection("upiTransactions")
    .where("gatewayOrderId", "==", orderId)
    .where("status", "==", "pending")
    .limit(1)
    .get();

  if (snap.empty) return res.status(200).send("Already processed");

  const txDoc = snap.docs[0];
  const tx    = txDoc.data();

  // Credit coins in a transaction
  await db.runTransaction(async (dbTx) => {
    const walletRef = db.collection("wallets").doc(tx.uid);
    dbTx.update(walletRef, {
      balance:   admin.firestore.FieldValue.increment(tx.coins),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    dbTx.update(txDoc.ref, {
      status:           "success",
      gatewayPaymentId: paymentId,
    });
    dbTx.update(db.collection("users").doc(tx.uid), {
      coins:    admin.firestore.FieldValue.increment(tx.coins),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    dbTx.set(db.collection("wallets").doc(tx.uid).collection("transactions").doc(uuid()), {
      uid:         tx.uid,
      type:        "recharge",
      amount:      tx.coins,
      description: `UPI recharge ₹${tx.amountINR}`,
      upiRef:      paymentId,
      timestamp:   admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return res.status(200).send("OK");
});


// ─────────────────────────────────────────────────────────────────────────────
// 9. INITIATE WITHDRAW
//    Deducts coins and queues a UPI payout (Razorpay Payout API).
// ─────────────────────────────────────────────────────────────────────────────
exports.initiateWithdraw = region.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const uid = context.auth.uid;
  const { coins, upiId } = data;

  if (!coins || coins < 100) {
    throw new functions.https.HttpsError("invalid-argument", "Minimum withdrawal is 100 coins");
  }
  if (!upiId || !upiId.includes("@")) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid UPI ID");
  }

  const amountINR = Math.floor(coins * COIN_TO_INR);

  await db.runTransaction(async (tx) => {
    const walletRef  = db.collection("wallets").doc(uid);
    const walletSnap = await tx.get(walletRef);

    if (!walletSnap.exists || walletSnap.data().balance < coins) {
      throw new functions.https.HttpsError("resource-exhausted", "Insufficient coins");
    }

    const txId = uuid();

    tx.update(walletRef, {
      balance:   admin.firestore.FieldValue.increment(-coins),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.update(db.collection("users").doc(uid), {
      coins:    admin.firestore.FieldValue.increment(-coins),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(db.collection("upiTransactions").doc(txId), {
      uid, direction: "out", upiId, amountINR, coins,
      status: "pending", gateway: "razorpay",
      gatewayOrderId: null, gatewayPaymentId: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(db.collection("wallets").doc(uid).collection("transactions").doc(uuid()), {
      uid, type: "withdraw", amount: -coins,
      description: `Withdrawal ₹${amountINR} to ${upiId}`,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  // TODO: trigger Razorpay Payout API here to send money to upiId
  // const payout = await razorpay.payouts.create({ ... });

  return { success: true, amountINR, coins };
});


// ─────────────────────────────────────────────────────────────────────────────
// 10. GET SIGNED MEDIA URL (for purchased content)
// ─────────────────────────────────────────────────────────────────────────────
exports.getSignedMediaUrl = region.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const uid = context.auth.uid;
  const { mediaId } = data;

  const mediaSnap = await db.collection("media").doc(mediaId).get();
  if (!mediaSnap.exists) throw new functions.https.HttpsError("not-found", "Media not found");

  const media = mediaSnap.data();

  if (media.status !== "purchased") {
    throw new functions.https.HttpsError("permission-denied", "Media not purchased");
  }
  if (media.requesterId !== uid && media.ownerId !== uid) {
    throw new functions.https.HttpsError("permission-denied", "Not authorized");
  }

  const [url] = await storage
    .bucket()
    .file(media.storagePath)
    .getSignedUrl({ action: "read", expires: Date.now() + 3600 * 1000 });

  return { url };
});


// ─────────────────────────────────────────────────────────────────────────────
// 11. ON USER BANNED (Firestore trigger) — cleanup
// ─────────────────────────────────────────────────────────────────────────────
exports.onUserBanned = region.firestore
  .document("users/{uid}")
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after  = change.after.data();

    if (!before.isBanned && after.isBanned) {
      const uid = context.params.uid;

      // Disable Firebase Auth account
      await auth.updateUser(uid, { disabled: true });

      // Mark all their active matches as inactive
      const matchesSnap = await db
        .collection("matches")
        .where("users", "array-contains", uid)
        .where("active", "==", true)
        .get();

      const batch = db.batch();
      matchesSnap.docs.forEach((d) => batch.update(d.ref, { active: false }));
      await batch.commit();

      console.info(`User ${uid} banned and cleaned up`);
    }
  });
