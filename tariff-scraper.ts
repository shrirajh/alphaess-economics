#!/usr/bin/env npx tsx
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tariff, TariffPeriodDef, FeedInPeriodDef } from './tariff-utils.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface ScraperConfig {
  filters: {
    fuelType: string;
    customerType: string;
  };
  cache: {
    enabled: boolean;
    ttlHours: number;
    directory: string;
    endpointsFile: string;
  };
  output: {
    directory: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CDR API TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface CDREndpoint {
  brand: string;
  brandName: string;
  logoUri?: string;
  dataHolderBrandId?: string;
  endpointDetail: {
    publicBaseUri: string;
  };
  status?: string;
}

interface CDREndpointsFile {
  fetchedAt: string;
  endpoints: CDREndpoint[];
}

interface CDRPlanListResponse {
  data: {
    plans: CDRPlanSummary[];
  };
  links: {
    self: string;
    next?: string;
  };
  meta: {
    totalRecords: number;
    totalPages: number;
  };
}

interface CDRPlanSummary {
  planId: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  lastUpdated: string;
  displayName?: string;
  description?: string;
  type: string;
  fuelType: string;
  brand: string;
  brandName: string;
  applicationUri?: string;
  customerType?: string;
  geography?: {
    distributors?: string[];
    includedPostcodes?: string[];
    excludedPostcodes?: string[];
  };
}

interface CDRPlanDetailResponse {
  data: CDRPlanDetail;
  links: { self: string };
  meta: Record<string, unknown>;
}

interface CDRPlanDetail extends CDRPlanSummary {
  meteringCharges?: Array<{
    displayName: string;
    description?: string;
    minimumValue?: string;
    maximumValue?: string;
    period?: string;
  }>;
  gasContract?: unknown;
  electricityContract?: CDRElectricityContract;
}

interface CDRElectricityContract {
  additionalFeeInformation?: string;
  pricingModel: string;
  timeZone?: string;
  isFixed?: boolean;
  variation?: string;
  onExpiryDescription?: string;
  paymentOption?: string[];
  intrinsicGreenPower?: {
    greenPercentage?: string;
  };
  controlledLoad?: Array<{
    displayName: string;
    rateBlockUType: string;
    startDate?: string;
    endDate?: string;
    singleRate?: CDRSingleRate;
    timeOfUseRates?: CDRTimeOfUseRate[];
  }>;
  incentives?: Array<{
    displayName: string;
    description: string;
    category: string;
    eligibility?: string;
  }>;
  discounts?: Array<{
    displayName: string;
    description?: string;
    type: string;
    category?: string;
    endDate?: string;
    methodUType: string;
    percentOfBill?: { rate: string };
    percentOfUse?: { rate: string };
    fixedAmount?: { amount: string };
    percentOverThreshold?: { rate: string; usageAmount: string };
  }>;
  greenPowerCharges?: Array<{
    displayName: string;
    description?: string;
    scheme: string;
    type: string;
    tiers: Array<{
      percentGreen: string;
      rate?: string;
      amount?: string;
    }>;
  }>;
  eligibility?: Array<{
    type: string;
    information: string;
    description?: string;
  }>;
  fees?: Array<{
    type: string;
    term: string;
    amount?: string;
    rate?: string;
    description?: string;
  }>;
  solarFeedInTariff?: CDRSolarFeedIn[];
  tariffPeriod: CDRTariffPeriod[];
}

interface CDRTariffPeriod {
  type?: string;
  displayName?: string;
  startDate?: string;
  endDate?: string;
  dailySupplyCharge?: string;       // Singular (CDR standard)
  dailySupplyCharges?: string;      // Plural (some APIs)
  dailySupplyChargeType?: string;
  rateBlockUType?: string;
  singleRate?: CDRSingleRate;
  timeOfUseRates?: CDRTimeOfUseRate[];
  demandCharges?: CDRDemandCharge[];
}

interface CDRSingleRate {
  displayName?: string;
  description?: string;
  generalUnitPrice?: string;
  rates: Array<{
    unitPrice: string;
    measureUnit?: string;
    volume?: number;
  }>;
  period?: string;
}

interface CDRTimeOfUseRate {
  displayName?: string;
  description?: string;
  rates: Array<{
    unitPrice: string;
    measureUnit?: string;
    volume?: number;
  }>;
  timeOfUse: Array<{
    days: string[];
    startTime: string;
    endTime: string;
    additionalInfo?: string;
    additionalInfoUri?: string;
  }>;
  type: string;
}

interface CDRDemandCharge {
  displayName?: string;
  description?: string;
  amount?: string;
  measureUnit?: string;
  startTime: string;
  endTime: string;
  days?: string[];
  minDemand?: string;
  maxDemand?: string;
  measurementPeriod: string;
  chargePeriod: string;
}

interface CDRSolarFeedIn {
  displayName: string;
  description?: string;
  scheme: string;
  payerType: string;
  tariffUType: string;
  singleTariff?: {
    amount: string;
  };
  timeVaryingTariffs?: Array<{
    type?: string;
    displayName?: string;
    amount?: string;
    rates?: Array<{ unitPrice: string }>;
    timeVariations: Array<{
      days?: string[];
      startTime: string;
      endTime: string;
    }>;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════

class ScraperError extends Error {
  constructor(
    message: string,
    public code: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ScraperError';
  }
}

const ERROR_CODES = {
  API_UNAVAILABLE: 'API_UNAVAILABLE',
  PLAN_NOT_FOUND: 'PLAN_NOT_FOUND',
  RATE_PARSE_ERROR: 'RATE_PARSE_ERROR',
  TIME_PARSE_ERROR: 'TIME_PARSE_ERROR',
  INCOMPLETE_COVERAGE: 'INCOMPLETE_COVERAGE',
  NO_ENDPOINTS: 'NO_ENDPOINTS',
  CONFIG_ERROR: 'CONFIG_ERROR',
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

let currentLogLevel: LogLevel = 'INFO';

function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (LOG_LEVELS[level] >= LOG_LEVELS[currentLogLevel]) {
    const prefix = `[${level}]`;
    const contextStr = context ? ' ' + JSON.stringify(context) : '';
    console.log(`${prefix} ${message}${contextStr}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

function loadConfig(configPath?: string): ScraperConfig {
  const defaultPath = './scraper-config.json';
  const filePath = configPath ?? defaultPath;

  if (!fs.existsSync(filePath)) {
    throw new ScraperError(`Config file not found: ${filePath}`, ERROR_CODES.CONFIG_ERROR);
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ScraperConfig;
}

// ═══════════════════════════════════════════════════════════════════════════
// CACHE LAYER
// ═══════════════════════════════════════════════════════════════════════════

function ensureCacheDir(config: ScraperConfig): void {
  if (!fs.existsSync(config.cache.directory)) {
    fs.mkdirSync(config.cache.directory, { recursive: true });
  }
}

function getCachePath(config: ScraperConfig, key: string): string {
  return path.join(config.cache.directory, `${key}.json`);
}

function isCacheValid(cachePath: string, ttlHours: number): boolean {
  if (!fs.existsSync(cachePath)) return false;

  const stats = fs.statSync(cachePath);
  const ageMs = Date.now() - stats.mtimeMs;
  const ttlMs = ttlHours * 60 * 60 * 1000;

  return ageMs < ttlMs;
}

function readCache<T>(cachePath: string): T | null {
  if (!fs.existsSync(cachePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeCache<T>(cachePath: string, data: T): void {
  const dir = path.dirname(cachePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
}

// ═══════════════════════════════════════════════════════════════════════════
// CDR ENDPOINT DISCOVERY
// ═══════════════════════════════════════════════════════════════════════════

const EME_REGISTER_URL = 'https://api.energymadeeasy.gov.au/refdata2?keys=organisations';

async function discoverEndpoints(config: ScraperConfig, force: boolean = false): Promise<CDREndpointsFile> {
  const endpointsPath = config.cache.endpointsFile;

  // Check cache first
  if (!force && isCacheValid(endpointsPath, config.cache.ttlHours * 7)) { // Endpoints cached for 7x longer
    const cached = readCache<CDREndpointsFile>(endpointsPath);
    if (cached) {
      log('INFO', `Using cached endpoints from ${endpointsPath}`);
      return cached;
    }
  }

  log('INFO', 'Discovering CDR endpoints from API...');

  // Try the Energy Made Easy API first for energy-specific endpoints
  try {
    const response = await fetch(EME_REGISTER_URL, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TariffScraper/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as {
      data?: {
        organisations?: Record<string, {
          orgId: string;
          orgName: string;
          tradingName?: string;
          cdrCode?: string;
          cdrBrand?: string;
          logo?: string;
          orgStatus?: string;
        }>;
      };
    };

    const endpoints: CDREndpoint[] = [];
    const orgs = data.data?.organisations;

    if (orgs) {
      for (const org of Object.values(orgs)) {
        // Only include active organisations with CDR codes
        if (org.cdrCode && org.orgStatus === 'active') {
          endpoints.push({
            brand: org.cdrCode,
            brandName: org.tradingName ?? org.orgName,
            logoUri: org.logo ? `https://www.energymadeeasy.gov.au${org.logo}` : undefined,
            dataHolderBrandId: org.cdrBrand,
            endpointDetail: {
              publicBaseUri: `https://cdr.energymadeeasy.gov.au/${org.cdrCode}`,
            },
            status: org.orgStatus,
          });
        }
      }
    }

    if (endpoints.length === 0) {
      throw new Error('No CDR endpoints found in response');
    }

    const result: CDREndpointsFile = {
      fetchedAt: new Date().toISOString(),
      endpoints,
    };

    writeCache(endpointsPath, result);
    log('INFO', `Discovered ${endpoints.length} CDR endpoints, cached to ${endpointsPath}`);

    return result;
  } catch (error) {
    log('WARN', `Failed to fetch from EME API: ${error}`);

    // Fallback: try known CDR endpoint pattern
    log('INFO', 'Falling back to known CDR endpoint patterns...');

    const knownRetailers = [
      { code: 'agl', name: 'AGL' },
      { code: 'origin', name: 'Origin Energy' },
      { code: 'energyaustralia', name: 'EnergyAustralia' },
      { code: 'alinta', name: 'Alinta Energy' },
      { code: 'red-energy', name: 'Red Energy' },
      { code: 'lumo', name: 'Lumo Energy' },
      { code: 'momentum', name: 'Momentum Energy' },
      { code: 'globird', name: 'GloBird Energy' },
      { code: 'powershop', name: 'Powershop' },
      { code: 'amber', name: 'Amber Electric' },
      { code: 'reamped', name: 'ReAmped Energy' },
      { code: 'sumo', name: 'Sumo' },
      { code: 'tango', name: 'Tango Energy' },
      { code: 'diamond', name: 'Diamond Energy' },
      { code: 'simply', name: 'Simply Energy' },
      { code: 'dodo', name: 'Dodo Power & Gas' },
      { code: 'nectr', name: 'Nectr' },
      { code: 'energy-locals', name: 'Energy Locals' },
    ];

    const endpoints: CDREndpoint[] = knownRetailers.map(r => ({
      brand: r.code,
      brandName: r.name,
      endpointDetail: {
        publicBaseUri: `https://cdr.energymadeeasy.gov.au/${r.code}`,
      },
      status: 'UNKNOWN',
    }));

    const result: CDREndpointsFile = {
      fetchedAt: new Date().toISOString(),
      endpoints,
    };

    writeCache(endpointsPath, result);
    log('WARN', `Using ${endpoints.length} fallback CDR endpoints (status unknown)`);

    return result;
  }
}

