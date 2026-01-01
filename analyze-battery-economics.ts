import * as fs from 'node:fs';
import 'dotenv/config';
import {
  loadTariff,
  createTariffHelpers,
  addTOU,
  touTotal,
  touPercentages,
  type TOUBreakdown,
  type SeasonName,
  BATTERY_COST,
  BATTERY_SIZE_KWH,
  BATTERY_LIFESPAN_YEARS,
  BATTERY_EFFICIENCY,
  USABLE_CAPACITY_PERCENT,
  MAX_CHARGE_RATE_KW,
  SHOULDER_HOURS,
  BATTERY_SUNK_COST,
  PANEL_SUNK_COST,
  getSeason,
} from './tariff-utils.js';

// Parse CLI args for system selection (--sn=, --only=, --skip=)
const targetSn = process.argv.find(a => a.startsWith('--sn='))?.slice(5)
  ?? process.argv.find(a => a.startsWith('--only='))?.slice(7)
  ?? null;
const skipPatterns = process.argv.find(a => a.startsWith('--skip='))?.slice(7)?.split(',').map(s => s.trim()).filter(Boolean) ?? null;

// ═══════════════════════════════════════════════════════════════════════════
// TARIFF INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

// Load tariff at startup and create helpers
const TARIFF = loadTariff();
const tariffHelpers = createTariffHelpers(TARIFF);
const {
  getRateForPeriod, calculateTOUCost, calculateWeightedAvgRate, getRatePeriod,
  emptyTOUBreakdown, getPeriodsByRate, getHighestRatePeriod,
  // Feed-in helpers
  hasTOUFeedIn, getFeedInRate, emptyFeedInBreakdown, calculateFeedInRevenue, getFeedInPeriodsByRate
} = tariffHelpers;

// ═══════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

interface PowerReading {
  uploadTime: string;
  feedIn: number;      // Export to grid (W)
  gridCharge: number;  // Import from grid (W)
  ppv: number;         // Solar generation (W)
  load: number;        // Consumption (W)
  cbat: number;        // Battery level
}

interface EnergyData {
  epv?: number;
  eInput?: number;
  eOutput?: number;
  eCharge?: number;
  eDischarge?: number;
  eGridCharge?: number;  // Grid→battery charging (kWh)
}

interface HistoricalDay {
  date: string;
  energy?: EnergyData;
  power?: PowerReading[] | null;
}

interface SystemInfo {
  cobat?: number;
}

interface DischargeConfig {
  batUseCap?: number;  // Battery reserve percentage (e.g., 15 = 15% reserve)
}

interface SystemData {
  systemInfo?: SystemInfo;
  dischargeConfig?: DischargeConfig;
  historicalData: HistoricalDay[];
}

interface Stats {
  systems: SystemData[];
}

interface DailyEntry {
  date: string;
  year: number;
  month: number;
  season: SeasonName;
  pvGeneration: number;
  gridImport: number;
  gridExport: number;
  batteryCharge: number;
  batteryDischarge: number;
  load: number;
  // TOU breakdown from actual power data (kWh)
  peakImport: number;
  shoulderImport: number;
  offpeakImport: number;
  peakExport: number;
  shoulderExport: number;
  offpeakExport: number;
  // Split peak into morning (6-10am) and afternoon/evening (3pm-1am)
  morningPeakImport: number;
  afternoonPeakImport: number;
  morningPeakExport: number;
  afternoonPeakExport: number;
  // Load analysis
  earlyMorningLoad: number;   // 6am-10am consumption (for pre-discharge analysis)
  // Battery behavior (from power data and daily aggregates)
  battery: BatteryBehavior;
}

interface BatteryBehavior {
  // Charging sources (kWh)
  chargeFromSolar: number;       // eCharge - eGridCharge
  chargeFromGrid: number;        // eGridCharge (from daily data)
  chargeFromGridByTOU: TOUBreakdown;  // Grid charging by TOU period (from power data)

  // Discharge destinations (kWh) - from power data
  dischargeToPeak: number;
  dischargeToShoulder: number;
  dischargeToOffpeak: number;

  // Utilization (from power data cbat readings)
  maxSoC: number;               // 0-100
  minSoC: number;               // 0-100
  cycleDepth: number;           // max - min

  // Headroom for additional battery
  solarCapturable: number;      // Export that could have been stored
  gridChargeable: number;       // Off-peak capacity available for grid charging
  peakOffsetable: number;       // Peak import that could be offset with more capacity

  // Full battery analysis
  reachedFullSoC: boolean;      // Did battery reach 95%+ today?
  hourReachedFull: number;      // Hour when battery first hit 95%+ (0-23, or -1 if never)
  exportAfterFull: number;      // kWh exported after battery was full
}

interface BatteryEfficiencyPeriod {
  period: string;  // e.g., "2024-Q1", "2024-summer"
  charge: number;
  discharge: number;
  efficiency: number;  // discharge / charge
  cycleCount: number;  // approximate cycles
}

interface PeriodTotals {
  days: number;
  pvGeneration: number;
  load: number;
  gridImport: number;
  gridExport: number;
  batteryCharge: number;
  batteryDischarge: number;
  // TOU breakdown (calculated from power data)
  importByTOU: TOUBreakdown;
  exportByTOU: TOUBreakdown;
  exportByFeedInPeriod: TOUBreakdown;  // Export bucketed by feed-in tariff periods
  // Battery behavior aggregates
  batteryDischargeTOU: TOUBreakdown;   // Discharge kWh by TOU period
  gridChargeTOU: TOUBreakdown;         // Grid→battery charging by TOU period
  chargeFromSolar: number;             // Total solar→battery kWh
  chargeFromGrid: number;              // Total grid→battery kWh (from eGridCharge)
  // Load analysis
  earlyMorningLoad: number;            // Total 6am-10am consumption (pre-solar peak)
}

interface PeriodAnalysis extends PeriodTotals {
  avgDaily: {
    pvGeneration: number;
    load: number;
    gridImport: number;
    gridExport: number;
    batteryCharge: number;
    batteryDischarge: number;
  };
  costs: {
    dailyImportCost: number;
    dailyFeedInRevenue: number;
    dailyNetCost: number;
  };
}

interface SolarDegradationPeriod {
  season: SeasonName;
  year1: number;
  year2: number;
  avgPV1: number;  // kWh/day in year1
  avgPV2: number;  // kWh/day in year2
  change: number;  // percentage change (negative = degradation)
}

interface SolarDegradation {
  periods: SolarDegradationPeriod[];
  annualRate: number;  // Average annual degradation rate
  hasEnoughData: boolean;
}

interface Analysis {
  currentBatteryKwh: number;
  configuredReservePercent: number;  // From dischargeConfig.batUseCap (e.g., 15 = 15% reserve)
  dateRange: { start: string; end: string };
  overall: PeriodAnalysis;
  byYear: Map<number, PeriodAnalysis>;
  bySeason: Map<SeasonName, PeriodAnalysis>;
  byYearSeason: Map<string, PeriodAnalysis>; // "2024-summer"
  daily: DailyEntry[];
  batteryEfficiency: BatteryEfficiencyPeriod[];
  solarDegradation: SolarDegradation;
  hasPowerData: boolean;  // Whether we have TOU power data
}

// Calculated battery parameters from actual data (replaces hardcoded constants)
interface BatteryParameters {
  // Calculated from actual data
  efficiency: number;              // Round-trip efficiency (discharge/charge)
  usableCapacityPercent: number;   // Observed SoC range (maxSoC - minSoC)
  maxChargeRateKw: number;         // Observed max charging speed
  solarChargingHours: number;      // Non-peak daylight hours for solar charging
  estimatedLifespanYears: number;  // Extrapolated from degradation rate

  // Observed SoC behavior (for display)
  observedMinSoC: number;          // Average minimum SoC observed
  observedMaxSoC: number;          // Average maximum SoC observed
  configuredReservePercent: number; // From dischargeConfig.batUseCap

  // Metadata about data quality
  efficiencyDays: number;          // Days of data used for efficiency calc
  socRangeDays: number;            // Days of data used for SoC range calc
  lifespanConfidence: 'low' | 'medium' | 'high';  // Data confidence for lifespan

  // Warnings/notes
  warnings: string[];
}

interface Scenario {
  additionalBatteries: number;
  additionalKwh: number;
  totalBatteryKwh: number;
  additionalUsableCapacity: number;
  dailySavings: number;
  annualSavings: number;
  investment: number;
  paybackYears: number;
  lifetimeSavings: number;
  roi: number;
  // Value breakdown by arbitrage type
  solarArbitrageValue: number;    // Annual $ from solar→battery→peak
  gridArbitrageValue: number;     // Annual $ from grid→battery→peak
}

