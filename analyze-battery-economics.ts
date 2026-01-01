import * as fs from 'node:fs';
import 'dotenv/config';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION FROM .env
// ═══════════════════════════════════════════════════════════════════════════

const RATES = {
  // Peak: 6am-10am and 3pm-1am ($/kWh)
  peak: parseFloat(process.env.RATE_PEAK ?? '') || 0.4905,
  // Off-peak: 1am-6am ($/kWh)
  offpeak: parseFloat(process.env.RATE_OFFPEAK ?? '') || 0.3362,
  // Shoulder: 10am-3pm ($/kWh)
  shoulder: parseFloat(process.env.RATE_SHOULDER ?? '') || 0.2875,
  // Feed-in tariff ($/kWh)
  feedIn: parseFloat(process.env.FEED_IN_TARIFF ?? '') || 0.06
};

const BATTERY_COST = parseFloat(process.env.BATTERY_COST_PER_10KWH ?? '') || 10000;
const BATTERY_SIZE_KWH = 10;
const BATTERY_LIFESPAN_YEARS = parseFloat(process.env.BATTERY_LIFESPAN_YEARS ?? '') || 10;
const BATTERY_EFFICIENCY = 0.90;
const USABLE_CAPACITY_PERCENT = 0.90;
const MAX_CHARGE_RATE_KW = 5; // Max battery charge rate in kW
const SHOULDER_HOURS = 5; // 10am-3pm = 5 hours of charging window

// Your actual installation costs (for retrospective ROI calculation)
const BATTERY_SUNK_COST = parseFloat(process.env.BATTERY_SUNK_COST ?? '') || 0;
const PANEL_SUNK_COST = parseFloat(process.env.PANEL_SUNK_COST ?? '') || 0;

// Southern Hemisphere seasons (Australia)
const SEASONS = {
  summer: [12, 1, 2],   // Dec, Jan, Feb
  autumn: [3, 4, 5],    // Mar, Apr, May
  winter: [6, 7, 8],    // Jun, Jul, Aug
  spring: [9, 10, 11]   // Sep, Oct, Nov
} as const;

type SeasonName = keyof typeof SEASONS;

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
}

type RatePeriod = 'peak' | 'shoulder' | 'offpeak';