function getEndpointForRetailer(endpoints: CDREndpointsFile, retailerCode: string): CDREndpoint | undefined {
  return endpoints.endpoints.find(e =>
    e.brand.toLowerCase() === retailerCode.toLowerCase() ||
    e.brandName.toLowerCase().includes(retailerCode.toLowerCase())
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CDR API CLIENT
// ═══════════════════════════════════════════════════════════════════════════

async function fetchWithRetry(url: string, options: RequestInit, retries = 3): Promise<Response> {
  let lastError: Error | null = null;

  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);

      if (response.status === 429) {
        // Rate limited - wait and retry
        const retryAfter = parseInt(response.headers.get('Retry-After') ?? '5', 10);
        log('WARN', `Rate limited, waiting ${retryAfter}s before retry ${i + 1}/${retries}`);
        await sleep(retryAfter * 1000);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error as Error;
      log('WARN', `Fetch failed (attempt ${i + 1}/${retries}): ${lastError.message}`);
      await sleep(1000 * (i + 1)); // Exponential backoff
    }
  }

  throw lastError ?? new Error('Fetch failed after retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchCDRPlans(
  endpoint: CDREndpoint,
  config: ScraperConfig,
  page: number = 1
): Promise<CDRPlanListResponse> {
  const baseUri = endpoint.endpointDetail.publicBaseUri;
  const url = new URL(`${baseUri}/cds-au/v1/energy/plans`);

  url.searchParams.set('page', page.toString());
  url.searchParams.set('page-size', '25');
  url.searchParams.set('fuelType', config.filters.fuelType);

  log('DEBUG', `Fetching plans from ${url.toString()}`);

  const response = await fetchWithRetry(url.toString(), {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'x-v': '1',
      'x-min-v': '1',
    },
  });

  if (!response.ok) {
    throw new ScraperError(
      `Failed to fetch plans: HTTP ${response.status}`,
      ERROR_CODES.API_UNAVAILABLE,
      { url: url.toString(), status: response.status }
    );
  }

  return await response.json() as CDRPlanListResponse;
}

