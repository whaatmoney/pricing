# QPC first-pass pricing bot (prototype)

Builds a decision record for one RFQ: the request facts, every price QPC has quoted, been ordered at or billed for that part, two named volume methods and the labor method calculated independently, and one recommended price with the exact decision a person still has to make. It never sends, approves or writes to a live system.

## Privacy

This repository is public. The code here holds no company data. Exports, emails, POs, drawings, Price Lab rate tables and decision records stay in private storage and are named in `bot/config.local.json` (git-ignored) or in the file named by `QPC_BOT_CONFIG`. Tests use synthetic fixtures only.

```json
{
  "routerHistoryFolder": "…/ROUTER HISTORY",
  "storeDir": "…/work/claude-pricing/router-history",
  "salesExport": "…/Quality Precision Cleaning_Sales by Product_Service Detail (3).xlsx",
  "priceLabDir": "…/work/price-lab-source-snapshot-2026-09-26",
  "calculatorHtml": "…/Documents/calculator/index.html",
  "monitorState": "…/work/rfq-monitor-state.json",
  "outputsDir": "…/outputs"
}
```

## Commands

```bash
npm run bot -- status          # current Router History snapshot, its age, exports not yet imported
npm run bot -- import          # validate and import the newest weekly export (replay is a no-op)
npm run bot -- import-all      # import every export in the folder, oldest first
npm run bot -- decide case.json   # write CLAUDE-DECISION-<case>-vN.{json,md,html} to outputsDir
npm test                       # Part Memory tests plus the bot suite
```

## Pieces

| File | What it does |
|---|---|
| `lib/router-snapshot.js` | Weekly `MMDDYY - LineItems_with_RouterHistory.xlsx` importer. Validates name, age, sheet, headers, row count against the last good snapshot, date coverage and price/date quality. Stores each accepted file once, keyed by SHA-256; a rejected or partial file never replaces the current snapshot. Keeps every row, including repeated occurrences. |
| `lib/part-history.js` | Exact P/N matching (exact token, formatting variant, known alias, longer token), customer identity, revision, oxygen/Aclar/level scope, and returned/credit/zero/blank exclusions. Reuses `core.js` parsing. |
| `lib/sales-export.js` | Reader for the QuickBooks Online sales export (billed prices only). |
| `lib/email-evidence.js` | Normalizes Outlook messages already retrieved by an authorized connector: newest authored text vs quoted history, price rows, terms, customer PO text with quantity/total cross-checks, and evidence types (RFQ, PO, sent estimate, acknowledgment, validity reply, internal…). |
| `lib/methods/pricegpt-master-v2.js` | PriceGPT Master v2 SQ2 (non-tube), SQ3, SQ4, SQ5 in exact integer arithmetic. Anything the master leaves undefined (credible anchor, divergence denominator, bracket overlap) is an explicit input or a block, never a silent default. |
| `lib/methods/price-lab-rules.js` | Loads the captured Price Lab package and refuses to run if a file's hash differs from its manifest. |
| `lib/methods/online-calculator.js` | Runs the published calculator's own tables and helpers from `calculator/index.html` and flags formula drift. |
| `lib/recommend.js` | Named recommendation policies. `repeat-accepted-hold-v0` is a proposal awaiting approval; `chain-only-v0` is master v2 as written. |
| `lib/decision.js` | Assembles the record: history timeline with a status per row (comparable, scope unverified, different, excluded), PO ↔ work order ↔ invoice cross-check by the customer's job number, calculations, recommendation, lifecycle and freshness. |
| `lib/render.js` | Markdown and a self-contained HTML review page. |

## Decision versions

The inputs fingerprint covers the case file, evidence, snapshot, invoice export, rate files, calculator and the engine code. The same fingerprint rewrites the same version; any change writes the next version and records what it supersedes. Approval, the quote actually sent and a later PO are separate lifecycle entries that a new version never overwrites.

## Not built yet

Unattended Outlook retrieval (the evidence file is currently filled by an authorized session), SQ6 review, the tube path, Zapier/tracker integration, and shared access for a second reviewer.
