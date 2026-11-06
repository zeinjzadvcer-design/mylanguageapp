---
name: Companion app — automatic Syriatel Cash verification
description: How to set up the Android phone that forwards Syriatel confirmation SMS, and what to do when it stops working.
---

# Companion app setup

Syriatel Cash has no merchant API. What it does have is an SMS: when a merchant
account receives money, Syriatel texts the merchant phone

```
تم استلام مبلغ 250000 ل.س بنجاح. رقم العملية هو 600123456789
```

and sends the **payer** a message carrying the same operation number. That
shared number is the whole mechanism. The student types their copy into the app;
a small Android app on the merchant phone forwards the merchant's copy; the
server matches the two on an exact value and activates the subscription.

Without the phone running, nothing breaks — payments simply wait for an admin in
`/admin/payments`, exactly as they did before. **The companion app is an
accelerator, not a dependency.** Treat it that way when deciding how much to
worry about it.

---

## What you need

| | |
|---|---|
| A Syriatel **merchant** account | A personal account caps at 550,000 SYP; a merchant account has no daily maximum. Requires a bank account at a Syriatel-supported bank, then a visit to a Syriatel main centre with ID and proof of that account. |
| An Android phone with the merchant SIM | Any cheap handset. It must stay powered and online. |
| The receive QR and account code | From the Syriatel Cash app — this is what you upload for students to scan. |
| An ingest token | Generated in the admin panel, below. |

iOS cannot do this: Apple does not let an app read SMS. It has to be Android.

---

## 1. Configure the server first

In the app, as an admin: **لوحة الإدارة → المدفوعات والاشتراكات**.

1. **Upload the receive QR** — the image from your Syriatel Cash app. Until this
   exists the payment page tells students the method is unavailable rather than
   showing them an empty frame.
2. **Account name and account code** (رمز الحساب) — shown beside the QR so a
   student whose app cannot scan can type it, and so anyone can confirm the
   account before sending money.
3. **Merchant phone number** — the handset that receives the SMS. Recorded so
   you can see which phone the app belongs on; the server never sends to it.
4. **Payment instructions** in Arabic — free text, shown to the student. Wallet
   app wording changes more often than this code does, which is why it is data.
5. **Generate an ingest token** and copy it. **It is shown once.** The server
   stores it but never returns it again: anything able to POST a forwarded SMS
   can mint a subscription, so it is write-only from the server's side.

### Then set the Syrian pound prices

**Nothing can be paid by wallet until you do this.** Each plan needs a SYP price,
set by hand:

```
PATCH /api/admin/subscription-plans/general_basic/price
{ "priceSyp": 250000 }
```

Deliberately not converted from USD. On 2026-11-02 the official CBS rate was
about 122 SYP/USD while the Damascus parallel market was about 143 — an 18%
spread. Verifying a payment against the wrong one either rejects a correct
transfer or under-collects, and which rate your students actually transact at is
a business judgement rather than an API lookup. A plan with no SYP price is
simply refused for wallet payment, which is a visible gap; a converted guess
would not be.

---

## 2. The forwarding app

You have two options.

### Option A — an off-the-shelf SMS forwarder (fastest)

Several free Android apps forward matching SMS to a webhook. Look for one that
supports a **custom HTTP POST with headers** and a **sender filter**. Configure:

| Setting | Value |
|---|---|
| URL | `https://your-domain/api/wallet-sms` |
| Method | POST |
| Header | `Authorization: Bearer <the token you copied>` |
| Content type | `application/json` |
| Sender filter | Syriatel's sender id — check an actual message |
| Body | see below |

```json
{
  "rawText": "{{message}}",
  "sender": "{{from}}",
  "receivedAt": "{{timestamp_iso8601}}"
}
```

The placeholder names differ per app; map them to the message body, the sender,
and the time **the handset received it**. That last one matters: the 48-hour
submission window is measured from it, so a phone that was offline for an hour
must not consume the student's window. If the app cannot give an ISO timestamp,
option B is better than guessing.

