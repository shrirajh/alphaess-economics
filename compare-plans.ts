#!/usr/bin/env npx tsx
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tariff, TariffPeriodDef, FeedInPeriodDef } from './tariff-utils.js';
import { createTariffHelpers } from './tariff-utils.js';

// ═══════════════════════════════════════════════════════════════════════════
// CLI ARGUMENT PARSING
// ═══════════════════════════════════════════════════════════════════════════

interface CliArgs {
  postcode: string;
  top: number;
  sn?: string;
  verbose: boolean;
  cacheDir: string;
  force: boolean;
  excludeConditions: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    postcode: '',
    top: 10,
    verbose: false,
    cacheDir: './cache',
    force: false,
  };

  for (const arg of args) {
    if (arg.startsWith('--postcode=')) {
      result.postcode = arg.slice(11);
    } else if (arg.startsWith('--top=')) {
      result.top = parseInt(arg.slice(6), 10);
    } else if (arg.startsWith('--sn=')) {
      result.sn = arg.slice(5);
    } else if (arg === '--verbose' || arg === '-v') {
      result.verbose = true;
    } else if (arg === '--force' || arg === '-f') {
      result.force = true;
    } else if (arg.startsWith('--cache=')) {
      result.cacheDir = arg.slice(8);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
Compare Energy Plans

Usage: npx tsx compare-plans.ts --postcode=XXXX [options]

Required:
  --postcode=XXXX     Your postcode (e.g., 3000)

Options:
  --top=N             Show top N cheapest plans (default: 10)
  --sn=SERIAL         System serial number (if multiple systems)
  --cache=DIR         Cache directory (default: ./cache)
  --force, -f         Force recalculation (ignore cache)
  --verbose, -v       Show detailed output
  --help, -h          Show this help

Example:
  npx tsx compare-plans.ts --postcode=3000 --top=5
`);
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

interface PowerReading {
  uploadTime: string;
  feedIn: number;
  gridCharge: number;
  ppv: number;
  load: number;
  cbat: number;
}

interface EnergyData {
  epv?: number;
  eInput?: number;
  eOutput?: number;
  eCharge?: number;
  eDischarge?: number;
}

interface HistoricalDay {
  date: string;
  energy?: EnergyData;
  power?: PowerReading[] | null;
}

interface SystemData {
  systemInfo?: { cobat?: number };
  historicalData: HistoricalDay[];
}

interface CachedPlanList {
  fetchedAt: string;
  retailer: string;
  retailerName: string;
  plans: CachedPlanSummary[];
}

interface CachedPlanSummary {
  planId: string;
  displayName?: string;
  brandName: string;
  type: string;
  fuelType: string;
  customerType?: string;
  geography?: {
    distributors?: string[];
    includedPostcodes?: string[];
    excludedPostcodes?: string[];
  };
}

interface PlanCondition {
  type: string;
  info: string;
}

interface PlanFee {
  type: string;
  amount: number;
  term: string;  // FIXED = annual, VARIABLE = per-unit
  description: string;
}

interface PlanCost {
  planId: string;
  planName: string;
  retailer: string;
  retailerCode: string;
  dailySupplyCharge: number;
  importCost: number;
  feedInRevenue: number;
  annualFees: number;  // Membership fees, etc.
  netCost: number;
  annualizedCost: number;
  avgImportRate: number;
  tariff: Tariff;
  conditions: PlanCondition[];
  fees: PlanFee[];
  effectiveFrom?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// CALCULATION CACHING
// ═══════════════════════════════════════════════════════════════════════════

interface CachedCalculation {
  planId: string;
  planName: string;
  retailer: string;
  retailerCode: string;
  dailySupplyCharge: number;
  importCost: number;
  feedInRevenue: number;
  annualFees: number;
  netCost: number;
  annualizedCost: number;
  avgImportRate: number;
  conditions: PlanCondition[];
  fees: PlanFee[];
  effectiveFrom?: string;
}

interface CalculationCacheEntry {
  usageFingerprint: string;  // Hash of usage data
  planFingerprint: string;   // Hash of plan lastUpdated
  calculation: CachedCalculation;
  tariff: Tariff;  // Store tariff for display
}

interface CalculationCache {
  version: number;
  sn: string;
  postcode: string;
  createdAt: string;
  entries: Record<string, CalculationCacheEntry>;  // keyed by planId
}

function createUsageFingerprint(usage: UsageSummary): string {
  // Simple fingerprint: days + rounded totals
  return `${usage.days}:${Math.round(usage.totalImport)}:${Math.round(usage.totalExport)}`;
}

function createPlanFingerprint(planData: unknown): string {
  // Extract lastUpdated from plan detail if available
  const plan = (planData as { data?: { lastUpdated?: string; effectiveFrom?: string } })?.data;
  return plan?.lastUpdated ?? plan?.effectiveFrom ?? 'unknown';
}

function getCalculationCachePath(cacheDir: string, sn: string, postcode: string): string {
  return path.join(cacheDir, `calculations-${sn}-${postcode}.json`);
}

function loadCalculationCache(cacheDir: string, sn: string, postcode: string): CalculationCache | null {
  const cachePath = getCalculationCachePath(cacheDir, sn, postcode);
  if (!fs.existsSync(cachePath)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as CalculationCache;
    if (data.version !== 1) return null;  // Invalidate on version change
    return data;
  } catch {
    return null;
  }
}

function saveCalculationCache(cacheDir: string, cache: CalculationCache): void {
  const cachePath = getCalculationCachePath(cacheDir, cache.sn, cache.postcode);
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════════════════

function loadSystemData(targetSn?: string): { system: SystemData; sn: string } {
  let systemFiles = fs.readdirSync('.').filter(f =>
    f.startsWith('alphaess-data-') && f.endsWith('.json')
  );

  if (targetSn) {
    systemFiles = systemFiles.filter(f => f.includes(targetSn));
  }

  if (systemFiles.length === 0) {
    console.error('No data file found. Run dump-stats.ts first.');
    process.exit(1);
  }
  if (systemFiles.length > 1) {
    console.error(`Multiple systems found: ${systemFiles.join(', ')}`);
    console.error('Use --sn= to select one');
    process.exit(1);
  }

  const file = systemFiles[0]!;
  const sn = file.replace('alphaess-data-', '').replace('.json', '');
  console.log(`Loading ${file}...`);
  return {
    system: JSON.parse(fs.readFileSync(file, 'utf8')) as SystemData,
    sn,
  };
}

function loadCachedPlans(cacheDir: string): CachedPlanList[] {
  if (!fs.existsSync(cacheDir)) {
    console.error(`Cache directory not found: ${cacheDir}`);
    console.error('Run "npx tsx tariff-scraper.ts fetch --all" first');
    process.exit(1);
  }

  const files = fs.readdirSync(cacheDir).filter(f => f.startsWith('plans-'));
  if (files.length === 0) {
    console.error('No cached plans found. Run tariff-scraper.ts fetch first.');
    process.exit(1);
  }

  const allPlans: CachedPlanList[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(cacheDir, file), 'utf8')
      ) as CachedPlanList;
      allPlans.push(data);
    } catch (e) {
      // Skip invalid files
    }
  }

  return allPlans;
}

function filterPlansByPostcode(
  allPlans: CachedPlanList[],
  postcode: string
): Array<{ retailerCode: string; retailerName: string; plan: CachedPlanSummary }> {
  const matching: Array<{ retailerCode: string; retailerName: string; plan: CachedPlanSummary }> = [];

  for (const retailer of allPlans) {
    for (const plan of retailer.plans) {
      // Check if plan is available for this postcode
      const geo = plan.geography;
      if (!geo) continue;

      const included = geo.includedPostcodes ?? [];
      const excluded = geo.excludedPostcodes ?? [];

      if (included.length > 0 && !included.includes(postcode)) continue;
      if (excluded.includes(postcode)) continue;

      matching.push({
        retailerCode: retailer.retailer,
        retailerName: retailer.retailerName,
        plan,
      });
    }
  }

  return matching;
}

// ═══════════════════════════════════════════════════════════════════════════
// CDR PLAN FETCHING & CACHING
// ═══════════════════════════════════════════════════════════════════════════

interface CachedPlanDetail {
  fetchedAt: string;
  planId: string;
  retailerCode: string;
  data: unknown;
}

interface PlanDetailCache {
  version: number;
  plans: Record<string, CachedPlanDetail>;  // keyed by planId
}

function getPlanDetailCachePath(cacheDir: string): string {
  return path.join(cacheDir, 'plan-details.json');
}

function loadPlanDetailCache(cacheDir: string): PlanDetailCache {
  const cachePath = getPlanDetailCachePath(cacheDir);
  if (!fs.existsSync(cachePath)) {
    return { version: 1, plans: {} };
  }
  try {
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as PlanDetailCache;
    if (data.version !== 1) return { version: 1, plans: {} };
    return data;
  } catch {
    return { version: 1, plans: {} };
  }
}

function savePlanDetailCache(cacheDir: string, cache: PlanDetailCache): void {
  const cachePath = getPlanDetailCachePath(cacheDir);
  fs.writeFileSync(cachePath, JSON.stringify(cache));  // No pretty-print to save space
}

async function fetchPlanDetail(
  retailerCode: string,
  planId: string,
  cache: PlanDetailCache,
  _cacheDir: string  // Kept for potential future use
): Promise<{ data: unknown; fromCache: boolean }> {
  // Check cache first
  const cached = cache.plans[planId];
  if (cached) {
    return { data: cached.data, fromCache: true };
  }

  // Fetch from API
  const baseUri = `https://cdr.energymadeeasy.gov.au/${retailerCode}`;
  const encodedPlanId = encodeURIComponent(planId);
  const url = `${baseUri}/cds-au/v1/energy/plans/${encodedPlanId}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'x-v': '3',
      'x-min-v': '1',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();

  // Cache the result
  cache.plans[planId] = {
    fetchedAt: new Date().toISOString(),
    planId,
    retailerCode,
    data,
  };

  return { data, fromCache: false };
}

// Rate name normalization
const RATE_NAME_MAP: Record<string, string> = {
  'PEAK': 'peak',
  'OFF_PEAK': 'offpeak',
  'SHOULDER': 'shoulder',
  'ALL_DAY': 'anytime',
};

function normalizeRateName(name: string): string {
  if (RATE_NAME_MAP[name]) return RATE_NAME_MAP[name]!;
  const normalized = name.toLowerCase().trim();
  return RATE_NAME_MAP[normalized] ?? normalized.replace(/\s+/g, '_');
}

// Day pattern conversion
const DAY_MAP: Record<string, number> = {
  'monday': 0, 'mon': 0,
  'tuesday': 1, 'tue': 1,
  'wednesday': 2, 'wed': 2,
  'thursday': 3, 'thu': 3,
  'friday': 4, 'fri': 4,
  'saturday': 5, 'sat': 5,
  'sunday': 6, 'sun': 6,
};

function daysToDayPattern(days: string[]): string {
  if (!days || days.length === 0) return 'MTWTFSS';
  const DAY_CHARS = 'MTWTFSS';
  const pattern = ['_', '_', '_', '_', '_', '_', '_'];
  for (const day of days) {
    const idx = DAY_MAP[day.toLowerCase()];
    if (idx !== undefined) pattern[idx] = DAY_CHARS[idx]!;
  }
  return pattern.join('');
}

function parseTimeRangeToHours(startTime: string, endTime: string): number[] {
  const startHour = parseInt(startTime.split(':')[0]!, 10);
  const endHour = parseInt(endTime.split(':')[0]!, 10);
  const hours: number[] = [];

  if (endHour <= startHour) {
    for (let h = startHour; h < 24; h++) hours.push(h);
    for (let h = 0; h < endHour; h++) hours.push(h);
  } else {
    for (let h = startHour; h < endHour; h++) hours.push(h);
  }
  return hours;
}

interface RawPeriod {
  name: string;
  hours: number[];
  rate: number;
  dayPattern: string;
}

interface ParsedPlanResult {
  tariff: Tariff;
  conditions: PlanCondition[];
  fees: PlanFee[];
  effectiveFrom?: string;
}

function parsePlanDetail(data: unknown, retailerName: string): ParsedPlanResult | null {
  const plan = (data as { data?: unknown })?.data as {
    planId?: string;
    displayName?: string;
    brandName?: string;
    effectiveFrom?: string;
    geography?: { distributors?: string[] };
    electricityContract?: {
      fees?: Array<{
        type?: string;
        term?: string;
        amount?: string;
        description?: string;
      }>;
      eligibility?: Array<{
        type?: string;
        information?: string;
      }>;
      tariffPeriod?: Array<{
        dailySupplyCharge?: string;
        dailySupplyCharges?: string;
        singleRate?: { rates?: Array<{ unitPrice?: string }>; displayName?: string };
        timeOfUseRates?: Array<{
          type?: string;
          displayName?: string;
          rates?: Array<{ unitPrice?: string }>;
          timeOfUse?: Array<{ days?: string[]; startTime: string; endTime: string }>;
        }>;
      }>;
      solarFeedInTariff?: Array<{
        displayName?: string;
        singleTariff?: { amount?: string };
        timeVaryingTariffs?: Array<{
          type?: string;
          displayName?: string;
          rates?: Array<{ unitPrice?: string }>;
          timeVariations?: Array<{ days?: string[]; startTime: string; endTime: string }>;
        }>;
      }>;
    };
  };

  if (!plan?.electricityContract) return null;

  const contract = plan.electricityContract;

  // Daily supply charge
  let dailySupplyCharge = 0;
  for (const period of contract.tariffPeriod ?? []) {
    const dsc = period.dailySupplyCharge ?? period.dailySupplyCharges;
    if (dsc) {
      dailySupplyCharge = parseFloat(dsc);
      break;
    }
  }

  // Parse usage rates
  const rawPeriods: RawPeriod[] = [];

  for (const tariffPeriod of contract.tariffPeriod ?? []) {
    if (tariffPeriod.singleRate) {
      const sr = tariffPeriod.singleRate;
      const rate = sr.rates?.[0]?.unitPrice ? parseFloat(sr.rates[0].unitPrice) : 0;
      rawPeriods.push({
        name: normalizeRateName(sr.displayName ?? 'anytime'),
        hours: Array.from({ length: 24 }, (_, i) => i),
        rate,
        dayPattern: 'MTWTFSS',
      });
    }

    if (tariffPeriod.timeOfUseRates) {
      for (const touRate of tariffPeriod.timeOfUseRates) {
        const rate = touRate.rates?.[0]?.unitPrice ? parseFloat(touRate.rates[0].unitPrice) : 0;
        const name = normalizeRateName(touRate.type ?? touRate.displayName ?? 'unknown');

        for (const tou of touRate.timeOfUse ?? []) {
          const hours = parseTimeRangeToHours(tou.startTime, tou.endTime);
          const dayPattern = daysToDayPattern(tou.days ?? []);
          rawPeriods.push({ name, hours, rate, dayPattern });
        }
      }
    }
  }

  if (rawPeriods.length === 0) return null;

  // Consolidate periods (simplified - just merge by name)
  const periodsByName = new Map<string, { hours: Set<number>; rate: number }>();
  for (const p of rawPeriods) {
    if (!periodsByName.has(p.name)) {
      periodsByName.set(p.name, { hours: new Set(), rate: p.rate });
    }
    const entry = periodsByName.get(p.name)!;
    for (const h of p.hours) entry.hours.add(h);
  }

  const periods: TariffPeriodDef[] = [];
  for (const [name, data] of Array.from(periodsByName)) {
    periods.push({
      name,
      hours: Array.from(data.hours).sort((a, b) => a - b),
      rate: data.rate,
    });
  }

  // Parse feed-in
  let feedInTariff = 0;
  let feedInPeriods: Record<string, FeedInPeriodDef[]> | undefined;
  const feedInRaws: RawPeriod[] = [];

  for (const fit of contract.solarFeedInTariff ?? []) {
    if (fit.singleTariff?.amount) {
      feedInTariff = parseFloat(fit.singleTariff.amount);
    }
    if (fit.timeVaryingTariffs) {
      for (const tvt of fit.timeVaryingTariffs) {
        const rate = tvt.rates?.[0]?.unitPrice ? parseFloat(tvt.rates[0].unitPrice) : 0;
        const name = normalizeRateName(tvt.type ?? tvt.displayName ?? 'export');
        for (const tv of tvt.timeVariations ?? []) {
          const hours = parseTimeRangeToHours(tv.startTime, tv.endTime);
          feedInRaws.push({ name, hours, rate, dayPattern: 'MTWTFSS' });
        }
      }
    }
  }

  if (feedInRaws.length > 0) {
    const rates = feedInRaws.map(r => r.rate);
    const allSame = rates.every(r => r === rates[0]);
    if (allSame) {
      feedInTariff = rates[0] ?? feedInTariff;
    } else {
      feedInTariff = Math.max(...rates);
      const feedInByName = new Map<string, { hours: Set<number>; rate: number }>();
      for (const p of feedInRaws) {
        if (!feedInByName.has(p.name)) {
          feedInByName.set(p.name, { hours: new Set(), rate: p.rate });
        }
        const entry = feedInByName.get(p.name)!;
        for (const h of p.hours) entry.hours.add(h);
      }
      feedInPeriods = {
        everyday: Array.from(feedInByName).map(([name, data]) => ({
          name,
          hours: Array.from(data.hours).sort((a, b) => a - b),
          rate: data.rate,
        })),
      };
    }
  }

  // Determine state from distributor
  let state = 'Unknown';
  const dist = plan.geography?.distributors?.[0] ?? '';
  if (dist.includes('United Energy') || dist.includes('Powercor') || dist.includes('CitiPower') ||
      dist.includes('Jemena') || dist.includes('AusNet')) state = 'VIC';
  else if (dist.includes('Ausgrid') || dist.includes('Endeavour') || dist.includes('Essential')) state = 'NSW';
  else if (dist.includes('Energex') || dist.includes('Ergon')) state = 'QLD';
  else if (dist.includes('SA Power')) state = 'SA';
  else if (dist.includes('Western Power')) state = 'WA';

  // Parse eligibility conditions
  const conditions: PlanCondition[] = [];
  for (const elig of contract.eligibility ?? []) {
    conditions.push({
      type: elig.type ?? 'OTHER',
      info: elig.information ?? '',
    });
  }

  // Parse fees (especially membership fees)
  const fees: PlanFee[] = [];
  for (const fee of contract.fees ?? []) {
    fees.push({
      type: fee.type ?? 'OTHER',
      amount: fee.amount ? parseFloat(fee.amount) : 0,
      term: fee.term ?? 'FIXED',
      description: fee.description ?? '',
    });
  }

  const tariff: Tariff = {
    name: plan.displayName ?? plan.planId ?? 'Unknown',
    provider: retailerName,
    state,
    dailySupplyCharge,
    feedInTariff,
    feedInPeriods,
    dayTypes: { everyday: 'MTWTFSS' },
    periods: { everyday: periods },
  };

  return {
    tariff,
    conditions,
    fees,
    effectiveFrom: plan.effectiveFrom,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// COST CALCULATION
// ═══════════════════════════════════════════════════════════════════════════

interface UsageSummary {
  days: number;
  totalImport: number;
  totalExport: number;
  importByHour: number[];  // 24 hours
  exportByHour: number[];  // 24 hours
}

function calculateUsageSummary(system: SystemData): UsageSummary {
  const importByHour = new Array(24).fill(0);
  const exportByHour = new Array(24).fill(0);
  let totalImport = 0;
  let totalExport = 0;
  let days = 0;

  for (const day of system.historicalData) {
    if (!day.energy) continue;
    days++;
    totalImport += day.energy.eInput ?? 0;
    totalExport += day.energy.eOutput ?? 0;

    // Break down by hour from power readings
    if (day.power && day.power.length > 0) {
      const sorted = [...day.power].sort((a, b) =>
        a.uploadTime.localeCompare(b.uploadTime)
      );

      for (let i = 0; i < sorted.length; i++) {
        const reading = sorted[i]!;
        const timePart = reading.uploadTime.includes('T')
          ? reading.uploadTime.split('T')[1]
          : reading.uploadTime.split(' ')[1];
        const hour = parseInt(timePart?.split(':')[0] ?? '0', 10);

        let intervalHours = 5 / 60;
        if (i < sorted.length - 1) {
          const next = sorted[i + 1]!;
          const diffMs = new Date(next.uploadTime).getTime() - new Date(reading.uploadTime).getTime();
          if (diffMs > 0 && diffMs < 3600000) {
            intervalHours = diffMs / 3600000;
          }
        }

        const importKwh = (reading.gridCharge / 1000) * intervalHours;
        const exportKwh = (reading.feedIn / 1000) * intervalHours;

        importByHour[hour] += importKwh;
        exportByHour[hour] += exportKwh;
      }
    }
  }

  return { days, totalImport, totalExport, importByHour, exportByHour };
}

function calculatePlanCost(
  parsed: ParsedPlanResult,
  usage: UsageSummary,
  planId: string,
  retailerCode: string,
  retailerName: string
): PlanCost {
  const { tariff, conditions, fees, effectiveFrom } = parsed;
  const helpers = createTariffHelpers(tariff);

  // Calculate import cost by hour
  let importCost = 0;
  for (let hour = 0; hour < 24; hour++) {
    const kwh = usage.importByHour[hour] ?? 0;
    const { rate } = helpers.getRatePeriod(hour, 1); // Use Monday as reference
    importCost += kwh * rate;
  }

  // Calculate feed-in revenue by hour
  let feedInRevenue = 0;
  for (let hour = 0; hour < 24; hour++) {
    const kwh = usage.exportByHour[hour] ?? 0;
    const { rate } = helpers.getFeedInRate(hour, 1);
    feedInRevenue += kwh * rate;
  }

  // Daily supply charge
  const dailyCharge = (tariff.dailySupplyCharge ?? 0) * usage.days;

  // Calculate annual fees (membership fees, etc.)
  // Only include FIXED term fees that apply annually
  let annualFees = 0;
  for (const fee of fees) {
    if (fee.term === 'FIXED' && (fee.type === 'MEMBERSHIP' || fee.type === 'OTHER')) {
      annualFees += fee.amount;
    }
  }
  // Pro-rate fees based on usage period
  const periodFees = (annualFees / 365) * usage.days;

  const netCost = importCost + dailyCharge + periodFees - feedInRevenue;
  const annualizedCost = (netCost / usage.days) * 365;
  const avgImportRate = usage.totalImport > 0 ? importCost / usage.totalImport : 0;

  return {
    planId,
    planName: tariff.name,
    retailer: retailerName,
    retailerCode,
    dailySupplyCharge: tariff.dailySupplyCharge ?? 0,
    importCost,
    feedInRevenue,
    annualFees,
    netCost,
    annualizedCost,
    avgImportRate,
    tariff,
    conditions,
    fees,
    effectiveFrom,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = parseArgs();

  if (!args.postcode) {
    console.error('Error: --postcode is required');
    printHelp();
    process.exit(1);
  }

  console.log('═'.repeat(80));
  console.log('ENERGY PLAN COMPARISON');
  console.log('═'.repeat(80));

  // Load usage data
  const { system, sn } = loadSystemData(args.sn);
  const usage = calculateUsageSummary(system);

  console.log(`\nSystem: ${sn}`);
  console.log(`Postcode: ${args.postcode}`);
  console.log(`Usage data: ${usage.days} days`);
  console.log(`Total import: ${usage.totalImport.toFixed(0)} kWh`);
  console.log(`Total export: ${usage.totalExport.toFixed(0)} kWh`);

  // Load cached plans
  const allPlans = loadCachedPlans(args.cacheDir);
  console.log(`\nLoaded ${allPlans.length} retailers from cache`);

  // Filter by postcode
  const matching = filterPlansByPostcode(allPlans, args.postcode);
  console.log(`Found ${matching.length} plans for postcode ${args.postcode}`);

  if (matching.length === 0) {
    console.error('\nNo plans found for this postcode.');
    console.error('Try running: npx tsx tariff-scraper.ts fetch --all');
    process.exit(1);
  }

  // Load plan detail cache
  const planDetailCache = loadPlanDetailCache(args.cacheDir);
  const cachedDetailCount = Object.keys(planDetailCache.plans).length;
  if (cachedDetailCount > 0) {
    console.log(`Loaded ${cachedDetailCount} cached plan details`);
  }

  // Load calculation cache
  const usageFingerprint = createUsageFingerprint(usage);
  let calcCache: CalculationCache | null = null;

  if (!args.force) {
    calcCache = loadCalculationCache(args.cacheDir, sn, args.postcode);

    // If usage changed, start fresh
    if (calcCache && calcCache.entries) {
      const firstEntry = Object.values(calcCache.entries)[0];
      if (firstEntry && firstEntry.usageFingerprint !== usageFingerprint) {
        console.log('\nUsage data changed, recalculating all plans...');
        calcCache = null;
      }
    }
  } else {
    console.log('\nForce flag set, recalculating all plans...');
  }

  if (!calcCache) {
    calcCache = {
      version: 1,
      sn,
      postcode: args.postcode,
      createdAt: new Date().toISOString(),
      entries: {},
    };
  }

  // Calculate costs for each plan
  console.log(`\nAnalyzing plans...`);
  const costs: PlanCost[] = [];
  let processed = 0;
  let errors = 0;
  let calcCacheHits = 0;
  let detailCacheHits = 0;
  let apiFetches = 0;
  let lastSaveAt = 0;
  const SAVE_EVERY = 50;  // Save cache every N API fetches

  for (const { retailerCode, retailerName, plan } of matching) {
    processed++;
    if (processed % 50 === 0) {
      process.stdout.write(`  ${processed}/${matching.length} plans (${calcCacheHits} calc cached, ${detailCacheHits} detail cached)...\r`);
    }

    // Check if we have a valid cached calculation
    const cachedEntry = calcCache.entries[plan.planId];
    if (cachedEntry && cachedEntry.usageFingerprint === usageFingerprint) {
      // Use cached result
      calcCacheHits++;
      costs.push({
        ...cachedEntry.calculation,
        tariff: cachedEntry.tariff,
      });
      continue;
    }

    // Need to fetch and calculate
    try {
      const { data: detail, fromCache } = await fetchPlanDetail(
        retailerCode,
        plan.planId,
        planDetailCache,
        args.cacheDir
      );

      if (fromCache) {
        detailCacheHits++;
      } else {
        apiFetches++;
        // Small delay to be polite when fetching from API
        await new Promise(r => setTimeout(r, 100));
      }

      const planFingerprint = createPlanFingerprint(detail);
      const parsed = parsePlanDetail(detail, retailerName);

      if (parsed) {
        const cost = calculatePlanCost(parsed, usage, plan.planId, retailerCode, retailerName);
        costs.push(cost);

        // Cache the result
        calcCache.entries[plan.planId] = {
          usageFingerprint,
          planFingerprint,
          calculation: {
            planId: cost.planId,
            planName: cost.planName,
            retailer: cost.retailer,
            retailerCode: cost.retailerCode,
            dailySupplyCharge: cost.dailySupplyCharge,
            importCost: cost.importCost,
            feedInRevenue: cost.feedInRevenue,
            annualFees: cost.annualFees,
            netCost: cost.netCost,
            annualizedCost: cost.annualizedCost,
            avgImportRate: cost.avgImportRate,
            conditions: cost.conditions,
            fees: cost.fees,
            effectiveFrom: cost.effectiveFrom,
          },
          tariff: cost.tariff,
        };

        // Save cache periodically to avoid losing progress on interrupt
        if (apiFetches - lastSaveAt >= SAVE_EVERY) {
          savePlanDetailCache(args.cacheDir, planDetailCache);
          saveCalculationCache(args.cacheDir, calcCache);
          lastSaveAt = apiFetches;
        }
      }
    } catch (e) {
      errors++;
      if (args.verbose) {
        console.error(`  Error: ${plan.planId}: ${e}`);
      }
    }
  }

  // Save updated caches
  if (apiFetches > 0) {
    savePlanDetailCache(args.cacheDir, planDetailCache);
  }
  if (detailCacheHits > 0 || apiFetches > 0) {
    saveCalculationCache(args.cacheDir, calcCache);
  }

  console.log(`\nAnalyzed ${costs.length} plans (${calcCacheHits} calc cached, ${detailCacheHits} detail cached, ${apiFetches} fetched, ${errors} errors)`);

  if (costs.length === 0) {
    console.error('No valid plans could be analyzed.');
    process.exit(1);
  }

  // Sort by net cost (ascending)
  costs.sort((a, b) => a.netCost - b.netCost);

  // Display top N
  const topN = costs.slice(0, args.top);

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`TOP ${args.top} CHEAPEST PLANS FOR POSTCODE ${args.postcode}`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`Based on ${usage.days} days of actual usage data\n`);

  console.log(
    '#'.padStart(3) +
    'Plan'.padEnd(35) +
    'Retailer'.padEnd(20) +
    'Net Cost'.padStart(12) +
    'Annual'.padStart(12)
  );
  console.log('-'.repeat(82));

  for (let i = 0; i < topN.length; i++) {
    const c = topN[i]!;
    const rank = (i + 1).toString();
    const planName = c.planName.slice(0, 33);
    const retailer = c.retailer.slice(0, 18);

    console.log(
      rank.padStart(3) +
      ` ${planName.padEnd(34)}` +
      retailer.padEnd(20) +
      `$${c.netCost.toFixed(2)}`.padStart(12) +
      `$${c.annualizedCost.toFixed(0)}/yr`.padStart(12)
    );
  }

  // Detailed view of top 3
  console.log(`\n${'═'.repeat(80)}`);
  console.log('TOP 3 PLAN DETAILS');
  console.log(`${'═'.repeat(80)}`);

  for (let i = 0; i < Math.min(3, topN.length); i++) {
    const c = topN[i]!;
    console.log(`\n#${i + 1}: ${c.planName}`);
    console.log(`    Retailer: ${c.retailer}`);
    console.log(`    Plan ID: ${c.planId}`);
    console.log('-'.repeat(50));
    console.log(`    Daily supply: $${c.dailySupplyCharge.toFixed(4)}/day`);
    console.log(`    Import cost:  $${c.importCost.toFixed(2)}`);
    console.log(`    Feed-in:      $${c.feedInRevenue.toFixed(2)}`);
    console.log(`    Net cost:     $${c.netCost.toFixed(2)} (over ${usage.days} days)`);
    console.log(`    Annualized:   $${c.annualizedCost.toFixed(0)}/year`);
    console.log(`    Avg import:   $${c.avgImportRate.toFixed(4)}/kWh`);

    // Show rates
    const t = c.tariff;
    const periods = t.periods['everyday'] ?? t.periods[Object.keys(t.periods)[0]!] ?? [];
    console.log('    Rates:');
    for (const p of periods.sort((a, b) => b.rate - a.rate)) {
      console.log(`      ${p.name.padEnd(12)} $${p.rate.toFixed(4)}/kWh`);
    }
    console.log(`    Feed-in:      $${t.feedInTariff.toFixed(4)}/kWh`);
  }

  // Savings comparison
  if (topN.length >= 2) {
    const cheapest = topN[0]!;
    const second = topN[1]!;
    const savings = second.annualizedCost - cheapest.annualizedCost;

    console.log(`\n${'═'.repeat(80)}`);
    console.log('POTENTIAL SAVINGS');
    console.log(`${'═'.repeat(80)}`);
    console.log(`Switching to "${cheapest.planName}" saves ~$${savings.toFixed(0)}/year vs #2`);
  }

  // Convert command hint
  console.log(`\n${'─'.repeat(80)}`);
  console.log('To save a plan as a tariff file for calculate-bill.ts:');
  console.log(`  npx tsx tariff-scraper.ts convert --retailer=${topN[0]?.retailerCode} --plan-id="${topN[0]?.planId}"`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