interface TOUBreakdown {
  peak: number;
  shoulder: number;
  offpeak: number;
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
  // Savings
  savingsFromBattery: number;      // actual vs solar-only
  savingsFromSolar: number;        // solar-only vs no-solar
  totalSavings: number;            // actual vs no-solar
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function getSeason(month: number): SeasonName {
  if (SEASONS.summer.includes(month as 1)) return 'summer';
  if (SEASONS.autumn.includes(month as 3)) return 'autumn';
  if (SEASONS.winter.includes(month as 6)) return 'winter';
  return 'spring';
}

function getRatePeriod(hour: number): RatePeriod {
  // Off-peak: 1am-6am (hours 1-5)
  if (hour >= 1 && hour < 6) return 'offpeak';
  // Shoulder: 10am-3pm (hours 10-14)
  if (hour >= 10 && hour < 15) return 'shoulder';
  // Peak: 6am-10am (hours 6-9) and 3pm-1am (hours 15-23, 0)
  return 'peak';
}

function emptyTOUBreakdown(): TOUBreakdown {
  return { peak: 0, shoulder: 0, offpeak: 0 };
}

interface TOUResult {
  import: TOUBreakdown;
  export: TOUBreakdown;
  // Split peak into morning (6-10am) vs afternoon/evening (3pm-1am)
  morningPeakImport: number;
  afternoonPeakImport: number;
  morningPeakExport: number;
  afternoonPeakExport: number;
}

// Check if hour is in morning peak (6-10am)
function isMorningPeak(hour: number): boolean {
  return hour >= 6 && hour < 10;
}

// Calculate TOU breakdown from power readings
// Power readings are in W, typically every 5 minutes
// We sum them and convert to approximate kWh
function calculateTOUFromPower(powerReadings: PowerReading[] | null | undefined): TOUResult {
  const importTOU = emptyTOUBreakdown();
  const exportTOU = emptyTOUBreakdown();
  let morningPeakImport = 0;
  let afternoonPeakImport = 0;
  let morningPeakExport = 0;
  let afternoonPeakExport = 0;

  if (!powerReadings || powerReadings.length === 0) {
    return {
      import: importTOU,
      export: exportTOU,
      morningPeakImport,
      afternoonPeakImport,
      morningPeakExport,
      afternoonPeakExport
    };
  }

  // Sort by time to calculate intervals
  const sorted = [...powerReadings].sort((a, b) =>
    a.uploadTime.localeCompare(b.uploadTime)
  );

  for (let i = 0; i < sorted.length; i++) {
    const reading = sorted[i];
    if (!reading) continue;

    // Parse time - format is typically "2024-01-15 14:30:00" or ISO
    const timePart = reading.uploadTime.includes('T')
      ? reading.uploadTime.split('T')[1]
      : reading.uploadTime.split(' ')[1];
    const hour = parseInt(timePart?.split(':')[0] ?? '0', 10);
    const period = getRatePeriod(hour);

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

    importTOU[period] += importKwh;
    exportTOU[period] += exportKwh;

    // Track morning vs afternoon peak separately
    if (period === 'peak') {
      if (isMorningPeak(hour)) {
        morningPeakImport += importKwh;
        morningPeakExport += exportKwh;
      } else {
        afternoonPeakImport += importKwh;
        afternoonPeakExport += exportKwh;
      }
    }
  }

  return {
    import: importTOU,
    export: exportTOU,
    morningPeakImport,
    afternoonPeakImport,
    morningPeakExport,
    afternoonPeakExport
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
    exportByTOU: emptyTOUBreakdown()
  };
}

function addTOU(target: TOUBreakdown, source: TOUBreakdown): void {
  target.peak += source.peak;
  target.shoulder += source.shoulder;
  target.offpeak += source.offpeak;
}

function touTotal(tou: TOUBreakdown): number {
  return tou.peak + tou.shoulder + tou.offpeak;
}

function touPercentages(tou: TOUBreakdown): { peak: number; shoulder: number; offpeak: number } {
  const total = touTotal(tou);
  if (total === 0) return { peak: 0, shoulder: 0, offpeak: 0 };
  return {
    peak: (tou.peak / total) * 100,
    shoulder: (tou.shoulder / total) * 100,
    offpeak: (tou.offpeak / total) * 100
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
    // Calculate from actual TOU breakdown
    const totalTOUCost =
      totals.importByTOU.peak * RATES.peak +
      totals.importByTOU.shoulder * RATES.shoulder +
      totals.importByTOU.offpeak * RATES.offpeak;
    dailyImportCost = totalTOUCost / days;
  } else {
    // Fall back to estimated distribution
    const importDistribution = { peak: 0.70, shoulder: 0.05, offpeak: 0.25 };
    dailyImportCost =
      avgDaily.gridImport * importDistribution.peak * RATES.peak +
      avgDaily.gridImport * importDistribution.shoulder * RATES.shoulder +
      avgDaily.gridImport * importDistribution.offpeak * RATES.offpeak;
  }

  const dailyFeedInRevenue = avgDaily.gridExport * RATES.feedIn;

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
  const systemFiles = fs.readdirSync('.').filter(f => f.startsWith('alphaess-data-') && f.endsWith('.json'));

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

    // Calculate TOU from power readings for this day
    const tou = calculateTOUFromPower(day.power as PowerReading[] | null);

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
      peakImport: tou.import.peak,
      shoulderImport: tou.import.shoulder,
      offpeakImport: tou.import.offpeak,
      peakExport: tou.export.peak,
      shoulderExport: tou.export.shoulder,
      offpeakExport: tou.export.offpeak,
      // Morning vs afternoon peak split
      morningPeakImport: tou.morningPeakImport,
      afternoonPeakImport: tou.afternoonPeakImport,
      morningPeakExport: tou.morningPeakExport,
      afternoonPeakExport: tou.afternoonPeakExport
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

  // Calculate using ACTUAL daily data with ACTUAL TOU breakdown
  for (let additionalBatteries = 0; additionalBatteries <= 3; additionalBatteries++) {
    const additionalKwh = additionalBatteries * BATTERY_SIZE_KWH;
    const totalBatteryKwh = currentBatteryKwh + additionalKwh;
    const additionalUsableKwh = additionalKwh * USABLE_CAPACITY_PERCENT;

    let totalValue = 0;
    let totalCaptured = 0;

    for (const day of analysis.daily) {
      // Calculate max useful discharge first - don't capture more than you can use
      // Only afternoon peak and shoulder imports can be offset by same-day solar
      const hasTOUData = day.peakImport > 0 || day.shoulderImport > 0 || day.offpeakImport > 0;
      let maxUsefulDischarge: number;

      if (hasTOUData) {
        maxUsefulDischarge = day.afternoonPeakImport + day.shoulderImport;
      } else {
        // Fall back: estimate useful discharge from total import
        const afternoonPeakRatio = 0.71;
        const overallPeakRatio = analysis.hasPowerData
          ? analysis.overall.importByTOU.peak / (analysis.overall.gridImport || 1)
          : 0.70;
        const shoulderRatio = analysis.hasPowerData
          ? analysis.overall.importByTOU.shoulder / (analysis.overall.gridImport || 1)
          : 0.05;
        maxUsefulDischarge = day.gridImport * (overallPeakRatio * afternoonPeakRatio + shoulderRatio);
      }

      // Max capture = max useful discharge / efficiency (need to charge more than you discharge)
      const maxUsefulCapture = maxUsefulDischarge / BATTERY_EFFICIENCY;

      // How much can we capture? Limited by:
      // 1. Battery capacity (usable)
      // 2. Available export (solar excess)
      // 3. Charge rate × available charging hours (shoulder period)
      // 4. What we can actually usefully discharge (don't capture more than we can use)
      const capturable = Math.min(
        additionalUsableKwh,
        Math.max(0, day.gridExport),
        maxDailyCharge,
        maxUsefulCapture
      );
      if (capturable <= 0) continue;

      // How much can we discharge? capturable × efficiency
      const dischargeable = capturable * BATTERY_EFFICIENCY;

      // Use ACTUAL TOU data: discharge during AFTERNOON peak only (not morning peak)
      // Morning peak (6-10am) happens BEFORE solar production, so we can't use same-day
      // solar to serve morning peak. Only afternoon/evening peak (3pm-1am) is serviceable.
      let afternoonPeakDischarge: number;
      let shoulderDischarge: number;

      if (hasTOUData) {
        // Use actual measured TOU data - only afternoon peak is usable
        afternoonPeakDischarge = Math.min(dischargeable, day.afternoonPeakImport);
        shoulderDischarge = Math.min(dischargeable - afternoonPeakDischarge, day.shoulderImport);
      } else {
        // Fall back: estimate afternoon peak as portion of total peak
        // Afternoon peak (3pm-1am = 10 hours) vs morning peak (6-10am = 4 hours)
        // So ~71% of peak hours are in the afternoon/evening
        const afternoonPeakRatio = 0.71;
        const overallPeakRatio = analysis.hasPowerData
          ? analysis.overall.importByTOU.peak / (analysis.overall.gridImport || 1)
          : 0.70;
        const shoulderRatio = analysis.hasPowerData
          ? analysis.overall.importByTOU.shoulder / (analysis.overall.gridImport || 1)
          : 0.05;
        const estimatedAfternoonPeak = day.gridImport * overallPeakRatio * afternoonPeakRatio;
        const estimatedShoulder = day.gridImport * shoulderRatio;
        afternoonPeakDischarge = Math.min(dischargeable, estimatedAfternoonPeak);
        shoulderDischarge = Math.min(dischargeable - afternoonPeakDischarge, estimatedShoulder);
      }

      // Calculate value: stored solar would have been exported at feed-in rate
      // Instead, we discharge during afternoon peak/shoulder avoiding those import costs
      const dayValue = afternoonPeakDischarge * RATES.peak + shoulderDischarge * RATES.shoulder
                       - capturable * RATES.feedIn;

      totalValue += dayValue;
      totalCaptured += capturable;
    }

    const numDays = analysis.daily.length;
    const avgDailyValue = numDays > 0 ? totalValue / numDays : 0;
    const avgDailyCapture = numDays > 0 ? totalCaptured / numDays : 0;

    const annualSavings = avgDailyValue * 365;
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
      roi
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
  const fallbackAvgRate =
    fallbackImportDist.peak * RATES.peak +
    fallbackImportDist.shoulder * RATES.shoulder +
    fallbackImportDist.offpeak * RATES.offpeak;

  // ACTUAL: What you paid with solar + battery
  // Use actual TOU data when available
  let actualImportCost: number;
  if (analysis.hasPowerData && touTotal(analysis.overall.importByTOU) > 0) {
    actualImportCost =
      analysis.overall.importByTOU.peak * RATES.peak +
      analysis.overall.importByTOU.shoulder * RATES.shoulder +
      analysis.overall.importByTOU.offpeak * RATES.offpeak;
  } else {
    actualImportCost = analysis.overall.gridImport * fallbackAvgRate;
  }
  const actualFeedInRevenue = analysis.overall.gridExport * RATES.feedIn;
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
  const solarOnlyExport = analysis.overall.gridExport + analysis.overall.batteryCharge;

  // Battery discharge was avoiding peak imports, so without battery those become peak imports
  // The additional imports from battery discharge should be costed at peak rate
  let solarOnlyImportCost: number;
  if (analysis.hasPowerData && touTotal(analysis.overall.importByTOU) > 0) {
    // Actual imports at their actual TOU rates, plus battery discharge at peak rate
    // (Battery discharge was primarily avoiding peak imports)
    solarOnlyImportCost = actualImportCost + (analysis.overall.batteryDischarge * RATES.peak);
  } else {
    // Fallback: Use higher peak ratio for solar-only (0.85 instead of 0.70)
    // because battery discharge (mostly peak) becomes grid imports
    const solarOnlyPeakRatio = 0.85;
    const solarOnlyAvgRate =
      solarOnlyPeakRatio * RATES.peak +
      0.05 * RATES.shoulder +
      0.10 * RATES.offpeak;
    solarOnlyImportCost = solarOnlyImport * solarOnlyAvgRate;
  }
  const solarOnlyFeedInRevenue = solarOnlyExport * RATES.feedIn;
  const solarOnlyNetCost = solarOnlyImportCost - solarOnlyFeedInRevenue;

  // NO SOLAR: What you would have paid with no solar at all
  // You'd import your entire load from the grid
  // Load = PV + Import + BatteryDischarge - Export - BatteryCharge
  // But simpler: noSolarImport = load (everything comes from grid)
  const noSolarImport = analysis.overall.load;
  const noSolarImportCost = noSolarImport * fallbackAvgRate;
  const noSolarNetCost = noSolarImportCost; // No feed-in revenue

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
    savingsFromBattery: solarOnlyNetCost - actualNetCost,
    savingsFromSolar: noSolarNetCost - solarOnlyNetCost,
    totalSavings: noSolarNetCost - actualNetCost
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
  console.log('\n📊 ELECTRICITY RATES');
  console.log('─'.repeat(60));
  console.log(`  Peak (6am-10am, 3pm-1am):    $${RATES.peak.toFixed(4)}/kWh`);
  console.log(`  Shoulder (10am-3pm):         $${RATES.shoulder.toFixed(4)}/kWh`);
  console.log(`  Off-peak (1am-6am):          $${RATES.offpeak.toFixed(4)}/kWh`);
  console.log(`  Feed-in tariff:              $${RATES.feedIn.toFixed(4)}/kWh`);

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
      pad(fmt(calcImportPct.peak, 1) + '%', 12) +
      pad(fmt(calcImportPct.shoulder, 1) + '%', 14) +
      pad(fmt(calcImportPct.offpeak, 1) + '%', 14) +
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
      pad(fmt(calcExportPct.peak, 1) + '%', 12) +
      pad(fmt(calcExportPct.shoulder, 1) + '%', 14) +
      pad(fmt(calcExportPct.offpeak, 1) + '%', 14) +
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
    const calcImportCost =
      analysis.overall.importByTOU.peak * RATES.peak +
      analysis.overall.importByTOU.shoulder * RATES.shoulder +
      analysis.overall.importByTOU.offpeak * RATES.offpeak;
    const estImportCost =
      analysis.overall.gridImport * (estimatedImportDist.peak / 100) * RATES.peak +
      analysis.overall.gridImport * (estimatedImportDist.shoulder / 100) * RATES.shoulder +
      analysis.overall.gridImport * (estimatedImportDist.offpeak / 100) * RATES.offpeak;

    console.log('\n  COST COMPARISON:');
    console.log(`    Import cost (calculated): $${fmt(calcImportCost, 2)}`);
    console.log(`    Import cost (estimated):  $${fmt(estImportCost, 2)}`);
    console.log(`    Difference:               $${fmt(calcImportCost - estImportCost, 2)} (${fmt((calcImportCost - estImportCost) / estImportCost * 100, 1)}%)`);
  } else {
    console.log('\n  ⚠️  No power data available - using estimated TOU distribution');
    console.log('  Import: Peak ' + estimatedImportDist.peak + '% | Shoulder ' + estimatedImportDist.shoulder + '% | Off-peak ' + estimatedImportDist.offpeak + '%');
    console.log('  Export: Peak ' + estimatedExportDist.peak + '% | Shoulder ' + estimatedExportDist.shoulder + '% | Off-peak ' + estimatedExportDist.offpeak + '%');
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

  console.log('\n  SAVINGS BREAKDOWN');
  console.log('─'.repeat(85));
  console.log(`  Solar savings (vs no solar):           $${fmt(savings.savingsFromSolar, 0)} total | $${fmt(savings.savingsFromSolar / years, 0)}/year`);
  console.log(`  Battery savings (vs solar only):       $${fmt(savings.savingsFromBattery, 0)} total | $${fmt(savings.savingsFromBattery / years, 0)}/year`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  Total savings (vs no solar):           $${fmt(savings.totalSavings, 0)} total | $${fmt(savings.totalSavings / years, 0)}/year`);

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
  console.log(`  Max arbitrage value:         $${((RATES.peak - RATES.feedIn) * BATTERY_EFFICIENCY).toFixed(4)}/kWh`);

  console.log('\n📊 SCENARIO COMPARISON');
  console.log('═'.repeat(85));
  console.log(
    'Additional'.padEnd(12) +
    'Total'.padStart(8) +
    'Usable+'.padStart(10) +
    'Daily $'.padStart(10) +
    'Annual $'.padStart(12) +
    'Payback'.padStart(10) +
    'Lifetime $'.padStart(12) +
    'ROI %'.padStart(10)
  );
  console.log('─'.repeat(85));

  for (const s of scenarios) {
    if (s.additionalBatteries === 0) {
      console.log(`  0 (current)`.padEnd(12) + pad(s.totalBatteryKwh + 'kWh', 8) + '     (baseline)');
    } else {
      console.log(
        `  +${s.additionalBatteries} (${s.additionalKwh}kWh)`.padEnd(12) +
        pad(s.totalBatteryKwh + 'kWh', 8) +
        pad(fmt(s.additionalUsableCapacity, 1), 10) +
        pad('$' + fmt(s.dailySavings, 2), 10) +
        pad('$' + fmt(s.annualSavings, 0), 12) +
        pad(s.paybackYears === Infinity ? 'N/A' : fmt(s.paybackYears, 1) + 'yr', 10) +
        pad('$' + fmt(s.lifetimeSavings, 0), 12) +
        pad(fmt(s.roi, 1) + '%', 10)
      );
    }
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
    rates: RATES,
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