async function fetchAllCDRPlans(
  endpoint: CDREndpoint,
  config: ScraperConfig
): Promise<CDRPlanSummary[]> {
  const allPlans: CDRPlanSummary[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const response = await fetchCDRPlans(endpoint, config, page);
    allPlans.push(...response.data.plans);
    totalPages = response.meta.totalPages;
    log('INFO', `Fetched page ${page}/${totalPages} (${response.data.plans.length} plans)`);
    page++;

    if (page <= totalPages) {
      await sleep(1500); // Rate limit protection
    }
  } while (page <= totalPages);

  return allPlans;
}

async function fetchCDRPlanDetail(
  endpoint: CDREndpoint,
  planId: string
): Promise<CDRPlanDetailResponse> {
  const baseUri = endpoint.endpointDetail.publicBaseUri;
  const encodedPlanId = encodeURIComponent(planId);
  const url = `${baseUri}/cds-au/v1/energy/plans/${encodedPlanId}`;

  log('DEBUG', `Fetching plan detail from ${url}`);

  const response = await fetchWithRetry(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'x-v': '3',
      'x-min-v': '1',
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new ScraperError(
        `Plan not found: ${planId}`,
        ERROR_CODES.PLAN_NOT_FOUND,
        { planId }
      );
    }
    throw new ScraperError(
      `Failed to fetch plan detail: HTTP ${response.status}`,
      ERROR_CODES.API_UNAVAILABLE,
      { url, status: response.status }
    );
  }

  return await response.json() as CDRPlanDetailResponse;
}

