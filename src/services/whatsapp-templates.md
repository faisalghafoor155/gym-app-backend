# WhatsApp templates

Meta will not let a business send free-form text to somebody who has not
messaged it in the last 24 hours. Every message this app sends is therefore a
**template**, registered and approved in advance. Sending a name that has not
been approved is rejected outright — not queued, not retried.

So there is a step here that cannot be skipped or automated: each of the four
templates below has to be created by hand in Meta's console and approved before
the corresponding message will send. Approval usually takes a few hours and
occasionally a day or two.

## Before the templates

1. A **Meta Business account**, verified. This is the slow part — it wants
   business documents and can take several days.
2. A **WhatsApp Business number** in Meta Business Suite. It must not be a
   number already registered to the normal WhatsApp or WhatsApp Business app;
   if it is, delete that account first, which cannot be undone.
3. From **WhatsApp → API Setup**, copy the **Phone number ID** and a
   **permanent access token** (a System User token — the one shown on first
   setup expires in 24 hours and is only useful for testing).

Put them in `.env`:

```
WHATSAPP_TOKEN="EAAG..."
WHATSAPP_PHONE_NUMBER_ID="123456789012345"
```

Until both are set, `whatsappEnabled` is false: every send logs instead and the
app runs exactly as it did before.

## Creating the templates

**WhatsApp Manager → Message templates → Create template.**

For all four: category **Utility** (not Marketing — utility is for transaction
and account notices, is cheaper, and is not subject to marketing opt-in rules),
language **English**, and no header or buttons unless you want them.

The `{{1}}`, `{{2}}` … are positional. Meta matches them by order alone, so the
order below must match the order in `whatsapp.ts` exactly. Getting it wrong
produces a perfectly deliverable message with the plan name where the member's
name should be.

---

### 1. `membership_expiry`

Sent on the day a membership runs out.

**Body:**

```
Hi {{1}}, your {{3}} membership at {{2}} expires today.

Visit us to renew and keep your access uninterrupted. Reply STOP to opt out of these messages.
```

| Slot | Value | Sample for approval |
|------|-------|---------------------|
| `{{1}}` | Member name | Ali Khan |
| `{{2}}` | Gym name | Iron House Gym |
| `{{3}}` | Plan name | Monthly |

---

### 2. `membership_expiring_soon`

The early warning, sent `REMINDER_WARN_DAYS` before expiry (3 by default).

**Body:**

```
Hi {{1}}, your {{3}} membership at {{2}} expires in {{4}} days.

Renew before it lapses to keep your remaining days. Reply STOP to opt out of these messages.
```

| Slot | Value | Sample for approval |
|------|-------|---------------------|
| `{{1}}` | Member name | Ali Khan |
| `{{2}}` | Gym name | Iron House Gym |
| `{{3}}` | Plan name | Monthly |
| `{{4}}` | Days remaining | 3 |

---

### 3. `member_welcome`

Sent when a member is registered.

**Body:**

```
Welcome to {{2}}, {{1}}!

Your member number is {{3}} — you will be asked for it at the front desk, so keep this message. Reply STOP to opt out of these messages.
```

| Slot | Value | Sample for approval |
|------|-------|---------------------|
| `{{1}}` | Member name | Ali Khan |
| `{{2}}` | Gym name | Iron House Gym |
| `{{3}}` | Member number | MEM-00125 |

---

### 4. `payment_receipt`

Sent when a payment is recorded as paid.

**Body:**

```
Hi {{1}}, {{2}} has received your payment of Rs. {{3}} for {{4}} on {{5}}.

Thank you. Reply STOP to opt out of these messages.
```

| Slot | Value | Sample for approval |
|------|-------|---------------------|
| `{{1}}` | Member name | Ali Khan |
| `{{2}}` | Gym name | Iron House Gym |
| `{{3}}` | Amount | 2,500 |
| `{{4}}` | What it was for | Monthly |
| `{{5}}` | Date of the payment | 3 September 2026 |

> **This template gained a fifth slot.** Until the new body is approved in
> Meta's console, receipts will be **rejected** — Meta refuses a send whose
> variable count does not match the approved body, so an out-of-date template
> means no receipt at all rather than a receipt missing its date. Submit the
> edit and wait for approval before deploying.
>
> The date is spelled out (`3 September 2026`, not `03/09/2026`) because a
> receipt is the document a member quotes back months later, and a numeric date
> is read two different ways either side of a border.

---

## Opting out

Every template ends with "Reply STOP to opt out". That line is not decoration —
Meta expects a business to honour it, and repeatedly messaging somebody who has
asked you to stop is how a number gets its quality rating cut and eventually
blocked.

**Nothing in this app reads incoming messages yet.** A member who replies STOP
is not automatically opted out; somebody has to tick `whatsappOptOut` on their
record. If the gym starts sending at volume, wire up Meta's inbound webhook and
set that field from it.

## Cost

Utility templates to Pakistani numbers are billed per message, roughly Rs. 1–2
at the time of writing. Meta publishes current rates per country; conversations
opened by the business are charged, and the price changes, so check rather than
budget from this line.

For a gym of 300 members, the recurring cost is the two expiry notices per
member per month — a few hundred rupees. Receipts and welcomes scale with how
busy the desk is.

## Testing before approval

Meta gives every new number five test recipients that can be messaged without
approved templates. **API Setup → To → Manage phone number list.** Add your own
number there and register a member with it — the welcome will arrive.

Beyond those five, an unapproved template fails with a 4xx that names the
problem. `whatsapp.ts` logs Meta's explanation verbatim, so read the server log
rather than guessing.
