/**
 * CoinDate — Firestore Database Schema
 * ═════════════════════════════════════
 *
 * WHY FIRESTORE (not Realtime Database)?
 * ──────────────────────────────────────
 * • Complex querying needed (filter by age, gender, location-free radius)
 * • Subcollections keep wallet/transaction data isolated per user
 * • Better security rules per-document
 * • RTDB would be used ONLY for presence (online/offline) — see below
 *
 * COST OPTIMIZATIONS:
 * ──────────────────
 * • Denormalize "match preview" data so chat list doesn't need extra reads
 * • Use Firestore bundles for static data
 * • Limit discover queries to 20 docs at a time
 * • Store coin balance in both `users` AND `wallets` (wallets is source of truth,
 *   users.coins is a denormalized cache for fast display — updated via Cloud Function)
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * COLLECTION STRUCTURE
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * /users/{uid}
 * ├── uid: string
 * ├── email: string | null
 * ├── displayName: string
 * ├── photoURL: string | null           ← Firebase Storage URL (profile thumb)
 * ├── provider: "gmail" | "telegram"
 * ├── profileComplete: boolean
 * ├── isActive: boolean
 * ├── isBanned: boolean
 * ├── isVerified: boolean               ← live-camera verified by admin
 * ├── setupStep: 1 | 2 | 3
 * ├── age: number
 * ├── gender: "male" | "female" | "other"
 * ├── lookingFor: "male" | "female" | "any"
 * ├── bio: string (max 150 chars)
 * ├── occupation: string
 * ├── intentions: string[]              e.g. ["serious", "friendship"]
 * ├── hobbies: string[]
 * ├── photos: string[]                  ← Storage paths (max 6)
 * ├── callRateVoice: number             coins/min caller pays
 * ├── callRateVideo: number
 * ├── photoPrice: number
 * ├── videoPrice: number
 * ├── coins: number                     ← DENORMALIZED cache (source of truth = wallets)
 * ├── coinsEarned: number               lifetime
 * ├── coinsSpent: number                lifetime
 * ├── telegramId: string | null
 * ├── telegramUsername: string | null
 * ├── createdAt: Timestamp
 * ├── updatedAt: Timestamp
 * └── lastActiveAt: Timestamp
 *
 * /wallets/{uid}
 * ├── uid: string
 * ├── balance: number                   ← SOURCE OF TRUTH for coin balance
 * ├── currency: "COIN"
 * ├── upiId: string | null
 * ├── upiVerified: boolean
 * ├── createdAt: Timestamp
 * └── updatedAt: Timestamp
 *
 * /wallets/{uid}/transactions/{txId}
 * ├── uid: string
 * ├── type: "earn"|"spend"|"recharge"|"withdraw"|"bonus"|"refund"
 * ├── amount: number                    positive=credit, negative=debit
 * ├── description: string
 * ├── counterpartyId: string | null     other user's uid
 * ├── callId: string | null             if call-related
 * ├── mediaId: string | null            if media-related
 * ├── appCut: number | null             40% cut stored for audit
 * ├── upiRef: string | null             UPI transaction reference
 * └── timestamp: Timestamp
 *
 * /swipes/{uid}/decisions/{targetUid}
 * ├── uid: string
 * ├── targetUid: string
 * ├── decision: "like" | "pass" | "superlike"
 * └── timestamp: Timestamp
 *
 * /matches/{matchId}                    matchId = sorted([uid1,uid2]).join("_")
 * ├── users: [uid1, uid2]              array for arrayContains queries
 * ├── user1: { uid, displayName, photoURL, coins }  denormalized
 * ├── user2: { uid, displayName, photoURL, coins }
 * ├── lastMessage: string | null
 * ├── lastMessageAt: Timestamp | null
 * ├── lastMessageBy: string | null
 * ├── unreadCount: { [uid]: number }
 * ├── active: boolean
 * └── createdAt: Timestamp
 *
 * /matches/{matchId}/messages/{msgId}
 * ├── senderId: string
 * ├── type: "text" | "coinTx" | "mediaRequest" | "callLog"
 * ├── text: string | null
 * ├── coinAmount: number | null          for coinTx type
 * ├── mediaId: string | null             for mediaRequest type
 * ├── callId: string | null              for callLog type
 * ├── callDuration: number | null        seconds
 * ├── callType: "voice"|"video" | null
 * ├── read: boolean
 * └── timestamp: Timestamp
 *
 * /calls/{callId}
 * ├── callerId: string
 * ├── receiverId: string
 * ├── matchId: string
 * ├── type: "voice" | "video"
 * ├── status: "ringing"|"active"|"ended"|"missed"|"rejected"
 * ├── ratePerMin: number                coins charged to caller per minute
 * ├── totalCoins: number                final total charged
 * ├── callerEarns: number               0 (caller pays)
 * ├── receiverEarns: number             60% of totalCoins
 * ├── appEarns: number                  40% of totalCoins
 * ├── startedAt: Timestamp | null
 * ├── endedAt: Timestamp | null
 * ├── duration: number | null            seconds
 * └── createdAt: Timestamp
 *
 * /media/{mediaId}
 * ├── ownerId: string                   who uploaded (earns coins when sold)
 * ├── requesterId: string               who requested/purchased
 * ├── matchId: string
 * ├── type: "photo" | "video"
 * ├── price: number                     coins set by owner
 * ├── storagePath: string               Firebase Storage path
 * ├── url: string | null                null until purchased
 * ├── status: "pending"|"purchased"|"rejected"
 * ├── ownerEarns: number                60% of price
 * ├── appEarns: number                  40% of price
 * └── createdAt: Timestamp
 *
 * /upiTransactions/{txId}
 * ├── uid: string
 * ├── direction: "in" | "out"           in=recharge, out=withdraw
 * ├── upiId: string
 * ├── amountINR: number
 * ├── coins: number
 * ├── status: "pending"|"success"|"failed"
 * ├── gateway: string                   "razorpay" | "cashfree"
 * ├── gatewayOrderId: string | null
 * ├── gatewayPaymentId: string | null
 * └── createdAt: Timestamp
 *
 * /reports/{reportId}
 * ├── reporterId: string
 * ├── reportedId: string
 * ├── reason: string
 * ├── status: "open" | "resolved" | "dismissed"
 * └── createdAt: Timestamp
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * REALTIME DATABASE (presence only — minimal cost)
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * /presence/{uid}
 * ├── online: boolean
 * └── lastSeen: number (epoch ms)
 *
 * ══════════════════════════════════════════════════════════════════════════════
 */
