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
  "outputsDir": "…/outputs",
  "quoteTemplate": "…/quote-template.txt",
  "brandBadge": "…/brand/badge.svg",
  "pagesMirror": "…/OneDrive/RFQ Pricing (Claude)/Pages"
}
```

`approverAddresses` (optional) maps each approver's sending address to their approver name; `from-sent` records a quote only when one of these addresses sent it to a recipient at the customer's domain, reads only the newest authored text of the email, and leaves any line the email does not clearly price open. `brandBadge` (optional) is the company badge shown on the board, read at render time so it never enters this repo. `pagesMirror` (optional) is a synced folder that receives a read-only copy of the board, its current price pages and the monitor's latest check report after every rebuild, so another computer can open them; superseded page versions are removed from the copy only.

`quoteTemplate` is the reviewer's own RFQ response wording. The page's Copy quote fills `{{parts}}` (P/N, Qty, Unit Price per part; tiers of one part at one price share an entry) and `{{process}}` (written once when every part shares it, otherwise under each part). Without it, Copy quote gives the parts and process alone.

## Commands

```bash
npm run bot -- status          # current Router History snapshot, its age, exports not yet imported
npm run bot -- import          # validate and import the newest weekly export (replay is a no-op)
npm run bot -- import-all      # import every export in the folder, oldest first
npm run bot -- decide case.json   # write CLAUDE-DECISION-<case>-vN.{json,md,html} to outputsDir
npm run bot -- approve case.json --version 1 --line L1 --choice approved --price 8.50 --by NAME --note "..."
                               # record a person's decision (approved | alternative | correction)
