# Expense Tracker

A private expense tracker that runs in your phone's browser. Upload a bank statement (PDF, Excel or CSV) and it:

- reads every row (date, narration, amount, direction, balance) and checks that the running balance adds up;
- sorts each row into **Spend**, **Income**, **Investment**, **Self transfer** or **Card bill**, with a category (Food & Dining, Mutual Funds, Salary, …);
- keeps investments, self transfers and credit card bill payments **out of your spend**;
- learns from your corrections ("always use this for Swiggy");
- lets you set your **monthly income, expected spend and expected investment**, then tells you whether you **saved or overspent** (income − spend − investment), with month-by-month charts and history;
- shows a month-at-a-glance summary, a spending-by-category donut, and a month-by-month trend line of spend and investment (last 6 months by default; 12 months or all history on request);
- has a **Counts as** menu on every transaction (Spending, Investment, Income, Self transfer, Card bill, Not counted): the app picks one automatically and you can override it, then apply the choice to similar payments;
- lets you add transactions by hand (cash, or any future-dated spend) and edit or delete them later;
- groups transactions by date or by category;
- keeps a list of uploaded statements, and deleting one removes its transactions.

Everything is processed and stored **on your device** (IndexedDB). Statements are never uploaded anywhere.

**Sign-in:** the app opens with a sign-in screen. The first login is `admin` / `admin`; change it in Settings → Sign-in. This is a screen lock for your device, not encryption: the data itself stays readable to anyone with access to the browser's storage.

## Supported statements

| Bank | PDF | Excel / CSV |
|---|---|---|
| HDFC Bank (savings) | ✅ tested | ✅ |
| ICICI Bank (savings) | ✅ tested | ✅ |
| SBI, Axis, Kotak and others | should work — any statement with Date / Narration / Withdrawal / Deposit / Balance columns | ✅ |

Password-protected PDFs are supported: the app asks for the password.

## How categorisation works

1. **Your learned rules** — when you change a category with "Always use this" ticked.
2. **Type rules** — credit card bills (INDmoney/CRED/card BillPay), salary, dividends, interest, refunds, and investments (Groww, Zerodha, mutual funds, NSE/ICCL clearing, MMTC-PAMP gold, NPS/PPF, foreign remittances).
3. **Self transfers** — a transfer narration containing your name (auto-detected from the statement, editable in Settings), a family member you add, or your other account's last 4 digits. Money leaving one of your accounts and arriving in another within 3 days is also paired as a self transfer.
4. **Merchant rules** — ~200 Indian merchants and keywords (Swiggy, Blinkit, Airtel, Netflix, IRCTC, pharmacies, fuel, CBDT tax, GST charges…).
5. **People vs shops** — UPI payments to a phone number or a person's name become "Payments to People"; shop QR codes (paytmqr, BharatPe, …) with no known merchant are marked **Needs category**.

## Monthly plan

On the Overview, tap **Edit plan** to enter the month's income, expected spend and expected investment. A plan carries forward to new months until you change it, and earlier months keep their own numbers, so history stays accurate. Income comes only from your entry; credits found in statements (salary, refunds, dividends) are shown but not used for the calculation.

- **Spent** = spend-type debits minus refunds (self transfers, card bill payments and investments are excluded).
- **Invested** = money put into investments that month (redemptions are shown separately).
- **Saved** = income − spent − invested. Negative means you overspent.

## Install on iPhone

1. Open the app's URL in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Open it from the home screen icon. It works offline, and home-screen apps keep their data (Safari can clear storage of sites you haven't visited in a while, so use the home-screen app and export a backup now and then from Settings).

## Hosting

The app is a static site (`npm run build` → `dist/`). Pick one:

- **GitHub Pages** — `.github/workflows/deploy.yml` tests, builds and deploys on every push to `main`. Enable it in *Settings → Pages → Source: GitHub Actions*. GitHub Pages needs a public repository (or a paid GitHub plan for private ones). The repo contains no personal data: statements are git-ignored and never leave your phone.
- **Netlify / Vercel / Cloudflare Pages** — free for private repositories. Import the repo, build command `npm run build`, output folder `dist`.

## Development

```bash
npm install
npm run dev        # http://localhost:5173 (use --host URL to open on your phone on the same Wi-Fi)
npm test           # unit tests (synthetic statements, no real data)
npm run typecheck
npm run build
```

Code map:

- `src/parse/layout.ts` — turns positioned PDF text into table rows (column detection, wrapped narrations, balance-based direction check).
- `src/parse/sheet.ts` — Excel/CSV header detection.
- `src/categorize/rules.ts` — keyword rules; `engine.ts` — categorisation order, merchant extraction, transfer pairing; `src/plans.ts` — monthly plans, carry-forward and saved/overspent maths.
- `src/ui/` — screens (Overview, Transactions, Upload, Settings).

Never commit real statements — `*.pdf`, `*.xls*` and `*.csv` are git-ignored.
