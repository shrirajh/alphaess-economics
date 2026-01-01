# AlphaESS Battery Economics Toolkit

A command-line toolkit for AlphaESS battery owners who want to understand their system's performance, optimize charge/discharge schedules, and compare electricity plans.

## What it does

This toolkit pulls historical data from your AlphaESS system and answers questions like:

- How much money is my battery actually saving me?
- Am I discharging during the right time periods?
- Would a second battery pay for itself?
- Is there a cheaper electricity plan I should switch to?

It also lets you apply optimized charge/discharge schedules based on your tariff's peak periods.

## Screenshots

### Web Report
<img width="1051" height="1384" alt="image" src="https://github.com/user-attachments/assets/5b998dc6-e249-4f5e-859a-b2bf40443cdc" />
<img width="1049" height="1222" alt="image" src="https://github.com/user-attachments/assets/a26a806c-e846-4f27-8be6-8d152a633146" />
<img width="1021" height="1362" alt="image" src="https://github.com/user-attachments/assets/1d681897-6d73-4f23-970f-40af18962f51" />

### CLI Script
<img width="1416" height="976" alt="image" src="https://github.com/user-attachments/assets/9e5c49f9-33c2-4f78-b639-30c143bb37cd" />
<img width="1427" height="1298" alt="image" src="https://github.com/user-attachments/assets/82b8fb7d-e70b-48b4-a0cf-ef6d3a02fad5" />
<img width="1866" height="1257" alt="image" src="https://github.com/user-attachments/assets/80d3bac8-c0ae-4cd0-aa87-5fe23926fcfd" />
<img width="1448" height="1275" alt="image" src="https://github.com/user-attachments/assets/1dcfcbdf-cca3-4305-8460-4e8d38873c25" />

## Setup

You'll need Node.js 18+ and an AlphaESS Open API account.

```bash
npm install
```

Create a `.env` file:

```
ALPHAESS_APP_ID=your_app_id
ALPHAESS_APP_SECRET=your_app_secret
```

Get your API credentials from the AlphaESS Open API portal. These are different from your regular app login.

Create a tariff file at `./tariffs/default.json`. Here's an example for a Victorian TOU plan:

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

### Fetch your data

```bash
npx tsx dump-stats.ts
```

Pulls all available historical data from your AlphaESS system. On first run this takes a while (it fetches up to 5 years of daily data). Subsequent runs only fetch new days.

If you have multiple systems, use `--only=SERIAL` or `--skip=SERIAL` to filter.

### Analyze battery economics

```bash
npx tsx analyze-battery-economics.ts
```

The main analysis tool. It shows:

