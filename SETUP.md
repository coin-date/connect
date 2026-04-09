# CoinDate — Firebase Backend Setup Guide
## Complete Production Setup from Scratch

---

## WHAT WAS BROKEN (original code)

| Problem | Impact | Fix |
|---|---|---|
| Only `Analytics` initialized | Auth, Firestore, Storage all missing | Added all services |
| No auth service | Users can't log in | Built `auth.service.js` with Telegram + Google |
| No Firestore rules | Anyone could read/write any data | Wrote production rules |
| No Storage rules | Anyone could upload anything | Wrote type+size restricted rules |
| No Cloud Functions | All coin logic was client-side (hackable) | 11 server-side functions |
| No offline persistence | App broke on bad network | Added IndexedDB + localStorage persistence |
| Wrong region | High latency from India | Set `asia-south1` (Mumbai) |
| No emulator setup | Painful local development | Full emulator config added |
| API key exposed, no env separation | Security risk | Added env-based config |

---

## STEP 1 — Install Firebase CLI

```bash
npm install -g firebase-tools
firebase login
```

---

## STEP 2 — Link to your Firebase project

```bash
cd coindate-firebase
firebase use coin-date
```

---

## STEP 3 — Enable Firebase services in the Console

Go to https://console.firebase.google.com/project/coin-date

1. **Authentication** → Sign-in method → Enable:
   - Google (for Gmail login)
   - Custom Token (for Telegram)

2. **Firestore Database** → Create database → **Production mode** → Location: `asia-south1`

3. **Storage** → Get started → Location: `asia-south1`

4. **Realtime Database** → Create database → Location: `asia-south1` (for presence only)

5. **Functions** → Upgrade to Blaze plan (pay-as-you-go, required for Functions)

---

## STEP 4 — Set Cloud Function secrets

```bash
# Telegram bot token (from @BotFather)
firebase functions:config:set telegram.bot_token="YOUR_BOT_TOKEN"

# Razorpay keys (from razorpay.com dashboard)
firebase functions:config:set razorpay.key_id="rzp_live_XXXX"
firebase functions:config:set razorpay.key_secret="YOUR_SECRET"
firebase functions:config:set razorpay.webhook_secret="YOUR_WEBHOOK_SECRET"

# Verify config
firebase functions:config:get
```

---

## STEP 5 — Install function dependencies

```bash
cd functions
npm install
cd ..
```

---

## STEP 6 — Deploy everything

```bash
# Deploy all at once
firebase deploy

# Or deploy individually
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
firebase deploy --only storage
firebase deploy --only functions
```

---

## STEP 7 — Frontend: install Firebase SDK

```bash
# In your frontend project
npm install firebase
```

Update `package.json` to use:
```json
"firebase": "^10.x.x"
```

---

## STEP 8 — Frontend: wire up the config

Copy `config/firebase.js` and `config/auth.service.js` and `config/api.service.js`
into your frontend `src/` folder.

Create `.env` (never commit this):
```env
VITE_USE_EMULATORS=false
```

---

## STEP 9 — Local development with emulators

```bash
# Start all emulators
firebase emulators:start

# Open Emulator UI
open http://localhost:4000

# In frontend .env
VITE_USE_EMULATORS=true
```

---

## STEP 10 — Telegram Login Widget (HTML snippet)

Add this to your login page. The widget calls your callback with `telegramData`.

```html
<script
  async
  src="https://telegram.org/js/telegram-widget.js?22"
  data-telegram-login="YOUR_BOT_USERNAME"
  data-size="large"
  data-onauth="onTelegramAuth(user)"
  data-request-access="write">
</script>

<script>
  async function onTelegramAuth(telegramData) {
    const { loginWithTelegram } = await import('./config/auth.service.js');
    const result = await loginWithTelegram(telegramData);
    if (result.success) {
      // redirect to app
    } else {
      alert(result.error);
    }
  }
</script>
```

---

## STEP 11 — Razorpay UPI integration (frontend)

```js
import { rechargeCoins } from './config/api.service.js';

async function handleRecharge(coinPackage, upiId) {
  // 1. Create order on server
  const { txId, amountPaise } = await rechargeCoins(coinPackage, upiId);

  // 2. Open Razorpay checkout
  const rzp = new Razorpay({
    key:    'rzp_live_XXXX',
    amount: amountPaise,
    currency: 'INR',
    name: 'CoinDate',
    description: `${coinPackage} Coins`,
    order_id: txId,  // from server
    prefill: { method: 'upi', vpa: upiId },
    handler: (response) => {
      // Payment successful — webhook will auto-credit coins
      console.log('Payment done:', response.razorpay_payment_id);
    },
  });
  rzp.open();
}
```