npm run bot -- answer --by NAME "<pasted answer line>"   # record a reviewer's answer exactly as pasted
npm run bot -- from-sent CASE --email sent.json [--dry-run]   # the reviewer's sent quote email is the decision
npm run bot -- render case.json   # redraw the latest saved version's page (the record is not rebuilt)
npm run bot -- board           # rewrite CLAUDE-DECISIONS-OPEN.html (decide/approve/answer also refresh it)
npm run bot -- sync            # import any new Router History export, then rebuild the board (the background job runs this)
npm run bot -- jobs case.json  # the customer's job numbers per part and which the saved evidence mentions
npm test                       # Part Memory tests plus the bot suite
```

`approve` options: `--choice approved` must name the recommended price; `alternative` takes any other price (a price that is not one of the listed options needs `--note` with its basis); `correction` takes no price and a `--note` naming the wrong fact, and the case file is then corrected and `decide` rerun. `--at` sets when the decision was made (default now) and `--rule approved|rejected` records a ruling on the recommendation policy the version used. If the config lists `approvers`, `--by` must be one of them.

Each line on a review page opens with the reviewer's card (P/N, Envelope Dimensions, Qty, Process, Suggested Unit Price, Why) and offers answer lines to copy. `answer` reads them exactly (grammar in `lib/answer.js`): `approve <price>`, `alt <price> — <basis>`, `correct <field>: <what is right>`, `method ok` or `method wrong <field>: <what is wrong>`, joined with `; method …` and `; rule approve|reject`. Every entry an answer implies is validated before any is written, and the pasted words are kept verbatim. Method reviews are their own lifecycle entries and never count as price decisions; the board collects them as method feedback.

Before a commit, the privacy check runs over tracked files only (`git grep`), because the git-ignored `config.local.json` holds approver names.

## Pieces

| File | What it does |
|---|---|
| `lib/router-snapshot.js` | Weekly `MMDDYY - LineItems_with_RouterHistory.xlsx` importer. Validates name, age, sheet, headers, row count against the last good snapshot, date coverage and price/date quality. Stores each accepted file once, keyed by SHA-256; a rejected or partial file never replaces the current snapshot. Keeps every row, including repeated occurrences. |
| `lib/part-history.js` | Exact P/N matching (exact token, formatting variant, known alias, longer token), customer identity, revision, oxygen/Aclar/level scope, and returned/credit/zero/blank exclusions. Reuses `core.js` parsing. |
| `lib/sales-export.js` | Reader for the QuickBooks Online sales export (billed prices only). |
| `lib/email-evidence.js` | Normalizes Outlook messages already retrieved by an authorized connector: newest authored text vs quoted history, price rows, terms, customer PO text with quantity/total cross-checks, and evidence types (RFQ, PO, sent estimate, acknowledgment, validity reply, internal…). |
| `lib/methods/pricegpt-master-v2.js` | PriceGPT Master v2 SQ2 (non-tube), SQ3, SQ4, SQ5 in exact integer arithmetic. Anything the master leaves undefined (credible anchor, divergence denominator, bracket overlap) is an explicit input or a block, never a silent default. |
| `lib/methods/price-lab-rules.js` | Loads the captured Price Lab package and refuses to run if a file's hash differs from its manifest. |
| `lib/methods/online-calculator.js` | Runs the published calculator's own tables and helpers from `calculator/index.html` and flags formula drift. Under ruling `calculator-volume-v1` its price (Cavity $ always 0; holes and bores only through Complexity, with a stated `complexityReason`) is the volume price, rounded to $0.25; the master's SQ2 is kept as a reference. An unknown size, weight or complexity name blocks the price. |
| `lib/recommend.js` | Named recommendation policies. `repeat-accepted-hold-v0` is a proposal awaiting approval; `chain-only-v0` is master v2 as written. |
| `lib/decision.js` | Assembles the record: history timeline with a status per row (comparable, scope unverified, different, excluded), PO ↔ work order ↔ invoice cross-check by the customer's job number, calculations, recommendation, lifecycle and freshness. |
| `lib/render.js` | Markdown and a self-contained HTML review page, including any recorded decisions. |
| `lib/lifecycle.js` | Decisions on a recommendation, kept append-only and hash-chained in `CLAUDE-DECISION-<case>-lifecycle.json`. A decision counts only for the version and inputs fingerprint it was made on. |
| `lib/review-card.js` | The reviewer's six-field card, the method path behind the price (history → SQ2 → SQ3 → SQ5 → pick) and the answer lines. |
| `lib/answer.js` | Parses a pasted answer line and records it through `lifecycle.js`, all or nothing. |
| `lib/board.js` | The open-decisions page: latest version per case, decision state, business days waiting, method feedback, and monitor RFQs (read only) with no page yet. |
| `lib/sync.js` | One safe, repeatable pass: import new weekly exports, rebuild the board, append to the sync log. Never rebuilds a recommendation or writes the monitor's files. |
| `lib/rulings.js` | Named, dated pricing rulings that change how the master is applied (engine file). |
| `lib/job-numbers.js` | The customer's own job numbers ("WO NO: W1-100", "JOB NO: 1234-1") on exact-part work orders, and which ones the saved evidence already mentions, so the rest can be searched in mail. |

## How it runs with the mail monitor

The mail monitor (a separate scheduled job) reads the shared mailboxes hourly and writes its queue to a state file. This bot only reads that file. A macOS LaunchAgent (kept outside the repo) runs `sync` whenever the monitor saves a check, whenever a file lands in the Router History folder, and daily at 7:00 as a backstop. The board then shows every unanswered RFQ, which ones have a decision page, what was decided, and, once the monitor sees the quote go out, marks the case sent. Building a case (evidence and facts) and recording a reviewer's answer are still done in an authorized Claude session.

## Decision versions

The inputs fingerprint covers the case file, evidence, snapshot, invoice export, rate files, calculator and the engine code. The same fingerprint rewrites the same version; any change writes the next version and records what it supersedes. Approval, the quote actually sent and a later PO are separate lifecycle entries that a new version never overwrites. `render.js`, `review-card.js`, `lifecycle.js`, `answer.js`, `board.js`, `job-numbers.js` and the CLI are outside the engine fingerprint: changing how a page reads never creates a new version, and a decision never changes a recommendation.

## Not built yet

Unattended Outlook retrieval (the evidence file is currently filled by an authorized session), SQ6 review, the tube path, Zapier/tracker integration, and shared access for a second reviewer.