Check the app before trusting it with this. It will hold a credential that can
activate subscriptions, and it reads every SMS on the phone.

### Option B — a purpose-built app (~100 lines)

More work, no third party holding the token. The whole app is a
`BroadcastReceiver` on `SMS_RECEIVED` plus one HTTP POST:

```kotlin
// AndroidManifest.xml needs:
//   <uses-permission android:name="android.permission.RECEIVE_SMS"/>
//   <uses-permission android:name="android.permission.INTERNET"/>

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        for (sms in Telephony.Sms.Intents.getMessagesFromIntent(intent)) {
            // Only Syriatel's messages leave the phone. Forwarding everything
            // would send the owner's private SMS to a server for no reason.
            if (!sms.originatingAddress.orEmpty().contains("Syriatel", true)) continue

            val body = JSONObject().apply {
                put("rawText", sms.messageBody)
                put("sender", sms.originatingAddress)
                // The handset's own receipt time, not now(): the submission
                // window is measured from this.
                put("receivedAt", Instant.ofEpochMilli(sms.timestampMillis).toString())
            }

            // Retry on 5xx only. A 4xx means the server rejected the message
            // itself and resending will not help; a 200 means stored, even if
            // it matched nothing.
            postWithRetry(body)
        }
    }
}
```

Keep the token in `EncryptedSharedPreferences`, not in source.

---

## 3. Keep the phone alive

This is where these setups actually fail — not in the code.

- **Disable battery optimisation** for the app. Android will otherwise kill its
  receiver after a few hours of inactivity, silently.
- **Keep it plugged in.** A phone on a charger beside the router is the usual
  arrangement.
- **Disable auto-updates and auto-restart** where you can. A reboot that lands
  on a lock screen may not restart the receiver.
- **Do not use the phone for anything else.** Another SMS app can consume the
  broadcast first on some vendors' Android.

---

## 4. Verify it works

1. Send a small amount — 1,000 ل.س is enough — from another Syriatel account to
   the merchant account.
2. Watch the server: `GET /api/admin/payment-submissions?status=pending` should
   stay empty, but the message should be stored. Check the database:

```sql
SELECT id, received_at, parsed_operation_number, parsed_amount_syp,
       matched_submission_id, raw_text
  FROM wallet_sms_messages ORDER BY id DESC LIMIT 5;
```

3. `parsed_operation_number` and `parsed_amount_syp` must both be filled. If
   `raw_text` is there but the parsed columns are null, **the message format has
   changed** — send me the raw text and the parser needs a line.
4. Then do it end to end: as a student, pick a plan, choose سيريتل كاش, transfer
   the exact SYP amount, and enter the operation number. The subscription should
   activate within a minute with no admin involvement.

---

## When it goes wrong

| Symptom | Cause | What happens meanwhile |
|---|---|---|
| Nothing arrives in `wallet_sms_messages` | Phone off, app killed, token wrong | Payments wait for an admin |
| Rows arrive, parsed columns null | Syriatel reworded the message | Payments wait for an admin; raw text is kept so it can be re-parsed |
| `needsReview: true` in the verification log | Amount short, or submitted after the window | Admin decides — the money did arrive |
| 401 from the ingest endpoint | Token rotated, or wrong | Nothing is stored |
| 503 from the ingest endpoint | No token generated yet | Nothing is stored |

**Every failure mode degrades to manual review.** None of them loses a payment:
the student's claim is recorded either way, and an admin can see it.

---

## What this does not protect against

**A student using someone else's operation number.** The number is the only
identity the SMS carries — Syriatel's message says the amount and the operation
number, not who paid. If student A learns student B's number and submits it
first, A's claim verifies and B's genuine payment reads as already used.

Three things bound this and none of them eliminates it: one number may be
claimed exactly once (a unique index, not an application check), submissions are
refused after 48 hours, and operation numbers are not published anywhere. The
number is a secret the payer holds, which is why the UI never displays another
student's.

**Rotating the token retires a handset.** If the phone is lost, generate a new
token — the old one stops working immediately, and the phone cannot activate
anything with it.