// ═══════════════════════════════════════════════════════════════════════════
// TIME & DAY PARSING UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

function parseTimeToHour(time: string): number {
  // Handle formats: "15:00", "3pm", "15:00:00", "1500"
  const normalized = time.trim().toLowerCase();

  // Check for am/pm format
  const ampmMatch = normalized.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)$/);
  if (ampmMatch) {
    let hour = parseInt(ampmMatch[1]!, 10);
    const isPM = ampmMatch[4] === 'pm';
    if (isPM && hour !== 12) hour += 12;
    if (!isPM && hour === 12) hour = 0;
    return hour;
  }

  // Check for 24h format with colons
  const colonMatch = normalized.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (colonMatch) {
    return parseInt(colonMatch[1]!, 10);
  }

  // Check for 4-digit format (1500)
  const fourDigitMatch = normalized.match(/^(\d{2})(\d{2})$/);
  if (fourDigitMatch) {
    return parseInt(fourDigitMatch[1]!, 10);
  }

  throw new ScraperError(
    `Cannot parse time: ${time}`,
    ERROR_CODES.TIME_PARSE_ERROR,
    { time }
  );
}

function parseTimeRangeToHours(startTime: string, endTime: string): number[] {
  const startHour = parseTimeToHour(startTime);
  const endHour = parseTimeToHour(endTime);

  const hours: number[] = [];

  if (endHour <= startHour) {
    // Overnight range: 21:00 to 06:00
    for (let h = startHour; h < 24; h++) hours.push(h);
    for (let h = 0; h < endHour; h++) hours.push(h);
  } else {
    // Same day range: 15:00 to 21:00
    for (let h = startHour; h < endHour; h++) hours.push(h);
  }

  return hours;
}

const DAY_MAP: Record<string, number> = {
  'monday': 0, 'mon': 0,
  'tuesday': 1, 'tue': 1,
  'wednesday': 2, 'wed': 2,
  'thursday': 3, 'thu': 3,
  'friday': 4, 'fri': 4,
  'saturday': 5, 'sat': 5,
  'sunday': 6, 'sun': 6,
};

const DAY_CHARS = 'MTWTFSS';

function daysToDayPattern(days: string[]): string {
  if (!days || days.length === 0) {
    return 'MTWTFSS'; // Default to all days
  }

  const pattern = ['_', '_', '_', '_', '_', '_', '_'];

  for (const day of days) {
    const normalized = day.toLowerCase().trim();
    const index = DAY_MAP[normalized];
    if (index !== undefined) {
      pattern[index] = DAY_CHARS[index]!;
    }
  }

  return pattern.join('');
}

function isAllDays(pattern: string): boolean {
  return pattern === 'MTWTFSS';
}

// ═══════════════════════════════════════════════════════════════════════════
// RATE NAME NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════

const RATE_NAME_MAP: Record<string, string> = {
  'peak': 'peak',
  'peak usage': 'peak',
  'peak rate': 'peak',
  'off peak': 'offpeak',
  'off-peak': 'offpeak',
  'offpeak': 'offpeak',
  'off_peak': 'offpeak',
  'off peak usage': 'offpeak',
  'shoulder': 'shoulder',
  'shoulder usage': 'shoulder',
  'solar sponge': 'solar_sponge',
  'controlled load': 'controlled',
  'controlled load 1': 'controlled1',
  'controlled load 2': 'controlled2',
  'anytime': 'anytime',
  'flat': 'anytime',
  'general usage': 'anytime',
  'all time': 'anytime',
  // CDR API type values
  'PEAK': 'peak',
  'OFF_PEAK': 'offpeak',
  'SHOULDER': 'shoulder',
  'ALL_DAY': 'anytime',
};

function normalizeRateName(name: string): string {
  // Check original case first (for CDR type values like PEAK, OFF_PEAK)
  if (RATE_NAME_MAP[name]) {
    return RATE_NAME_MAP[name]!;
  }
  const normalized = name.toLowerCase().trim();
  return RATE_NAME_MAP[normalized] ?? normalized.replace(/\s+/g, '_');
}

// ═══════════════════════════════════════════════════════════════════════════
// CDR TO TARIFF CONVERSION
// ═══════════════════════════════════════════════════════════════════════════

interface RawPeriod {
  name: string;
  hours: number[];
  rate: number;
  dayPattern: string;
}

