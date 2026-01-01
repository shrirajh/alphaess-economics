import * as fs from 'node:fs';
import 'dotenv/config';

// ═══════════════════════════════════════════════════════════════════════════
// TARIFF TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface TariffPeriodDef {
  name: string;      // e.g., "peak", "offpeak", "shoulder"
  hours: number[];   // e.g., [6, 7, 8, 9] for 6am-10am
  rate: number;      // $/kWh
}

export interface FeedInPeriodDef {
  name: string;      // e.g., "peak-export", "midday-export"
  hours: number[];   // e.g., [16, 17, 18, 19, 20] for 4pm-9pm
  rate: number;      // $/kWh feed-in rate
}

export interface Tariff {
  name: string;
  provider?: string;
  state?: string;
  feedInTariff: number;  // Flat rate fallback
  feedInPeriods?: Record<string, FeedInPeriodDef[]>;  // Optional TOU feed-in by day type
  dayTypes: Record<string, string>;  // e.g., { "weekday": "MTWTF", "weekend": "SS" }
  periods: Record<string, TariffPeriodDef[]>;  // e.g., { "weekday": [...], "weekend": [...] }
}

export type TOUBreakdown = Record<string, number>;

export interface RateLookupResult {
  name: string;
  rate: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// DAY PATTERN MATCHING
// ═══════════════════════════════════════════════════════════════════════════

// Day index mapping: JS Date.getDay() returns 0=Sunday, 1=Monday, ..., 6=Saturday
// MTWTFSS notation: M=Mon(1), T=Tue(2), W=Wed(3), T=Thu(4), F=Fri(5), S=Sat(6), S=Sun(0)
const DAY_PATTERN_MAP: Record<number, number> = {
  0: 6,  // Sunday -> position 6 in MTWTFSS
  1: 0,  // Monday -> position 0
  2: 1,  // Tuesday -> position 1
  3: 2,  // Wednesday -> position 2
  4: 3,  // Thursday -> position 3
  5: 4,  // Friday -> position 4
  6: 5   // Saturday -> position 5
};

export function matchesDayPattern(dayOfWeek: number, pattern: string): boolean {
  const patternIndex = DAY_PATTERN_MAP[dayOfWeek] ?? 0;
  const char = pattern[patternIndex];
  return char !== undefined && char !== '_' && char !== ' ';
}

export function getDayType(dayOfWeek: number, tariff: Tariff): string {
  for (const [typeName, pattern] of Object.entries(tariff.dayTypes)) {
    if (matchesDayPattern(dayOfWeek, pattern)) {
      return typeName;
    }
  }
  // Fallback to first day type
  return Object.keys(tariff.dayTypes)[0] ?? 'weekday';
}

// ═══════════════════════════════════════════════════════════════════════════
// TARIFF LOADING
// ═══════════════════════════════════════════════════════════════════════════

export function loadTariff(tariffPath?: string): Tariff {
  // Check for explicit path first
  if (tariffPath) {
    try {
      const tariffData = JSON.parse(fs.readFileSync(tariffPath, 'utf8')) as Tariff;
      console.log(`📋 Loaded tariff: ${tariffData.name} from ${tariffPath}`);
      return tariffData;
    } catch (e) {
      console.error(`❌ Failed to load tariff from ${tariffPath}: ${e}`);
      throw e;
    }
  }

  // Check for --tariff= CLI arg
  const tariffArg = process.argv.find(a => a.startsWith('--tariff='))?.slice(9);

  if (tariffArg) {
    try {
      const tariffData = JSON.parse(fs.readFileSync(tariffArg, 'utf8')) as Tariff;
      console.log(`📋 Loaded tariff: ${tariffData.name} from ${tariffArg}`);
      return tariffData;
    } catch (e) {
      console.error(`❌ Failed to load tariff from ${tariffArg}: ${e}`);
      process.exit(1);
    }
  }

  // Check for default tariff file
  const defaultTariffPath = './tariffs/default.json';
  if (fs.existsSync(defaultTariffPath)) {
    try {
      const tariffData = JSON.parse(fs.readFileSync(defaultTariffPath, 'utf8')) as Tariff;
      console.log(`📋 Loaded tariff: ${tariffData.name}`);
      return tariffData;
    } catch (e) {
      console.warn(`⚠️  Failed to load default tariff: ${e}`);
    }
  }

  // Fallback to .env values (backward compatible)
  console.log(`📋 Using .env rates (no tariff file found)`);
  return createEnvTariff();
}

export function createEnvTariff(): Tariff {
  return {
    name: 'Default (.env)',
    feedInTariff: parseFloat(process.env.FEED_IN_TARIFF ?? '') || 0.06,
    dayTypes: {
      weekday: 'MTWTFSS'  // All days same (original behavior)
    },
    periods: {
      weekday: [
        { name: 'offpeak', hours: [1, 2, 3, 4, 5], rate: parseFloat(process.env.RATE_OFFPEAK ?? '') || 0.3362 },
        { name: 'peak', hours: [6, 7, 8, 9], rate: parseFloat(process.env.RATE_PEAK ?? '') || 0.4905 },
        { name: 'shoulder', hours: [10, 11, 12, 13, 14], rate: parseFloat(process.env.RATE_SHOULDER ?? '') || 0.2875 },
        { name: 'peak', hours: [15, 16, 17, 18, 19, 20, 21, 22, 23, 0], rate: parseFloat(process.env.RATE_PEAK ?? '') || 0.4905 }
      ]
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TARIFF HELPERS (bound to a specific tariff)
// ═══════════════════════════════════════════════════════════════════════════

export function createTariffHelpers(tariff: Tariff) {
  function getRateForPeriod(periodName: string): number {
    for (const periods of Object.values(tariff.periods)) {
      const period = periods.find(p => p.name === periodName);
      if (period) return period.rate;
    }
    return 0;
  }

  function calculateTOUCost(tou: TOUBreakdown): number {
    let total = 0;
    for (const [periodName, kwh] of Object.entries(tou)) {
      total += kwh * getRateForPeriod(periodName);
    }
    return total;
  }

  function calculateWeightedAvgRate(distribution: Record<string, number>): number {
    let total = 0;
    for (const [periodName, fraction] of Object.entries(distribution)) {
      total += fraction * getRateForPeriod(periodName);
    }
    return total;
  }

  function getRatePeriod(hour: number, dayOfWeek: number = 1): RateLookupResult {
    const dayType = getDayType(dayOfWeek, tariff);
    const periods = tariff.periods[dayType] ?? tariff.periods[Object.keys(tariff.periods)[0] ?? 'weekday'] ?? [];

    for (const period of periods) {
      if (period.hours.includes(hour)) {
        return { name: period.name, rate: period.rate };
      }
    }

    // Fallback to first period if hour not found
    const fallback = periods[0];
    return fallback ? { name: fallback.name, rate: fallback.rate } : { name: 'unknown', rate: 0 };
  }

  function emptyTOUBreakdown(): TOUBreakdown {
    const breakdown: TOUBreakdown = {};
    for (const periods of Object.values(tariff.periods)) {
      for (const period of periods) {
        breakdown[period.name] = 0;
      }
    }
    return breakdown;
  }

  function getPeriodsByRate(): { name: string; rate: number }[] {
    const periods: { name: string; rate: number }[] = [];
    const seen = new Set<string>();
    for (const dayPeriods of Object.values(tariff.periods)) {
      for (const p of dayPeriods) {
        if (!seen.has(p.name)) {
          seen.add(p.name);
          periods.push({ name: p.name, rate: p.rate });
        }
      }
    }
    return periods.sort((a, b) => b.rate - a.rate);
  }

  function getHighestRatePeriod(): { name: string; rate: number } {
    const sorted = getPeriodsByRate();
    return sorted[0] ?? { name: 'unknown', rate: 0 };
  }

  function getLowestRatePeriod(): { name: string; rate: number } {
    const sorted = getPeriodsByRate();
    return sorted[sorted.length - 1] ?? { name: 'unknown', rate: 0 };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FEED-IN TARIFF HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  function hasTOUFeedIn(): boolean {
    return tariff.feedInPeriods !== undefined && Object.keys(tariff.feedInPeriods).length > 0;
  }

  function getFeedInRate(hour: number, dayOfWeek: number = 1): RateLookupResult {
    // If no TOU feed-in defined, return flat rate
    if (!tariff.feedInPeriods) {
      return { name: 'flat', rate: tariff.feedInTariff };
    }

    const dayType = getDayType(dayOfWeek, tariff);
    const periods = tariff.feedInPeriods[dayType] ?? tariff.feedInPeriods[Object.keys(tariff.feedInPeriods)[0] ?? ''] ?? [];

    for (const period of periods) {
      if (period.hours.includes(hour)) {
        return { name: period.name, rate: period.rate };
      }
    }

    // Fallback to flat rate if hour not found in any period
    return { name: 'flat', rate: tariff.feedInTariff };
  }

  function emptyFeedInBreakdown(): TOUBreakdown {
    const breakdown: TOUBreakdown = {};
    if (tariff.feedInPeriods) {
      for (const periods of Object.values(tariff.feedInPeriods)) {
        for (const period of periods) {
          breakdown[period.name] = 0;
        }
      }
    }
    return breakdown;
  }

  function getFeedInRateForPeriod(periodName: string): number {
    if (!tariff.feedInPeriods) return tariff.feedInTariff;
    for (const periods of Object.values(tariff.feedInPeriods)) {
      const period = periods.find(p => p.name === periodName);
      if (period) return period.rate;
    }
    return tariff.feedInTariff;
  }

  function calculateFeedInRevenue(exportByFeedInPeriod: TOUBreakdown): number {
    // If no TOU feed-in or empty breakdown, use flat rate with total
    if (!tariff.feedInPeriods || Object.keys(exportByFeedInPeriod).length === 0) {
      const total = Object.values(exportByFeedInPeriod).reduce((sum, v) => sum + v, 0);
      return total * tariff.feedInTariff;
    }

    let revenue = 0;
    for (const [periodName, kwh] of Object.entries(exportByFeedInPeriod)) {
      revenue += kwh * getFeedInRateForPeriod(periodName);
    }
    return revenue;
  }

  function getFeedInPeriodsByRate(): { name: string; rate: number }[] {
    if (!tariff.feedInPeriods) {
      return [{ name: 'flat', rate: tariff.feedInTariff }];
    }
    const periods: { name: string; rate: number }[] = [];
    const seen = new Set<string>();
    for (const dayPeriods of Object.values(tariff.feedInPeriods)) {
      for (const p of dayPeriods) {
        if (!seen.has(p.name)) {
          seen.add(p.name);
          periods.push({ name: p.name, rate: p.rate });
        }
      }
    }
    return periods.sort((a, b) => b.rate - a.rate);
  }

  return {
    tariff,
    getRateForPeriod,
    calculateTOUCost,
    calculateWeightedAvgRate,
    getRatePeriod,
    emptyTOUBreakdown,
    getPeriodsByRate,
    getHighestRatePeriod,
    getLowestRatePeriod,
    // Feed-in helpers
    hasTOUFeedIn,
    getFeedInRate,
    emptyFeedInBreakdown,
    getFeedInRateForPeriod,
    calculateFeedInRevenue,
    getFeedInPeriodsByRate,
  };
}

export type TariffHelpers = ReturnType<typeof createTariffHelpers>;

// ═══════════════════════════════════════════════════════════════════════════
// TOU UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

export function addTOU(target: TOUBreakdown, source: TOUBreakdown): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

export function touTotal(tou: TOUBreakdown): number {
  let sum = 0;
  for (const value of Object.values(tou)) {
    sum += value;
  }
  return sum;
}

export function touPercentages(tou: TOUBreakdown): Record<string, number> {
  const total = touTotal(tou);
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(tou)) {
    result[key] = total > 0 ? (value / total) * 100 : 0;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS (configurable via .env)
// ═══════════════════════════════════════════════════════════════════════════

export const BATTERY_COST = parseFloat(process.env.BATTERY_COST_PER_10KWH ?? '') || 10000;
export const BATTERY_SIZE_KWH = 10;
export const BATTERY_LIFESPAN_YEARS = parseFloat(process.env.BATTERY_LIFESPAN_YEARS ?? '') || 10;
export const BATTERY_EFFICIENCY = 0.90;
export const USABLE_CAPACITY_PERCENT = 0.90;
export const MAX_CHARGE_RATE_KW = 5;
export const SHOULDER_HOURS = 5; // 10am-3pm = 5 hours of charging window

// Installation costs (for retrospective ROI)
export const BATTERY_SUNK_COST = parseFloat(process.env.BATTERY_SUNK_COST ?? '') || 0;
export const PANEL_SUNK_COST = parseFloat(process.env.PANEL_SUNK_COST ?? '') || 0;

// Southern Hemisphere seasons (Australia)
export const SEASONS = {
  summer: [12, 1, 2],   // Dec, Jan, Feb
  autumn: [3, 4, 5],    // Mar, Apr, May
  winter: [6, 7, 8],    // Jun, Jul, Aug
  spring: [9, 10, 11]   // Sep, Oct, Nov
} as const;

export type SeasonName = keyof typeof SEASONS;

export function getSeason(month: number): SeasonName {
  if (SEASONS.summer.includes(month as 1)) return 'summer';
  if (SEASONS.autumn.includes(month as 3)) return 'autumn';
  if (SEASONS.winter.includes(month as 6)) return 'winter';
  return 'spring';
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPARISON CONSTANTS (for wacky comparisons)
// ═══════════════════════════════════════════════════════════════════════════

export const COMPARISONS = {
  // Energy equivalents
  iphoneChargeKwh: 0.012,      // kWh per full charge
  coffeeKwh: 0.1,              // kWh per cup (electric kettle)
  tvYearKwh: 876,              // 100W × 24h × 365 days
  gamingPcYearKwh: 1752,       // 200W × 24h × 365 days
  avgHomeYearKwh: 7300,        // 20 kWh/day × 365
  avgHomeDayKwh: 20,           // Average Australian home daily usage
  evKmPerKwh: 6,               // km per kWh

  // Environmental (Australian grid)
  co2PerKwhAvoided: 0.7,       // kg CO2 per kWh (Australian grid average)
  treeCo2PerYear: 22,          // kg CO2 absorbed per mature tree per year
  carCo2PerYear: 4600,         // kg CO2 per average car per year
  flightSydLonCo2: 5000,       // kg CO2 per return flight Sydney↔London
  flightSydBaliCo2: 1200,      // kg CO2 per return flight Sydney↔Bali
};

export function calculateComparisons(totalKwh: number) {
  const co2Avoided = totalKwh * COMPARISONS.co2PerKwhAvoided;

  return {
    // Pop culture
    iphones: Math.round(totalKwh / COMPARISONS.iphoneChargeKwh),
    coffees: Math.round(totalKwh / COMPARISONS.coffeeKwh),
    tvYears: totalKwh / COMPARISONS.tvYearKwh,
    gamingPcYears: totalKwh / COMPARISONS.gamingPcYearKwh,
    homesYears: totalKwh / COMPARISONS.avgHomeYearKwh,
    evKm: totalKwh * COMPARISONS.evKmPerKwh,

    // Environmental
    co2Avoided,
    treesEquivalent: Math.round(co2Avoided / COMPARISONS.treeCo2PerYear),
    carsOffRoad: co2Avoided / COMPARISONS.carCo2PerYear,
    flightsSydLon: co2Avoided / COMPARISONS.flightSydLonCo2,
    flightsSydBali: co2Avoided / COMPARISONS.flightSydBaliCo2,
  };
}

export function formatComparison(value: number, singular: string, plural?: string): string {
  const p = plural ?? singular + 's';
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(1)} million ${p}`;
  } else if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k ${p}`;
  } else if (value >= 10) {
    return `${Math.round(value)} ${value === 1 ? singular : p}`;
  } else if (value >= 1) {
    return `${value.toFixed(1)} ${p}`;
  } else {
    return `${value.toFixed(2)} ${p}`;
  }
}
