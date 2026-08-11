# MyPlopPlop ↔ Odoo integration

For merchants who run Odoo and whose prices change too often for a CSV upload to
keep up. MyPlopPlop reads the catalogue straight out of Odoo and keeps prices and
stock in step automatically.

Tested against **Odoo 19 Enterprise, on-premise**. The same code works with
Odoo 14 and up, community or enterprise, hosted or self-hosted.

---

## 1. What we need from the merchant's Odoo administrator

Four things, nothing else:

| | |
|---|---|
| **Odoo URL** | e.g. `https://odoo.example.com` — must answer on HTTPS from the internet |
| **Database name** | the exact Odoo database, e.g. `production` |
| **Integration user** | a dedicated Odoo user, e.g. `myplopplop@example.com` |
| **API key** | generated for that user in Odoo |

### Creating the API key

1. Log into Odoo **as the integration user**.
2. Top-right avatar → **Preferences** → **Account Security** tab.
3. **New API Key** → give it the name `MyPlopPlop` → copy the key.
   Odoo shows it once and never again.

An API key is preferable to the account password: it can be revoked on its own,
and it does not stop working when the user changes their password.

### Access rights

Read-only is enough. The user needs to be able to read:

- `product.template` (or `product.product` if you sell variants)
- `product.category`
- `product.pricelist.item` — only if you want a specific pricelist honoured

Giving them *Sales → User* plus *Inventory → User* covers it.

**We never write to Odoo.** Every call is `search_read` / `read` / `fields_get`.
No orders, no stock moves, no product edits. If you want to prove that, point
the integration user at a read-only access group and everything still works.

### Network

Odoo's external API lives at `POST {your-url}/jsonrpc`. On an on-premise install
behind a firewall, that path has to be reachable from the internet. Options, best
first:

1. Publish Odoo on HTTPS through your existing reverse proxy (nginx/Apache).
2. Restrict `/jsonrpc` to our server's IP address — tell us and we will supply it.
3. If Odoo genuinely cannot be exposed, we can flip the direction: Odoo pushes
   changes out to us (see §4) and we never call in. It requires only outbound
   HTTPS from the Odoo box.

---

## 2. What the merchant sets up on MyPlopPlop

Merchant dashboard → **Inventory** → **Odoo**, or directly at
`/merchant/odoo.html`.

Paste the four values above, then choose how the Odoo price becomes the
MyPlopPlop price:

| Setting | Meaning |
|---|---|
| Price field | `list_price` (sales price) or `standard_price` (cost) |
| Pricelist | optional Odoo pricelist ID to apply instead of the plain price |
| Currency in Odoo | HTG or USD — USD is converted at the rate below |
| USD → HTG rate | conversion rate when Odoo prices are in USD |
| Markup % | added on top; 0 means publish the Odoo price as-is |
| Round to | round the final gourde price to the nearest 5, 10, … (0 = off) |
| Every N minutes | how often we re-read Odoo (minimum 5, default 30) |
| Only "can be sold" | skip anything without `sale_ok` |
| Bring stock across | copy `qty_available`; 0 in Odoo = out of stock on MyPlopPlop |
| Skip items priced at 0 | keeps service lines and unpriced drafts out of the shop |
| Hide what disappears | products deleted or archived in Odoo stop showing on MyPlopPlop |
| Import product photos | pulls `image_512` once per product |

**Test connection** does a dry run: it reports the Odoo version, how many
products match, and shows five real products with the Odoo price next to the
price MyPlopPlop would publish. Nothing is written until you press
**Sync now**.

---

## 3. How the sync behaves

Three modes:

- **full** — reads everything. First run, then once a day. Only a full run can
  notice that a product vanished from Odoo.
- **incremental** — reads only records whose `write_date` moved since the last
  run. This is what makes a 30-minute refresh cheap on a large catalogue.
- **webhook** — Odoo pushes the ids it just changed; we re-read only those.

Matching, in order: our stored Odoo id → SKU (`default_code`) → exact product
name. That last step means a merchant who already uploaded a CSV gets those rows
**adopted**, not duplicated.

Products removed from Odoo are **deactivated, never deleted** — order history
stays intact and the row comes back if the product returns.

Photos set by hand in the MyPlopPlop dashboard are never overwritten by Odoo.

---

## 4. Instant updates (optional)

The scheduled pull is enough for most merchants. If a price change has to appear
within seconds, add an automated action in Odoo.

**Odoo → Settings → Technical → Automated Actions → New**

- Model: `Product Template` (`product.template`)
- Trigger: *On Update*
- Action To Do: *Execute Python Code*

```python
import json, urllib.request

ids = [r.id for r in records]
req = urllib.request.Request(
    "https://myplopplop-api.onrender.com/api/odoo/hook/<STORE_ID>",
    data=json.dumps({"ids": ids}).encode(),
    headers={
        "Content-Type": "application/json",
        "x-mpp-odoo-token": "<TOKEN>",
    },
)
try:
    urllib.request.urlopen(req, timeout=5)
except Exception:
    pass  # never let MyPlopPlop being down block a save in Odoo
```

The exact URL and token, already filled in, are shown on the merchant's Odoo
page (§2). The token authenticates the call — treat it like a password. It only
ever triggers a re-read of the ids you send; it cannot change anything.

---

## 5. API reference

All merchant endpoints require the store owner's (or an admin's) bearer token.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/odoo/:storeId/config` | current settings (API key masked) |
| PUT | `/api/odoo/:storeId/config` | save settings; blank `apiKey` keeps the stored one |
| DELETE | `/api/odoo/:storeId/config` | disconnect; imported products are left alone |
| POST | `/api/odoo/:storeId/test` | dry run — version, match count, 5 mapped samples |
| POST | `/api/odoo/:storeId/sync?mode=full\|incremental` | run now |
| GET | `/api/odoo/:storeId/status` | state, counts, last 20 runs |
| GET | `/api/odoo/:storeId/odoo-categories` | Odoo product categories, for mapping |
| GET | `/api/odoo/:storeId/webhook` | push URL + token |
| POST | `/api/odoo/hook/:storeId` | push endpoint, `x-mpp-odoo-token` header |

---

## 6. Troubleshooting

| Message | Cause |
|---|---|
| *Odoo rejected the login* | wrong database name, wrong user, or the key belongs to a different user |
| *non-JSON response* | the URL is not Odoo, or `/jsonrpc` sits behind a login page / firewall |
| *did not answer within 30s* | Odoo not reachable from the internet |
| *cannot read product.template* | the integration user lacks read access to Sales/Inventory |
| 0 matching products | "Only can be sold" is on and the products lack `sale_ok`, or a category filter is too narrow |
| Prices look wrong | check price field, currency and markup on the merchant page; **Test connection** shows both sides |

## 7. Running the test suite

```
node scripts/test-odoo-sync.js
```

Spins up a stand-in Odoo and an in-memory MongoDB and drives the real sync
engine through full, incremental, webhook and removal scenarios. No credentials
and no network required.