function consolidatePeriods(rawPeriods: RawPeriod[]): Map<string, TariffPeriodDef[]> {
  // Group by day pattern
  const byDayPattern = new Map<string, RawPeriod[]>();

  for (const period of rawPeriods) {
    const key = period.dayPattern;
    if (!byDayPattern.has(key)) {
      byDayPattern.set(key, []);
    }
    byDayPattern.get(key)!.push(period);
  }

  const result = new Map<string, TariffPeriodDef[]>();

  for (const [dayPattern, periods] of Array.from(byDayPattern)) {
    // Group periods by name within this day pattern
    const byName = new Map<string, RawPeriod[]>();
    for (const p of periods) {
      if (!byName.has(p.name)) {
        byName.set(p.name, []);
      }
      byName.get(p.name)!.push(p);
    }

    const consolidated: TariffPeriodDef[] = [];

    for (const [name, sameName] of Array.from(byName)) {
      // Merge all hours for same name (assuming same rate)
      const allHours = new Set<number>();
      let rate = sameName[0]!.rate;

      for (const p of sameName) {
        for (const h of p.hours) {
          allHours.add(h);
        }
        // Use the most common rate if they differ
        rate = p.rate;
      }

      consolidated.push({
        name,
        hours: Array.from(allHours).sort((a, b) => a - b),
        rate,
      });
    }

    // Determine day type name
    let dayTypeName: string;
    if (isAllDays(dayPattern)) {
      dayTypeName = 'everyday';
    } else if (dayPattern === 'MTWTF__') {
      dayTypeName = 'weekday';
    } else if (dayPattern === '_____SS') {
      dayTypeName = 'weekend';
    } else {
      dayTypeName = `days_${dayPattern.replace(/_/g, '')}`;
    }

    result.set(dayTypeName, consolidated);
  }

  return result;
}

function validateHourCoverage(periods: TariffPeriodDef[], label: string): void {
  const covered = new Set<number>();
  for (const period of periods) {
    for (const h of period.hours) {
      covered.add(h);
    }
  }

  if (covered.size !== 24) {
    const missing: number[] = [];
    for (let h = 0; h < 24; h++) {
      if (!covered.has(h)) missing.push(h);
    }
    log('WARN', `${label}: Missing hours ${missing.join(', ')}`);
  }
}

