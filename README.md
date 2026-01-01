# AlphaESS Battery Economics Toolkit

Figure out if your battery is saving you money, whether adding another battery makes sense, find a cheaper electricity plan, and optimize your charge/discharge schedule.

## Quick Start

```bash
npm install
```

Create `.env` with your [AlphaESS Open API](https://open.alphaess.com/) credentials:

```
ALPHAESS_APP_ID=your_app_id
ALPHAESS_APP_SECRET=your_app_secret
```

Fetch your data and run analysis:

```bash
npx tsx dump-stats.ts
npx tsx analyze-battery-economics.ts
```

Open `report.html` in a browser and upload the generated `battery-analysis-*.json` to view your report.

## View Reports

**Detailed report** - Open `report.html`, upload your `battery-analysis-*.json`. Interactive charts, printable to PDF.

**Solar Wrapped** (just for fun) - Run `npx tsx generate-charts.ts` for a Spotify Wrapped-style slideshow of your year in solar. Shareable HTML.

## Screenshots

<table>
<tr>
<td><img width="400" alt="Web Report" src="https://github.com/user-attachments/assets/5b998dc6-e249-4f5e-859a-b2bf40443cdc" /></td>
<td><img width="400" alt="Web Report" src="https://github.com/user-attachments/assets/a26a806c-e846-4f27-8be6-8d152a633146" /></td>
<td><img width="400" alt="Web Report" src="https://github.com/user-attachments/assets/1d681897-6d73-4f23-970f-40af18962f51" /></td>
</tr>
<tr>
<td><img width="400" alt="CLI Output" src="https://github.com/user-attachments/assets/9e5c49f9-33c2-4f78-b639-30c143bb37cd" /></td>
<td><img width="400" alt="CLI Output" src="https://github.com/user-attachments/assets/82b8fb7d-e70b-48b4-a0cf-ef6d3a02fad5" /></td>
<td><img width="400" alt="CLI Output" src="https://github.com/user-attachments/assets/80d3bac8-c0ae-4cd0-aa87-5fe23926fcfd" /></td>
</tr>
<tr>
<td><img width="400" alt="CLI Output" src="https://github.com/user-attachments/assets/1dcfcbdf-cca3-4305-8460-4e8d38873c25" /></td>
<td><img width="400" alt="Solar Wrapped" src="https://github.com/user-attachments/assets/02443713-752f-4c16-95a9-813b2354e8fd" /></td>
<td><img width="400" alt="Solar Wrapped" src="https://github.com/user-attachments/assets/74120aff-aafc-48ec-b930-b57e78e147d6" /></td>
</tr>
</table>

## Tariff Configuration

Create `./tariffs/default.json` with your electricity rates. Example for a Victorian TOU plan:

```json
{
  "name": "My Retailer TOU",
  "provider": "My Retailer",
  "state": "VIC",
  "dailySupplyCharge": 1.0274,
  "feedInTariff": 0.05,
  "dayTypes": {
    "everyday": "MTWTFSS"
  },
  "periods": {
    "everyday": [
      { "name": "offpeak", "hours": [1, 2, 3, 4, 5], "rate": 0.1650 },
      { "name": "peak", "hours": [6, 7, 8, 9, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0], "rate": 0.3520 },
      { "name": "shoulder", "hours": [10, 11, 12, 13, 14], "rate": 0.1980 }
    ]
  }
}
```

Or use the tariff scraper to generate one automatically from your retailer's published rates (see below).

## Commands

### dump-stats.ts

```bash
npx tsx dump-stats.ts
```

Fetches historical data. First run takes a while (up to 5 years). Later runs only fetch new days.

Options: `--only=SERIAL` or `--skip=SERIAL` to filter systems.

### analyze-battery-economics.ts

```bash
npx tsx analyze-battery-economics.ts
```

Runs the analysis and outputs `battery-analysis-*.json`. Shows seasonal patterns, TOU breakdown, battery utilization, savings vs no-battery/no-solar, ROI scenarios, and optimization recommendations.

### calculate-bill.ts

```bash
npx tsx calculate-bill.ts
npx tsx calculate-bill.ts --tariff=./tariffs/current.json --tariff=./tariffs/new-plan.json
```

Calculates your bill from usage data. Pass multiple `--tariff` flags to compare plans.

## Tariff Scraper (Australia)

Australian retailers publish plans via the Consumer Data Right (CDR) API. The scraper fetches these and converts them to tariff JSON.

```bash
npx tsx tariff-scraper.ts discover                    # Find retailers
npx tsx tariff-scraper.ts fetch --all                 # Fetch all plans (slow, polite)
npx tsx tariff-scraper.ts fetch --retailer=globird    # Fetch one retailer
npx tsx tariff-scraper.ts list --retailer=globird     # List cached plans
npx tsx tariff-scraper.ts convert --retailer=globird --plan-id=GBI12345E  # Save as tariff JSON
```

Options: `--force` to refresh cache, `--limit=10` for first N retailers.

### compare-plans.ts

```bash
npx tsx compare-plans.ts --postcode=3000 --top=10
```

Ranks plans by actual cost using your usage data.

Options:
- `--postcode=XXXX` - Your postcode (required)
- `--top=N` - Show top N cheapest plans (default: 10)
- `--sn=SERIAL` - System serial number (if multiple systems)
- `--current=FILE` - Compare against your current tariff JSON
- `--save` - Save top N plans as JSON tariff files
- `--output=DIR` - Output directory for saved tariffs (default: ./tariffs)
- `--cache=DIR` - Cache directory (default: ./cache)
- `--force` - Force recalculation (ignore cache)
- `--exclude-conditions` - Exclude plans with eligibility conditions
- `--exclude-vpp` - Exclude plans requiring VPP enrollment
- `--allow-no-life-support` - Include plans that exclude life support customers
- `--allow-high-income` - Include plans requiring high income ($100k+)
- `--verbose` - Show detailed output

### Workflow: find a cheaper plan

```bash
npx tsx dump-stats.ts
npx tsx tariff-scraper.ts discover
npx tsx tariff-scraper.ts fetch --all
npx tsx compare-plans.ts --postcode=3000 --top=10 --save
npx tsx calculate-bill.ts --tariff=./tariffs/default.json --tariff=./tariffs/globird-solar-saver-tou-vic.json
```

## Battery Settings

### optimize-battery.ts

```bash
npx tsx optimize-battery.ts --config=./recommended-config-YOURSERIAL.json
```

Applies the recommended discharge schedule. Use `--dry-run` to preview. Note: AlphaESS only allows one settings change per 24 hours.

### restore-battery.ts

```bash
npx tsx restore-battery.ts --backup --sn=YOURSERIAL
npx tsx restore-battery.ts --list --sn=YOURSERIAL
npx tsx restore-battery.ts --restore=./backups/alphaess-backup-YOURSERIAL-2025-01-15T10-30-00.json
```

Backup and restore battery charge/discharge settings.

## Configuration

Optional `.env` settings:

```
# Battery assumptions for ROI calculations
BATTERY_COST_PER_10KWH=10000
BATTERY_LIFESPAN_YEARS=10

# Your actual installation costs (for retrospective payback tracking)
BATTERY_SUNK_COST=12000
PANEL_SUNK_COST=8000

# How many empty days before stopping historical fetch
MAX_EMPTY_DAYS=30
```

## File structure

After running the tools:

```
./alphaess-data-SERIAL.json      # Cached system data
./recommended-config-SERIAL.json # Generated optimization config
./backups/                       # Settings backups
./tariffs/                       # Tariff definitions
./cache/                         # CDR API cache
  cdr-endpoints.json             # Retailer endpoint list
  plans-{retailer}.json          # Plan summaries by retailer
  plan-details.json              # Full plan details cache
  calculations-{sn}-{postcode}.json # Cost calculation cache
```

## Known issues

The `alphaess-client` npm package has bugs where `getChargeConfigInfo` and `updateDischargeConfigInfo` call wrong endpoints. This toolkit includes workarounds in `alphaess-api-helpers.ts`.

The CDR API coverage varies by retailer. Some retailers have incomplete data, missing feed-in tariffs, or plans that don't parse cleanly. The scraper logs warnings when it encounters issues.
