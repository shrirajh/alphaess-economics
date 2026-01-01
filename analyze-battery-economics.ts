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

interface SystemData {
  systemInfo?: SystemInfo;
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
  let morningPeakImport = 0;
  let afternoonPeakImport = 0;
  let morningPeakExport = 0;
  let afternoonPeakExport = 0;
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

    // Use dynamic period name from tariff for imports
    const periodName = periodResult.name;
    importTOU[periodName] = (importTOU[periodName] ?? 0) + importKwh;
    exportTOU[periodName] = (exportTOU[periodName] ?? 0) + exportKwh;

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
    minSoC,
    maxSoC
  };
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
    chargeFromGrid: 0
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
      peakOffsetable
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

function modelBatteryScenarios(analysis: Analysis): Scenario[] {
  const scenarios: Scenario[] = [];
  const currentBatteryKwh = analysis.currentBatteryKwh;

  // Max energy that can be captured in a day based on charge rate and shoulder hours
  const maxDailyCharge = MAX_CHARGE_RATE_KW * SHOULDER_HOURS;

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
    const additionalUsableKwh = additionalKwh * USABLE_CAPACITY_PERCENT;

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
        maxUsefulDischarge / BATTERY_EFFICIENCY
      );

      if (solarCapturable > 0) {
        const solarDischargeable = solarCapturable * BATTERY_EFFICIENCY;

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
      const solarDischarge = solarCapturable > 0 ? solarCapturable * BATTERY_EFFICIENCY : 0;
      const afternoonPeakRemaining = Math.max(0, day.afternoonPeakImport - solarDischarge);
      const peakImportRemaining = hasTOUData
        ? day.morningPeakImport + afternoonPeakRemaining  // Morning peak unaffected by solar
        : Math.max(0, day.gridImport * 0.70 - solarDischarge);

      // Available capacity for grid charging (after solar capture)
      const capacityForGridCharge = Math.max(0, additionalUsableKwh - solarCapturable);

      // Grid charging is most valuable for morning peak (before solar)
      // Can charge overnight (off-peak) to serve morning peak (6-10am)
      const morningPeakTarget = hasTOUData ? day.morningPeakImport : day.gridImport * 0.70 * 0.29;

      // Grid chargeable = min(remaining capacity, peak import remaining, morning peak target)
      const gridChargeable = Math.min(
        capacityForGridCharge,
        peakImportRemaining / BATTERY_EFFICIENCY,
        morningPeakTarget / BATTERY_EFFICIENCY
      );

      if (gridChargeable > 0) {
        const gridDischargeable = gridChargeable * BATTERY_EFFICIENCY;

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
    const lifetimeSavings = annualSavings * BATTERY_LIFESPAN_YEARS;
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
      if (batteryYearsToPayback > BATTERY_LIFESPAN_YEARS) {
        console.log(`     ⚠️  Warning: Payback exceeds expected ${BATTERY_LIFESPAN_YEARS}-year lifespan`);
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

  // Battery scenarios
  const scenarios = modelBatteryScenarios(analysis);

  console.log('\n🔋 BATTERY INVESTMENT ANALYSIS');
  console.log('─'.repeat(60));
  console.log(`  Battery cost assumption:     $${BATTERY_COST} per ${BATTERY_SIZE_KWH}kWh`);
  console.log(`  Assumed lifespan:            ${BATTERY_LIFESPAN_YEARS} years`);
  console.log(`  Round-trip efficiency:       ${(BATTERY_EFFICIENCY * 100).toFixed(0)}%`);
  const highestRate = getHighestRatePeriod();
  // For TOU feed-in, use lowest feed-in rate (solar typically captured during midday)
  const lowestFeedIn = hasTOUFeedIn()
    ? getFeedInPeriodsByRate()[getFeedInPeriodsByRate().length - 1]?.rate ?? TARIFF.feedInTariff
    : TARIFF.feedInTariff;
  console.log(`  Max arbitrage value:         $${((highestRate.rate - lowestFeedIn) * BATTERY_EFFICIENCY).toFixed(4)}/kWh (${highestRate.name})`);

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
    console.log(`  📈 Estimated ROI over ${BATTERY_LIFESPAN_YEARS} years: ${fmt(bestScenario.roi, 1)}%`);

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
    assumptions: { batteryCost: BATTERY_COST, batterySize: BATTERY_SIZE_KWH, lifespanYears: BATTERY_LIFESPAN_YEARS, efficiency: BATTERY_EFFICIENCY },
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