function parseCDRPlanToTariff(plan: CDRPlanDetail): Tariff | null {
  const contract = plan.electricityContract;
  if (!contract) {
    log('WARN', `Plan ${plan.planId} has no electricity contract`);
    return null;
  }

  // Extract daily supply charge (handle both singular and plural field names)
  let dailySupplyCharge = 0;
  for (const period of contract.tariffPeriod) {
    const dsc = period.dailySupplyCharge ?? period.dailySupplyCharges;
    if (dsc) {
      dailySupplyCharge = parseFloat(dsc);
      break;
    }
  }

  // Parse usage rates
  const rawPeriods: RawPeriod[] = [];

  for (const tariffPeriod of contract.tariffPeriod) {
    // Handle single rate
    if (tariffPeriod.singleRate) {
      const sr = tariffPeriod.singleRate;
      const rate = sr.rates[0]?.unitPrice ? parseFloat(sr.rates[0].unitPrice) : 0;
      rawPeriods.push({
        name: normalizeRateName(sr.displayName ?? 'anytime'),
        hours: Array.from({ length: 24 }, (_, i) => i),
        rate,
        dayPattern: 'MTWTFSS',
      });
    }

    // Handle time of use rates
    if (tariffPeriod.timeOfUseRates) {
      for (const touRate of tariffPeriod.timeOfUseRates) {
        const rate = touRate.rates[0]?.unitPrice ? parseFloat(touRate.rates[0].unitPrice) : 0;
        // Prefer type (PEAK, OFF_PEAK) over displayName (Tariff 1, Tariff 2)
        const name = normalizeRateName(touRate.type ?? touRate.displayName ?? 'unknown');

        for (const tou of touRate.timeOfUse) {
          const hours = parseTimeRangeToHours(tou.startTime, tou.endTime);
          const dayPattern = daysToDayPattern(tou.days);

          rawPeriods.push({
            name,
            hours,
            rate,
            dayPattern,
          });
        }
      }
    }
  }

  if (rawPeriods.length === 0) {
    log('WARN', `Plan ${plan.planId} has no parseable rates`);
    return null;
  }

  // Consolidate periods
  const consolidatedPeriods = consolidatePeriods(rawPeriods);

  // Build dayTypes
  const dayTypes: Record<string, string> = {};
  const periods: Record<string, TariffPeriodDef[]> = {};

  for (const [dayTypeName, defs] of Array.from(consolidatedPeriods)) {
    // Determine the day pattern for this day type
    let pattern: string;
    if (dayTypeName === 'everyday') pattern = 'MTWTFSS';
    else if (dayTypeName === 'weekday') pattern = 'MTWTF__';
    else if (dayTypeName === 'weekend') pattern = '_____SS';
    else pattern = 'MTWTFSS'; // Default

    dayTypes[dayTypeName] = pattern;
    periods[dayTypeName] = defs;

    validateHourCoverage(defs, `${plan.planId}/${dayTypeName}`);
  }

  // Parse feed-in tariffs
  let feedInTariff = 0;
  let feedInPeriods: Record<string, FeedInPeriodDef[]> | undefined;

  if (contract.solarFeedInTariff && contract.solarFeedInTariff.length > 0) {
    const feedInRaws: RawPeriod[] = [];

    for (const fit of contract.solarFeedInTariff) {
      // Single tariff (flat rate)
      if (fit.singleTariff) {
        feedInTariff = parseFloat(fit.singleTariff.amount);
      }

      // Time varying tariffs
      if (fit.timeVaryingTariffs) {
        for (const tvt of fit.timeVaryingTariffs) {
          // Rate can be in tvt.amount (old format) or tvt.rates[0].unitPrice (CDR format)
          const rateStr = (tvt as { amount?: string }).amount ?? tvt.rates?.[0]?.unitPrice ?? '0';
          const rate = parseFloat(rateStr);
          // Prefer type (PEAK, OFF_PEAK, SHOULDER) over displayName
          const name = normalizeRateName(tvt.type ?? tvt.displayName ?? 'export');

          for (const tv of tvt.timeVariations) {
            const hours = parseTimeRangeToHours(tv.startTime, tv.endTime);
            const dayPattern = daysToDayPattern(tv.days ?? []);

            feedInRaws.push({
              name,
              hours,
              rate,
              dayPattern,
            });
          }
        }
      }
    }

    // Check if all feed-in rates are the same (flat rate)
    if (feedInRaws.length > 0) {
      const rates = feedInRaws.map(r => r.rate);
      const allSame = rates.every(r => r === rates[0]);

      if (allSame) {
        feedInTariff = rates[0] ?? 0;
      } else {
        // TOU feed-in
        feedInTariff = Math.max(...rates); // Use highest as fallback
        const consolidated = consolidatePeriods(feedInRaws);
        feedInPeriods = {};
        for (const [dayTypeName, defs] of Array.from(consolidated)) {
          feedInPeriods[dayTypeName] = defs.map(d => ({
            name: d.name,
            hours: d.hours,
            rate: d.rate,
          }));
        }
      }
    }
  }

  // Determine state from geography
  let state = 'Unknown';
  if (plan.geography?.distributors) {
    const dist = plan.geography.distributors[0] ?? '';
    if (dist.includes('United Energy') || dist.includes('Powercor') || dist.includes('CitiPower') ||
        dist.includes('Jemena') || dist.includes('AusNet')) {
      state = 'VIC';
    } else if (dist.includes('Ausgrid') || dist.includes('Endeavour') || dist.includes('Essential')) {
      state = 'NSW';
    } else if (dist.includes('Energex') || dist.includes('Ergon')) {
      state = 'QLD';
    } else if (dist.includes('SA Power')) {
      state = 'SA';
    } else if (dist.includes('Western Power')) {
      state = 'WA';
    } else if (dist.includes('TasNetworks')) {
      state = 'TAS';
    }
  }

  return {
    name: `${plan.displayName ?? plan.planId} (${state})`,
    provider: plan.brandName,
    state,
    dailySupplyCharge,
    feedInTariff,
    feedInPeriods,
    dayTypes,
    periods,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI COMMANDS
// ═══════════════════════════════════════════════════════════════════════════

interface CliArgs {
  command: string;
  retailer?: string;
  planId?: string;
  output?: string;
  all?: boolean;
  force?: boolean;
  verbose?: boolean;
  config?: string;
  endpoints?: string;
  limit?: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = { command: args[0] ?? 'help' };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--retailer=')) {
      result.retailer = arg.slice(11);
    } else if (arg.startsWith('--plan-id=') || arg.startsWith('--plan=')) {
      result.planId = arg.includes('=') ? arg.split('=')[1] : undefined;
    } else if (arg.startsWith('--output=')) {
      result.output = arg.slice(9);
    } else if (arg === '--all') {
      result.all = true;
    } else if (arg === '--force') {
      result.force = true;
    } else if (arg === '--verbose' || arg === '-v') {
      result.verbose = true;
    } else if (arg.startsWith('--config=')) {
      result.config = arg.slice(9);
    } else if (arg.startsWith('--endpoints=')) {
      result.endpoints = arg.slice(12);
    } else if (arg.startsWith('--limit=')) {
      result.limit = parseInt(arg.slice(8), 10);
    }
  }

  return result;
}

async function commandDiscover(config: ScraperConfig, args: CliArgs): Promise<void> {
  console.log('Discovering CDR endpoints...\n');

  const endpoints = await discoverEndpoints(config, args.force);

  console.log(`Found ${endpoints.endpoints.length} retailers:\n`);
  console.log('Code'.padEnd(20) + 'Name'.padEnd(30) + 'Status');
  console.log('-'.repeat(60));

  for (const ep of endpoints.endpoints.sort((a, b) => a.brand.localeCompare(b.brand))) {
    console.log(
      ep.brand.padEnd(20) +
      ep.brandName.slice(0, 28).padEnd(30) +
      (ep.status ?? 'UNKNOWN')
    );
  }

  console.log(`\nEndpoints cached to: ${config.cache.endpointsFile}`);
}