Add Razorpay script to `index.html`:
```html
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
```

---

## EXAMPLE FRONTEND USAGE

```js
import {
  loginWithGoogle,
  loginWithTelegram,
  logout,
  onAuthChange,
} from './config/auth.service.js';

import {
  updateProfile,
  fetchDiscoverProfiles,
  swipe,
  listenToMatches,
  sendMessage,
  initiateCall,
  endCall,
  listenToWallet,
  rechargeCoins,
  withdrawCoins,
  sendCoins,
  uploadProfilePhoto,
  initPresence,
} from './config/api.service.js';

// ── Auth ─────────────────────────────────────────────────────────────
const result = await loginWithGoogle();
if (result.success) initPresence();

onAuthChange((user) => {
  if (user) console.log('Logged in:', user.profile.displayName);
  else console.log('Logged out');
});

// ── Profile Setup ─────────────────────────────────────────────────────
await updateProfile({
  displayName: 'Arjun',
  age: 25,
  bio: 'Software Engineer from Kerala',
  hobbies: ['Music', 'Travel'],
  intentions: ['serious'],
  callRateVoice: 10,
  callRateVideo: 20,
  profileComplete: true,
});

// ── Discover ──────────────────────────────────────────────────────────
const { profiles, lastDoc } = await fetchDiscoverProfiles();
// Next page:
const { profiles: page2 } = await fetchDiscoverProfiles(lastDoc);

// Swipe right → check for match
const swipeResult = await swipe(targetUid, 'like');
if (swipeResult.matched) {
  console.log('Match created:', swipeResult.matchId);
}

// ── Real-time Chat ────────────────────────────────────────────────────
const unsubMatches = listenToMatches((matches) => {
  console.log('Matches:', matches);
});

await sendMessage(matchId, 'Hey there!');

// ── Calls ─────────────────────────────────────────────────────────────
const { callId, ratePerMin } = await initiateCall(receiverId, matchId, 'voice');
// ... WebRTC/TURN session ...
const billing = await endCall(callId, 185); // 185 seconds
console.log('Charged:', billing.totalCoins, 'coins');

// ── Wallet ────────────────────────────────────────────────────────────
const unsubWallet = listenToWallet((wallet) => {
  console.log('Balance:', wallet.balance, 'coins');
});

await rechargeCoins(500, 'arjun@okaxis');  // opens Razorpay
await withdrawCoins(200, 'arjun@okaxis');  // instant UPI payout
await sendCoins(receiverId, 50, matchId);  // peer-to-peer
```

---

## ARCHITECTURE DECISIONS

### Why Firestore over Realtime Database?
- Complex queries (filter by gender + active + not-banned + age range)
- Subcollections perfectly model wallets/transactions per user
- Better security rules granularity
- RTDB retained **only** for presence (online/offline) — it's cheaper for that use case

### Why Cloud Functions for all coin logic?
- **Client-side coin math is hackable.** The 60/40 split, balance checks,
  and transaction atomicity MUST run server-side
- Firestore transactions in Functions prevent race conditions
  (two calls ending simultaneously can't double-spend)

### Why `asia-south1` region?
- Closest Google Cloud region to Kerala, India
- Reduces function cold-start and Firestore latency by ~50% vs `us-central1`

### Cost optimizations
- `listenTo*` uses `onSnapshot` with `limit()` — avoids full collection scans
- `users.coins` is a denormalized cache — UI reads from it without hitting `wallets`
- Paid media served via signed URLs (not public Storage URLs) — can't be shared
- Indexes are pre-defined — no collection scans on filtered queries
- Presence uses RTDB (cheaper per-connection vs Firestore listeners)

---

## SECURITY CHECKLIST

- [x] All coin mutations are server-only (Cloud Functions)
- [x] Users can only read/write their own wallet
- [x] Profile updates whitelist only safe fields
- [x] Storage blocks direct read of paid media (signed URLs only)
- [x] Storage enforces file type + size limits
- [x] Telegram auth verifies HMAC hash + freshness
- [x] Banned users are disabled in Auth + cleaned up from matches
- [x] Age minimum enforced in security rules (≥18)
- [x] No location data stored or exposed
- [x] Social media links blocked at profile level
- [x] Catch-all deny rule at bottom of Firestore rules
