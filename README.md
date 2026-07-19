# QPC Line Item History

A local-only browser tool for searching prior line-item formatting, inspecting exact source records, and referencing historical pricing.

## What it does

- Loads `.xlsx`, `.xls`, `.xlsm`, or `.csv` files without uploading them.
- Finds the best matching sheet and header row.
- Normalizes Access/Excel line breaks before search and part-number extraction.
- Excludes duplicate rows case-insensitively.
- Reports accepted rows, excluded duplicates, price gaps, invalid values, and P/N extraction coverage.
- Calculates interpolated median and percentiles without discarding cents.
- Shows a traceable reference range, latest price, trimmed average, sample size, and confidence level.
- Charts the filtered price history and exposes every contributing line in the table.
- Keeps dense search results beside a persistent pane containing every exact source field and line break.
- Includes $0 and blank-price records by default so formatting-only history remains searchable.
- Neutralizes formula-sensitive text during CSV export.

## Privacy

The workbook is read in the browser. The app makes no request containing workbook contents and does not save workbook data to browser storage.

## Calculation policy

- Price statistics use positive numeric prices only.
- Matching-line and priced-line counts are displayed separately.
- Median, P25, and P75 use inclusive linear interpolation.
- The recommendation range is P25–P75 and is presented as a reference, not an automatic quote.
- The trimmed average removes the lowest and highest 10% when at least ten priced lines are available.

## Tests

Run the focused regression suite:

```powershell
npm test
```

Run the production-workbook check by supplying the workbook path:

```powershell
npm run test:production -- "C:\path\to\LINE ITEMS.xlsx"
```

The spreadsheet reader is vendored from SheetJS CE 0.20.3 so the deployed tool remains self-contained.