async function commandFetch(config: ScraperConfig, args: CliArgs): Promise<void> {
  const endpoints = await discoverEndpoints(config, false);

  if (!args.retailer && !args.all) {
    console.error('Error: Specify --retailer=CODE or --all');
    console.log('Available retailers:');
    for (const ep of endpoints.endpoints) {
      console.log(`  ${ep.brand}: ${ep.brandName}`);
    }
    process.exit(1);
  }

  let retailersToFetch: CDREndpoint[] = [];

  if (args.all) {
    retailersToFetch = [...endpoints.endpoints].sort((a, b) => a.brand.localeCompare(b.brand));
  } else {
    const endpoint = getEndpointForRetailer(endpoints, args.retailer!);
    if (!endpoint) {
      console.error(`Error: Retailer not found: ${args.retailer}`);
      console.log('Available retailers:');
      for (const ep of endpoints.endpoints) {
        console.log(`  ${ep.brand}: ${ep.brandName}`);
      }
      process.exit(1);
    }
    retailersToFetch.push(endpoint);
  }

  // Apply limit if specified
  if (args.limit && args.limit > 0) {
    retailersToFetch = retailersToFetch.slice(0, args.limit);
    console.log(`Limiting to first ${args.limit} retailers`);
  }

  ensureCacheDir(config);

  const totalCount = retailersToFetch.length;
  let fetchedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  // Polite mode: longer delays and skip already cached
  const isPolite = args.all && totalCount > 5;
  const delayBetweenRetailers = isPolite ? 5000 : 2000;  // 5s for bulk, 2s for single

  console.log(`\nFetching from ${totalCount} retailer(s)...`);
  if (isPolite) {
    console.log(`Polite mode: ${delayBetweenRetailers / 1000}s delay between retailers`);
    if (!args.force) {
      console.log(`Skipping retailers with valid cache (use --force to refresh)`);
    }
  }

  for (let i = 0; i < retailersToFetch.length; i++) {
    const endpoint = retailersToFetch[i]!;
    const progress = `[${i + 1}/${totalCount}]`;

    // Check if already cached (skip in polite mode unless --force)
    const cachePath = getCachePath(config, `plans-${endpoint.brand}`);
    if (isPolite && !args.force && isCacheValid(cachePath, config.cache.ttlHours)) {
      console.log(`${progress} ${endpoint.brand}: skipped (cached)`);
      skippedCount++;
      continue;
    }

    console.log(`${progress} ${endpoint.brandName}...`);

    try {
      const plans = await fetchAllCDRPlans(endpoint, config);

      // Filter for electricity and residential
      const filtered = plans.filter(p =>
        p.fuelType === 'ELECTRICITY' &&
        (!p.customerType || p.customerType === 'RESIDENTIAL')
      );

      // Cache the plan list
      writeCache(cachePath, {
        fetchedAt: new Date().toISOString(),
        retailer: endpoint.brand,
        retailerName: endpoint.brandName,
        plans: filtered,
      });

      console.log(`  ${filtered.length} plans cached`);
      fetchedCount++;

      // Rate limit between retailers (skip delay on last one)
      if (i < retailersToFetch.length - 1) {
        await sleep(delayBetweenRetailers);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`  Error: ${errMsg.slice(0, 60)}`);
      errorCount++;

      // Still delay after errors to be polite
      if (i < retailersToFetch.length - 1) {
        await sleep(delayBetweenRetailers);
      }
    }
  }

  console.log(`\nDone: ${fetchedCount} fetched, ${skippedCount} skipped, ${errorCount} errors`);
}

async function commandList(config: ScraperConfig, args: CliArgs): Promise<void> {
  if (!args.retailer) {
    // List all cached retailers
    const cacheDir = config.cache.directory;
    if (!fs.existsSync(cacheDir)) {
      console.log('No cached data. Run "fetch" first.');
      return;
    }

    const files = fs.readdirSync(cacheDir).filter(f => f.startsWith('plans-'));
    if (files.length === 0) {
      console.log('No cached plans. Run "fetch --retailer=CODE" first.');
      return;
    }

    console.log('Cached retailers:\n');
    for (const file of files) {
      const retailer = file.replace('plans-', '').replace('.json', '');
      const data = readCache<{ plans: CDRPlanSummary[]; fetchedAt: string }>(path.join(cacheDir, file));
      console.log(`  ${retailer}: ${data?.plans.length ?? 0} plans (fetched: ${data?.fetchedAt ?? 'unknown'})`);
    }
    return;
  }

  // List plans for specific retailer
  const cachePath = getCachePath(config, `plans-${args.retailer}`);
  const data = readCache<{ plans: CDRPlanSummary[]; retailerName: string; fetchedAt: string }>(cachePath);

  if (!data) {
    console.error(`No cached data for ${args.retailer}. Run "fetch --retailer=${args.retailer}" first.`);
    process.exit(1);
  }

  console.log(`\nPlans from ${data.retailerName} (fetched: ${data.fetchedAt}):\n`);
  console.log('Plan ID'.padEnd(25) + 'Name'.padEnd(40) + 'Type');
  console.log('-'.repeat(80));

  for (const plan of data.plans) {
    console.log(
      plan.planId.slice(0, 23).padEnd(25) +
      (plan.displayName ?? 'Unnamed').slice(0, 38).padEnd(40) +
      plan.type
    );
  }
}

async function commandInfo(config: ScraperConfig, args: CliArgs): Promise<void> {
  if (!args.retailer || !args.planId) {
    console.error('Error: Specify --retailer=CODE and --plan-id=ID');
    process.exit(1);
  }

  const endpoints = await discoverEndpoints(config, false);
  const endpoint = getEndpointForRetailer(endpoints, args.retailer);

  if (!endpoint) {
    console.error(`Error: Retailer not found: ${args.retailer}`);
    process.exit(1);
  }

  console.log(`Fetching plan ${args.planId} from ${endpoint.brandName}...`);

  const detail = await fetchCDRPlanDetail(endpoint, args.planId);
  console.log('\nPlan Details:\n');
  console.log(JSON.stringify(detail, null, 2));
}