- Seasonal generation and consumption patterns
- Time-of-use breakdown (when you're importing/exporting)
- Battery utilization (is it discharging during peak or wasting cycles on off-peak?)
- Retrospective savings (what you saved vs no battery, vs no solar)
- ROI scenarios for adding more battery capacity
- Optimization recommendations with estimated dollar value

Example output:

```
🔧 BATTERY OPTIMIZATION RECOMMENDATIONS
═══════════════════════════════════════════════════════════════════════════════════════════════════════
  Total potential savings from optimization: $247/year
  (This is FREE money - no hardware purchase required!)

  🔴 ISSUE 1: Battery discharge timing: 71% peak vs 24% off-peak
     Severity: HIGH | Potential value: $247/year
     Impact: Discharging 2.3 kWh/day during cheap off-peak while still importing 3.1 kWh/day during expensive peak
```

### Calculate your bill

```bash
npx tsx calculate-bill.ts
```

Shows what your electricity bill would be based on actual usage data. Useful for checking against your retailer's bill.

Compare two tariffs:

```bash
npx tsx calculate-bill.ts --tariff=./tariffs/current.json --tariff=./tariffs/new-plan.json
```

## Fetching tariffs from Australian retailers

Australian energy retailers are required to publish their plans through the Consumer Data Right (CDR) API. This toolkit can fetch those plans directly and convert them into tariff JSON files.

### Scraper configuration

Create `scraper-config.json`:

```json
{
  "filters": {
    "fuelType": "ELECTRICITY",
    "customerType": "RESIDENTIAL"
  },
  "cache": {
    "enabled": true,
    "ttlHours": 24,
    "directory": "./cache",
    "endpointsFile": "./cache/cdr-endpoints.json"
  },
  "output": {
    "directory": "./tariffs"
  }
}
```

### Discover available retailers

```bash
npx tsx tariff-scraper.ts discover
```

Queries the Energy Made Easy register to find all retailers with CDR endpoints. Results are cached to `./cache/cdr-endpoints.json`.

Example output:

```
Found 45 retailers:

Code                Name                          Status
------------------------------------------------------------
agl                 AGL                           active
origin              Origin Energy                 active
energyaustralia     EnergyAustralia              active
globird             GloBird Energy               active
...
```

### Fetch plan lists

Fetch plans from a single retailer:

```bash
npx tsx tariff-scraper.ts fetch --retailer=globird
```

Fetch from all retailers (polite mode with 5-second delays):

```bash
npx tsx tariff-scraper.ts fetch --all
```

This caches plan summaries to `./cache/plans-{retailer}.json`. Plans include metadata like which postcodes they're available in, but not the actual rates yet.

Use `--force` to refresh cached data, or `--limit=10` to only fetch from the first N retailers.

### List cached plans

```bash
npx tsx tariff-scraper.ts list --retailer=globird
```

Shows all plans from a retailer that are in your cache:

```
Plans from GloBird Energy (fetched: 2025-01-15T10:30:00.000Z):

Plan ID                  Name                                    Type
--------------------------------------------------------------------------------
GBI12345E                EasyFlat                                STANDING
GBI12346E                EasySaver                               MARKET
GBI12347E                Solar Plus TOU                          MARKET
...
```

### View raw plan details

```bash
npx tsx tariff-scraper.ts info --retailer=globird --plan-id=GBI12345E
```

Fetches and displays the full CDR plan detail JSON. Useful for debugging or understanding what data is available.

### Convert a plan to tariff JSON

```bash
npx tsx tariff-scraper.ts convert --retailer=globird --plan-id=GBI12345E
```

Fetches the plan details from the CDR API and converts them into the tariff JSON format used by the other tools. The output includes:

- Daily supply charge
- Time-of-use rates with hour mappings
- Feed-in tariffs (flat or TOU)
- Day type patterns (weekday/weekend if applicable)

Output:

```
Fetching plan GBI12345E from GloBird Energy...

Tariff saved to: ./tariffs/globird-solar-plus-tou-vic.json

Tariff Summary:
  Name: Solar Plus TOU (VIC)
  Provider: GloBird Energy
  State: VIC
  Daily Supply: $1.0274/day
  Feed-in: $0.0500/kWh

  Periods:
    everyday (MTWTFSS):
      peak: $0.3520/kWh (hours: 14)
      shoulder: $0.1980/kWh (hours: 5)
      offpeak: $0.1650/kWh (hours: 5)
```

### Compare plans against your usage

Once you've fetched plan data, compare all available plans for your postcode:

```bash
npx tsx compare-plans.ts --postcode=3000 --top=10
```

This calculates what each plan would actually cost based on your historical usage data, including TOU patterns. Results are ranked by net cost:

```
TOP 10 CHEAPEST PLANS FOR POSTCODE 3000
════════════════════════════════════════════════════════════════════════════════
Based on 365 days of actual usage data

  #  Plan                               Retailer             Net Cost      Annual
----------------------------------------------------------------------------------
  1  Solar Saver TOU                    GloBird Energy        $847.23   $847/yr
  2  Simply Plus                        Simply Energy         $892.45   $892/yr
  3  Freedom Plus                       Powershop             $901.12   $901/yr
...
```

Options:

- `--current=./tariffs/current.json` - compare against your current plan
- `--save` - save the top N plans as tariff JSON files
- `--output=./tariffs` - directory for saved tariffs
- `--exclude-conditions` - skip plans requiring memberships, new customer status, etc.

### Workflow example

Find a cheaper plan:

```bash
# 1. Make sure you have usage data
npx tsx dump-stats.ts

# 2. Discover and fetch retailer plans
npx tsx tariff-scraper.ts discover
npx tsx tariff-scraper.ts fetch --all

# 3. Compare plans for your postcode
npx tsx compare-plans.ts --postcode=3000 --top=10 --save

# 4. Run a detailed bill comparison with the top result
npx tsx calculate-bill.ts \
  --tariff=./tariffs/default.json \
  --tariff=./tariffs/globird-solar-saver-tou-vic.json
```

## Optimize battery settings

After running the analysis, it generates a recommended config file:

```bash
npx tsx optimize-battery.ts --config=./recommended-config-YOURSERIAL.json
```

This updates your AlphaESS discharge schedule to prioritize peak periods. Use `--dry-run` to see what would change without applying it.

**Warning:** AlphaESS only allows one settings change per 24 hours.

## Backup and restore

```bash
npx tsx restore-battery.ts --backup --sn=YOURSERIAL
npx tsx restore-battery.ts --list --sn=YOURSERIAL
npx tsx restore-battery.ts --restore=./backups/alphaess-backup-YOURSERIAL-2025-01-15T10-30-00.json
```

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