interface SavingsComparison {
  // Actual costs with current setup (solar + battery)
  actual: {
    totalImportCost: number;
    totalFeedInRevenue: number;
    totalNetCost: number;
  };
  // What it would have cost with solar only (no battery)
  solarOnly: {
    totalImportCost: number;
    totalFeedInRevenue: number;
    totalNetCost: number;
  };
  // What it would have cost with no solar at all
  noSolar: {
    totalImportCost: number;
    totalNetCost: number;
  };
  // What optimal battery control could have achieved
  optimal: {
    totalImportCost: number;
    totalFeedInRevenue: number;
    totalNetCost: number;
  };
  // Savings
  savingsFromBattery: number;      // actual vs solar-only
  savingsFromSolar: number;        // solar-only vs no-solar
  totalSavings: number;            // actual vs no-solar
  // Value attribution
  solarArbitrageValue: number;     // Solar→battery→peak savings
  gridArbitrageValue: number;      // Grid→battery→peak savings
  // Gap analysis
  optimalGap: number;              // What we left on the table (optimal - actual)
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

interface TOUResult {
  import: TOUBreakdown;
  export: TOUBreakdown;
  exportByFeedInPeriod: TOUBreakdown;  // Export bucketed by feed-in tariff periods
  // Split peak into morning (6-10am) vs afternoon/evening (3pm-1am)
  morningPeakImport: number;
  afternoonPeakImport: number;
  morningPeakExport: number;
  afternoonPeakExport: number;
  // Battery behavior tracking
  batteryDischargeTOU: TOUBreakdown;  // Discharge kWh by TOU period
  gridChargeTOU: TOUBreakdown;        // Grid→battery charging by TOU period
  loadByTOU: TOUBreakdown;            // Consumption by TOU period
  earlyMorningLoad: number;           // Load from 6am-10am (pre-solar peak)
  minSoC: number;                     // Minimum battery SoC (0-100)
  maxSoC: number;                     // Maximum battery SoC (0-100)
}

// Check if hour is in morning peak (6-10am)
function isMorningPeak(hour: number): boolean {
  return hour >= 6 && hour < 10;
}

// Calculate TOU breakdown from power readings
// Power readings are in W, typically every 5 minutes
// We sum them and convert to approximate kWh
function calculateTOUFromPower(powerReadings: PowerReading[] | null | undefined, batteryCapacityKwh: number = 10): TOUResult {
  const importTOU = emptyTOUBreakdown();
  const exportTOU = emptyTOUBreakdown();
  const exportByFeedInPeriod = emptyFeedInBreakdown();
  const batteryDischargeTOU = emptyTOUBreakdown();
  const gridChargeTOU = emptyTOUBreakdown();
  const loadByTOU = emptyTOUBreakdown();  // Track consumption by TOU period
  let morningPeakImport = 0;
  let afternoonPeakImport = 0;
  let morningPeakExport = 0;
  let afternoonPeakExport = 0;
  let earlyMorningLoad = 0;  // 6am-10am (before solar peak)
  let minSoC = 100;
  let maxSoC = 0;

  if (!powerReadings || powerReadings.length === 0) {
    return {
      import: importTOU,
      export: exportTOU,
      exportByFeedInPeriod,
      morningPeakImport,
      afternoonPeakImport,
      morningPeakExport,
      afternoonPeakExport,
      batteryDischargeTOU,
      gridChargeTOU,
      loadByTOU,
      earlyMorningLoad,
      minSoC: 0,
      maxSoC: 0
    };
  }

  // Sort by time to calculate intervals
  const sorted = [...powerReadings].sort((a, b) =>
    a.uploadTime.localeCompare(b.uploadTime)
  );

  for (let i = 0; i < sorted.length; i++) {
    const reading = sorted[i];
    if (!reading) continue;

    // Parse date and time - format is typically "2024-01-15 14:30:00" or ISO
    const dateObj = new Date(reading.uploadTime);
    const dayOfWeek = dateObj.getDay();  // 0=Sunday, 6=Saturday
    const timePart = reading.uploadTime.includes('T')
      ? reading.uploadTime.split('T')[1]
      : reading.uploadTime.split(' ')[1];
    const hour = parseInt(timePart?.split(':')[0] ?? '0', 10);
    const periodResult = getRatePeriod(hour, dayOfWeek);

    // Calculate time interval (assume 5 min if we can't determine)
    let intervalHours = 5 / 60; // default 5 minutes
    if (i < sorted.length - 1) {
      const next = sorted[i + 1];
      if (next) {
        const currentTime = new Date(reading.uploadTime).getTime();
        const nextTime = new Date(next.uploadTime).getTime();
        const diffMs = nextTime - currentTime;
        if (diffMs > 0 && diffMs < 3600000) { // less than 1 hour
          intervalHours = diffMs / 3600000;
        }
      }
    }

    // Convert W to kWh for this interval
    const importKwh = (reading.gridCharge / 1000) * intervalHours;
    const exportKwh = (reading.feedIn / 1000) * intervalHours;
    const loadKwh = (reading.load / 1000) * intervalHours;

    // Use dynamic period name from tariff for imports
    const periodName = periodResult.name;
    importTOU[periodName] = (importTOU[periodName] ?? 0) + importKwh;
    exportTOU[periodName] = (exportTOU[periodName] ?? 0) + exportKwh;
    loadByTOU[periodName] = (loadByTOU[periodName] ?? 0) + loadKwh;

    // Track early morning load (6am-10am) for pre-discharge analysis
    if (hour >= 6 && hour < 10) {
      earlyMorningLoad += loadKwh;
    }

    // Track exports by feed-in period (may differ from consumption periods)
    const feedInResult = getFeedInRate(hour, dayOfWeek);
    exportByFeedInPeriod[feedInResult.name] = (exportByFeedInPeriod[feedInResult.name] ?? 0) + exportKwh;

    // Track morning vs afternoon peak separately (for battery optimization)
    if (periodName === 'peak') {
      if (isMorningPeak(hour)) {
        morningPeakImport += importKwh;
        morningPeakExport += exportKwh;
      } else {
        afternoonPeakImport += importKwh;
        afternoonPeakExport += exportKwh;
      }
    }

    // Track battery SoC min/max
    if (reading.cbat !== undefined && reading.cbat !== null) {
      minSoC = Math.min(minSoC, reading.cbat);
      maxSoC = Math.max(maxSoC, reading.cbat);
    }

    // Track battery discharge by TOU period (when SoC decreases from previous reading)
    if (i > 0) {
      const prevReading = sorted[i - 1];
      if (prevReading && prevReading.cbat !== undefined && reading.cbat !== undefined) {
        const socDelta = prevReading.cbat - reading.cbat;  // Positive = discharging
        if (socDelta > 0) {
          // Battery is discharging - convert SoC % change to kWh
          const dischargeKwh = (socDelta / 100) * batteryCapacityKwh;
          batteryDischargeTOU[periodName] = (batteryDischargeTOU[periodName] ?? 0) + dischargeKwh;
        }
      }
    }

    // Track grid charging by TOU period (when importing from grid AND battery charging)
    // Detect battery charging: cbat increasing from previous reading
    if (i > 0 && reading.gridCharge > 0) {
      const prevReading = sorted[i - 1];
      if (prevReading && prevReading.cbat !== undefined && reading.cbat !== undefined) {
        const socDelta = reading.cbat - prevReading.cbat;  // Positive = charging
        if (socDelta > 0) {
          // Battery is charging while importing from grid
          // Estimate grid portion: if no solar (ppv ≈ 0) or solar < load, grid is charging battery
          const solarExcess = reading.ppv - reading.load;
          if (solarExcess <= 0) {
            // All charging is from grid
            const chargeKwh = (socDelta / 100) * batteryCapacityKwh;
            gridChargeTOU[periodName] = (gridChargeTOU[periodName] ?? 0) + chargeKwh;
          } else if (reading.gridCharge > 0) {
            // Mixed: some solar, some grid - attribute proportionally
            const totalInput = solarExcess + reading.gridCharge;
            const gridFraction = reading.gridCharge / totalInput;
            const chargeKwh = (socDelta / 100) * batteryCapacityKwh * gridFraction;
            gridChargeTOU[periodName] = (gridChargeTOU[periodName] ?? 0) + chargeKwh;
          }
        }
      }
    }
  }

  return {
    import: importTOU,
    export: exportTOU,
    exportByFeedInPeriod,
    morningPeakImport,
    afternoonPeakImport,
    morningPeakExport,
    afternoonPeakExport,
    batteryDischargeTOU,
    gridChargeTOU,
    loadByTOU,
    earlyMorningLoad,
    minSoC,
    maxSoC
  };
}

// Analyze when battery reaches full and export that occurs afterward
function analyzeFullBatteryBehavior(powerReadings: PowerReading[] | null): {
  reachedFullSoC: boolean;
  hourReachedFull: number;
  exportAfterFull: number;
} {
  const FULL_SOC_THRESHOLD = 95;

  if (!powerReadings || powerReadings.length === 0) {
    return { reachedFullSoC: false, hourReachedFull: -1, exportAfterFull: 0 };
  }

  // Sort by time
  const sorted = [...powerReadings].sort((a, b) =>
    a.uploadTime.localeCompare(b.uploadTime)
  );

  let reachedFullSoC = false;
  let hourReachedFull = -1;
  let exportAfterFull = 0;
  let batteryIsFull = false;

  for (let i = 0; i < sorted.length; i++) {
    const reading = sorted[i];
    if (!reading) continue;

    const timePart = reading.uploadTime.includes('T')
      ? reading.uploadTime.split('T')[1]
      : reading.uploadTime.split(' ')[1];
    const hour = parseInt(timePart?.split(':')[0] ?? '0', 10);

    // Calculate interval for energy calculation
    let intervalHours = 5 / 60; // default 5 minutes
    if (i < sorted.length - 1) {
      const next = sorted[i + 1];
      if (next) {
        const currentTime = new Date(reading.uploadTime).getTime();
        const nextTime = new Date(next.uploadTime).getTime();
        const diffMs = nextTime - currentTime;
        if (diffMs > 0 && diffMs < 3600000) {
          intervalHours = diffMs / 3600000;
        }
      }
    }

    // Check if battery reached full
    if (!reachedFullSoC && reading.cbat !== undefined && reading.cbat >= FULL_SOC_THRESHOLD) {
      reachedFullSoC = true;
      hourReachedFull = hour;
      batteryIsFull = true;
    }

    // Track if battery dropped below full (e.g., started discharging)
    if (batteryIsFull && reading.cbat !== undefined && reading.cbat < FULL_SOC_THRESHOLD - 5) {
      batteryIsFull = false;
    }

    // Track export after battery was full (or is still full)
    if (reachedFullSoC && reading.feedIn > 0) {
      exportAfterFull += (reading.feedIn / 1000) * intervalHours;
    }
  }

  return { reachedFullSoC, hourReachedFull, exportAfterFull };
}

function emptyTotals(): PeriodTotals {
  return {
    days: 0,
    pvGeneration: 0,
    load: 0,
    gridImport: 0,
    gridExport: 0,
    batteryCharge: 0,
    batteryDischarge: 0,
    importByTOU: emptyTOUBreakdown(),
    exportByTOU: emptyTOUBreakdown(),
    exportByFeedInPeriod: emptyFeedInBreakdown(),
    batteryDischargeTOU: emptyTOUBreakdown(),
    gridChargeTOU: emptyTOUBreakdown(),
    chargeFromSolar: 0,
    chargeFromGrid: 0,
    earlyMorningLoad: 0
  };
}

// Calculate battery efficiency by quarter
function calculateBatteryEfficiency(daily: DailyEntry[]): BatteryEfficiencyPeriod[] {
  // Group by quarter
  const quarters = new Map<string, { charge: number; discharge: number; days: number }>();

  for (const day of daily) {
    const quarter = `${day.year}-Q${Math.ceil(day.month / 3)}`;
    if (!quarters.has(quarter)) {
      quarters.set(quarter, { charge: 0, discharge: 0, days: 0 });
    }
    const q = quarters.get(quarter)!;
    q.charge += day.batteryCharge;
    q.discharge += day.batteryDischarge;
    q.days++;
  }

  const results: BatteryEfficiencyPeriod[] = [];
  for (const [period, data] of quarters) {
    const cycleCount = data.discharge / 10; // Rough estimate assuming 10kWh battery
    // Require at least 10 cycles for meaningful efficiency calculation
    if (data.charge > 0 && cycleCount >= 10) {
      results.push({
        period,
        charge: data.charge,
        discharge: data.discharge,
        efficiency: data.discharge / data.charge,
        cycleCount
      });
    }
  }

  return results.sort((a, b) => a.period.localeCompare(b.period));
}

// Calculate solar degradation by comparing same seasons across years
function calculateSolarDegradation(byYearSeason: Map<string, PeriodAnalysis>): SolarDegradation {
  const periods: SolarDegradationPeriod[] = [];
  const seasons: SeasonName[] = ['summer', 'autumn', 'winter', 'spring'];

  // Group data by season, then compare across years
  for (const season of seasons) {
    // Find all years that have data for this season
    const yearData: { year: number; avgPV: number; days: number }[] = [];

    for (const [key, analysis] of byYearSeason) {
      if (key.endsWith(`-${season}`)) {
        const year = parseInt(key.split('-')[0] ?? '0', 10);
        // Require at least 30 days for meaningful comparison
        if (analysis.days >= 30) {
          yearData.push({
            year,
            avgPV: analysis.avgDaily.pvGeneration,
            days: analysis.days
          });
        }
      }
    }

    // Sort by year and compare consecutive years
    yearData.sort((a, b) => a.year - b.year);

    for (let i = 0; i < yearData.length - 1; i++) {
      const d1 = yearData[i];
      const d2 = yearData[i + 1];
      if (!d1 || !d2) continue;

      const change = ((d2.avgPV - d1.avgPV) / d1.avgPV) * 100;
      periods.push({
        season,
        year1: d1.year,
        year2: d2.year,
        avgPV1: d1.avgPV,
        avgPV2: d2.avgPV,
        change
      });
    }
  }

  // Calculate average annual degradation rate
  let annualRate = 0;
  if (periods.length > 0) {
    const totalChange = periods.reduce((sum, p) => sum + p.change, 0);
    annualRate = totalChange / periods.length;
  }

  return {
    periods,
    annualRate,
    hasEnoughData: periods.length >= 2  // Need at least 2 season comparisons
  };
}

// Calculate battery parameters from actual data (replaces hardcoded constants)
function calculateBatteryParameters(analysis: Analysis): BatteryParameters {
  const warnings: string[] = [];

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. BATTERY EFFICIENCY - from batteryEfficiency data
  // ═══════════════════════════════════════════════════════════════════════════
  let efficiency = BATTERY_EFFICIENCY; // Default
  let efficiencyDays = 0;

  if (analysis.batteryEfficiency.length > 0) {
    // Use weighted average of all periods (weighted by cycle count)
    let totalCycles = 0;
    let weightedEfficiency = 0;
    for (const period of analysis.batteryEfficiency) {
      weightedEfficiency += period.efficiency * period.cycleCount;
      totalCycles += period.cycleCount;
    }
    if (totalCycles > 0) {
      efficiency = weightedEfficiency / totalCycles;
      // Count total days from all periods
      efficiencyDays = analysis.batteryEfficiency.reduce((sum, p) =>
        sum + Math.round(p.cycleCount * 10 / (p.discharge / p.charge || 1)), 0);
      efficiencyDays = analysis.overall.days; // Simpler: use total days
    }
    // Sanity check
    if (efficiency < 0.7 || efficiency > 1.0) {
      warnings.push(`Calculated efficiency ${(efficiency * 100).toFixed(1)}% seems off, using default`);
      efficiency = BATTERY_EFFICIENCY;
    }
  } else {
    warnings.push('No efficiency data - using default 90%');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. USABLE CAPACITY PERCENT - from SoC range
  // ═══════════════════════════════════════════════════════════════════════════
  let usableCapacityPercent = USABLE_CAPACITY_PERCENT; // Default
  let socRangeDays = 0;
  let observedMinSoC = 0;
  let observedMaxSoC = 100;

  // Filter days with valid SoC data (maxSoC > 0 means we have power data)
  const daysWithSoC = analysis.daily.filter(d => d.battery.maxSoC > 0);
  socRangeDays = daysWithSoC.length;

  if (socRangeDays >= 30) {
    // Calculate average min and max SoC
    observedMinSoC = daysWithSoC.reduce((sum, d) => sum + d.battery.minSoC, 0) / socRangeDays;
    observedMaxSoC = daysWithSoC.reduce((sum, d) => sum + d.battery.maxSoC, 0) / socRangeDays;

    // Usable capacity is the range we actually use
    usableCapacityPercent = (observedMaxSoC - observedMinSoC) / 100;

    // Sanity check
    if (usableCapacityPercent < 0.3 || usableCapacityPercent > 1.0) {
      warnings.push(`Calculated usable capacity ${(usableCapacityPercent * 100).toFixed(0)}% seems off, using default`);
      usableCapacityPercent = USABLE_CAPACITY_PERCENT;
    }
  } else if (socRangeDays > 0) {
    warnings.push(`Only ${socRangeDays} days of SoC data - using default usable capacity`);
  } else {
    warnings.push('No SoC data - using default usable capacity 90%');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. MAX CHARGE RATE - from solar generation and battery fill speed
  // ═══════════════════════════════════════════════════════════════════════════
  let maxChargeRateKw = MAX_CHARGE_RATE_KW; // Default

  if (analysis.daily.length >= 30) {
    // Estimate from solar charge rate
    // Days that reached full - use hour reached full and solar charge amount
    const fullDays = analysis.daily.filter(d =>
      d.battery.reachedFullSoC && d.battery.hourReachedFull > 0
    );

    if (fullDays.length >= 10) {
      // Estimate charge rate from solar charge / hours to full
      // Assuming charging starts around 9am on average
      const chargeRates = fullDays.map(d => {
        const chargingHours = Math.max(1, d.battery.hourReachedFull - 9);
        return d.battery.chargeFromSolar / chargingHours;
      }).filter(r => r > 0 && r < 20); // Sanity filter

      if (chargeRates.length >= 5) {
        // Use 90th percentile to get max sustainable rate
        chargeRates.sort((a, b) => a - b);
        const p90Index = Math.floor(chargeRates.length * 0.9);
        maxChargeRateKw = chargeRates[p90Index] ?? MAX_CHARGE_RATE_KW;
      }
    }
  }

  // Sanity check
  if (maxChargeRateKw < 1 || maxChargeRateKw > 15) {
    if (maxChargeRateKw !== MAX_CHARGE_RATE_KW) {
      warnings.push(`Calculated charge rate ${maxChargeRateKw.toFixed(1)} kW seems off, using default`);
    }
    maxChargeRateKw = MAX_CHARGE_RATE_KW;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. SOLAR CHARGING HOURS - from tariff (non-peak daylight hours)
  // ═══════════════════════════════════════════════════════════════════════════
  const solarDaylightHours = [9, 10, 11, 12, 13, 14, 15]; // Core solar hours

  // Get peak hours from tariff (check all day types)
  const peakHours = new Set<number>();
  for (const periods of Object.values(TARIFF.periods)) {
    for (const period of periods) {
      if (period.name === 'peak') {
        for (const hour of period.hours) {
          peakHours.add(hour);
        }
      }
    }
  }

  // Solar charging hours = daylight hours that are NOT peak
  const nonPeakSolarHours = solarDaylightHours.filter(h => !peakHours.has(h));
  const solarChargingHours = nonPeakSolarHours.length > 0 ? nonPeakSolarHours.length : SHOULDER_HOURS;

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. ESTIMATED LIFESPAN - from degradation rate
  // ═══════════════════════════════════════════════════════════════════════════
  let estimatedLifespanYears = BATTERY_LIFESPAN_YEARS; // Default
  let lifespanConfidence: 'low' | 'medium' | 'high' = 'low';
  const yearsOfData = analysis.overall.days / 365;

  if (analysis.batteryEfficiency.length >= 4) {
    // We have at least 4 quarters of data - can estimate degradation
    const sorted = [...analysis.batteryEfficiency].sort((a, b) => a.period.localeCompare(b.period));

    if (sorted.length >= 4) {
      const firstHalf = sorted.slice(0, Math.floor(sorted.length / 2));
      const secondHalf = sorted.slice(Math.floor(sorted.length / 2));

      const avgFirst = firstHalf.reduce((s, p) => s + p.efficiency, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce((s, p) => s + p.efficiency, 0) / secondHalf.length;

      // Calculate years between first and second half midpoints
      const yearsBetweenHalves = yearsOfData / 2;

      if (yearsBetweenHalves > 0.25 && avgFirst > avgSecond) {
        // Calculate annual degradation rate
        const annualDegradation = (avgFirst - avgSecond) / yearsBetweenHalves;

        // End of life at 70% of original efficiency
        const endOfLifeEfficiency = 0.70;
        const currentEfficiency = avgSecond;

        if (annualDegradation > 0.001) {
          const yearsRemaining = (currentEfficiency - endOfLifeEfficiency) / annualDegradation;
          estimatedLifespanYears = Math.min(20, Math.max(5, yearsRemaining + yearsOfData));

          lifespanConfidence = yearsOfData >= 2 ? 'medium' : 'low';
          if (yearsOfData >= 3 && sorted.length >= 8) {
            lifespanConfidence = 'high';
          }
        }
      } else if (avgSecond >= avgFirst) {
        // No degradation observed
        warnings.push('No degradation detected yet - using default lifespan');
      }

      if (yearsOfData < 1) {
        warnings.push(`Only ${(yearsOfData * 12).toFixed(0)} months of data - lifespan estimate may be inaccurate`);
      }
    }
  } else {
    warnings.push('Insufficient efficiency history - using default lifespan');
  }

  return {
    efficiency,
    usableCapacityPercent,
    maxChargeRateKw,
    solarChargingHours,
    estimatedLifespanYears,
    observedMinSoC,
    observedMaxSoC,
    configuredReservePercent: analysis.configuredReservePercent,
    efficiencyDays,
    socRangeDays,
    lifespanConfidence,
    warnings
  };
}

function calculatePeriodAnalysis(totals: PeriodTotals): PeriodAnalysis {
  const days = totals.days || 1;
  const avgDaily = {
    pvGeneration: totals.pvGeneration / days,
    load: totals.load / days,
    gridImport: totals.gridImport / days,
    gridExport: totals.gridExport / days,
    batteryCharge: totals.batteryCharge / days,
    batteryDischarge: totals.batteryDischarge / days
  };

  // Use actual TOU data when available, otherwise fall back to estimated distribution
  const hasTOUData = touTotal(totals.importByTOU) > 0;
  let dailyImportCost: number;

  if (hasTOUData) {
    // Calculate from actual TOU breakdown using tariff rates
    const totalTOUCost = calculateTOUCost(totals.importByTOU);
    dailyImportCost = totalTOUCost / days;
  } else {
    // Fall back to estimated distribution
    const importDistribution = { peak: 0.70, shoulder: 0.05, offpeak: 0.25 };
    dailyImportCost = avgDaily.gridImport * calculateWeightedAvgRate(importDistribution);
  }

  // Calculate feed-in revenue using TOU feed-in rates when available
  let dailyFeedInRevenue: number;
  if (hasTOUData && hasTOUFeedIn() && touTotal(totals.exportByFeedInPeriod) > 0) {
    // Use actual export TOU breakdown with feed-in period rates
    dailyFeedInRevenue = calculateFeedInRevenue(totals.exportByFeedInPeriod) / days;
  } else {
    // Fall back to flat rate
    dailyFeedInRevenue = avgDaily.gridExport * TARIFF.feedInTariff;
  }

  return {
    ...totals,
    avgDaily,
    costs: {
      dailyImportCost,
      dailyFeedInRevenue,
      dailyNetCost: dailyImportCost - dailyFeedInRevenue
    }
  };
}

function pad(str: string, len: number): string {
  return str.padStart(len);
}

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

// ═══════════════════════════════════════════════════════════════════════════
// LOAD STATS FROM DATA FILES
// ═══════════════════════════════════════════════════════════════════════════

function loadLatestStats(): Stats {
  let systemFiles = fs.readdirSync('.').filter(f => f.startsWith('alphaess-data-') && f.endsWith('.json'));

  // Filter by --skip (partial match)
  if (skipPatterns) {
    systemFiles = systemFiles.filter(f => !skipPatterns.some(p => f.includes(p)));
  }

  // Filter by --only or --sn (partial match)
  if (targetSn) {
    systemFiles = systemFiles.filter(f => f.includes(targetSn));
  }

  // Validate we have exactly one system
  if (systemFiles.length === 0) {
    console.error(`❌ No data file found matching filters`);
    const allFiles = fs.readdirSync('.').filter(f => f.startsWith('alphaess-data-') && f.endsWith('.json'));
    console.error(`   Available: ${allFiles.map(f => f.replace('alphaess-data-', '').replace('.json', '')).join(', ')}`);
    process.exit(1);
  }
  if (systemFiles.length > 1) {
    console.error(`❌ Multiple systems match filters:`);
    console.error(`   ${systemFiles.map(f => f.replace('alphaess-data-', '').replace('.json', '')).join(', ')}`);
    console.error(`   Use --only= or --skip= to narrow down to one system`);
    process.exit(1);
  }

  if (systemFiles.length > 0) {
    const systems: SystemData[] = [];
    for (const file of systemFiles) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8')) as SystemData;
        systems.push(data);
        console.log(`📂 Loaded ${file} (${data.historicalData.length} days)`);
      } catch {
        console.warn(`⚠️  Could not parse ${file}`);
      }
    }
    if (systems.length > 0) {
      return { systems };
    }
  }

  const legacyFiles = fs.readdirSync('.').filter(f => f.startsWith('alphaess-stats-') && f.endsWith('.json'));
  if (legacyFiles.length === 0) {
    console.error('❌ No stats file found. Run dump-stats.ts first.');
    process.exit(1);
  }
  legacyFiles.sort().reverse();
  const latestFile = legacyFiles[0];
  if (!latestFile) {
    console.error('❌ No stats file found.');
    process.exit(1);
  }
  console.log(`📂 Loading ${latestFile} (legacy format)\n`);
  return JSON.parse(fs.readFileSync(latestFile, 'utf8')) as Stats;
}

// ═══════════════════════════════════════════════════════════════════════════
// ANALYZE HISTORICAL DATA
// ═══════════════════════════════════════════════════════════════════════════

function analyzeHistoricalData(stats: Stats): Analysis {
  const system = stats.systems[0];
  if (!system) {
    console.error('❌ No system data found');
    process.exit(1);
  }

  // Get battery capacity from system info (default 10kWh)
  const batteryCapacityKwh = system.systemInfo?.cobat ?? 10;

  const daily: DailyEntry[] = [];
  const overallTotals = emptyTotals();
  const yearTotals = new Map<number, PeriodTotals>();
  const seasonTotals = new Map<SeasonName, PeriodTotals>();
  const yearSeasonTotals = new Map<string, PeriodTotals>();

  for (const day of system.historicalData) {
    if (!day.energy) continue;

    const e = day.energy;
    const [yearStr, monthStr] = day.date.split('-');
    if (!yearStr || !monthStr) continue;

    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const season = getSeason(month);
    const yearSeasonKey = `${year}-${season}`;

    const load = (e.epv ?? 0) + (e.eInput ?? 0) + (e.eDischarge ?? 0) - (e.eOutput ?? 0) - (e.eCharge ?? 0);

    // Calculate TOU from power readings for this day (with battery behavior tracking)
    const tou = calculateTOUFromPower(day.power as PowerReading[] | null, batteryCapacityKwh);

    // Analyze when battery reaches full and export afterward
    const fullBattery = analyzeFullBatteryBehavior(day.power as PowerReading[] | null);

    // Calculate battery behavior from daily aggregates + power data
    const chargeFromGrid = e.eGridCharge ?? 0;
    const chargeFromSolar = Math.max(0, (e.eCharge ?? 0) - chargeFromGrid);

    // Calculate headroom for additional battery
    // Solar capturable = export that could have been stored
    const solarCapturable = e.eOutput ?? 0;
    // Peak offsetable = peak import remaining (could be offset with more battery capacity)
    const peakOffsetable = (tou.import.peak ?? 0) + (tou.morningPeakImport ?? 0);
    // Grid chargeable = estimate of off-peak capacity available
    // (if we had more battery, we could charge more from grid during off-peak)
    const currentUsedCapacity = (tou.maxSoC - tou.minSoC) / 100 * batteryCapacityKwh;
    const gridChargeable = Math.max(0, batteryCapacityKwh * USABLE_CAPACITY_PERCENT - currentUsedCapacity);

    const batteryBehavior: BatteryBehavior = {
      chargeFromSolar,
      chargeFromGrid,
      chargeFromGridByTOU: tou.gridChargeTOU,
      dischargeToPeak: tou.batteryDischargeTOU.peak ?? 0,
      dischargeToShoulder: tou.batteryDischargeTOU.shoulder ?? 0,
      dischargeToOffpeak: tou.batteryDischargeTOU.offpeak ?? 0,
      maxSoC: tou.maxSoC,
      minSoC: tou.minSoC,
      cycleDepth: tou.maxSoC - tou.minSoC,
      solarCapturable,
      gridChargeable,
      peakOffsetable,
      reachedFullSoC: fullBattery.reachedFullSoC,
      hourReachedFull: fullBattery.hourReachedFull,
      exportAfterFull: fullBattery.exportAfterFull
    };

    const entry: DailyEntry = {
      date: day.date,
      year,
      month,
      season,
      pvGeneration: e.epv ?? 0,
      gridImport: e.eInput ?? 0,
      gridExport: e.eOutput ?? 0,
      batteryCharge: e.eCharge ?? 0,
      batteryDischarge: e.eDischarge ?? 0,
      load,
      // TOU breakdown from actual power data
      peakImport: tou.import.peak ?? 0,
      shoulderImport: tou.import.shoulder ?? 0,
      offpeakImport: tou.import.offpeak ?? 0,
      peakExport: tou.export.peak ?? 0,
      shoulderExport: tou.export.shoulder ?? 0,
      offpeakExport: tou.export.offpeak ?? 0,
      // Morning vs afternoon peak split
      morningPeakImport: tou.morningPeakImport,
      afternoonPeakImport: tou.afternoonPeakImport,
      morningPeakExport: tou.morningPeakExport,
      afternoonPeakExport: tou.afternoonPeakExport,
      // Load analysis
      earlyMorningLoad: tou.earlyMorningLoad,
      // Battery behavior
      battery: batteryBehavior
    };
    daily.push(entry);

    // Accumulate totals
    const addToTotals = (totals: PeriodTotals) => {
      totals.days++;
      totals.pvGeneration += entry.pvGeneration;
      totals.load += entry.load;
      totals.gridImport += entry.gridImport;
      totals.gridExport += entry.gridExport;
      totals.batteryCharge += entry.batteryCharge;
      totals.batteryDischarge += entry.batteryDischarge;
      addTOU(totals.importByTOU, tou.import);
      addTOU(totals.exportByTOU, tou.export);
      addTOU(totals.exportByFeedInPeriod, tou.exportByFeedInPeriod);
      // Battery behavior aggregates
      addTOU(totals.batteryDischargeTOU, tou.batteryDischargeTOU);
      addTOU(totals.gridChargeTOU, tou.gridChargeTOU);
      totals.chargeFromSolar += chargeFromSolar;
      totals.chargeFromGrid += chargeFromGrid;
      // Load analysis
      totals.earlyMorningLoad += entry.earlyMorningLoad;
    };

    addToTotals(overallTotals);

    if (!yearTotals.has(year)) yearTotals.set(year, emptyTotals());
    addToTotals(yearTotals.get(year)!);

    if (!seasonTotals.has(season)) seasonTotals.set(season, emptyTotals());
    addToTotals(seasonTotals.get(season)!);

    if (!yearSeasonTotals.has(yearSeasonKey)) yearSeasonTotals.set(yearSeasonKey, emptyTotals());
    addToTotals(yearSeasonTotals.get(yearSeasonKey)!);
  }

  // Sort daily entries by date
  daily.sort((a, b) => a.date.localeCompare(b.date));

  const dateRange = {
    start: daily[0]?.date ?? 'N/A',
    end: daily[daily.length - 1]?.date ?? 'N/A'
  };

  // Convert totals to analyses
  const byYear = new Map<number, PeriodAnalysis>();
  for (const [year, totals] of yearTotals) {
    byYear.set(year, calculatePeriodAnalysis(totals));
  }

  const bySeason = new Map<SeasonName, PeriodAnalysis>();
  for (const [season, totals] of seasonTotals) {
    bySeason.set(season, calculatePeriodAnalysis(totals));
  }

  const byYearSeason = new Map<string, PeriodAnalysis>();
  for (const [key, totals] of yearSeasonTotals) {
    byYearSeason.set(key, calculatePeriodAnalysis(totals));
  }

  // Check if we have power data for TOU calculations
  const hasPowerData = touTotal(overallTotals.importByTOU) > 0 || touTotal(overallTotals.exportByTOU) > 0;

  // Calculate battery efficiency over time
  const batteryEfficiency = calculateBatteryEfficiency(daily);

  // Calculate solar degradation by comparing same seasons across years
  const solarDegradation = calculateSolarDegradation(byYearSeason);

  return {
    currentBatteryKwh: system.systemInfo?.cobat ?? 0,
    configuredReservePercent: system.dischargeConfig?.batUseCap ?? 0,
    dateRange,
    overall: calculatePeriodAnalysis(overallTotals),
    byYear,
    bySeason,
    byYearSeason,
    daily,
    batteryEfficiency,
    solarDegradation,
    hasPowerData
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MODEL BATTERY SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════

function modelBatteryScenarios(analysis: Analysis, params?: BatteryParameters): Scenario[] {
  // Use calculated params or fall back to defaults
  const efficiency = params?.efficiency ?? BATTERY_EFFICIENCY;
  const usableCapacity = params?.usableCapacityPercent ?? USABLE_CAPACITY_PERCENT;
  const maxChargeRate = params?.maxChargeRateKw ?? MAX_CHARGE_RATE_KW;
  const solarHours = params?.solarChargingHours ?? SHOULDER_HOURS;
  const lifespanYears = params?.estimatedLifespanYears ?? BATTERY_LIFESPAN_YEARS;

  const scenarios: Scenario[] = [];
  const currentBatteryKwh = analysis.currentBatteryKwh;

  // Max energy that can be captured in a day based on charge rate and solar hours
  const maxDailyCharge = maxChargeRate * solarHours;

  // Get tariff rates for value calculations
  const peakRate = getRateForPeriod('peak');
  const offpeakRate = getRateForPeriod('offpeak');
  const feedInRate = hasTOUFeedIn()
    ? getFeedInPeriodsByRate()[getFeedInPeriodsByRate().length - 1]?.rate ?? TARIFF.feedInTariff
    : TARIFF.feedInTariff;

  // Calculate using ACTUAL daily data with ACTUAL TOU breakdown
  for (let additionalBatteries = 0; additionalBatteries <= 3; additionalBatteries++) {
    const additionalKwh = additionalBatteries * BATTERY_SIZE_KWH;
    const totalBatteryKwh = currentBatteryKwh + additionalKwh;
    const additionalUsableKwh = additionalKwh * usableCapacity;

    let totalSolarArbValue = 0;
    let totalGridArbValue = 0;
    let totalCaptured = 0;

    for (const day of analysis.daily) {
      const hasTOUData = day.peakImport > 0 || day.shoulderImport > 0 || day.offpeakImport > 0;

      // ═══════════════════════════════════════════════════════════════════════
      // SOLAR ARBITRAGE: Capture excess solar → discharge during peak
      // ═══════════════════════════════════════════════════════════════════════

      // Calculate max useful discharge first - afternoon peak and shoulder
      let maxUsefulDischarge: number;
      if (hasTOUData) {
        maxUsefulDischarge = day.afternoonPeakImport + day.shoulderImport;
      } else {
        const afternoonPeakRatio = 0.71;
        const overallPeakRatio = analysis.hasPowerData
          ? (analysis.overall.importByTOU.peak ?? 0) / (analysis.overall.gridImport || 1)
          : 0.70;
        const shoulderRatio = analysis.hasPowerData
          ? (analysis.overall.importByTOU.shoulder ?? 0) / (analysis.overall.gridImport || 1)
          : 0.05;
        maxUsefulDischarge = day.gridImport * (overallPeakRatio * afternoonPeakRatio + shoulderRatio);
      }

      // Solar capturable = min(additional capacity, solar export, charge rate limit, useful discharge)
      const solarCapturable = Math.min(
        additionalUsableKwh,
        Math.max(0, day.gridExport),
        maxDailyCharge,
        maxUsefulDischarge / efficiency
      );

      if (solarCapturable > 0) {
        const solarDischargeable = solarCapturable * efficiency;

        // Discharge to afternoon peak first, then shoulder
        let afternoonPeakDischarge: number;
        let shoulderDischarge: number;
        if (hasTOUData) {
          afternoonPeakDischarge = Math.min(solarDischargeable, day.afternoonPeakImport);
          shoulderDischarge = Math.min(solarDischargeable - afternoonPeakDischarge, day.shoulderImport);
        } else {
          const afternoonPeakRatio = 0.71;
          const overallPeakRatio = analysis.hasPowerData
            ? (analysis.overall.importByTOU.peak ?? 0) / (analysis.overall.gridImport || 1) : 0.70;
          const shoulderRatio = analysis.hasPowerData
            ? (analysis.overall.importByTOU.shoulder ?? 0) / (analysis.overall.gridImport || 1) : 0.05;
          afternoonPeakDischarge = Math.min(solarDischargeable, day.gridImport * overallPeakRatio * afternoonPeakRatio);
          shoulderDischarge = Math.min(solarDischargeable - afternoonPeakDischarge, day.gridImport * shoulderRatio);
        }

        // Solar arbitrage value = peak discharge value - feed-in opportunity cost
        const solarDayValue = afternoonPeakDischarge * peakRate + shoulderDischarge * getRateForPeriod('shoulder')
                              - solarCapturable * feedInRate;
        totalSolarArbValue += Math.max(0, solarDayValue);
        totalCaptured += solarCapturable;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // GRID ARBITRAGE: Charge from off-peak grid → discharge during peak
      // ═══════════════════════════════════════════════════════════════════════

      // Grid arbitrage is valuable when:
      // 1. There's remaining peak import that wasn't offset by solar
      // 2. There's unused battery capacity
      // 3. The price spread (peak - offpeak) is positive

      // Solar discharge primarily serves AFTERNOON peak (solar is available then)
      // Morning peak (6-10am) is before significant solar, so it's fully available for grid arbitrage
      const solarDischarge = solarCapturable > 0 ? solarCapturable * efficiency : 0;
      const afternoonPeakRemaining = Math.max(0, day.afternoonPeakImport - solarDischarge);
      const peakImportRemaining = hasTOUData
        ? day.morningPeakImport + afternoonPeakRemaining  // Morning peak unaffected by solar
        : Math.max(0, day.gridImport * 0.70 - solarDischarge);

      // Available capacity for grid charging (after solar capture)
      const capacityForGridCharge = Math.max(0, additionalUsableKwh - solarCapturable);

      // Grid charging can serve ANY remaining peak demand (morning or afternoon)
      // Charge overnight (off-peak) → discharge to peak periods
      // Grid chargeable = min(remaining capacity, peak import remaining)
      const gridChargeable = Math.min(
        capacityForGridCharge,
        peakImportRemaining / efficiency
      );

      if (gridChargeable > 0) {
        const gridDischargeable = gridChargeable * efficiency;

        // Grid arbitrage value = (peak rate - offpeak rate) × discharge amount
        // We charge at off-peak, discharge at peak
        const gridDayValue = gridDischargeable * (peakRate - offpeakRate);
        totalGridArbValue += Math.max(0, gridDayValue);
      }
    }

    const numDays = analysis.daily.length;
    const avgDailySolarArb = numDays > 0 ? totalSolarArbValue / numDays : 0;
    const avgDailyGridArb = numDays > 0 ? totalGridArbValue / numDays : 0;
    const avgDailyValue = avgDailySolarArb + avgDailyGridArb;
    const avgDailyCapture = numDays > 0 ? totalCaptured / numDays : 0;

    const annualSolarArb = avgDailySolarArb * 365;
    const annualGridArb = avgDailyGridArb * 365;
    const annualSavings = annualSolarArb + annualGridArb;
    const investment = additionalBatteries * BATTERY_COST;
    const paybackYears = investment > 0 && annualSavings > 0 ? investment / annualSavings : Infinity;
    const lifetimeSavings = annualSavings * lifespanYears;
    const roi = investment > 0 ? ((lifetimeSavings - investment) / investment * 100) : 0;

    scenarios.push({
      additionalBatteries,
      additionalKwh,
      totalBatteryKwh,
      additionalUsableCapacity: avgDailyCapture,
      dailySavings: avgDailyValue,
      annualSavings,
      investment,
      paybackYears,
      lifetimeSavings,
      roi,
      solarArbitrageValue: annualSolarArb,
      gridArbitrageValue: annualGridArb
    });
  }

  return scenarios;
}

// ═══════════════════════════════════════════════════════════════════════════
// CALCULATE RETROSPECTIVE SAVINGS
// ═══════════════════════════════════════════════════════════════════════════

function calculateSavingsComparison(analysis: Analysis): SavingsComparison {
  // Fallback TOU distribution if no power data available
  const fallbackImportDist = { peak: 0.70, shoulder: 0.05, offpeak: 0.25 };
  const fallbackAvgRate = calculateWeightedAvgRate(fallbackImportDist);

  // Get tariff rates
  const peakRate = getRateForPeriod('peak');
  const offpeakRate = getRateForPeriod('offpeak');
  const feedInRate = TARIFF.feedInTariff;

  // ACTUAL: What you paid with solar + battery
  // Use actual TOU data when available
  let actualImportCost: number;
  if (analysis.hasPowerData && touTotal(analysis.overall.importByTOU) > 0) {
    actualImportCost = calculateTOUCost(analysis.overall.importByTOU);
  } else {
    actualImportCost = analysis.overall.gridImport * fallbackAvgRate;
  }
  // Calculate feed-in revenue using TOU rates when available
  const actualFeedInRevenue = (analysis.hasPowerData && hasTOUFeedIn() && touTotal(analysis.overall.exportByFeedInPeriod) > 0)
    ? calculateFeedInRevenue(analysis.overall.exportByFeedInPeriod)
    : analysis.overall.gridExport * TARIFF.feedInTariff;
  const actualNetCost = actualImportCost - actualFeedInRevenue;

  // SOLAR ONLY: What you would have paid without the battery
  // Without battery: all solar excess goes to grid, all non-solar consumption comes from grid
  // The battery saves you by: storing cheap solar and using it during peak instead of importing
  //
  // Battery discharge = energy that would have been imported
  // Battery charge (from solar) = energy that would have been exported
  //
  // CRITICAL: Battery discharge is primarily during PEAK hours (that's the arbitrage strategy).
  // Without battery, that peak demand becomes grid imports at peak rates.
  // So solar-only scenario has MORE peak imports than actual, not the same distribution.

  const solarOnlyImport = analysis.overall.gridImport + analysis.overall.batteryDischarge;
  // Fix: Only solar charge becomes additional export (not grid charge)
  const solarOnlyExport = analysis.overall.gridExport + analysis.overall.chargeFromSolar;

  // Battery discharge was avoiding imports - use actual TOU breakdown when available
  const highestRate = getHighestRatePeriod();
  let solarOnlyImportCost: number;
  if (analysis.hasPowerData && touTotal(analysis.overall.batteryDischargeTOU) > 0) {
    // Use actual TOU breakdown of when battery discharged (more accurate than assuming highest rate)
    solarOnlyImportCost = actualImportCost + calculateTOUCost(analysis.overall.batteryDischargeTOU);
  } else if (analysis.hasPowerData && touTotal(analysis.overall.importByTOU) > 0) {
    // Fallback: assume discharge at highest rate
    solarOnlyImportCost = actualImportCost + (analysis.overall.batteryDischarge * highestRate.rate);
  } else {
    // No TOU data: use weighted average
    solarOnlyImportCost = solarOnlyImport * fallbackAvgRate +
                          analysis.overall.batteryDischarge * (highestRate.rate - fallbackAvgRate);
  }
  // For solar-only, we'd export more (battery charge goes to grid instead)
  // Use actual average feed-in rate when available, otherwise flat rate
  const avgFeedInRate = (analysis.hasPowerData && hasTOUFeedIn() && touTotal(analysis.overall.exportByFeedInPeriod) > 0)
    ? calculateFeedInRevenue(analysis.overall.exportByFeedInPeriod) / analysis.overall.gridExport
    : TARIFF.feedInTariff;
  const solarOnlyFeedInRevenue = solarOnlyExport * avgFeedInRate;
  const solarOnlyNetCost = solarOnlyImportCost - solarOnlyFeedInRevenue;

  // NO SOLAR: What you would have paid with no solar at all
  // You'd import your entire load from the grid
  // Load = PV + Import + BatteryDischarge - Export - BatteryCharge
  // But simpler: noSolarImport = load (everything comes from grid)
  const noSolarImport = analysis.overall.load;
  const noSolarImportCost = noSolarImport * fallbackAvgRate;
  const noSolarNetCost = noSolarImportCost; // No feed-in revenue

  // ═══════════════════════════════════════════════════════════════════════════
  // VALUE ATTRIBUTION: Break down actual battery value by source
  // ═══════════════════════════════════════════════════════════════════════════

  // Calculate value attribution from actual battery behavior
  const totalPeakDischarge = analysis.overall.batteryDischargeTOU.peak ?? 0;
  const totalChargeFromSolar = analysis.overall.chargeFromSolar;
  const totalChargeFromGrid = analysis.overall.chargeFromGrid;
  const totalCharge = totalChargeFromSolar + totalChargeFromGrid;

  // Attribute peak discharge proportionally to solar vs grid charge
  const solarFraction = totalCharge > 0 ? totalChargeFromSolar / totalCharge : 1;
  const gridFraction = totalCharge > 0 ? totalChargeFromGrid / totalCharge : 0;

  // Solar arbitrage value: solar charge that displaced peak imports
  // Value = discharge × (peak_rate - feed_in_rate) for solar portion
  const solarToPeak = totalPeakDischarge * solarFraction;
  const solarArbitrageValue = solarToPeak * (peakRate - feedInRate);

  // Grid arbitrage value: grid charge that displaced peak imports
  // Value = discharge × (peak_rate - offpeak_rate) for grid portion
  const gridToPeak = totalPeakDischarge * gridFraction;
  const gridArbitrageValue = gridToPeak * (peakRate - offpeakRate);

  // ═══════════════════════════════════════════════════════════════════════════
  // OPTIMAL: What we could have achieved with perfect battery control
  // Calculate by identifying inefficiencies in actual operation
  // ═══════════════════════════════════════════════════════════════════════════

  // 1. Off-peak discharge waste - battery discharged during cheap periods
  //    This energy should have been saved for peak periods
  const offpeakDischarge = analysis.overall.batteryDischargeTOU.offpeak ?? 0;
  const offpeakDischargeWaste = offpeakDischarge * (peakRate - offpeakRate);

  // 2. Peak grid charging waste - charged from grid during expensive periods
  //    Should have charged during off-peak instead
  const peakGridCharge = analysis.overall.gridChargeTOU.peak ?? 0;
  const peakGridChargeWaste = peakGridCharge * (peakRate - offpeakRate);

  // 3. Missed solar capture - solar we exported but could have stored
  //    Only count if there was peak demand to use it
  const batteryCapacity = analysis.currentBatteryKwh * USABLE_CAPACITY_PERCENT;
  let missedSolarCapture = 0;
  for (const day of analysis.daily) {
    // If there was export AND battery wasn't at max SoC, we may have missed capture
    const usedCapacity = (day.battery.maxSoC / 100) * analysis.currentBatteryKwh;
    const unusedCapacity = Math.max(0, batteryCapacity - usedCapacity);
    // Only count missed capture up to what we could use in peak
    const peakDemandRemaining = day.peakImport;  // Peak import we still had
    const potentialMissedCapture = Math.min(day.gridExport, unusedCapacity, peakDemandRemaining / BATTERY_EFFICIENCY);
    if (potentialMissedCapture > 0) {
      // Value = what we could have saved vs exporting
      missedSolarCapture += potentialMissedCapture * (peakRate - feedInRate);
    }
  }

  // Total optimization gap = sum of all inefficiencies
  const optimalGap = Math.max(0, offpeakDischargeWaste + peakGridChargeWaste + missedSolarCapture);

  // Optimal net cost = actual - the gap (optimal is always <= actual)
  const optimalImportCost = Math.max(0, actualImportCost - optimalGap);
  const optimalFeedInRevenue = actualFeedInRevenue;  // Conservative: keep same feed-in
  const optimalNetCost = optimalImportCost - optimalFeedInRevenue;

  return {
    actual: {
      totalImportCost: actualImportCost,
      totalFeedInRevenue: actualFeedInRevenue,
      totalNetCost: actualNetCost
    },
    solarOnly: {
      totalImportCost: solarOnlyImportCost,
      totalFeedInRevenue: solarOnlyFeedInRevenue,
      totalNetCost: solarOnlyNetCost
    },
    noSolar: {
      totalImportCost: noSolarImportCost,
      totalNetCost: noSolarNetCost
    },
    optimal: {
      totalImportCost: optimalImportCost,
      totalFeedInRevenue: optimalFeedInRevenue,
      totalNetCost: optimalNetCost
    },
    savingsFromBattery: solarOnlyNetCost - actualNetCost,
    savingsFromSolar: noSolarNetCost - solarOnlyNetCost,
    totalSavings: noSolarNetCost - actualNetCost,
    solarArbitrageValue,
    gridArbitrageValue,
    optimalGap
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// DISPLAY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function printPeriodTable(title: string, periods: [string, PeriodAnalysis][]) {
  console.log(`\n${title}`);
  console.log('─'.repeat(100));
  console.log(
    'Period'.padEnd(16) +
    'Days'.padStart(6) +
    'PV Gen'.padStart(10) +
    'Export'.padStart(10) +
    'Import'.padStart(10) +
    'Load'.padStart(10) +
    'Batt Chg'.padStart(10) +
    'Net $/day'.padStart(12) +
    'Net $/yr'.padStart(12)
  );
  console.log('─'.repeat(100));

  for (const [name, p] of periods) {
    const annualNetCost = p.costs.dailyNetCost * 365;
    console.log(
      name.padEnd(16) +
      pad(p.days.toString(), 6) +
      pad(fmt(p.avgDaily.pvGeneration), 10) +
      pad(fmt(p.avgDaily.gridExport), 10) +
      pad(fmt(p.avgDaily.gridImport), 10) +
      pad(fmt(p.avgDaily.load), 10) +
      pad(fmt(p.avgDaily.batteryCharge), 10) +
      pad('$' + fmt(p.costs.dailyNetCost, 2), 12) +
      pad('$' + fmt(annualNetCost, 0), 12)
    );
  }
}

function printSeasonalComparison(analysis: Analysis) {
  const seasonOrder: SeasonName[] = ['summer', 'autumn', 'winter', 'spring'];
  const years = Array.from(analysis.byYear.keys()).sort();

  console.log('\n📅 SEASONAL PATTERNS BY YEAR');
  console.log('─'.repeat(90));

  // Header
  let header = 'Season'.padEnd(12);
  for (const year of years) {
    header += `│ ${year} PV`.padStart(12) + `Export`.padStart(8) + `Import`.padStart(8);
  }
  console.log(header);
  console.log('─'.repeat(90));

  for (const season of seasonOrder) {
    let row = (season.charAt(0).toUpperCase() + season.slice(1)).padEnd(12);
    for (const year of years) {
      const key = `${year}-${season}`;
      const data = analysis.byYearSeason.get(key);
      if (data && data.days > 0) {
        row += `│ ${pad(fmt(data.avgDaily.pvGeneration), 10)}${pad(fmt(data.avgDaily.gridExport), 8)}${pad(fmt(data.avgDaily.gridImport), 8)}`;
      } else {
        row += `│ ${'--'.padStart(10)}${'--'.padStart(8)}${'--'.padStart(8)}`;
      }
    }
    console.log(row);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BATTERY UTILIZATION REPORT
// ═══════════════════════════════════════════════════════════════════════════

function printBatteryUtilizationReport(analysis: Analysis): void {
  console.log('\n📊 ACTUAL BATTERY UTILIZATION (from power data)');
  console.log('═'.repeat(95));

  const seasonOrder: SeasonName[] = ['summer', 'autumn', 'winter', 'spring'];

  // Header
  console.log(
    '                              ' +
    'Summer'.padStart(10) +
    'Autumn'.padStart(10) +
    'Winter'.padStart(10) +
    'Spring'.padStart(10) +
    'Annual'.padStart(10)
  );
  console.log('─'.repeat(95));

  // Charging Source section
  console.log('CHARGING SOURCE');

  // From solar
  const solarRow = '  From solar             ';
  let solarValues = seasonOrder.map(s => {
    const data = analysis.bySeason.get(s);
    if (!data || data.days === 0) return '--';
    return fmt(data.chargeFromSolar / data.days, 1) + 'kWh';
  });
  const annualSolarAvg = analysis.overall.days > 0
    ? fmt(analysis.overall.chargeFromSolar / analysis.overall.days, 1) + 'kWh/day'
    : '--';
  console.log(solarRow + solarValues.map(v => v.padStart(10)).join('') + annualSolarAvg.padStart(12));

  // From grid (break down by TOU)
  const gridRow = '  From grid (off-peak)   ';
  let gridOffpeakValues = seasonOrder.map(s => {
    const data = analysis.bySeason.get(s);
    if (!data || data.days === 0) return '--';
    const offpeakCharge = data.gridChargeTOU.offpeak ?? 0;
    return fmt(offpeakCharge / data.days, 1) + 'kWh';
  });
  const annualGridOffpeak = analysis.overall.days > 0
    ? fmt((analysis.overall.gridChargeTOU.offpeak ?? 0) / analysis.overall.days, 1) + 'kWh/day'
    : '--';
  console.log(gridRow + gridOffpeakValues.map(v => v.padStart(10)).join('') + annualGridOffpeak.padStart(12));

  // From grid (peak) - wasteful
  const peakGridCharge = analysis.overall.gridChargeTOU.peak ?? 0;
  if (peakGridCharge > 0) {
    const peakRow = '  From grid (peak) ⚠️    ';
    let gridPeakValues = seasonOrder.map(s => {
      const data = analysis.bySeason.get(s);
      if (!data || data.days === 0) return '--';
      const peakCharge = data.gridChargeTOU.peak ?? 0;
      if (peakCharge === 0) return '--';
      return fmt(peakCharge / data.days, 1) + 'kWh';
    });
    const annualGridPeak = analysis.overall.days > 0
      ? fmt(peakGridCharge / analysis.overall.days, 1) + 'kWh/day'
      : '--';
    console.log(peakRow + gridPeakValues.map(v => v.padStart(10)).join('') + annualGridPeak.padStart(12));
  }

  console.log('');

  // Discharge Destination section
  console.log('DISCHARGE DESTINATION');

  // To peak
  const peakDischargeRow = '  To peak periods        ';
  let peakDischargeValues = seasonOrder.map(s => {
    const data = analysis.bySeason.get(s);
    if (!data || data.days === 0) return '--';
    const peakDischarge = data.batteryDischargeTOU.peak ?? 0;
    return fmt(peakDischarge / data.days, 1) + 'kWh';
  });
  const annualPeakDischarge = analysis.overall.days > 0
    ? fmt((analysis.overall.batteryDischargeTOU.peak ?? 0) / analysis.overall.days, 1) + 'kWh/day'
    : '--';
  console.log(peakDischargeRow + peakDischargeValues.map(v => v.padStart(10)).join('') + annualPeakDischarge.padStart(12));

  // To shoulder
  const shoulderDischargeRow = '  To shoulder periods    ';
  let shoulderDischargeValues = seasonOrder.map(s => {
    const data = analysis.bySeason.get(s);
    if (!data || data.days === 0) return '--';
    const shoulderDischarge = data.batteryDischargeTOU.shoulder ?? 0;
    return fmt(shoulderDischarge / data.days, 1) + 'kWh';
  });
  const annualShoulderDischarge = analysis.overall.days > 0
    ? fmt((analysis.overall.batteryDischargeTOU.shoulder ?? 0) / analysis.overall.days, 1) + 'kWh/day'
    : '--';
  console.log(shoulderDischargeRow + shoulderDischargeValues.map(v => v.padStart(10)).join('') + annualShoulderDischarge.padStart(12));

  // To off-peak (wasteful)
  const offpeakDischarge = analysis.overall.batteryDischargeTOU.offpeak ?? 0;
  if (offpeakDischarge > 0) {
    const offpeakDischargeRow = '  To off-peak ⚠️         ';
    let offpeakDischargeValues = seasonOrder.map(s => {
      const data = analysis.bySeason.get(s);
      if (!data || data.days === 0) return '--';
      const discharge = data.batteryDischargeTOU.offpeak ?? 0;
      if (discharge === 0) return '--';
      return fmt(discharge / data.days, 1) + 'kWh';
    });
    const annualOffpeakDischarge = analysis.overall.days > 0
      ? fmt(offpeakDischarge / analysis.overall.days, 1) + 'kWh/day'
      : '--';
    console.log(offpeakDischargeRow + offpeakDischargeValues.map(v => v.padStart(10)).join('') + annualOffpeakDischarge.padStart(12));
  }

  // Value attribution section
  console.log('\n' + '─'.repeat(95));
  console.log('VALUE ATTRIBUTION');

  // Calculate values using tariff rates
  const peakRate = getRateForPeriod('peak');
  const offpeakRate = getRateForPeriod('offpeak');
  const feedInRate = TARIFF.feedInTariff;

  const solarArbRow = '  Solar arbitrage value  ';
  let solarArbValues = seasonOrder.map(s => {
    const data = analysis.bySeason.get(s);
    if (!data || data.days === 0) return '--';
    // Value = solar charge that went to peak discharge
    const peakDischarge = data.batteryDischargeTOU.peak ?? 0;
    const solarCharge = data.chargeFromSolar;
    // Attribute peak discharge proportionally to solar vs grid charge
    const totalCharge = solarCharge + data.chargeFromGrid;
    const solarFraction = totalCharge > 0 ? solarCharge / totalCharge : 1;
    const solarToPeak = peakDischarge * solarFraction;
    const value = solarToPeak * (peakRate - feedInRate);
    return '$' + fmt(value, 0);
  });
  // Annual
  const annualPeakDischTotal = analysis.overall.batteryDischargeTOU.peak ?? 0;
  const annualTotalCharge = analysis.overall.chargeFromSolar + analysis.overall.chargeFromGrid;
  const annualSolarFraction = annualTotalCharge > 0 ? analysis.overall.chargeFromSolar / annualTotalCharge : 1;
  const annualSolarToPeak = annualPeakDischTotal * annualSolarFraction;
  const annualSolarArbValue = annualSolarToPeak * (peakRate - feedInRate);
  console.log(solarArbRow + solarArbValues.map(v => v.padStart(10)).join('') + ('$' + fmt(annualSolarArbValue, 0) + '/yr').padStart(10));

  const gridArbRow = '  Grid arbitrage value   ';
  let gridArbValues = seasonOrder.map(s => {
    const data = analysis.bySeason.get(s);
    if (!data || data.days === 0) return '--';
    const peakDischarge = data.batteryDischargeTOU.peak ?? 0;
    const totalCharge = data.chargeFromSolar + data.chargeFromGrid;
    const gridFraction = totalCharge > 0 ? data.chargeFromGrid / totalCharge : 0;
    const gridToPeak = peakDischarge * gridFraction;
    const value = gridToPeak * (peakRate - offpeakRate);
    return '$' + fmt(value, 0);
  });
  const annualGridFraction = annualTotalCharge > 0 ? analysis.overall.chargeFromGrid / annualTotalCharge : 0;
  const annualGridToPeak = annualPeakDischTotal * annualGridFraction;
  const annualGridArbValue = annualGridToPeak * (peakRate - offpeakRate);
  console.log(gridArbRow + gridArbValues.map(v => v.padStart(10)).join('') + ('$' + fmt(annualGridArbValue, 0) + '/yr').padStart(10));

  console.log('─'.repeat(95));
  const totalRow = '  Total battery value    ';
  let totalValues = seasonOrder.map(s => {
    const data = analysis.bySeason.get(s);
    if (!data || data.days === 0) return '--';
    const peakDischarge = data.batteryDischargeTOU.peak ?? 0;
    const totalCharge = data.chargeFromSolar + data.chargeFromGrid;
    const solarFrac = totalCharge > 0 ? data.chargeFromSolar / totalCharge : 1;
    const gridFrac = 1 - solarFrac;
    const solarValue = peakDischarge * solarFrac * (peakRate - feedInRate);
    const gridValue = peakDischarge * gridFrac * (peakRate - offpeakRate);
    return '$' + fmt(solarValue + gridValue, 0);
  });
  const annualTotalValue = annualSolarArbValue + annualGridArbValue;
  console.log(totalRow + totalValues.map(v => v.padStart(10)).join('') + ('$' + fmt(annualTotalValue, 0) + '/yr').padStart(10));
}

// ═══════════════════════════════════════════════════════════════════════════
// OPTIMIZATION RECOMMENDATIONS
// ═══════════════════════════════════════════════════════════════════════════

interface OptimizationIssue {
  severity: 'high' | 'medium' | 'low';
  issue: string;
  impact: string;
  annualValue: number;
  howToFix: string[];
}

function generateOptimizationRecommendations(analysis: Analysis, params?: BatteryParameters): OptimizationIssue[] {
  const issues: OptimizationIssue[] = [];
  const peakRate = getRateForPeriod('peak');
  const offpeakRate = getRateForPeriod('offpeak');
  const feedInRate = TARIFF.feedInTariff;
  const efficiency = params?.efficiency ?? BATTERY_EFFICIENCY;
  const usableCapacity = params?.usableCapacityPercent ?? USABLE_CAPACITY_PERCENT;

  // Get peak hours from tariff for recommendations
  const peakHours = TARIFF.periods?.everyday?.find((p: { name: string }) => p.name === 'peak')?.hours as number[] | undefined;

  // Format peak hours, handling split periods (e.g., 6-10am AND 3pm-1am)
  function formatPeakHours(hours: number[]): string {
    if (!hours || hours.length === 0) return 'check your tariff for peak hours';

    const sorted = [...hours].sort((a, b) => a - b);
    const ranges: string[] = [];
    let start = sorted[0]!;
    let end = sorted[0]!;

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === end + 1) {
        end = sorted[i]!;
      } else {
        ranges.push(`${start}:00-${end + 1}:00`);
        start = sorted[i]!;
        end = sorted[i]!;
      }
    }
    ranges.push(`${start}:00-${end + 1}:00`);

    return ranges.join(' and ');
  }

  const peakHoursDesc = formatPeakHours(peakHours ?? []);

  // Issue 1: Battery discharge timing (UNIFIED analysis)
  const offpeakDischarge = analysis.overall.batteryDischargeTOU.offpeak ?? 0;
  const shoulderDischarge = analysis.overall.batteryDischargeTOU.shoulder ?? 0;
  const peakDischarge = analysis.overall.batteryDischargeTOU.peak ?? 0;
  const totalDischarge = offpeakDischarge + peakDischarge + shoulderDischarge;

  // What peak import still remains? (this is what we COULD offset)
  const peakImport = analysis.overall.importByTOU.peak ?? 0;

  if (totalDischarge > 0) {
    const offpeakDischargePercent = (offpeakDischarge / totalDischarge) * 100;
    const peakDischargePercent = (peakDischarge / totalDischarge) * 100;
    const shoulderDischargePercent = (shoulderDischarge / totalDischarge) * 100;

    // Daily averages
    const offpeakDischargeDaily = offpeakDischarge / analysis.overall.days;
    const peakDischargeDaily = peakDischarge / analysis.overall.days;
    const peakImportDaily = peakImport / analysis.overall.days;
    const totalDischargeDaily = totalDischarge / analysis.overall.days;

    // How much off-peak discharge COULD be redirected to peak?
    // Limited by: remaining peak import (can't discharge more than you'd import)
    const redirectable = Math.min(offpeakDischargeDaily, peakImportDaily);
    const redirectValue = redirectable * (peakRate - offpeakRate) * 365;

    if (offpeakDischargePercent > 20 && redirectValue > 50) {
      const howToFix: string[] = [];

      howToFix.push('📊 CURRENT DISCHARGE BREAKDOWN:');
      howToFix.push(`   Peak (${peakHoursDesc}):     ${fmt(peakDischargeDaily, 1)} kWh/day (${fmt(peakDischargePercent, 0)}%)`);
      if (shoulderDischargePercent > 1) {
        howToFix.push(`   Shoulder:                   ${fmt(shoulderDischarge / analysis.overall.days, 1)} kWh/day (${fmt(shoulderDischargePercent, 0)}%)`);
      }
      howToFix.push(`   Off-peak:                   ${fmt(offpeakDischargeDaily, 1)} kWh/day (${fmt(offpeakDischargePercent, 0)}%) ⚠️`);
      howToFix.push(`   Total:                      ${fmt(totalDischargeDaily, 1)} kWh/day`);
      howToFix.push('');

      // Analyze WHY off-peak discharge is happening
      howToFix.push('❓ WHY IS BATTERY DISCHARGING DURING OFF-PEAK?');

      if (peakImportDaily > 0.5) {
        // Still importing during peak = battery discharging at wrong time
        howToFix.push(`   → You still import ${fmt(peakImportDaily, 1)} kWh/day during PEAK`);
        howToFix.push(`   → But battery discharges ${fmt(offpeakDischargeDaily, 1)} kWh/day during OFF-PEAK`);
        howToFix.push(`   → Battery is discharging at the WRONG TIME`);
        howToFix.push(`   → Likely cause: "Self-Consumption" mode ignores TOU rates`);
        howToFix.push('');
        howToFix.push('💰 VALUE OF FIXING THIS:');
        howToFix.push(`   Redirect ${fmt(redirectable, 1)} kWh/day from off-peak → peak:`);
        howToFix.push(`   • Currently saves:  $${fmt(redirectable * offpeakRate, 2)}/day (off-peak rate $${fmt(offpeakRate, 2)})`);
        howToFix.push(`   • Could save:       $${fmt(redirectable * peakRate, 2)}/day (peak rate $${fmt(peakRate, 2)})`);
        howToFix.push(`   • Extra value:      $${fmt(redirectable * (peakRate - offpeakRate), 2)}/day = $${fmt(redirectValue, 0)}/year`);
      } else {
        howToFix.push(`   → Peak import is only ${fmt(peakImportDaily, 1)} kWh/day (already mostly covered)`);
        howToFix.push(`   → Off-peak discharge is powering your off-peak consumption`);
        howToFix.push(`   → This is self-consumption, not waste - limited room for improvement`);
      }

      howToFix.push('');
      howToFix.push('🔧 HOW TO FIX:');
      howToFix.push('   1. Open AlphaESS app → Settings → Function Setting');
      howToFix.push('   2. Enable "Battery Discharge Time Control"');
      howToFix.push(`   3. Set discharge period to: ${peakHoursDesc}`);
      howToFix.push('   4. This tells battery to PRIORITIZE peak hours');
      howToFix.push('   5. Battery will still power loads from solar during off-peak');
      howToFix.push('      but won\'t drain stored energy until peak hours');

      issues.push({
        severity: offpeakDischargePercent > 40 ? 'high' : 'medium',
        issue: `Battery discharge timing: ${fmt(peakDischargePercent, 0)}% peak vs ${fmt(offpeakDischargePercent, 0)}% off-peak`,
        impact: `Discharging ${fmt(offpeakDischargeDaily, 1)} kWh/day during cheap off-peak while still importing ${fmt(peakImportDaily, 1)} kWh/day during expensive peak`,
        annualValue: redirectValue,
        howToFix
      });
    }
  }

  // Issue 2: Peak grid charging waste
  const peakGridCharge = analysis.overall.gridChargeTOU.peak ?? 0;
  const totalGridCharge = analysis.overall.chargeFromGrid;

  if (peakGridCharge > 0) {
    const peakChargePercent = totalGridCharge > 0 ? (peakGridCharge / totalGridCharge) * 100 : 0;
    const annualWaste = (peakGridCharge / analysis.overall.days) * 365 * (peakRate - offpeakRate);

    if (annualWaste > 20) {
      issues.push({
        severity: peakChargePercent > 30 ? 'high' : 'medium',
        issue: `Battery charging from grid during peak periods (${fmt(peakChargePercent, 0)}% of grid charging)`,
        impact: `Paying peak rate ($${fmt(peakRate, 2)}/kWh) instead of off-peak ($${fmt(offpeakRate, 2)}/kWh) to charge`,
        annualValue: annualWaste,
        howToFix: [
          '1. Open AlphaESS app → Settings → Function Setting',
          '2. Enable "Charge Batteries from Grid"',
          '3. Set charging period to ONLY off-peak hours (typically overnight)',
          '4. Disable any "force charge" settings during peak hours',
          '5. Consider setting a charge limit (e.g., charge to 80%) to leave room for solar'
        ]
      });
    }
  }

  // Issue 4: Missed solar capture (exporting while battery has capacity)
  const avgExport = analysis.overall.gridExport / analysis.overall.days;
  const avgSolarCharge = analysis.overall.chargeFromSolar / analysis.overall.days;
  const batteryCapacity = analysis.currentBatteryKwh * usableCapacity;

  // Analyze battery "reaching full" behavior across all days
  const daysReachedFull = analysis.daily.filter(d => d.battery.reachedFullSoC).length;
  const daysWithData = analysis.daily.filter(d => d.battery.maxSoC > 0).length;
  const pctDaysReachedFull = daysWithData > 0 ? (daysReachedFull / daysWithData) * 100 : 0;

  const daysWithHourData = analysis.daily.filter(d => d.battery.hourReachedFull >= 0);
  const avgHourReachedFull = daysWithHourData.length > 0
    ? daysWithHourData.reduce((sum, d) => sum + d.battery.hourReachedFull, 0) / daysWithHourData.length
    : -1;

  const totalExportAfterFull = analysis.daily.reduce((sum, d) => sum + d.battery.exportAfterFull, 0);
  const avgExportAfterFull = analysis.overall.days > 0 ? totalExportAfterFull / analysis.overall.days : 0;

  if (avgExport > 2 && avgSolarCharge < batteryCapacity * 0.7) {
    // Significant export but battery not fully utilizing solar
    const potentialCapture = Math.min(avgExport, batteryCapacity - avgSolarCharge);
    const annualValue = potentialCapture * 365 * (peakRate - feedInRate);

    if (annualValue > 50) {
      // Build data-driven how-to-fix based on actual battery behavior
      const howToFix: string[] = [];

      if (pctDaysReachedFull > 50 && avgHourReachedFull >= 0) {
        const hourFormatted = avgHourReachedFull < 10 ? `0${Math.floor(avgHourReachedFull)}:00` : `${Math.floor(avgHourReachedFull)}:00`;
        howToFix.push(`✓ Battery reaches 100% on ${fmt(pctDaysReachedFull, 0)}% of days, typically around ${hourFormatted}`);
        howToFix.push(`  → ${fmt(avgExportAfterFull, 1)} kWh/day exported AFTER battery is full`);

        // Model what would happen with additional battery capacity
        // Estimate solar charge rate: current capacity / hours to fill
        const SOLAR_START_HOUR = 7;  // Assume meaningful solar starts at 7am
        const hoursToFill = Math.max(1, avgHourReachedFull - SOLAR_START_HOUR);
        const solarChargeRate = avgSolarCharge / hoursToFill;  // kWh per hour

        // With +10kWh battery, how much later would it fill?
        const additionalCapacity = BATTERY_SIZE_KWH * usableCapacity;
        const additionalHoursToFill = solarChargeRate > 0 ? additionalCapacity / solarChargeRate : 0;
        const newFillHour = avgHourReachedFull + additionalHoursToFill;

        // How much more solar could be captured?
        // KEY CONSTRAINT: You can only capture what you can usefully discharge!
        // Remaining peak import = what's left after current battery
        const remainingPeakImport = (analysis.overall.importByTOU.peak ?? 0) / analysis.overall.days;
        const remainingShoulderImport = (analysis.overall.importByTOU.shoulder ?? 0) / analysis.overall.days;
        const maxUsefulDischarge = remainingPeakImport + remainingShoulderImport;

        // Solar capturable is limited by: export available, capacity, and useful discharge
        const additionalSolarCapture = Math.min(
          avgExportAfterFull,
          additionalCapacity,
          maxUsefulDischarge / efficiency  // Can only store what you can usefully discharge
        );

        // Get the actual modeled value from scenarios (more accurate than avg calculation)
        const scenarios = modelBatteryScenarios(analysis, params);
        const plusOneBattery = scenarios.find(s => s.additionalBatteries === 1);
        const modeledSolarArb = plusOneBattery?.solarArbitrageValue ?? 0;
        const modeledGridArb = plusOneBattery?.gridArbitrageValue ?? 0;
        const modeledTotal = plusOneBattery?.annualSavings ?? 0;

        howToFix.push('');
        howToFix.push('  📊 MODELING: What if you had MORE battery capacity?');
        howToFix.push(`     Current ${fmt(batteryCapacity, 0)}kWh fills at ~${hourFormatted}`);
        howToFix.push(`     Solar charge rate: ~${fmt(solarChargeRate, 1)} kWh/hour`);
        howToFix.push(`     Remaining peak+shoulder import: ${fmt(maxUsefulDischarge, 1)} kWh/day avg`);
        howToFix.push('');
        if (newFillHour < 24) {
          const newHourFormatted = newFillHour < 10 ? `0${Math.floor(newFillHour)}:00` : `${Math.floor(newFillHour)}:00`;
          howToFix.push(`     With +${BATTERY_SIZE_KWH}kWh (${fmt(batteryCapacity + additionalCapacity, 0)}kWh total):`);
          howToFix.push(`        → Would fill at ~${newHourFormatted} instead of ${hourFormatted}`);
          if (additionalSolarCapture < avgExportAfterFull * 0.9) {
            // Limited by peak import, not by export
            howToFix.push(`        → Export after full: ${fmt(avgExportAfterFull, 1)} kWh/day`);
            howToFix.push(`        → But can only offset: ${fmt(maxUsefulDischarge, 1)} kWh/day peak import`);
          } else {
            howToFix.push(`        → Could capture extra ${fmt(additionalSolarCapture, 1)} kWh/day`);
          }
          howToFix.push('');
          howToFix.push(`     ACTUAL MODELED VALUE (day-by-day calculation):`);
          howToFix.push(`        → Solar arbitrage: $${fmt(modeledSolarArb, 0)}/year`);
          howToFix.push(`        → Grid arbitrage:  $${fmt(modeledGridArb, 0)}/year`);
          howToFix.push(`        → TOTAL:           $${fmt(modeledTotal, 0)}/year`);
          howToFix.push(`        → Payback:         ${fmt(BATTERY_COST / modeledTotal, 1)} years ($${BATTERY_COST} cost)`);
        } else {
          howToFix.push(`     With +${BATTERY_SIZE_KWH}kWh: Would NOT reach 100% on most days`);
          howToFix.push(`        → Solar arbitrage: $${fmt(modeledSolarArb, 0)}/year`);
          howToFix.push(`        → Grid arbitrage:  $${fmt(modeledGridArb, 0)}/year`);
          howToFix.push(`        → TOTAL:           $${fmt(modeledTotal, 0)}/year`);
        }

        if (avgHourReachedFull < 12) {
          howToFix.push('');
          howToFix.push('  ⚠️  BUT: Battery fills BEFORE solar peak!');

          // Check if morning consumption is high enough for pre-discharge strategy
          const avgEarlyMorningLoad = analysis.overall.earlyMorningLoad / analysis.overall.days;
          // Note: batteryCapacity already has USABLE_CAPACITY_PERCENT applied (line 1644)
          const nominalCapacity = analysis.currentBatteryKwh;

          howToFix.push('');
          howToFix.push('  📊 MORNING (6-10am) ANALYSIS:');
          howToFix.push(`     Your morning consumption:    ${fmt(avgEarlyMorningLoad, 1)} kWh/day`);
          howToFix.push(`     Battery capacity:            ${fmt(nominalCapacity, 1)} kWh`);

          // Calculate what % of battery morning load would drain
          const drainPercent = (avgEarlyMorningLoad / nominalCapacity) * 100;

          if (drainPercent >= 50) {
            // Enough morning consumption to significantly drain battery
            howToFix.push(`     Potential drain:             ${fmt(drainPercent, 0)}% of battery`);
            howToFix.push('');
            howToFix.push('  ✓  PRE-DISCHARGE STRATEGY VIABLE:');
            howToFix.push('     Currently: Battery is full overnight → fills early → exports excess');
            howToFix.push('     With pre-discharge: Battery powers morning load → has room for solar');
            howToFix.push('');
            howToFix.push('  🔧 HOW TO IMPLEMENT:');
            howToFix.push('     1. Set "Battery Discharge Time Control" to include 6:00-10:00');
            howToFix.push('     2. Battery will power your morning consumption');
            howToFix.push(`     3. This creates ~${fmt(avgEarlyMorningLoad, 1)} kWh headroom for solar`);
            howToFix.push('     4. More solar captured = less wasted export');
          } else if (drainPercent >= 20) {
            // Some morning consumption, partial benefit
            howToFix.push(`     Potential drain:             ${fmt(drainPercent, 0)}% of battery`);
            howToFix.push('');
            howToFix.push('  ⚠️  PARTIAL PRE-DISCHARGE POSSIBLE:');
            howToFix.push(`     Morning load would only drain ${fmt(drainPercent, 0)}% of battery`);
            howToFix.push(`     Creates ${fmt(avgEarlyMorningLoad, 1)} kWh headroom, but battery still mostly full`);
            howToFix.push('     May help capture some extra solar, but limited benefit');
          } else {
            // Very low morning consumption - pre-discharge won't help
            howToFix.push(`     Potential drain:             only ${fmt(drainPercent, 0)}% of battery`);
            howToFix.push('');
            howToFix.push('  ❌  PRE-DISCHARGE WON\'T HELP:');
            howToFix.push('     Your morning consumption is too low to drain the battery');
            howToFix.push('     Battery will still be nearly full when solar ramps up');
            howToFix.push('     → Additional battery capacity is the only solution for more capture');
          }
        } else {
          howToFix.push('');
          howToFix.push('  ✓  Battery fills in AFTERNOON (after solar peak)');
          howToFix.push('     Additional capacity WOULD help capture more solar.');
        }
      } else if (pctDaysReachedFull < 30) {
        howToFix.push(`✓ Battery only reaches 100% on ${fmt(pctDaysReachedFull, 0)}% of days`);
        howToFix.push('  → Battery capacity is NOT the limiting factor');
        howToFix.push('');
        howToFix.push('  Check these settings:');
        howToFix.push('  1. Ensure "Charge from Solar" / "Self-consumption" is enabled');
        howToFix.push('  2. Check if there\'s a charge limit (e.g., 80%) set');
        howToFix.push('  3. Verify inverter/battery communication is working');
      } else {
        howToFix.push('1. Check battery charge settings - ensure "Charge from Solar" is enabled');
        howToFix.push('2. Verify no charge limit is set too low');
        howToFix.push('3. Review any "grid charge" schedules that might fill battery before solar peak');
      }

      issues.push({
        severity: potentialCapture > 3 ? 'medium' : 'low',
        issue: `Exporting ${fmt(avgExport, 1)} kWh/day while battery only captures ${fmt(avgSolarCharge, 1)} kWh/day from solar`,
        impact: `Could store more solar instead of exporting at low feed-in rate ($${fmt(feedInRate, 2)}/kWh)`,
        annualValue: annualValue,
        howToFix
      });
    }
  }

  // Sort by annual value (highest first)
  issues.sort((a, b) => b.annualValue - a.annualValue);

  return issues;
}

function printOptimizationRecommendations(analysis: Analysis, params?: BatteryParameters): void {
  const issues = generateOptimizationRecommendations(analysis, params);

  if (issues.length === 0) {
    console.log('\n✅ BATTERY OPTIMIZATION');
    console.log('═'.repeat(95));
    console.log('  No significant optimization issues detected. Battery appears well-configured!');
    return;
  }

  const totalAnnualValue = issues.reduce((sum, i) => sum + i.annualValue, 0);

  console.log('\n🔧 BATTERY OPTIMIZATION RECOMMENDATIONS');
  console.log('═'.repeat(95));
  console.log(`  Total potential savings from optimization: $${fmt(totalAnnualValue, 0)}/year`);
  console.log('  (This is FREE money - no hardware purchase required!)\n');

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    if (!issue) continue;

    const severityIcon = issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '🟡' : '🟢';
    const severityLabel = issue.severity.toUpperCase();

    console.log(`  ${severityIcon} ISSUE ${i + 1}: ${issue.issue}`);
    console.log(`     Severity: ${severityLabel} | Potential value: $${fmt(issue.annualValue, 0)}/year`);
    console.log(`     Impact: ${issue.impact}`);
    console.log('');
    console.log('     HOW TO FIX:');
    for (const step of issue.howToFix) {
      console.log(`       ${step}`);
    }
    console.log('');
    console.log('─'.repeat(95));
  }

  // Summary comparison
  console.log('\n  💡 OPTIMIZATION vs NEW BATTERY COMPARISON');
  console.log('─'.repeat(95));
  console.log(`     Fix current battery settings:  +$${fmt(totalAnnualValue, 0)}/year (FREE)`);

  // Calculate what a new battery would add - use the same logic as modelBatteryScenarios
  // Get the pre-calculated scenario value for consistency
  const scenarios = modelBatteryScenarios(analysis, params);
  const plusOneBattery = scenarios.find(s => s.additionalBatteries === 1);
  const newBatteryAnnual = plusOneBattery ? plusOneBattery.annualSavings : 0;

  console.log(`     Buy additional ${BATTERY_SIZE_KWH}kWh battery:    +$${fmt(newBatteryAnnual, 0)}/year (costs $${BATTERY_COST})`);
  console.log('');

  if (totalAnnualValue > newBatteryAnnual * 0.5) {
    console.log('     ⚠️  RECOMMENDATION: Fix settings FIRST before considering new hardware!');
    console.log('        The optimization savings are significant compared to new battery value.');
  }

  // Check for discharge timing issue and show backup power consideration
  const dischargeTimingIssue = issues.find(i => i.issue.includes('discharge timing'));
  if (dischargeTimingIssue) {
    console.log('\n  🔌 BACKUP POWER CONSIDERATION');
    console.log('─'.repeat(95));
    console.log('     Off-peak discharge depletes battery BEFORE the evening peak.');
    console.log('     This means LESS reserve available when:');
    console.log('        • Grid stress is highest (outages more likely)');
    console.log('        • Family is home and needs power (evening)');
    console.log('');
    console.log('     ✓  Reserving battery for peak ALSO improves backup reliability!');
    console.log('');
    console.log('     💡 BONUS: Fixing discharge timing improves BOTH savings AND backup!');
  }

  // Address environmental considerations with actual carbon calculations
  console.log('\n  🌱 CARBON IMPACT ANALYSIS');
  console.log('─'.repeat(95));

  // Australian grid carbon intensity estimates (g CO2/kWh)
  // Source: Australian Energy Market Operator (AEMO) data
  // VIC/SA grid is coal-heavy, especially at night
  const GRID_CARBON_DAYTIME = 450;   // g CO2/kWh - lower due to solar on grid
  const GRID_CARBON_NIGHT = 750;     // g CO2/kWh - higher coal baseload at night
  const GRID_CARBON_PEAK = 600;      // g CO2/kWh - gas peakers + coal

  // Calculate actual carbon flows from their data
  const carbonAvgExport = analysis.overall.gridExport / analysis.overall.days;
  const carbonAvgGridCharge = analysis.overall.chargeFromGrid / analysis.overall.days;
  const carbonAvgSolarCharge = analysis.overall.chargeFromSolar / analysis.overall.days;
  const carbonAvgPeakImport = (analysis.overall.importByTOU.peak ?? 0) / analysis.overall.days;
  const carbonAvgOffpeakImport = (analysis.overall.importByTOU.offpeak ?? 0) / analysis.overall.days;

  // Carbon saved by solar export (displaces grid generation)
  const carbonSavedByExport = carbonAvgExport * GRID_CARBON_DAYTIME / 1000;  // kg CO2/day

  // Carbon from grid imports
  const carbonFromPeakImport = carbonAvgPeakImport * GRID_CARBON_PEAK / 1000;
  const carbonFromOffpeakImport = carbonAvgOffpeakImport * GRID_CARBON_NIGHT / 1000;
  const totalCarbonImport = carbonFromPeakImport + carbonFromOffpeakImport;

  // Battery carbon: solar charge is clean, grid charge has carbon cost
  const batteryCleanPercent = (carbonAvgSolarCharge + carbonAvgGridCharge) > 0
    ? (carbonAvgSolarCharge / (carbonAvgSolarCharge + carbonAvgGridCharge)) * 100
    : 100;
  const carbonFromGridCharge = carbonAvgGridCharge * GRID_CARBON_NIGHT / 1000;  // Grid charge usually overnight

  // Net carbon position
  const netCarbonDaily = totalCarbonImport + carbonFromGridCharge - carbonSavedByExport;
  const netCarbonAnnual = netCarbonDaily * 365;

  console.log('     YOUR CARBON FOOTPRINT (based on actual usage data):');
  console.log('');
  console.log(`     Solar export to grid:       ${fmt(carbonAvgExport, 1)} kWh/day`);
  console.log(`        → Displaces grid power:  -${fmt(carbonSavedByExport, 1)} kg CO2/day saved`);
  console.log('');
  console.log(`     Grid imports:`);
  console.log(`        Peak imports:            ${fmt(carbonAvgPeakImport, 1)} kWh/day → +${fmt(carbonFromPeakImport, 1)} kg CO2/day`);
  console.log(`        Off-peak imports:        ${fmt(carbonAvgOffpeakImport, 1)} kWh/day → +${fmt(carbonFromOffpeakImport, 1)} kg CO2/day`);
  console.log('');
  console.log(`     Battery charging:`);
  console.log(`        From solar (clean):      ${fmt(carbonAvgSolarCharge, 1)} kWh/day (${fmt(batteryCleanPercent, 0)}% of charge)`);
  console.log(`        From grid (night):       ${fmt(carbonAvgGridCharge, 1)} kWh/day → +${fmt(carbonFromGridCharge, 1)} kg CO2/day`);
  console.log('');
  console.log('     ─────────────────────────────────────────────────────────────');
  if (netCarbonDaily < 0) {
    console.log(`     NET CARBON:                 ${fmt(Math.abs(netCarbonDaily), 1)} kg CO2/day NEGATIVE (you're carbon positive!)`);
    console.log(`                                 ${fmt(Math.abs(netCarbonAnnual), 0)} kg CO2/year saved`);
  } else {
    console.log(`     NET CARBON:                 +${fmt(netCarbonDaily, 1)} kg CO2/day`);
    console.log(`                                 +${fmt(netCarbonAnnual, 0)} kg CO2/year`);
  }

  // Analysis of what adding more battery would do for carbon
  console.log('');
  console.log('     📊 WOULD MORE BATTERY HELP THE ENVIRONMENT?');
  console.log('');

  if (carbonAvgGridCharge > 0.5) {
    const gridChargeCarbon = carbonAvgGridCharge * GRID_CARBON_NIGHT * 365 / 1000;
    console.log(`     ⚠️  You charge ${fmt(carbonAvgGridCharge, 1)} kWh/day from GRID (mostly overnight)`);
    console.log(`        This adds ${fmt(gridChargeCarbon, 0)} kg CO2/year (night grid is ${GRID_CARBON_NIGHT}g CO2/kWh)`);
    console.log('');
    console.log('        Grid arbitrage (charge off-peak → discharge peak) is NOT green:');
    console.log(`        • Off-peak grid is coal-heavy (${GRID_CARBON_NIGHT}g vs ${GRID_CARBON_PEAK}g peak)`);
    console.log('        • You\'re storing "dirty" night power to use during "cleaner" day');
  }

  if (carbonAvgExport > 2) {
    console.log('');
    console.log(`     ✓  You export ${fmt(carbonAvgExport, 1)} kWh/day - this IS helping the grid go green`);
    console.log('        Solar export during daytime displaces fossil generation');
    console.log('        Capturing more of this in battery is carbon-neutral (not better, not worse)');
  }

  // Verdict
  console.log('');
  console.log('     VERDICT:');
  if (carbonAvgGridCharge > carbonAvgSolarCharge * 0.3) {
    console.log('        → Reduce GRID charging to improve carbon footprint');
    console.log('        → Prioritize solar capture over grid arbitrage');
  } else if (carbonAvgExport > carbonAvgSolarCharge) {
    console.log('        → Your solar export already helps the grid');
    console.log('        → More battery for solar capture = carbon neutral');
    console.log('        → More battery for grid arbitrage = INCREASES carbon');
  } else {
    console.log('        → Your system is well-optimized for carbon');
    console.log('        → Focus on reducing overall consumption for more impact');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

function main() {
  console.log('═'.repeat(100));
  console.log('🔋 ALPHAESS BATTERY ECONOMICS ANALYSIS - SEASONAL BREAKDOWN');
  console.log('═'.repeat(100));

  const stats = loadLatestStats();
  const analysis = analyzeHistoricalData(stats);

  if (analysis.overall.days === 0) {
    console.error('❌ No historical energy data available');
    process.exit(1);
  }

  // Calculate battery parameters from actual data
  const params = calculateBatteryParameters(analysis);

  // Rates
  console.log('\n📊 TARIFF: ' + TARIFF.name);
  console.log('─'.repeat(60));
  // Show periods sorted by rate (highest first)
  for (const period of getPeriodsByRate()) {
    const label = (period.name.charAt(0).toUpperCase() + period.name.slice(1) + ':').padEnd(25);
    console.log(`  ${label} $${period.rate.toFixed(4)}/kWh`);
  }
  // Show feed-in rates
  if (hasTOUFeedIn()) {
    console.log('  Feed-in (TOU):');
    for (const period of getFeedInPeriodsByRate()) {
      const label = ('    ' + period.name + ':').padEnd(27);
      console.log(`${label} $${period.rate.toFixed(4)}/kWh`);
    }
  } else {
    console.log(`  ${'Feed-in tariff:'.padEnd(25)} $${TARIFF.feedInTariff.toFixed(4)}/kWh`);
  }
  // Show day types
  console.log('  Day types:');
  for (const [name, pattern] of Object.entries(TARIFF.dayTypes)) {
    console.log(`    ${name}: ${pattern}`);
  }

  // Data summary
  console.log('\n📈 DATA SUMMARY');
  console.log('─'.repeat(60));
  console.log(`  Date Range:                  ${analysis.dateRange.start} to ${analysis.dateRange.end}`);
  console.log(`  Total Days Analyzed:         ${analysis.overall.days}`);
  console.log(`  Current Battery:             ${analysis.currentBatteryKwh} kWh`);

  // Calculated battery parameters
  console.log('\n📊 SYSTEM PARAMETERS (calculated from your data)');
  console.log('─'.repeat(60));
  const effSource = params.efficiencyDays > 0
    ? `from ${params.efficiencyDays} days of data`
    : 'default (no data)';
  console.log(`  Round-trip efficiency:       ${(params.efficiency * 100).toFixed(1)}% (${effSource})`);

  if (params.socRangeDays > 0) {
    console.log(`  Usable capacity:             ${(params.usableCapacityPercent * 100).toFixed(0)}% (observed SoC range ${params.observedMinSoC.toFixed(0)}-${params.observedMaxSoC.toFixed(0)}%)`);
    if (params.configuredReservePercent > 0) {
      const configuredUsable = 100 - params.configuredReservePercent;
      const actualVsConfigured = params.observedMinSoC > params.configuredReservePercent
        ? `typically stays above ${params.configuredReservePercent}% reserve`
        : `reaches configured ${params.configuredReservePercent}% reserve`;
      console.log(`                               ↳ Reserve setting: ${params.configuredReservePercent}% (${configuredUsable}% max usable, ${actualVsConfigured})`);
    }
  } else {
    console.log(`  Usable capacity:             ${(params.usableCapacityPercent * 100).toFixed(0)}% (default - no SoC data)`);
  }

  console.log(`  Max charge rate:             ${params.maxChargeRateKw.toFixed(1)} kW`);
  console.log(`  Solar charging window:       ${params.solarChargingHours} hours (non-peak daylight)`);

  const lifespanIcon = params.lifespanConfidence === 'high' ? '✓' :
    params.lifespanConfidence === 'medium' ? '~' : '⚠️';
  console.log(`  Estimated lifespan:          ${lifespanIcon} ${params.estimatedLifespanYears.toFixed(1)} years (${params.lifespanConfidence} confidence)`);

  if (params.warnings.length > 0) {
    console.log('  Notes:');
    for (const warning of params.warnings) {
      console.log(`    • ${warning}`);
    }
  }

  // Overall totals
  console.log('\n📊 LIFETIME TOTALS');
  console.log('─'.repeat(60));
  console.log(`  Total PV Generation:         ${fmt(analysis.overall.pvGeneration, 0)} kWh`);
  console.log(`  Total Grid Import:           ${fmt(analysis.overall.gridImport, 0)} kWh`);
  console.log(`  Total Grid Export:           ${fmt(analysis.overall.gridExport, 0)} kWh`);
  console.log(`  Total Battery Charged:       ${fmt(analysis.overall.batteryCharge, 0)} kWh`);
  console.log(`  Self-Consumption Rate:       ${fmt((1 - analysis.overall.gridExport / (analysis.overall.pvGeneration || 1)) * 100)}%`);

  // Yearly breakdown
  const yearlyPeriods: [string, PeriodAnalysis][] = Array.from(analysis.byYear.entries())
    .sort(([a], [b]) => a - b)
    .map(([year, data]) => [year.toString(), data]);
  printPeriodTable('📅 YEARLY BREAKDOWN (avg kWh/day)', yearlyPeriods);

  // Seasonal breakdown (all-time averages)
  const seasonOrder: SeasonName[] = ['summer', 'autumn', 'winter', 'spring'];
  const seasonalPeriods: [string, PeriodAnalysis][] = seasonOrder
    .map((s): [string, PeriodAnalysis | undefined] => [s.charAt(0).toUpperCase() + s.slice(1), analysis.bySeason.get(s)])
    .filter((pair): pair is [string, PeriodAnalysis] => pair[1] !== undefined && pair[1].days > 0);
  printPeriodTable('🌡️  SEASONAL BREAKDOWN (avg kWh/day)', seasonalPeriods);

  // TOU Breakdown - calculated vs estimated
  console.log('\n⏰ TIME-OF-USE BREAKDOWN');
  console.log('═'.repeat(85));

  const estimatedImportDist = { peak: 70, shoulder: 5, offpeak: 25 };
  const estimatedExportDist = { peak: 20, shoulder: 75, offpeak: 5 };

  if (analysis.hasPowerData) {
    const calcImportPct = touPercentages(analysis.overall.importByTOU);
    const calcExportPct = touPercentages(analysis.overall.exportByTOU);

    console.log('\n  GRID IMPORT by Time-of-Use:');
    console.log('─'.repeat(85));
    console.log('                        Peak         Shoulder      Off-peak      Total kWh');
    console.log('─'.repeat(85));
    console.log(
      '  Calculated (actual)   ' +
      pad(fmt(calcImportPct.peak ?? 0, 1) + '%', 12) +
      pad(fmt(calcImportPct.shoulder ?? 0, 1) + '%', 14) +
      pad(fmt(calcImportPct.offpeak ?? 0, 1) + '%', 14) +
      pad(fmt(touTotal(analysis.overall.importByTOU), 0), 12)
    );
    console.log(
      '  Estimated (assumed)   ' +
      pad(estimatedImportDist.peak + '%', 12) +
      pad(estimatedImportDist.shoulder + '%', 14) +
      pad(estimatedImportDist.offpeak + '%', 14) +
      pad('--', 12)
    );

    console.log('\n  GRID EXPORT by Time-of-Use:');
    console.log('─'.repeat(85));
    console.log(
      '  Calculated (actual)   ' +
      pad(fmt(calcExportPct.peak ?? 0, 1) + '%', 12) +
      pad(fmt(calcExportPct.shoulder ?? 0, 1) + '%', 14) +
      pad(fmt(calcExportPct.offpeak ?? 0, 1) + '%', 14) +
      pad(fmt(touTotal(analysis.overall.exportByTOU), 0), 12)
    );
    console.log(
      '  Estimated (assumed)   ' +
      pad(estimatedExportDist.peak + '%', 12) +
      pad(estimatedExportDist.shoulder + '%', 14) +
      pad(estimatedExportDist.offpeak + '%', 14) +
      pad('--', 12)
    );

    // Calculate cost difference
    const calcImportCost = calculateTOUCost(analysis.overall.importByTOU);
    const estDistFraction = { peak: estimatedImportDist.peak / 100, shoulder: estimatedImportDist.shoulder / 100, offpeak: estimatedImportDist.offpeak / 100 };
    const estImportCost = analysis.overall.gridImport * calculateWeightedAvgRate(estDistFraction);

    console.log('\n  COST COMPARISON:');
    console.log(`    Import cost (calculated): $${fmt(calcImportCost, 2)}`);
    console.log(`    Import cost (estimated):  $${fmt(estImportCost, 2)}`);
    console.log(`    Difference:               $${fmt(calcImportCost - estImportCost, 2)} (${fmt((calcImportCost - estImportCost) / estImportCost * 100, 1)}%)`);
  } else {
    console.log('\n  ⚠️  No power data available - using estimated TOU distribution');
    console.log('  Import: Peak ' + estimatedImportDist.peak + '% | Shoulder ' + estimatedImportDist.shoulder + '% | Off-peak ' + estimatedImportDist.offpeak + '%');
    console.log('  Export: Peak ' + estimatedExportDist.peak + '% | Shoulder ' + estimatedExportDist.shoulder + '% | Off-peak ' + estimatedExportDist.offpeak + '%');
  }

  // Battery Utilization Report (Phase 2: Ground truth from power data)
  if (analysis.hasPowerData) {
    printBatteryUtilizationReport(analysis);
    printOptimizationRecommendations(analysis, params);
  }

  // Battery Efficiency / Degradation
  console.log('\n🔋 BATTERY EFFICIENCY OVER TIME');
  console.log('═'.repeat(85));

  if (analysis.batteryEfficiency.length > 0) {
    console.log('  Period      Charged(kWh)  Discharged(kWh)  Efficiency   Cycles   Degradation');
    console.log('─'.repeat(85));

    const firstEfficiency = analysis.batteryEfficiency[0]?.efficiency ?? 0;
    for (const period of analysis.batteryEfficiency) {
      const degradation = firstEfficiency > 0
        ? ((firstEfficiency - period.efficiency) / firstEfficiency * 100)
        : 0;
      const degradationStr = degradation > 0 ? `-${fmt(degradation, 1)}%` : '--';

      console.log(
        '  ' + period.period.padEnd(12) +
        pad(fmt(period.charge, 0), 12) +
        pad(fmt(period.discharge, 0), 16) +
        pad(fmt(period.efficiency * 100, 1) + '%', 13) +
        pad(fmt(period.cycleCount, 0), 9) +
        pad(degradationStr, 12)
      );
    }

    // Summary
    const first = analysis.batteryEfficiency[0];
    const last = analysis.batteryEfficiency[analysis.batteryEfficiency.length - 1];
    if (first && last && first !== last) {
      const totalDegradation = ((first.efficiency - last.efficiency) / first.efficiency * 100);
      const totalCycles = analysis.batteryEfficiency.reduce((sum, p) => sum + p.cycleCount, 0);

      console.log('─'.repeat(85));
      console.log(`  Initial efficiency: ${fmt(first.efficiency * 100, 1)}%`);
      console.log(`  Current efficiency: ${fmt(last.efficiency * 100, 1)}%`);
      if (totalDegradation > 0) {
        console.log(`  Total degradation:  ${fmt(totalDegradation, 2)}% over ~${fmt(totalCycles, 0)} cycles`);
        console.log(`  Degradation rate:   ${fmt(totalDegradation / totalCycles * 100, 3)}% per 100 cycles`);
      }
    }
  } else {
    console.log('  ⚠️  Insufficient battery data to calculate efficiency trends');
  }

  // Solar Degradation
  console.log('\n☀️  SOLAR PANEL DEGRADATION');
  console.log('═'.repeat(85));

  if (analysis.solarDegradation.hasEnoughData) {
    console.log('  Season       Year 1 → Year 2      Avg PV (kWh/day)         Change');
    console.log('─'.repeat(85));

    for (const period of analysis.solarDegradation.periods) {
      const changeStr = period.change >= 0
        ? `+${fmt(period.change, 1)}%`
        : `${fmt(period.change, 1)}%`;
      const changeColor = period.change < -1 ? '⚠️ ' : '   ';

      console.log(
        '  ' + period.season.padEnd(13) +
        `${period.year1} → ${period.year2}`.padEnd(18) +
        `${fmt(period.avgPV1, 1)} → ${fmt(period.avgPV2, 1)}`.padEnd(24) +
        changeColor + changeStr
      );
    }

    console.log('─'.repeat(85));
    const rateStr = analysis.solarDegradation.annualRate >= 0
      ? `+${fmt(analysis.solarDegradation.annualRate, 2)}%`
      : `${fmt(analysis.solarDegradation.annualRate, 2)}%`;
    console.log(`  Average annual change: ${rateStr}/year`);

    // Context: typical solar panel degradation
    if (analysis.solarDegradation.annualRate < -0.3 && analysis.solarDegradation.annualRate > -1.0) {
      console.log('  📊 Within normal range (panels typically degrade 0.5-0.8% per year)');
    } else if (analysis.solarDegradation.annualRate <= -1.0) {
      console.log('  ⚠️  Higher than expected degradation (typical is 0.5-0.8% per year)');
    } else if (analysis.solarDegradation.annualRate >= 0) {
      console.log('  ✓ No degradation detected (may need more years of data)');
    }
  } else {
    console.log('  ⚠️  Need at least 2 complete seasons across different years to measure degradation');
    console.log('     (requires 30+ days per season for accurate comparison)');
  }

  // Year-over-year seasonal comparison
  printSeasonalComparison(analysis);

  // Savings comparison
  const savings = calculateSavingsComparison(analysis);
  const years = analysis.overall.days / 365;

  console.log('\n' + '═'.repeat(85));
  console.log('💰 RETROSPECTIVE SAVINGS ANALYSIS');
  console.log('═'.repeat(85));

  console.log('\n  SCENARIO COMPARISON (over ' + fmt(years, 1) + ' years of data)');
  console.log('─'.repeat(85));
  console.log('                                   Grid Cost    Feed-in Rev    Net Cost');
  console.log('─'.repeat(85));
  console.log(
    '  No Solar (grid only)          ' +
    pad('$' + fmt(savings.noSolar.totalImportCost, 0), 12) +
    pad('$0', 15) +
    pad('$' + fmt(savings.noSolar.totalNetCost, 0), 12)
  );
  console.log(
    '  Solar Only (no battery)       ' +
    pad('$' + fmt(savings.solarOnly.totalImportCost, 0), 12) +
    pad('$' + fmt(savings.solarOnly.totalFeedInRevenue, 0), 15) +
    pad('$' + fmt(savings.solarOnly.totalNetCost, 0), 12)
  );
  console.log(
    '  Solar + Battery (actual)      ' +
    pad('$' + fmt(savings.actual.totalImportCost, 0), 12) +
    pad('$' + fmt(savings.actual.totalFeedInRevenue, 0), 15) +
    pad('$' + fmt(savings.actual.totalNetCost, 0), 12)
  );
  console.log(
    '  Solar + Battery (optimal)     ' +
    pad('$' + fmt(savings.optimal.totalImportCost, 0), 12) +
    pad('$' + fmt(savings.optimal.totalFeedInRevenue, 0), 15) +
    pad('$' + fmt(savings.optimal.totalNetCost, 0), 12) + '  ← perfect control'
  );

  console.log('\n  SAVINGS BREAKDOWN');
  console.log('─'.repeat(85));
  console.log(`  Solar savings (vs no solar):           $${fmt(savings.savingsFromSolar, 0)} total | $${fmt(savings.savingsFromSolar / years, 0)}/year`);
  console.log(`  Battery savings (vs solar only):       $${fmt(savings.savingsFromBattery, 0)} total | $${fmt(savings.savingsFromBattery / years, 0)}/year`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  Total savings (vs no solar):           $${fmt(savings.totalSavings, 0)} total | $${fmt(savings.totalSavings / years, 0)}/year`);

  // Battery value attribution
  console.log('\n  BATTERY VALUE ATTRIBUTION');
  console.log('─'.repeat(85));
  const totalBatteryValue = savings.solarArbitrageValue + savings.gridArbitrageValue;
  const solarArbPct = totalBatteryValue > 0 ? (savings.solarArbitrageValue / totalBatteryValue * 100) : 0;
  const gridArbPct = totalBatteryValue > 0 ? (savings.gridArbitrageValue / totalBatteryValue * 100) : 0;
  console.log(`  Solar arbitrage (solar→peak):          $${fmt(savings.solarArbitrageValue, 0)} total | $${fmt(savings.solarArbitrageValue / years, 0)}/year (${fmt(solarArbPct, 0)}%)`);
  console.log(`  Grid arbitrage (offpeak→peak):         $${fmt(savings.gridArbitrageValue, 0)} total | $${fmt(savings.gridArbitrageValue / years, 0)}/year (${fmt(gridArbPct, 0)}%)`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  Total battery value:                   $${fmt(totalBatteryValue, 0)} total | $${fmt(totalBatteryValue / years, 0)}/year`);

  // Gap analysis
  if (savings.optimalGap > 0) {
    console.log('\n  OPTIMIZATION OPPORTUNITY');
    console.log('─'.repeat(85));
    console.log(`  Gap vs optimal control:                $${fmt(savings.optimalGap, 0)} total | $${fmt(savings.optimalGap / years, 0)}/year`);
    console.log(`  Potential improvement:                 ${fmt(savings.optimalGap / savings.savingsFromBattery * 100, 0)}% more battery value possible`);
  }

  // Retrospective ROI for existing installations
  console.log('\n  WAS YOUR INVESTMENT WORTH IT?');
  console.log('─'.repeat(85));

  if (PANEL_SUNK_COST > 0) {
    const solarPaybackSoFar = savings.savingsFromSolar;
    const solarRemaining = PANEL_SUNK_COST - solarPaybackSoFar;
    const solarAnnualSavings = savings.savingsFromSolar / years;
    const solarYearsToPayback = PANEL_SUNK_COST / solarAnnualSavings;

    if (solarRemaining <= 0) {
      console.log(`  ✅ SOLAR PANELS: PAID OFF! You've saved $${fmt(solarPaybackSoFar, 0)} on a $${fmt(PANEL_SUNK_COST, 0)} investment`);
      console.log(`     Profit so far: $${fmt(-solarRemaining, 0)}`);
    } else {
      console.log(`  ⏳ SOLAR PANELS: $${fmt(solarPaybackSoFar, 0)} recovered of $${fmt(PANEL_SUNK_COST, 0)} (${fmt(solarPaybackSoFar / PANEL_SUNK_COST * 100, 0)}%)`);
      console.log(`     Est. payback in ${fmt(solarYearsToPayback, 1)} years total (${fmt(solarRemaining / solarAnnualSavings, 1)} more years)`);
    }
  } else {
    console.log(`  ℹ️  SOLAR: Set PANEL_SUNK_COST in .env to calculate payback`);
    console.log(`     At $${fmt(savings.savingsFromSolar / years, 0)}/year, you'd pay off a $10,000 system in ${fmt(10000 / (savings.savingsFromSolar / years), 1)} years`);
  }

  if (BATTERY_SUNK_COST > 0) {
    const batteryPaybackSoFar = savings.savingsFromBattery;
    const batteryRemaining = BATTERY_SUNK_COST - batteryPaybackSoFar;
    const batteryAnnualSavings = savings.savingsFromBattery / years;
    const batteryYearsToPayback = batteryAnnualSavings > 0 ? BATTERY_SUNK_COST / batteryAnnualSavings : Infinity;

    if (batteryRemaining <= 0) {
      console.log(`  ✅ BATTERY: PAID OFF! You've saved $${fmt(batteryPaybackSoFar, 0)} on a $${fmt(BATTERY_SUNK_COST, 0)} investment`);
      console.log(`     Profit so far: $${fmt(-batteryRemaining, 0)}`);
    } else if (batteryAnnualSavings > 0) {
      console.log(`  ⏳ BATTERY: $${fmt(batteryPaybackSoFar, 0)} recovered of $${fmt(BATTERY_SUNK_COST, 0)} (${fmt(batteryPaybackSoFar / BATTERY_SUNK_COST * 100, 0)}%)`);
      console.log(`     Est. payback in ${fmt(batteryYearsToPayback, 1)} years total (${fmt(batteryRemaining / batteryAnnualSavings, 1)} more years)`);
      if (batteryYearsToPayback > params.estimatedLifespanYears) {
        console.log(`     ⚠️  Warning: Payback exceeds expected ${params.estimatedLifespanYears.toFixed(1)}-year lifespan`);
      }
    } else {
      console.log(`  ❌ BATTERY: No measurable savings yet (battery may be too small or usage pattern doesn't suit)`);
    }
  } else {
    console.log(`  ℹ️  BATTERY: Set BATTERY_SUNK_COST in .env to calculate payback`);
    if (savings.savingsFromBattery > 0) {
      console.log(`     At $${fmt(savings.savingsFromBattery / years, 0)}/year, you'd pay off a $10,000 battery in ${fmt(10000 / (savings.savingsFromBattery / years), 1)} years`);
    } else {
      console.log(`     Currently showing no battery savings - check if battery is being utilized`);
    }
  }

  // Combined system ROI
  if (PANEL_SUNK_COST > 0 && BATTERY_SUNK_COST > 0) {
    const totalInvestment = PANEL_SUNK_COST + BATTERY_SUNK_COST;
    const totalRecovered = savings.totalSavings;
    const totalRemaining = totalInvestment - totalRecovered;
    const annualTotalSavings = savings.totalSavings / years;
    const combinedPaybackYears = totalInvestment / annualTotalSavings;

    console.log(`\n  COMBINED SYSTEM (Solar + Battery)`);
    console.log('─'.repeat(85));
    if (totalRemaining <= 0) {
      console.log(`  ✅ FULLY PAID OFF! Total investment $${fmt(totalInvestment, 0)}, saved $${fmt(totalRecovered, 0)}`);
      console.log(`     Net profit: $${fmt(-totalRemaining, 0)}`);
    } else {
      console.log(`  ⏳ $${fmt(totalRecovered, 0)} recovered of $${fmt(totalInvestment, 0)} total investment (${fmt(totalRecovered / totalInvestment * 100, 0)}%)`);
      console.log(`     Est. combined payback: ${fmt(combinedPaybackYears, 1)} years (${fmt(totalRemaining / annualTotalSavings, 1)} more years)`);
    }
  }

  // Battery scenarios (using calculated parameters)
  const scenarios = modelBatteryScenarios(analysis, params);

  console.log('\n🔋 BATTERY INVESTMENT ANALYSIS');
  console.log('─'.repeat(60));
  console.log(`  Battery cost assumption:     $${BATTERY_COST} per ${BATTERY_SIZE_KWH}kWh`);
  console.log(`  Calculated lifespan:         ${params.estimatedLifespanYears.toFixed(1)} years (${params.lifespanConfidence} confidence)`);
  console.log(`  Calculated efficiency:       ${(params.efficiency * 100).toFixed(1)}%`);
  const highestRate = getHighestRatePeriod();
  // For TOU feed-in, use lowest feed-in rate (solar typically captured during midday)
  const lowestFeedIn = hasTOUFeedIn()
    ? getFeedInPeriodsByRate()[getFeedInPeriodsByRate().length - 1]?.rate ?? TARIFF.feedInTariff
    : TARIFF.feedInTariff;
  console.log(`  Max arbitrage value:         $${((highestRate.rate - lowestFeedIn) * params.efficiency).toFixed(4)}/kWh (${highestRate.name})`);

  console.log('\n📊 SCENARIO COMPARISON (with grid arbitrage)');
  console.log('═'.repeat(100));
  console.log(
    'Additional'.padEnd(14) +
    'Total'.padStart(8) +
    'Solar Arb'.padStart(12) +
    'Grid Arb'.padStart(12) +
    'Total $/yr'.padStart(12) +
    'Payback'.padStart(10) +
    'Lifetime $'.padStart(12) +
    'ROI %'.padStart(10)
  );
  console.log('─'.repeat(100));

  for (const s of scenarios) {
    if (s.additionalBatteries === 0) {
      console.log(`  0 (current)`.padEnd(14) + pad(s.totalBatteryKwh + 'kWh', 8) + '     (baseline - no additional value)');
    } else {
      console.log(
        `  +${s.additionalBatteries} (${s.additionalKwh}kWh)`.padEnd(14) +
        pad(s.totalBatteryKwh + 'kWh', 8) +
        pad('$' + fmt(s.solarArbitrageValue, 0), 12) +
        pad('$' + fmt(s.gridArbitrageValue, 0), 12) +
        pad('$' + fmt(s.annualSavings, 0), 12) +
        pad(s.paybackYears === Infinity ? 'N/A' : fmt(s.paybackYears, 1) + 'yr', 10) +
        pad('$' + fmt(s.lifetimeSavings, 0), 12) +
        pad(fmt(s.roi, 1) + '%', 10)
      );
    }
  }

  // Show value source breakdown for best scenario
  const bestNonZero = scenarios.find(s => s.additionalBatteries > 0 && s.annualSavings > 0);
  if (bestNonZero) {
    const solarPct = bestNonZero.solarArbitrageValue / bestNonZero.annualSavings * 100;
    const gridPct = bestNonZero.gridArbitrageValue / bestNonZero.annualSavings * 100;
    console.log('─'.repeat(100));
    console.log(`  Value sources for +1 battery: Solar arbitrage ${fmt(solarPct, 0)}% | Grid arbitrage ${fmt(gridPct, 0)}%`);
  }

  // Recommendation
  console.log('\n' + '═'.repeat(85));
  console.log('📋 RECOMMENDATION');
  console.log('═'.repeat(85));

  const additionalScenarios = scenarios.slice(1);
  const bestScenario = additionalScenarios.reduce<Scenario | null>((best, s) =>
    !best || s.roi > best.roi ? s : best
  , null);

  if (bestScenario && bestScenario.roi > 0) {
    console.log(`\n  Based on ${analysis.overall.days} days of data across ${analysis.byYear.size} year(s):`);
    console.log(`  ✅ Adding ${bestScenario.additionalBatteries}x ${BATTERY_SIZE_KWH}kWh battery could be worthwhile`);
    console.log(`  💵 Estimated payback period: ${fmt(bestScenario.paybackYears, 1)} years`);
    console.log(`  📈 Estimated ROI over ${params.estimatedLifespanYears.toFixed(1)} years: ${fmt(bestScenario.roi, 1)}%`);

    // Seasonal insight
    const summer = analysis.bySeason.get('summer');
    const winter = analysis.bySeason.get('winter');
    if (summer && winter && summer.days > 0 && winter.days > 0) {
      const summerExport = summer.avgDaily.gridExport;
      const winterExport = winter.avgDaily.gridExport;
      const ratio = summerExport / (winterExport || 1);
      console.log(`\n  📊 Seasonal insight: Summer exports ${fmt(ratio, 1)}x more than winter`);
      console.log(`     Summer avg export: ${fmt(summerExport, 1)} kWh/day | Winter: ${fmt(winterExport, 1)} kWh/day`);
    }
  } else {
    console.log(`\n  ⚠️  Additional battery storage may not be economical`);
    console.log(`  The payback period exceeds the expected battery lifespan.`);
  }

  console.log('\n📋 ANALYSIS METHODOLOGY');
  console.log('─'.repeat(60));
  if (analysis.hasPowerData) {
    console.log('  ✓ TOU calculated from actual timestamped power data');
    console.log('  ✓ Battery scenarios use real daily import/export');
  } else {
    console.log('  ⚠ TOU estimated (no power data available)');
  }
  if (analysis.batteryEfficiency.length > 0) {
    console.log('  ✓ Battery degradation tracked from historical data');
  }
  if (analysis.solarDegradation.hasEnoughData) {
    console.log('  ✓ Solar degradation tracked year-over-year');
  }

  console.log('\n⚠️  LIMITATIONS');
  console.log('─'.repeat(60));
  console.log('  • Does not account for future electricity rate changes');
  console.log('  • Backup power value not included in ROI');

  // Save report
  const report = {
    generatedAt: new Date().toISOString(),
    tariff: TARIFF,
    calculatedParameters: {
      efficiency: params.efficiency,
      usableCapacityPercent: params.usableCapacityPercent,
      maxChargeRateKw: params.maxChargeRateKw,
      solarChargingHours: params.solarChargingHours,
      estimatedLifespanYears: params.estimatedLifespanYears,
      lifespanConfidence: params.lifespanConfidence,
      warnings: params.warnings
    },
    assumptions: { batteryCost: BATTERY_COST, batterySize: BATTERY_SIZE_KWH },
    dateRange: analysis.dateRange,
    overall: analysis.overall,
    byYear: Object.fromEntries(analysis.byYear),
    bySeason: Object.fromEntries(analysis.bySeason),
    scenarios
  };

  const reportFile = `battery-analysis-${new Date().toISOString().split('T')[0]}.json`;
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`\n📁 Detailed analysis saved to ${reportFile}`);
}

main();