async function commandConvert(config: ScraperConfig, args: CliArgs): Promise<void> {
  if (!args.retailer || !args.planId) {
    console.error('Error: Specify --retailer=CODE and --plan-id=ID');
    process.exit(1);
  }

  const endpoints = await discoverEndpoints(config, false);
  const endpoint = getEndpointForRetailer(endpoints, args.retailer);

  if (!endpoint) {
    console.error(`Error: Retailer not found: ${args.retailer}`);
    process.exit(1);
  }

  console.log(`Fetching plan ${args.planId} from ${endpoint.brandName}...`);

  const detail = await fetchCDRPlanDetail(endpoint, args.planId);
  const tariff = parseCDRPlanToTariff(detail.data);

  if (!tariff) {
    console.error('Error: Could not parse plan to tariff format');
    process.exit(1);
  }

  // Determine output path
  const outputDir = args.output ?? config.output.directory;
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const safeName = (tariff.name ?? args.planId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const outputPath = path.join(outputDir, `${safeName}.json`);

  fs.writeFileSync(outputPath, JSON.stringify(tariff, null, 2));
  console.log(`\nTariff saved to: ${outputPath}`);

  // Show summary
  console.log('\nTariff Summary:');
  console.log(`  Name: ${tariff.name}`);
  console.log(`  Provider: ${tariff.provider}`);
  console.log(`  State: ${tariff.state}`);
  console.log(`  Daily Supply: $${tariff.dailySupplyCharge?.toFixed(4) ?? 'N/A'}/day`);
  console.log(`  Feed-in: $${tariff.feedInTariff.toFixed(4)}/kWh`);

  console.log('\n  Periods:');
  for (const [dayType, periods] of Object.entries(tariff.periods)) {
    console.log(`    ${dayType} (${tariff.dayTypes[dayType]}):`);
    for (const p of periods) {
      console.log(`      ${p.name}: $${p.rate.toFixed(4)}/kWh (hours: ${p.hours.length})`);
    }
  }

  if (tariff.feedInPeriods) {
    console.log('\n  Feed-in Periods:');
    for (const [dayType, periods] of Object.entries(tariff.feedInPeriods)) {
      console.log(`    ${dayType}:`);
      for (const p of periods) {
        console.log(`      ${p.name}: $${p.rate.toFixed(4)}/kWh`);
      }
    }
  }
}

function commandHelp(): void {
  console.log(`
Energy Plan Tariff Scraper

Usage: npx tsx tariff-scraper.ts <command> [options]

Commands:
  discover              Discover and cache CDR retailer endpoints
  fetch                 Fetch plan list from retailer(s)
  list                  List cached plans
  info                  Show raw plan details
  convert               Convert plan to tariff JSON format
  help                  Show this help

Options:
  --retailer=CODE       Retailer code (e.g., globird, agl, origin)
  --plan-id=ID          Plan ID to fetch/convert
  --output=DIR          Output directory for converted tariffs
  --all                 Fetch from all discovered retailers (polite mode)
  --limit=N             Limit to first N retailers when using --all
  --force               Force refresh cached data
  --verbose, -v         Show debug output
  --config=PATH         Path to config file (default: ./scraper-config.json)
  --endpoints=PATH      Path to endpoints file (overrides config)

Examples:
  # Discover available retailers
  npx tsx tariff-scraper.ts discover

  # Fetch plans from a retailer
  npx tsx tariff-scraper.ts fetch --retailer=globird

  # Fetch from all retailers (polite: 5s delay, skips cached)
  npx tsx tariff-scraper.ts fetch --all

  # Fetch from first 10 retailers only
  npx tsx tariff-scraper.ts fetch --all --limit=10

  # Force refresh all retailers
  npx tsx tariff-scraper.ts fetch --all --force

  # List cached plans
  npx tsx tariff-scraper.ts list --retailer=globird

  # Convert a plan to tariff JSON
  npx tsx tariff-scraper.ts convert --retailer=globird --plan-id=GBI12345E

  # Then compare using calculate-bill.ts
  npx tsx calculate-bill.ts --tariff=./tariffs/new-plan.json
`);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.verbose) {
    setLogLevel('DEBUG');
  }

  if (args.command === 'help') {
    commandHelp();
    return;
  }

  const config = loadConfig(args.config);

  // Override endpoints file if specified
  if (args.endpoints) {
    config.cache.endpointsFile = args.endpoints;
  }

  switch (args.command) {
    case 'discover':
      await commandDiscover(config, args);
      break;
    case 'fetch':
      await commandFetch(config, args);
      break;
    case 'list':
      await commandList(config, args);
      break;
    case 'info':
      await commandInfo(config, args);
      break;
    case 'convert':
      await commandConvert(config, args);
      break;
    default:
      console.error(`Unknown command: ${args.command}`);
      commandHelp();
      process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
