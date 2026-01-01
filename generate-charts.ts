import * as fs from 'node:fs';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import 'dotenv/config';
import {
  loadTariff,
  createTariffHelpers,
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
  calculateComparisons,
  formatComparison,
} from './tariff-utils.js';

// ═══════════════════════════════════════════════════════════════════════════
// TARIFF CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

// Load tariff and create helpers
const TARIFF = loadTariff();
const tariffHelpers = createTariffHelpers(TARIFF);

// Create backward-compatible RATES object from tariff
const RATES = {
  peak: tariffHelpers.getRateForPeriod('peak'),
  offpeak: tariffHelpers.getRateForPeriod('offpeak'),
  shoulder: tariffHelpers.getRateForPeriod('shoulder'),
  feedIn: TARIFF.feedInTariff
};

// ═══════════════════════════════════════════════════════════════════════════
// TEXT POOLS FOR RANDOM VARIETY
// ═══════════════════════════════════════════════════════════════════════════

const TEXT_POOLS = {
  hookOpeners: [
    "This year, your roof worked hard.",
    "Your solar panels didn't take a single day off.",
    "While you were sleeping, your roof was earning.",
    "Every sunny day, your panels were busy.",
    "Rain or shine, your system kept going.",
  ],
  hookEmphasis: [
    "Really hard.",
    "Incredibly hard.",
    "Like, seriously hard.",
    "Non-stop.",
    "Dawn to dusk.",
  ],
  generationIntros: [
    "You captured",
    "You harvested",
    "You generated",
    "Your panels produced",
    "Your roof delivered",
  ],
  selfConsumptionPraise: [
    "And you didn't waste it.",
    "And you kept it for yourself.",
    "Smart. Very smart.",
    "That's efficiency.",
  ],
  savingsTeases: [
    "So what did all this actually save you?",
    "Now for the number you've been waiting for...",
    "Time to talk money.",
    "Let's count the savings.",
  ],
  celebratory: [
    "Not bad for a roof.",
    "Your roof is basically a power plant.",
    "The sun paid you back.",
    "That's solar working for you.",
  ],
};

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function shuffle<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS (copied from analyze-battery-economics.ts)
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
  peakImport: number;
  shoulderImport: number;
  offpeakImport: number;
  peakExport: number;
  shoulderExport: number;
  offpeakExport: number;
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
  period: string;
  charge: number;
  discharge: number;
  efficiency: number;
  cycleCount: number;
}

interface PeriodTotals {
  days: number;
  pvGeneration: number;
  load: number;
  gridImport: number;
  gridExport: number;
  batteryCharge: number;
  batteryDischarge: number;
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
  avgPV1: number;
  avgPV2: number;
  change: number;
}

interface SolarDegradation {
  periods: SolarDegradationPeriod[];
  annualRate: number;
  hasEnoughData: boolean;
}

interface Analysis {
  currentBatteryKwh: number;
  dateRange: { start: string; end: string };
  overall: PeriodAnalysis;
  byYear: Map<number, PeriodAnalysis>;
  bySeason: Map<SeasonName, PeriodAnalysis>;
  byYearSeason: Map<string, PeriodAnalysis>;
  daily: DailyEntry[];
  batteryEfficiency: BatteryEfficiencyPeriod[];
  solarDegradation: SolarDegradation;
  hasPowerData: boolean;
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
  actual: { totalImportCost: number; totalFeedInRevenue: number; totalNetCost: number };
  solarOnly: { totalImportCost: number; totalFeedInRevenue: number; totalNetCost: number };
  noSolar: { totalImportCost: number; totalNetCost: number };
  savingsFromBattery: number;
  savingsFromSolar: number;
  totalSavings: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function getRatePeriod(hour: number): RatePeriod {
  if (hour >= 1 && hour < 6) return 'offpeak';
  if (hour >= 10 && hour < 15) return 'shoulder';
  return 'peak';
}

function emptyTOUBreakdown(): TOUBreakdown {
  return { peak: 0, shoulder: 0, offpeak: 0 };
}

interface TOUResult {
  import: TOUBreakdown;
  export: TOUBreakdown;
  morningPeakImport: number;
  afternoonPeakImport: number;
  morningPeakExport: number;
  afternoonPeakExport: number;
}

function isMorningPeak(hour: number): boolean {
  return hour >= 6 && hour < 10;
}

function calculateTOUFromPower(powerReadings: PowerReading[] | null | undefined): TOUResult {
  const importTOU = emptyTOUBreakdown();
  const exportTOU = emptyTOUBreakdown();
  let morningPeakImport = 0, afternoonPeakImport = 0, morningPeakExport = 0, afternoonPeakExport = 0;

  if (!powerReadings || powerReadings.length === 0) {
    return { import: importTOU, export: exportTOU, morningPeakImport, afternoonPeakImport, morningPeakExport, afternoonPeakExport };
  }

  const sorted = [...powerReadings].sort((a, b) => a.uploadTime.localeCompare(b.uploadTime));

  for (let i = 0; i < sorted.length; i++) {
    const reading = sorted[i];
    if (!reading) continue;

    const timePart = reading.uploadTime.includes('T') ? reading.uploadTime.split('T')[1] : reading.uploadTime.split(' ')[1];
    const hour = parseInt(timePart?.split(':')[0] ?? '0', 10);
    const period = getRatePeriod(hour);

    let intervalHours = 5 / 60;
    if (i < sorted.length - 1) {
      const next = sorted[i + 1];
      if (next) {
        const diffMs = new Date(next.uploadTime).getTime() - new Date(reading.uploadTime).getTime();
        if (diffMs > 0 && diffMs < 3600000) intervalHours = diffMs / 3600000;
      }
    }

    const importKwh = (reading.gridCharge / 1000) * intervalHours;
    const exportKwh = (reading.feedIn / 1000) * intervalHours;

    importTOU[period] += importKwh;
    exportTOU[period] += exportKwh;

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

  return { import: importTOU, export: exportTOU, morningPeakImport, afternoonPeakImport, morningPeakExport, afternoonPeakExport };
}

function emptyTotals(): PeriodTotals {
  return { days: 0, pvGeneration: 0, load: 0, gridImport: 0, gridExport: 0, batteryCharge: 0, batteryDischarge: 0, importByTOU: emptyTOUBreakdown(), exportByTOU: emptyTOUBreakdown() };
}

function addTOU(target: TOUBreakdown, source: TOUBreakdown): void {
  target.peak += source.peak;
  target.shoulder += source.shoulder;
  target.offpeak += source.offpeak;
}

function touTotal(tou: TOUBreakdown): number {
  return tou.peak + tou.shoulder + tou.offpeak;
}

function calculateBatteryEfficiency(daily: DailyEntry[]): BatteryEfficiencyPeriod[] {
  const quarters = new Map<string, { charge: number; discharge: number; days: number }>();

  for (const day of daily) {
    const quarter = `${day.year}-Q${Math.ceil(day.month / 3)}`;
    if (!quarters.has(quarter)) quarters.set(quarter, { charge: 0, discharge: 0, days: 0 });
    const q = quarters.get(quarter)!;
    q.charge += day.batteryCharge;
    q.discharge += day.batteryDischarge;
    q.days++;
  }

  const results: BatteryEfficiencyPeriod[] = [];
  for (const [period, data] of quarters) {
    const cycleCount = data.discharge / 10;
    if (data.charge > 0 && cycleCount >= 10) {
      results.push({ period, charge: data.charge, discharge: data.discharge, efficiency: data.discharge / data.charge, cycleCount });
    }
  }

  return results.sort((a, b) => a.period.localeCompare(b.period));
}

function calculateSolarDegradation(byYearSeason: Map<string, PeriodAnalysis>): SolarDegradation {
  const periods: SolarDegradationPeriod[] = [];
  const seasons: SeasonName[] = ['summer', 'autumn', 'winter', 'spring'];

  for (const season of seasons) {
    const yearData: { year: number; avgPV: number; days: number }[] = [];
    for (const [key, analysis] of byYearSeason) {
      if (key.endsWith(`-${season}`)) {
        const year = parseInt(key.split('-')[0] ?? '0', 10);
        if (analysis.days >= 30) yearData.push({ year, avgPV: analysis.avgDaily.pvGeneration, days: analysis.days });
      }
    }

    yearData.sort((a, b) => a.year - b.year);
    for (let i = 0; i < yearData.length - 1; i++) {
      const d1 = yearData[i], d2 = yearData[i + 1];
      if (!d1 || !d2) continue;
      const change = ((d2.avgPV - d1.avgPV) / d1.avgPV) * 100;
      periods.push({ season, year1: d1.year, year2: d2.year, avgPV1: d1.avgPV, avgPV2: d2.avgPV, change });
    }
  }

  let annualRate = 0;
  if (periods.length > 0) annualRate = periods.reduce((sum, p) => sum + p.change, 0) / periods.length;

  return { periods, annualRate, hasEnoughData: periods.length >= 2 };
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

  const hasTOUData = touTotal(totals.importByTOU) > 0;
  let dailyImportCost: number;

  if (hasTOUData) {
    const totalTOUCost = totals.importByTOU.peak * RATES.peak + totals.importByTOU.shoulder * RATES.shoulder + totals.importByTOU.offpeak * RATES.offpeak;
    dailyImportCost = totalTOUCost / days;
  } else {
    const importDistribution = { peak: 0.70, shoulder: 0.05, offpeak: 0.25 };
    dailyImportCost = avgDaily.gridImport * importDistribution.peak * RATES.peak + avgDaily.gridImport * importDistribution.shoulder * RATES.shoulder + avgDaily.gridImport * importDistribution.offpeak * RATES.offpeak;
  }

  const dailyFeedInRevenue = avgDaily.gridExport * RATES.feedIn;
  return { ...totals, avgDaily, costs: { dailyImportCost, dailyFeedInRevenue, dailyNetCost: dailyImportCost - dailyFeedInRevenue } };
}

// ═══════════════════════════════════════════════════════════════════════════
// LOAD STATS
// ═══════════════════════════════════════════════════════════════════════════

interface LoadedSystem {
  file: string;
  systemId: string;
  data: SystemData;
}

function loadAllSystems(): LoadedSystem[] {
  const systems: LoadedSystem[] = [];
  const systemFiles = fs.readdirSync('.').filter(f => f.startsWith('alphaess-data-') && f.endsWith('.json'));

  for (const file of systemFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as SystemData;
      const systemId = file.replace('alphaess-data-', '').replace('.json', '');
      systems.push({ file, systemId, data });
      console.log(`📂 Found ${file} (${data.historicalData.length} days)`);
    } catch {
      console.warn(`⚠️  Could not parse ${file}`);
    }
  }

  if (systems.length === 0) {
    // Try legacy format
    const legacyFiles = fs.readdirSync('.').filter(f => f.startsWith('alphaess-stats-') && f.endsWith('.json'));
    if (legacyFiles.length === 0) {
      console.error('❌ No stats file found. Run dump-stats.ts first.');
      process.exit(1);
    }
    legacyFiles.sort().reverse();
    const latestFile = legacyFiles[0]!;
    console.log(`📂 Loading ${latestFile} (legacy format)\n`);
    const stats = JSON.parse(fs.readFileSync(latestFile, 'utf8')) as Stats;
    if (stats.systems[0]) {
      systems.push({ file: latestFile, systemId: 'legacy', data: stats.systems[0] });
    }
  }

  return systems;
}

function loadSystemStats(system: LoadedSystem): Stats {
  return { systems: [system.data] };
}

// ═══════════════════════════════════════════════════════════════════════════
// ANALYZE HISTORICAL DATA
// ═══════════════════════════════════════════════════════════════════════════

function analyzeHistoricalData(stats: Stats): Analysis {
  const system = stats.systems[0];
  if (!system) { console.error('❌ No system data found'); process.exit(1); }

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
    const tou = calculateTOUFromPower(day.power as PowerReading[] | null);

    const entry: DailyEntry = {
      date: day.date, year, month, season,
      pvGeneration: e.epv ?? 0, gridImport: e.eInput ?? 0, gridExport: e.eOutput ?? 0,
      batteryCharge: e.eCharge ?? 0, batteryDischarge: e.eDischarge ?? 0, load,
      peakImport: tou.import.peak, shoulderImport: tou.import.shoulder, offpeakImport: tou.import.offpeak,
      peakExport: tou.export.peak, shoulderExport: tou.export.shoulder, offpeakExport: tou.export.offpeak,
      morningPeakImport: tou.morningPeakImport, afternoonPeakImport: tou.afternoonPeakImport,
      morningPeakExport: tou.morningPeakExport, afternoonPeakExport: tou.afternoonPeakExport
    };
    daily.push(entry);

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

  daily.sort((a, b) => a.date.localeCompare(b.date));

  const dateRange = { start: daily[0]?.date ?? 'N/A', end: daily[daily.length - 1]?.date ?? 'N/A' };

  const byYear = new Map<number, PeriodAnalysis>();
  for (const [year, totals] of yearTotals) byYear.set(year, calculatePeriodAnalysis(totals));

  const bySeason = new Map<SeasonName, PeriodAnalysis>();
  for (const [season, totals] of seasonTotals) bySeason.set(season, calculatePeriodAnalysis(totals));

  const byYearSeason = new Map<string, PeriodAnalysis>();
  for (const [key, totals] of yearSeasonTotals) byYearSeason.set(key, calculatePeriodAnalysis(totals));

  const hasPowerData = touTotal(overallTotals.importByTOU) > 0 || touTotal(overallTotals.exportByTOU) > 0;
  const batteryEfficiency = calculateBatteryEfficiency(daily);
  const solarDegradation = calculateSolarDegradation(byYearSeason);

  return { currentBatteryKwh: system.systemInfo?.cobat ?? 0, dateRange, overall: calculatePeriodAnalysis(overallTotals), byYear, bySeason, byYearSeason, daily, batteryEfficiency, solarDegradation, hasPowerData };
}

// ═══════════════════════════════════════════════════════════════════════════
// MODEL BATTERY SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════

function modelBatteryScenarios(analysis: Analysis): Scenario[] {
  const scenarios: Scenario[] = [];
  const currentBatteryKwh = analysis.currentBatteryKwh;
  const maxDailyCharge = MAX_CHARGE_RATE_KW * SHOULDER_HOURS;

  for (let additionalBatteries = 0; additionalBatteries <= 3; additionalBatteries++) {
    const additionalKwh = additionalBatteries * BATTERY_SIZE_KWH;
    const totalBatteryKwh = currentBatteryKwh + additionalKwh;
    const additionalUsableKwh = additionalKwh * USABLE_CAPACITY_PERCENT;

    let totalValue = 0, totalCaptured = 0;

    for (const day of analysis.daily) {
      const hasTOUData = day.peakImport > 0 || day.shoulderImport > 0 || day.offpeakImport > 0;
      let maxUsefulDischarge: number;

      if (hasTOUData) {
        maxUsefulDischarge = day.afternoonPeakImport + day.shoulderImport;
      } else {
        const afternoonPeakRatio = 0.71;
        const overallPeakRatio = analysis.hasPowerData ? analysis.overall.importByTOU.peak / (analysis.overall.gridImport || 1) : 0.70;
        const shoulderRatio = analysis.hasPowerData ? analysis.overall.importByTOU.shoulder / (analysis.overall.gridImport || 1) : 0.05;
        maxUsefulDischarge = day.gridImport * (overallPeakRatio * afternoonPeakRatio + shoulderRatio);
      }

      const maxUsefulCapture = maxUsefulDischarge / BATTERY_EFFICIENCY;
      const capturable = Math.min(additionalUsableKwh, Math.max(0, day.gridExport), maxDailyCharge, maxUsefulCapture);
      if (capturable <= 0) continue;

      const dischargeable = capturable * BATTERY_EFFICIENCY;
      let afternoonPeakDischarge: number, shoulderDischarge: number;

      if (hasTOUData) {
        afternoonPeakDischarge = Math.min(dischargeable, day.afternoonPeakImport);
        shoulderDischarge = Math.min(dischargeable - afternoonPeakDischarge, day.shoulderImport);
      } else {
        const afternoonPeakRatio = 0.71;
        const overallPeakRatio = analysis.hasPowerData ? analysis.overall.importByTOU.peak / (analysis.overall.gridImport || 1) : 0.70;
        const shoulderRatio = analysis.hasPowerData ? analysis.overall.importByTOU.shoulder / (analysis.overall.gridImport || 1) : 0.05;
        const estimatedAfternoonPeak = day.gridImport * overallPeakRatio * afternoonPeakRatio;
        const estimatedShoulder = day.gridImport * shoulderRatio;
        afternoonPeakDischarge = Math.min(dischargeable, estimatedAfternoonPeak);
        shoulderDischarge = Math.min(dischargeable - afternoonPeakDischarge, estimatedShoulder);
      }

      const dayValue = afternoonPeakDischarge * RATES.peak + shoulderDischarge * RATES.shoulder - capturable * RATES.feedIn;
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

    scenarios.push({ additionalBatteries, additionalKwh, totalBatteryKwh, additionalUsableCapacity: avgDailyCapture, dailySavings: avgDailyValue, annualSavings, investment, paybackYears, lifetimeSavings, roi });
  }

  return scenarios;
}

// ═══════════════════════════════════════════════════════════════════════════
// CALCULATE SAVINGS COMPARISON
// ═══════════════════════════════════════════════════════════════════════════

function calculateSavingsComparison(analysis: Analysis): SavingsComparison {
  const fallbackImportDist = { peak: 0.70, shoulder: 0.05, offpeak: 0.25 };
  const fallbackAvgRate = fallbackImportDist.peak * RATES.peak + fallbackImportDist.shoulder * RATES.shoulder + fallbackImportDist.offpeak * RATES.offpeak;

  let actualImportCost: number;
  if (analysis.hasPowerData && touTotal(analysis.overall.importByTOU) > 0) {
    actualImportCost = analysis.overall.importByTOU.peak * RATES.peak + analysis.overall.importByTOU.shoulder * RATES.shoulder + analysis.overall.importByTOU.offpeak * RATES.offpeak;
  } else {
    actualImportCost = analysis.overall.gridImport * fallbackAvgRate;
  }
  const actualFeedInRevenue = analysis.overall.gridExport * RATES.feedIn;
  const actualNetCost = actualImportCost - actualFeedInRevenue;

  const solarOnlyImport = analysis.overall.gridImport + analysis.overall.batteryDischarge;
  const solarOnlyExport = analysis.overall.gridExport + analysis.overall.batteryCharge;

  let solarOnlyImportCost: number;
  if (analysis.hasPowerData && touTotal(analysis.overall.importByTOU) > 0) {
    solarOnlyImportCost = actualImportCost + (analysis.overall.batteryDischarge * RATES.peak);
  } else {
    const solarOnlyPeakRatio = 0.85;
    const solarOnlyAvgRate = solarOnlyPeakRatio * RATES.peak + 0.05 * RATES.shoulder + 0.10 * RATES.offpeak;
    solarOnlyImportCost = solarOnlyImport * solarOnlyAvgRate;
  }
  const solarOnlyFeedInRevenue = solarOnlyExport * RATES.feedIn;
  const solarOnlyNetCost = solarOnlyImportCost - solarOnlyFeedInRevenue;

  const noSolarImport = analysis.overall.load;
  const noSolarImportCost = noSolarImport * fallbackAvgRate;
  const noSolarNetCost = noSolarImportCost;

  return {
    actual: { totalImportCost: actualImportCost, totalFeedInRevenue: actualFeedInRevenue, totalNetCost: actualNetCost },
    solarOnly: { totalImportCost: solarOnlyImportCost, totalFeedInRevenue: solarOnlyFeedInRevenue, totalNetCost: solarOnlyNetCost },
    noSolar: { totalImportCost: noSolarImportCost, totalNetCost: noSolarNetCost },
    savingsFromBattery: solarOnlyNetCost - actualNetCost,
    savingsFromSolar: noSolarNetCost - solarOnlyNetCost,
    totalSavings: noSolarNetCost - actualNetCost
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CALCULATE AVERAGE DAILY POWER PROFILE
// ═══════════════════════════════════════════════════════════════════════════

interface HourlyAverage {
  hour: number;
  solar: number;
  load: number;
  batteryFlow: number; // positive = charging, negative = discharging
  gridFlow: number; // positive = importing, negative = exporting
}

function calculateAverageDailyProfile(stats: Stats): HourlyAverage[] {
  const system = stats.systems[0];
  if (!system) return [];

  const hourlyData = new Map<number, { solar: number[]; load: number[]; battery: number[]; grid: number[] }>();
  for (let h = 0; h < 24; h++) {
    hourlyData.set(h, { solar: [], load: [], battery: [], grid: [] });
  }

  for (const day of system.historicalData) {
    if (!day.power || day.power.length === 0) continue;

    for (const reading of day.power) {
      const timePart = reading.uploadTime.includes('T') ? reading.uploadTime.split('T')[1] : reading.uploadTime.split(' ')[1];
      const hour = parseInt(timePart?.split(':')[0] ?? '0', 10);
      const data = hourlyData.get(hour);
      if (data) {
        data.solar.push(reading.ppv / 1000); // W to kW
        data.load.push(reading.load / 1000);
        data.grid.push((reading.gridCharge - reading.feedIn) / 1000); // positive = import, negative = export
        // cbat is battery level %, we'd need to calculate flow from differences - skip for now
        data.battery.push(0);
      }
    }
  }

  const result: HourlyAverage[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const data = hourlyData.get(hour)!;
    result.push({
      hour,
      solar: data.solar.length > 0 ? data.solar.reduce((a, b) => a + b, 0) / data.solar.length : 0,
      load: data.load.length > 0 ? data.load.reduce((a, b) => a + b, 0) / data.load.length : 0,
      batteryFlow: data.battery.length > 0 ? data.battery.reduce((a, b) => a + b, 0) / data.battery.length : 0,
      gridFlow: data.grid.length > 0 ? data.grid.reduce((a, b) => a + b, 0) / data.grid.length : 0
    });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORT DATA
// ═══════════════════════════════════════════════════════════════════════════

// Year-over-year comparison
interface YoYComparison {
  metric: string;
  thisYear: number;
  lastYear: number | null;
  delta: number;           // percentage change (positive = increase)
  deltaAbsolute: number;   // absolute change
  direction: 'up' | 'down' | 'same';
}

// Wacky comparisons
interface WackyComparisons {
  // Tech & Entertainment
  iphones: number;
  netflixHours: number;
  spotifyStreams: number;
  gamingHours: number;
  // Household
  coffees: number;
  laundryLoads: number;
  acHours: number;
  hotShowers: number;
  toastSlices: number;
  pizzas: number;
  // Legacy
  tvYears: number;
  gamingPcYears: number;
  homesYears: number;
  evKm: number;
  // Environmental
  co2Avoided: number;
  treesEquivalent: number;
  carsOffRoad: number;
  flightsSydLon: number;
  flightsSydBali: number;
}

interface ReportData {
  generatedAt: string;
  dateRange: { start: string; end: string };
  daysAnalyzed: number;
  batteryKwh: number;

  // Hero stats
  totalGenerated: number;
  totalConsumed: number;
  totalExported: number;
  selfConsumptionRate: number;

  // Savings
  savings: SavingsComparison;
  years: number;

  // TOU breakdown
  importByTOU: TOUBreakdown;
  exportByTOU: TOUBreakdown;
  hasPowerData: boolean;

  // Seasonal
  byYear: { year: number; data: PeriodAnalysis }[];
  bySeason: { season: string; data: PeriodAnalysis }[];
  byYearSeason: { year: number; season: string; data: PeriodAnalysis }[];

  // Battery efficiency
  batteryEfficiency: BatteryEfficiencyPeriod[];

  // Solar degradation
  solarDegradation: SolarDegradation;

  // Scenarios
  scenarios: Scenario[];

  // Daily profile
  dailyProfile: HourlyAverage[];

  // Year-over-year comparisons
  yoy: {
    generation: YoYComparison;
    selfConsumption: YoYComparison;
    savings: YoYComparison;
    dailyCost: YoYComparison;
  } | null;

  // Wacky comparisons
  comparisons: WackyComparisons;

  // Sparkline data (last 30 days)
  sparklineData: number[];

  // Config
  rates: typeof RATES;
  batteryCost: number;
  batteryLifespan: number;
  sunkCosts: { battery: number; panels: number };
}

function buildReportData(stats: Stats, analysis: Analysis): ReportData {
  const savings = calculateSavingsComparison(analysis);
  const scenarios = modelBatteryScenarios(analysis);
  const dailyProfile = calculateAverageDailyProfile(stats);
  const years = analysis.overall.days / 365;
  const selfConsumptionRate = (1 - analysis.overall.gridExport / (analysis.overall.pvGeneration || 1)) * 100;

  // Calculate year-over-year comparisons
  const byYear = Array.from(analysis.byYear.entries()).sort(([a], [b]) => a - b).map(([year, data]) => ({ year, data }));
  let yoy: ReportData['yoy'] = null;

  if (byYear.length >= 2) {
    const thisYearData = byYear[byYear.length - 1]!;
    const lastYearData = byYear[byYear.length - 2]!;

    const makeYoY = (metric: string, thisVal: number, lastVal: number): YoYComparison => {
      const delta = lastVal !== 0 ? ((thisVal - lastVal) / lastVal) * 100 : 0;
      const deltaAbsolute = thisVal - lastVal;
      return {
        metric,
        thisYear: thisVal,
        lastYear: lastVal,
        delta,
        deltaAbsolute,
        direction: delta > 0.5 ? 'up' : delta < -0.5 ? 'down' : 'same'
      };
    };

    // Calculate YoY for each metric (annualized for fair comparison)
    const thisYearGen = thisYearData.data.avgDaily.pvGeneration * 365;
    const lastYearGen = lastYearData.data.avgDaily.pvGeneration * 365;

    const thisYearSelfCons = (1 - thisYearData.data.gridExport / (thisYearData.data.pvGeneration || 1)) * 100;
    const lastYearSelfCons = (1 - lastYearData.data.gridExport / (lastYearData.data.pvGeneration || 1)) * 100;

    const thisYearSavings = thisYearData.data.days > 0
      ? (savings.totalSavings / analysis.overall.days) * thisYearData.data.days * (365 / thisYearData.data.days)
      : 0;
    const lastYearSavings = lastYearData.data.days > 0
      ? (savings.totalSavings / analysis.overall.days) * lastYearData.data.days * (365 / lastYearData.data.days)
      : 0;

    const thisYearDailyCost = thisYearData.data.costs.dailyNetCost;
    const lastYearDailyCost = lastYearData.data.costs.dailyNetCost;

    yoy = {
      generation: makeYoY('Generation', thisYearGen, lastYearGen),
      selfConsumption: makeYoY('Self-consumption', thisYearSelfCons, lastYearSelfCons),
      savings: makeYoY('Savings', thisYearSavings, lastYearSavings),
      dailyCost: makeYoY('Daily Cost', thisYearDailyCost, lastYearDailyCost)
    };
  }

  // Calculate wacky comparisons
  const comparisons = calculateComparisons(analysis.overall.pvGeneration);

  // Extract sparkline data (last 30 days of generation)
  const sortedDaily = [...analysis.daily].sort((a, b) => a.date.localeCompare(b.date));
  const sparklineData = sortedDaily.slice(-30).map(d => d.pvGeneration);

  return {
    generatedAt: new Date().toISOString(),
    dateRange: analysis.dateRange,
    daysAnalyzed: analysis.overall.days,
    batteryKwh: analysis.currentBatteryKwh,

    totalGenerated: analysis.overall.pvGeneration,
    totalConsumed: analysis.overall.load,
    totalExported: analysis.overall.gridExport,
    selfConsumptionRate,

    savings,
    years,

    importByTOU: analysis.overall.importByTOU,
    exportByTOU: analysis.overall.exportByTOU,
    hasPowerData: analysis.hasPowerData,

    byYear,
    bySeason: ['summer', 'autumn', 'winter', 'spring'].map(s => ({ season: s, data: analysis.bySeason.get(s as SeasonName)! })).filter(x => x.data),
    byYearSeason: Array.from(analysis.byYearSeason.entries()).map(([key, data]) => {
      const [yearStr, season] = key.split('-');
      return { year: parseInt(yearStr!, 10), season: season!, data };
    }).sort((a, b) => a.year - b.year || a.season.localeCompare(b.season)),

    batteryEfficiency: analysis.batteryEfficiency,
    solarDegradation: analysis.solarDegradation,
    scenarios,
    dailyProfile,

    // New visual enhancement data
    yoy,
    comparisons,
    sparklineData,

    rates: RATES,
    batteryCost: BATTERY_COST,
    batteryLifespan: BATTERY_LIFESPAN_YEARS,
    sunkCosts: { battery: BATTERY_SUNK_COST, panels: PANEL_SUNK_COST }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// VEGA-LITE CHART SPECS
// ═══════════════════════════════════════════════════════════════════════════

function createSavingsComparisonChart(data: ReportData): object {
  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: 'container',
    height: 250,
    background: 'transparent',
    data: {
      values: [
        { scenario: 'No Solar', cost: data.savings.noSolar.totalNetCost, order: 0 },
        { scenario: 'Solar Only', cost: data.savings.solarOnly.totalNetCost, order: 1 },
        { scenario: 'Solar + Battery', cost: data.savings.actual.totalNetCost, order: 2 }
      ]
    },
    mark: { type: 'bar', cornerRadiusEnd: 8 },
    encoding: {
      x: { field: 'scenario', type: 'nominal', axis: { labelColor: '#B3B3B3', titleColor: '#B3B3B3', labelAngle: 0 }, sort: { field: 'order' }, title: null },
      y: { field: 'cost', type: 'quantitative', axis: { labelColor: '#B3B3B3', titleColor: '#B3B3B3', format: '$,.0f', gridColor: '#333' }, title: 'Total Cost' },
      color: { field: 'scenario', type: 'nominal', scale: { domain: ['No Solar', 'Solar Only', 'Solar + Battery'], range: ['#FF6B35', '#FFE205', '#1DB954'] }, legend: null },
      tooltip: [
        { field: 'scenario', type: 'nominal', title: 'Scenario' },
        { field: 'cost', type: 'quantitative', title: 'Total Cost', format: '$,.0f' }
      ]
    }
  };
}

function createTOUDonutChart(data: ReportData, type: 'import' | 'export'): object {
  const tou = type === 'import' ? data.importByTOU : data.exportByTOU;
  const total = tou.peak + tou.shoulder + tou.offpeak;

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: 180,
    height: 180,
    background: 'transparent',
    data: {
      values: [
        { period: 'Peak', value: tou.peak, rate: data.rates.peak, pct: (tou.peak / total * 100) },
        { period: 'Shoulder', value: tou.shoulder, rate: data.rates.shoulder, pct: (tou.shoulder / total * 100) },
        { period: 'Off-peak', value: tou.offpeak, rate: data.rates.offpeak, pct: (tou.offpeak / total * 100) }
      ]
    },
    mark: { type: 'arc', innerRadius: 50, cornerRadius: 4 },
    encoding: {
      theta: { field: 'value', type: 'quantitative', stack: true },
      color: { field: 'period', type: 'nominal', scale: { domain: ['Peak', 'Shoulder', 'Off-peak'], range: ['#FF6B35', '#FFE205', '#1DB954'] }, legend: { labelColor: '#B3B3B3', titleColor: '#B3B3B3' } },
      tooltip: [
        { field: 'period', type: 'nominal', title: 'Period' },
        { field: 'value', type: 'quantitative', title: 'kWh', format: '.1f' },
        { field: 'pct', type: 'quantitative', title: '%', format: '.1f' },
        { field: 'rate', type: 'quantitative', title: '$/kWh', format: '$.4f' }
      ]
    }
  };
}

function createSeasonalChart(data: ReportData): object {
  const seasonOrder: Record<string, number> = { summer: 0, autumn: 1, winter: 2, spring: 3 };

  // Use byYearSeason for year-specific seasonal data
  const values = data.byYearSeason.map(({ year, season, data: seasonData }) => ({
    year,
    season: season.charAt(0).toUpperCase() + season.slice(1),
    generation: seasonData.avgDaily.pvGeneration,
    order: seasonOrder[season] ?? 0
  }));

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: 'container',
    height: 200,
    background: 'transparent',
    data: { values },
    mark: { type: 'bar', cornerRadiusEnd: 4 },
    encoding: {
      x: { field: 'season', type: 'nominal', axis: { labelColor: '#B3B3B3', labelAngle: 0 }, sort: { field: 'order' }, title: null },
      y: { field: 'generation', type: 'quantitative', axis: { labelColor: '#B3B3B3', titleColor: '#B3B3B3', gridColor: '#333' }, title: 'Avg Daily Generation (kWh)' },
      xOffset: { field: 'year', type: 'nominal' },
      color: { field: 'year', type: 'nominal', scale: { scheme: 'viridis' }, legend: { labelColor: '#B3B3B3', titleColor: '#B3B3B3' } },
      tooltip: [
        { field: 'year', type: 'nominal', title: 'Year' },
        { field: 'season', type: 'nominal', title: 'Season' },
        { field: 'generation', type: 'quantitative', title: 'Avg kWh/day', format: '.1f' }
      ]
    }
  };
}

function createBatteryEfficiencyChart(data: ReportData): object {
  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: 'container',
    height: 200,
    background: 'transparent',
    data: {
      values: data.batteryEfficiency.map(p => ({
        period: p.period,
        efficiency: p.efficiency * 100,
        cycles: p.cycleCount
      }))
    },
    layer: [
      {
        mark: { type: 'line', color: '#4ECDC4', strokeWidth: 3, point: { color: '#4ECDC4', size: 80 } },
        encoding: {
          x: { field: 'period', type: 'ordinal', axis: { labelColor: '#B3B3B3', labelAngle: -45 }, title: null },
          y: { field: 'efficiency', type: 'quantitative', axis: { labelColor: '#B3B3B3', titleColor: '#B3B3B3', gridColor: '#333' }, title: 'Efficiency %', scale: { domain: [80, 100] } },
          tooltip: [
            { field: 'period', type: 'nominal', title: 'Period' },
            { field: 'efficiency', type: 'quantitative', title: 'Efficiency %', format: '.1f' },
            { field: 'cycles', type: 'quantitative', title: 'Cycles', format: '.0f' }
          ]
        }
      }
    ]
  };
}

function createScenarioChart(data: ReportData): object {
  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: 'container',
    height: 250,
    background: 'transparent',
    data: {
      values: data.scenarios.filter(s => s.additionalBatteries > 0).map(s => ({
        batteries: `+${s.additionalBatteries} (${s.additionalKwh}kWh)`,
        annualSavings: s.annualSavings,
        payback: s.paybackYears === Infinity ? null : s.paybackYears,
        roi: s.roi,
        investment: s.investment
      }))
    },
    layer: [
      {
        mark: { type: 'bar', cornerRadiusEnd: 8, color: '#1DB954' },
        encoding: {
          x: { field: 'batteries', type: 'nominal', axis: { labelColor: '#B3B3B3', labelAngle: 0 }, title: null },
          y: { field: 'annualSavings', type: 'quantitative', axis: { labelColor: '#B3B3B3', titleColor: '#B3B3B3', format: '$,.0f', gridColor: '#333' }, title: 'Annual Savings' },
          tooltip: [
            { field: 'batteries', type: 'nominal', title: 'Additional Batteries' },
            { field: 'annualSavings', type: 'quantitative', title: 'Annual Savings', format: '$,.0f' },
            { field: 'payback', type: 'quantitative', title: 'Payback Years', format: '.1f' },
            { field: 'roi', type: 'quantitative', title: 'ROI %', format: '.1f' },
            { field: 'investment', type: 'quantitative', title: 'Investment', format: '$,.0f' }
          ]
        }
      }
    ]
  };
}

function createDailyProfileChart(data: ReportData): object {
  const values: { hour: number; type: string; value: number }[] = [];

  for (const h of data.dailyProfile) {
    values.push({ hour: h.hour, type: 'Solar', value: h.solar });
    values.push({ hour: h.hour, type: 'Load', value: h.load });
    values.push({ hour: h.hour, type: 'Grid', value: Math.abs(h.gridFlow) * (h.gridFlow >= 0 ? 1 : -1) });
  }

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: 'container',
    height: 220,
    background: 'transparent',
    data: { values },
    layer: [
      {
        mark: { type: 'area', opacity: 0.7, interpolate: 'monotone' },
        encoding: {
          x: { field: 'hour', type: 'quantitative', axis: { labelColor: '#B3B3B3', titleColor: '#B3B3B3', values: [0, 6, 10, 15, 24] }, title: 'Hour of Day', scale: { domain: [0, 23] } },
          y: { field: 'value', type: 'quantitative', axis: { labelColor: '#B3B3B3', titleColor: '#B3B3B3', gridColor: '#333' }, title: 'Power (kW)' },
          color: { field: 'type', type: 'nominal', scale: { domain: ['Solar', 'Load', 'Grid'], range: ['#1DB954', '#FF6B35', '#22A7F0'] }, legend: { labelColor: '#B3B3B3', titleColor: '#B3B3B3' } },
          tooltip: [
            { field: 'hour', type: 'quantitative', title: 'Hour' },
            { field: 'type', type: 'nominal', title: 'Type' },
            { field: 'value', type: 'quantitative', title: 'kW', format: '.2f' }
          ]
        }
      },
      // Peak hours shading
      {
        data: { values: [{ x: 6, x2: 10 }, { x: 15, x2: 24 }] },
        mark: { type: 'rect', opacity: 0.1, color: '#FF6B35' },
        encoding: {
          x: { field: 'x', type: 'quantitative' },
          x2: { field: 'x2' }
        }
      }
    ]
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SVG GRAPHICS GENERATORS
// ═══════════════════════════════════════════════════════════════════════════

// Animated sun with rotating rays
function createSunSVG(size = 120): string {
  const r = size / 2;
  const innerR = r * 0.35;
  const rayCount = 12;
  const rays = [];

  for (let i = 0; i < rayCount; i++) {
    const angle = (i / rayCount) * Math.PI * 2;
    const x1 = r + Math.cos(angle) * (innerR + 8);
    const y1 = r + Math.sin(angle) * (innerR + 8);
    const x2 = r + Math.cos(angle) * (r - 5);
    const y2 = r + Math.sin(angle) * (r - 5);
    rays.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="url(#sunGradient)" stroke-width="3" stroke-linecap="round"/>`);
  }

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="sun-icon">
    <defs>
      <linearGradient id="sunGradient" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#FFD93D"/>
        <stop offset="100%" stop-color="#FF9F1C"/>
      </linearGradient>
      <radialGradient id="sunCenter" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#FFEE93"/>
        <stop offset="100%" stop-color="#FFD93D"/>
      </radialGradient>
    </defs>
    <g class="sun-rays">${rays.join('')}</g>
    <circle cx="${r}" cy="${r}" r="${innerR}" fill="url(#sunCenter)"/>
  </svg>`;
}

// Battery icon with fill level animation
function createBatterySVG(level: number, size = 80): string {
  const w = size;
  const h = size * 1.6;
  const fillHeight = (level / 100) * (h - 20);
  const color = level > 60 ? '#1DB954' : level > 30 ? '#FFE205' : '#E74C3C';

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="battery-icon">
    <defs>
      <linearGradient id="batteryFill" x1="0%" y1="100%" x2="0%" y2="0%">
        <stop offset="0%" stop-color="${color}"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.6"/>
      </linearGradient>
    </defs>
    <!-- Battery cap -->
    <rect x="${w * 0.3}" y="0" width="${w * 0.4}" height="8" rx="3" fill="rgba(255,255,255,0.3)"/>
    <!-- Battery body -->
    <rect x="4" y="10" width="${w - 8}" height="${h - 14}" rx="8" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="3"/>
    <!-- Fill level -->
    <rect x="8" y="${h - 8 - fillHeight}" width="${w - 16}" height="${fillHeight}" rx="5" fill="url(#batteryFill)" class="battery-fill"/>
    <!-- Shine effect -->
    <rect x="12" y="18" width="8" height="${h - 34}" rx="4" fill="rgba(255,255,255,0.15)"/>
  </svg>`;
}

// Energy flow diagram (sun -> home / sun -> grid)
function createEnergyFlowSVG(selfConsumption: number, size = 200): string {
  const exported = 100 - selfConsumption;
  const homeThickness = Math.max(2, (selfConsumption / 100) * 8);
  const gridThickness = Math.max(2, (exported / 100) * 8);

  return `<svg width="${size}" height="${size * 0.6}" viewBox="0 0 200 120" class="energy-flow">
    <defs>
      <linearGradient id="flowHome" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#FFD93D"/>
        <stop offset="100%" stop-color="#1DB954"/>
      </linearGradient>
      <linearGradient id="flowGrid" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#FFD93D"/>
        <stop offset="100%" stop-color="#22A7F0"/>
      </linearGradient>
    </defs>
    <!-- Sun -->
    <circle cx="30" cy="60" r="20" fill="#FFD93D"/>
    <!-- Home icon -->
    <path d="M160 50 L175 35 L190 50 L190 75 L160 75 Z" fill="none" stroke="#1DB954" stroke-width="2"/>
    <rect x="170" y="60" width="10" height="15" fill="#1DB954"/>
    <!-- Grid icon -->
    <path d="M160 95 L175 85 L190 95 L190 115 L160 115 Z" fill="none" stroke="#22A7F0" stroke-width="2"/>
    <!-- Flow to home -->
    <path d="M55 55 Q100 40 155 50" fill="none" stroke="url(#flowHome)" stroke-width="${homeThickness}" stroke-linecap="round" class="flow-line flow-home"/>
    <!-- Flow to grid -->
    <path d="M55 65 Q100 80 155 95" fill="none" stroke="url(#flowGrid)" stroke-width="${gridThickness}" stroke-linecap="round" class="flow-line flow-grid"/>
    <!-- Labels -->
    <text x="100" y="32" text-anchor="middle" fill="#1DB954" font-size="11" font-weight="600">${selfConsumption.toFixed(0)}% home</text>
    <text x="100" y="108" text-anchor="middle" fill="#22A7F0" font-size="11" font-weight="600">${exported.toFixed(0)}% grid</text>
  </svg>`;
}

// Donut chart for self-consumption
function createDonutSVG(percentage: number, size = 120, color = '#1DB954'): string {
  const r = size / 2;
  const strokeWidth = size * 0.15;
  const innerR = r - strokeWidth / 2 - 5;
  const circumference = 2 * Math.PI * innerR;
  const dashoffset = circumference * (1 - percentage / 100);

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="donut-chart">
    <!-- Background circle -->
    <circle cx="${r}" cy="${r}" r="${innerR}" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="${strokeWidth}"/>
    <!-- Progress circle -->
    <circle cx="${r}" cy="${r}" r="${innerR}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"
      stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${dashoffset}"
      transform="rotate(-90 ${r} ${r})" class="donut-progress"/>
    <!-- Center text -->
    <text x="${r}" y="${r}" text-anchor="middle" dominant-baseline="central" fill="#fff" font-size="${size * 0.25}" font-weight="700">${percentage.toFixed(0)}%</text>
  </svg>`;
}

// Mini sparkline chart (inline SVG, no Vega needed)
function createSparklineSVG(data: number[], width = 200, height = 50, color = '#1DB954'): string {
  if (data.length === 0) return '';

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const padding = 2;
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;

  const points = data.map((v, i) => {
    const x = padding + (i / (data.length - 1)) * usableWidth;
    const y = padding + usableHeight - ((v - min) / range) * usableHeight;
    return `${x},${y}`;
  });

  const areaPoints = [
    `${padding},${height - padding}`,
    ...points,
    `${width - padding},${height - padding}`
  ].join(' ');

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="sparkline">
    <defs>
      <linearGradient id="sparkFill" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.4"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <polygon points="${areaPoints}" fill="url(#sparkFill)"/>
    <polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

// Mini season bars
function createSeasonBarsSVG(seasons: { name: string; value: number }[], width = 180, height = 60): string {
  if (seasons.length === 0) return '';

  const max = Math.max(...seasons.map(s => s.value));
  const barWidth = (width - 20) / seasons.length - 8;
  const colors: Record<string, string> = { summer: '#FFE205', autumn: '#FF6B35', winter: '#22A7F0', spring: '#1DB954' };

  const bars = seasons.map((s, i) => {
    const barHeight = (s.value / max) * (height - 20);
    const x = 10 + i * (barWidth + 8);
    const y = height - 10 - barHeight;
    const color = colors[s.name.toLowerCase()] ?? '#888';
    return `
      <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="3" fill="${color}" opacity="0.8"/>
      <text x="${x + barWidth / 2}" y="${height - 2}" text-anchor="middle" fill="rgba(255,255,255,0.6)" font-size="8">${s.name.slice(0, 3).toUpperCase()}</text>
    `;
  }).join('');

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="season-bars">${bars}</svg>`;
}

// YoY delta indicator
function createYoYDeltaSVG(delta: number, direction: 'up' | 'down' | 'same'): string {
  if (direction === 'same') return '';

  const color = direction === 'up' ? '#1DB954' : '#E74C3C';
  const arrow = direction === 'up' ? '↑' : '↓';
  const sign = delta > 0 ? '+' : '';

  return `<span class="yoy-delta ${direction}" style="color: ${color}; font-weight: 600;">${arrow} ${sign}${delta.toFixed(1)}%</span>`;
}

// Pulsing roof outline with solar panels
function createRoofSVG(size = 200): string {
  const w = size;
  const h = size * 0.6;
  return `<svg width="${w}" height="${h}" viewBox="0 0 200 120" class="roof-outline">
    <defs>
      <linearGradient id="roofGlow" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#1DB954" stop-opacity="0.8"/>
        <stop offset="100%" stop-color="#22A7F0" stop-opacity="0.6"/>
      </linearGradient>
    </defs>
    <!-- House base -->
    <rect x="40" y="60" width="120" height="50" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="2"/>
    <!-- Roof -->
    <path d="M30 60 L100 15 L170 60" fill="none" stroke="url(#roofGlow)" stroke-width="3" stroke-linecap="round"/>
    <!-- Solar panels on roof -->
    <g class="solar-panels">
      <rect x="55" y="30" width="25" height="18" rx="2" fill="#22A7F0" opacity="0.7"/>
      <rect x="85" y="30" width="25" height="18" rx="2" fill="#22A7F0" opacity="0.7"/>
      <rect x="115" y="30" width="25" height="18" rx="2" fill="#22A7F0" opacity="0.7"/>
      <!-- Panel grid lines -->
      <line x1="67.5" y1="30" x2="67.5" y2="48" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>
      <line x1="97.5" y1="30" x2="97.5" y2="48" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>
      <line x1="127.5" y1="30" x2="127.5" y2="48" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>
    </g>
    <!-- Door -->
    <rect x="85" y="80" width="30" height="30" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/>
    <!-- Windows -->
    <rect x="50" y="75" width="20" height="20" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/>
    <rect x="130" y="75" width="20" height="20" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/>
  </svg>`;
}

// Floating particles container (money, energy, leaves)
function createParticleContainerHTML(type: 'money' | 'energy' | 'leaves', count = 8): string {
  const particles: Record<string, string[]> = {
    money: ['💵', '💰', '💸', '$'],
    energy: ['⚡', '✨', '☀️', '💡'],
    leaves: ['🌿', '🍃', '🌱', '🌳'],
  };
  const icons = particles[type] ?? particles.energy!;

  const items = Array.from({ length: count }, (_, i) => {
    const icon = icons[i % icons.length];
    const left = 10 + Math.random() * 80; // 10-90% from left
    const delay = Math.random() * 2; // 0-2s delay
    const duration = 2.5 + Math.random() * 1.5; // 2.5-4s duration
    const size = 0.8 + Math.random() * 0.6; // 0.8-1.4 scale
    return `<span class="particle" style="left: ${left}%; --delay: ${delay.toFixed(1)}s; --duration: ${duration.toFixed(1)}s; font-size: ${size}em;">${icon}</span>`;
  });

  return `<div class="particle-container">${items.join('')}</div>`;
}

// House icons grid (for context slide - homes powered)
function createHouseGridSVG(totalHomes: number, width = 200, height = 80): string {
  const displayHomes = Math.min(Math.ceil(totalHomes), 12); // Cap at 12 icons
  const cols = Math.min(displayHomes, 6);
  const rows = Math.ceil(displayHomes / cols);
  const cellW = width / cols;
  const cellH = height / rows;
  const iconSize = Math.min(cellW, cellH) * 0.6;

  const houses = Array.from({ length: displayHomes }, (_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx = col * cellW + cellW / 2;
    const cy = row * cellH + cellH / 2;
    const halfSize = iconSize / 2;
    // Simple house shape
    return `<g class="house-icon" style="animation-delay: ${i * 0.1}s;">
      <path d="M${cx - halfSize} ${cy + halfSize * 0.3} L${cx} ${cy - halfSize * 0.5} L${cx + halfSize} ${cy + halfSize * 0.3} L${cx + halfSize} ${cy + halfSize} L${cx - halfSize} ${cy + halfSize} Z"
        fill="#1DB954" opacity="0.8"/>
    </g>`;
  });

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="house-grid">${houses.join('')}</svg>`;
}

// Savings stacked bar (solar vs battery contribution)
function createSavingsBarSVG(solarAmount: number, batteryAmount: number, width = 280, height = 40): string {
  const total = solarAmount + batteryAmount;
  const solarPct = (solarAmount / total) * 100;
  const batteryPct = (batteryAmount / total) * 100;
  const barHeight = 24;
  const barY = (height - barHeight) / 2;
  const solarWidth = (solarPct / 100) * (width - 20);
  const batteryWidth = (batteryPct / 100) * (width - 20);

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="savings-bar">
    <defs>
      <linearGradient id="solarGrad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#1DB954"/>
        <stop offset="100%" stop-color="#1DB954"/>
      </linearGradient>
      <linearGradient id="batteryGrad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#22A7F0"/>
        <stop offset="100%" stop-color="#22A7F0"/>
      </linearGradient>
    </defs>
    <!-- Background track -->
    <rect x="10" y="${barY}" width="${width - 20}" height="${barHeight}" rx="${barHeight / 2}" fill="rgba(255,255,255,0.1)"/>
    <!-- Solar portion -->
    <rect x="10" y="${barY}" width="${solarWidth}" height="${barHeight}" rx="${barHeight / 2}" fill="url(#solarGrad)" class="bar-fill" style="--target-width: ${solarWidth}px;"/>
    <!-- Battery portion -->
    <rect x="${10 + solarWidth}" y="${barY}" width="${batteryWidth}" height="${barHeight}" rx="0 ${barHeight / 2} ${barHeight / 2} 0" fill="url(#batteryGrad)" class="bar-fill" style="--target-width: ${batteryWidth}px; animation-delay: 0.3s;"/>
    <!-- Labels -->
    <text x="${10 + solarWidth / 2}" y="${barY + barHeight / 2 + 4}" text-anchor="middle" fill="#fff" font-size="10" font-weight="600">${solarPct.toFixed(0)}%</text>
    <text x="${10 + solarWidth + batteryWidth / 2}" y="${barY + barHeight / 2 + 4}" text-anchor="middle" fill="#fff" font-size="10" font-weight="600">${batteryPct.toFixed(0)}%</text>
  </svg>
  <div style="display: flex; justify-content: center; gap: 1.5rem; margin-top: 0.5rem; font-size: 0.85rem;">
    <span style="color: #1DB954;">● Solar</span>
    <span style="color: #22A7F0;">● Battery</span>
  </div>`;
}

// Cost comparison bars (you vs grid-only)
function createCostComparisonSVG(yourCost: number, gridCost: number, width = 300, height = 100): string {
  const maxCost = Math.max(yourCost, gridCost);
  const yourWidth = (yourCost / maxCost) * (width - 100);
  const gridWidth = (gridCost / maxCost) * (width - 100);
  const barHeight = 28;
  const savings = gridCost - yourCost;

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="cost-comparison">
    <!-- Your cost bar -->
    <text x="0" y="22" fill="#E0E0E0" font-size="12">You</text>
    <rect x="45" y="8" width="${yourWidth}" height="${barHeight}" rx="4" fill="#1DB954" class="bar-fill" style="--target-width: ${yourWidth}px;"/>
    <text x="${50 + yourWidth + 5}" y="28" fill="#1DB954" font-size="14" font-weight="700">$${yourCost.toFixed(0)}</text>

    <!-- Grid cost bar -->
    <text x="0" y="62" fill="#E0E0E0" font-size="12">Grid</text>
    <rect x="45" y="48" width="${gridWidth}" height="${barHeight}" rx="4" fill="#E74C3C" class="bar-fill" style="--target-width: ${gridWidth}px; animation-delay: 0.2s;"/>
    <text x="${50 + gridWidth + 5}" y="68" fill="#E74C3C" font-size="14" font-weight="700">$${gridCost.toFixed(0)}</text>

    <!-- Savings arrow -->
    <line x1="${45 + yourWidth + 5}" y1="36" x2="${45 + yourWidth + 5}" y2="48" stroke="#FFE205" stroke-width="2" stroke-dasharray="3,2"/>
    <text x="${width / 2}" y="95" text-anchor="middle" fill="#FFE205" font-size="13" font-weight="600">↓ $${savings.toFixed(0)} saved/day</text>
  </svg>`;
}

// Clock face showing peak hours avoided
function createPeakClockSVG(peakHoursAvoided: number, size = 120): string {
  const cx = size / 2;
  const cy = size / 2;
  const r = (size - 20) / 2;

  // Peak hours: 6-10am and 3pm-midnight (15-24, 0-1)
  const peakSegments = [
    { start: 6, end: 10 },   // Morning peak
    { start: 15, end: 24 },  // Evening peak
  ];

  const segments = peakSegments.map(seg => {
    const startAngle = ((seg.start / 24) * 360 - 90) * (Math.PI / 180);
    const endAngle = ((seg.end / 24) * 360 - 90) * (Math.PI / 180);
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const largeArc = (seg.end - seg.start) > 12 ? 1 : 0;
    return `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc},1 ${x2},${y2} Z" fill="#FF6B35" opacity="0.3"/>`;
  });

  // Hour markers
  const markers = Array.from({ length: 12 }, (_, i) => {
    const angle = ((i / 12) * 360 - 90) * (Math.PI / 180);
    const x1 = cx + (r - 5) * Math.cos(angle);
    const y1 = cy + (r - 5) * Math.sin(angle);
    const x2 = cx + r * Math.cos(angle);
    const y2 = cy + r * Math.sin(angle);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(255,255,255,0.4)" stroke-width="2"/>`;
  });

  const hoursText = peakHoursAvoided > 0 ? `${peakHoursAvoided.toLocaleString()} kWh` : 'Peak';

  return `<svg width="${size}" height="${size + 24}" viewBox="0 0 ${size} ${size + 24}" class="peak-clock">
    <!-- Clock face -->
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="2"/>
    <!-- Peak hour segments -->
    ${segments.join('')}
    <!-- Hour markers -->
    ${markers.join('')}
    <!-- Center dot -->
    <circle cx="${cx}" cy="${cy}" r="4" fill="#1DB954"/>
    <!-- Clock hands (static) -->
    <line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - r * 0.6}" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
    <line x1="${cx}" y1="${cy}" x2="${cx + r * 0.4}" y2="${cy}" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>
    <!-- Label -->
    <text x="${cx}" y="${size + 16}" text-anchor="middle" fill="#FF6B35" font-size="12" font-weight="600">${hoursText} shifted</text>
  </svg>`;
}

// Battery stack (current + potential additional batteries)
function createBatteryStackSVG(currentCount: number, additionalSavings: number[], size = 60): string {
  const totalBatteries = currentCount + additionalSavings.length;
  const spacing = 5;
  const batteryHeight = size * 1.2;
  const batteryWidth = size * 0.7;
  const totalWidth = totalBatteries * (batteryWidth + spacing);

  const batteries = [];
  for (let i = 0; i < totalBatteries; i++) {
    const isCurrent = i < currentCount;
    const x = i * (batteryWidth + spacing);
    const opacity = isCurrent ? 1 : 0.4;
    const fill = isCurrent ? '#1DB954' : '#22A7F0';
    const strokeDash = isCurrent ? '' : '4,2';

    batteries.push(`
      <g transform="translate(${x}, 0)" opacity="${opacity}">
        <!-- Battery cap -->
        <rect x="${batteryWidth * 0.25}" y="0" width="${batteryWidth * 0.5}" height="6" rx="2" fill="rgba(255,255,255,0.3)"/>
        <!-- Battery body -->
        <rect x="2" y="8" width="${batteryWidth - 4}" height="${batteryHeight - 12}" rx="6"
          fill="none" stroke="${fill}" stroke-width="2" ${strokeDash ? `stroke-dasharray="${strokeDash}"` : ''}/>
        <!-- Fill -->
        <rect x="5" y="${batteryHeight * 0.3}" width="${batteryWidth - 10}" height="${batteryHeight * 0.6}" rx="4" fill="${fill}" opacity="0.6"/>
        ${!isCurrent && additionalSavings[i - currentCount] ? `
          <text x="${batteryWidth / 2}" y="${batteryHeight + 15}" text-anchor="middle" fill="#FFE205" font-size="10" font-weight="600">
            +$${Math.round(additionalSavings[i - currentCount] ?? 0)}/yr
          </text>
        ` : ''}
      </g>
    `);
  }

  return `<svg width="${totalWidth}" height="${batteryHeight + 25}" viewBox="0 0 ${totalWidth} ${batteryHeight + 25}" class="battery-stack">
    ${batteries.join('')}
  </svg>`;
}

// Trophy icon for best season
function createTrophySVG(size = 40): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 40 40" class="trophy-icon">
    <path d="M20 5 L25 15 L35 15 L27 22 L30 32 L20 26 L10 32 L13 22 L5 15 L15 15 Z"
      fill="#FFE205" stroke="#FF9F1C" stroke-width="1"/>
  </svg>`;
}

// Wacky comparison options with thresholds
interface WackyOption {
  key: keyof WackyComparisons;
  icon: string;
  format: (value: number) => string;
  min: number;
}

const WACKY_OPTIONS: WackyOption[] = [
  // Tech & Entertainment
  { key: 'iphones', icon: '📱', format: v => formatComparison(v, 'iPhone charge'), min: 1000 },
  { key: 'netflixHours', icon: '📺', format: v => formatComparison(v, 'hour') + ' of Netflix', min: 100 },
  { key: 'spotifyStreams', icon: '🎵', format: v => formatComparison(v, 'Spotify stream'), min: 500 },
  { key: 'gamingHours', icon: '🎮', format: v => formatComparison(v, 'hour') + ' of gaming', min: 100 },
  // Household
  { key: 'coffees', icon: '☕', format: v => formatComparison(v, 'cup', 'cups') + ' of coffee', min: 100 },
  { key: 'laundryLoads', icon: '👕', format: v => formatComparison(v, 'laundry load'), min: 50 },
  { key: 'acHours', icon: '❄️', format: v => formatComparison(v, 'hour') + ' of AC', min: 10 },
  { key: 'hotShowers', icon: '🚿', format: v => formatComparison(v, 'hot shower'), min: 20 },
  { key: 'toastSlices', icon: '🍞', format: v => formatComparison(v, 'slice', 'slices') + ' of toast', min: 100 },
  { key: 'pizzas', icon: '🍕', format: v => formatComparison(v, 'homemade pizza'), min: 10 },
  // Transport
  { key: 'evKm', icon: '🚗', format: v => formatComparison(v, 'km') + ' in an EV', min: 1000 },
  // Environmental
  { key: 'treesEquivalent', icon: '🌳', format: v => 'Like planting ' + formatComparison(v, 'tree'), min: 10 },
  { key: 'co2Avoided', icon: '🌍', format: v => formatComparison(v, 'kg') + ' CO₂ avoided', min: 100 },
  { key: 'flightsSydBali', icon: '✈️', format: v => formatComparison(v, 'flight') + ' to Bali offset', min: 1 },
];

// Format wacky comparison - returns randomized selection
function formatWackyComparison(comparisons: WackyComparisons, count = 6): { icon: string; text: string }[] {
  // Filter to comparisons that pass threshold
  const valid = WACKY_OPTIONS.filter(opt => comparisons[opt.key] >= opt.min);

  // Shuffle and take up to `count` items
  const selected = shuffle(valid).slice(0, count);

  return selected.map(opt => ({
    icon: opt.icon,
    text: opt.format(comparisons[opt.key])
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// HTML GENERATION
// ═══════════════════════════════════════════════════════════════════════════

function generateHTML(data: ReportData): string {
  const f = (n: number, d = 0) => n.toLocaleString('en-AU', { minimumFractionDigits: d, maximumFractionDigits: d });
  const money = (n: number) => '$' + f(n, 0);

  // Derived stats
  const sortedSeasons = [...data.bySeason].sort((a, b) => b.data.avgDaily.pvGeneration - a.data.avgDaily.pvGeneration);
  const bestSeason = sortedSeasons[0];
  const totalCycles = data.batteryEfficiency.reduce((sum, p) => sum + p.cycleCount, 0);
  const bestScenario = data.scenarios.filter(s => s.additionalBatteries > 0).sort((a, b) => b.roi - a.roi)[0];
  const avgHomePower = 20; // kWh/day average Australian home
  const yearsOfPower = data.totalGenerated / (avgHomePower * 365);
  const evKmPerKwh = 6; // km per kWh for typical EV
  const evKm = data.totalGenerated * evKmPerKwh;
  const dailyCostWithoutSolar = data.savings.noSolar.totalNetCost / data.daysAnalyzed;
  const dailyCostActual = data.savings.actual.totalNetCost / data.daysAnalyzed;
  const peakAvoided = data.savings.savingsFromBattery;
  const startYear = new Date(data.dateRange.start).getFullYear();
  const endYear = new Date(data.dateRange.end).getFullYear();
  const yearRange = startYear === endYear ? `${startYear}` : `${startYear}–${endYear}`;
  const avgEfficiency = data.batteryEfficiency.length > 0
    ? data.batteryEfficiency.reduce((sum, p) => sum + p.efficiency, 0) / data.batteryEfficiency.length * 100
    : 90;

  // SVG Graphics
  const sunSvg = createSunSVG(100);
  const batterySvg = createBatterySVG(avgEfficiency, 60);
  const energyFlowSvg = createEnergyFlowSVG(data.selfConsumptionRate, 200);
  const donutSvg = createDonutSVG(data.selfConsumptionRate, 100);
  const sparklineSvg = createSparklineSVG(data.sparklineData, 180, 40);
  const seasonBars = createSeasonBarsSVG(
    data.bySeason.map(s => ({ name: s.season, value: s.data.avgDaily.pvGeneration })),
    160, 50
  );

  // New graphics for visual overhaul
  const roofSvg = createRoofSVG(180);
  const energyParticles = createParticleContainerHTML('energy', 10);
  const moneyParticles = createParticleContainerHTML('money', 8);
  const homesPowered = Math.floor(data.totalGenerated / 7300); // avg home uses 7300 kWh/year
  const houseGridSvg = createHouseGridSVG(Math.min(12, homesPowered + 4), Math.min(12, homesPowered));
  const savingsBarHtml = createSavingsBarSVG(data.savings.savingsFromSolar, data.savings.savingsFromBattery);
  const costComparisonHtml = createCostComparisonSVG(dailyCostActual, dailyCostWithoutSolar);
  const peakClockSvg = createPeakClockSVG(Math.round(data.savings.savingsFromBattery / (RATES.peak - RATES.offpeak)));
  const batteryStackHtml = createBatteryStackSVG(1, data.scenarios.slice(0, 2).map(s => s.annualSavings));
  const trophySvg = createTrophySVG(32);

  // Random text selections
  const hookOpener = pickRandom(TEXT_POOLS.hookOpeners);
  const hookEmphasis = pickRandom(TEXT_POOLS.hookEmphasis);
  const generationIntro = pickRandom(TEXT_POOLS.generationIntros);
  const selfConsumptionPraise = pickRandom(TEXT_POOLS.selfConsumptionPraise);
  const savingsTease = pickRandom(TEXT_POOLS.savingsTeases);
  const celebratory = pickRandom(TEXT_POOLS.celebratory);

  // YoY indicators
  const genYoY = data.yoy ? createYoYDeltaSVG(data.yoy.generation.delta, data.yoy.generation.direction) : '';
  const selfConsYoY = data.yoy ? createYoYDeltaSVG(data.yoy.selfConsumption.delta, data.yoy.selfConsumption.direction) : '';
  const savingsYoY = data.yoy ? createYoYDeltaSVG(data.yoy.savings.delta, data.yoy.savings.direction) : '';

  // Wacky comparisons formatted
  const wackyComps = formatWackyComparison(data.comparisons);

  // Charts for detail panels
  const charts = {
    savingsComparison: createSavingsComparisonChart(data),
    touImport: createTOUDonutChart(data, 'import'),
    touExport: createTOUDonutChart(data, 'export'),
    seasonal: createSeasonalChart(data),
    batteryEfficiency: createBatteryEfficiencyChart(data),
    scenarios: createScenarioChart(data),
    dailyProfile: createDailyProfileChart(data)
  };

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Solar Wrapped ${yearRange}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    html {
      scroll-snap-type: y mandatory;
      scroll-behavior: smooth;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #fff;
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
    }

    /* ═══════════════════════════════════════════════════════════════════════
       SLIDES
       ═══════════════════════════════════════════════════════════════════════ */
    .slide {
      height: 100vh;
      width: 100vw;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
      padding: 40px 24px;
      scroll-snap-align: start;
      scroll-snap-stop: always;
      position: relative;
      overflow: hidden;
    }

    /* Animated gradient backgrounds */
    .slide::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: var(--gradient);
      background-size: 400% 400%;
      animation: gradientShift 12s ease infinite;
      z-index: -1;
    }

    @keyframes gradientShift {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }

    /* Gradient themes */
    .slide.theme-intro { --gradient: linear-gradient(135deg, #1a1a2e, #16213e, #0f3460); }
    .slide.theme-hook { --gradient: linear-gradient(135deg, #0f3460, #1a5276, #148f77); }
    .slide.theme-generation { --gradient: linear-gradient(135deg, #148f77, #1e8449, #239b56); }
    .slide.theme-context { --gradient: linear-gradient(135deg, #239b56, #58d68d, #f4d03f); }
    .slide.theme-self { --gradient: linear-gradient(135deg, #f4d03f, #eb984e, #e67e22); }
    .slide.theme-battery { --gradient: linear-gradient(135deg, #e67e22, #3498db, #2874a6); }
    .slide.theme-tease { --gradient: linear-gradient(135deg, #2874a6, #6c3483, #8e44ad); }
    .slide.theme-savings { --gradient: linear-gradient(135deg, #8e44ad, #1abc9c, #16a085); }
    .slide.theme-daily { --gradient: linear-gradient(135deg, #16a085, #1abc9c, #3498db); }
    .slide.theme-season { --gradient: linear-gradient(135deg, #f39c12, #e74c3c, #c0392b); }
    .slide.theme-peak { --gradient: linear-gradient(135deg, #e74c3c, #c0392b, #922b21); }
    .slide.theme-future { --gradient: linear-gradient(135deg, #2c3e50, #34495e, #5d6d7e); }
    .slide.theme-summary { --gradient: linear-gradient(135deg, #8e44ad, #3498db, #1abc9c, #f1c40f, #e74c3c); background-size: 600% 600%; }

    /* Typography */
    .headline {
      font-size: clamp(1.5rem, 5vw, 2.5rem);
      font-weight: 400;
      opacity: 0.9;
      margin-bottom: 1rem;
      line-height: 1.3;
    }

    .hero-number {
      font-size: clamp(4rem, 15vw, 10rem);
      font-weight: 800;
      line-height: 1;
      margin: 0.5rem 0;
      text-shadow: 0 4px 30px rgba(0,0,0,0.3);
    }

    .hero-unit {
      font-size: clamp(1.5rem, 4vw, 2.5rem);
      font-weight: 300;
      opacity: 0.8;
      margin-bottom: 1rem;
    }

    .subtext {
      font-size: clamp(0.9rem, 2.5vw, 1.2rem);
      opacity: 0.6;
      max-width: 500px;
      line-height: 1.5;
    }

    .scroll-hint {
      position: absolute;
      bottom: 30px;
      left: 50%;
      transform: translateX(-50%);
      opacity: 0.5;
      font-size: 0.9rem;
      animation: bounce 2s infinite;
    }

    @keyframes bounce {
      0%, 100% { transform: translateX(-50%) translateY(0); }
      50% { transform: translateX(-50%) translateY(8px); }
    }

    /* Explore button */
    .explore-btn {
      position: absolute;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(255,255,255,0.15);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.2);
      color: #fff;
      padding: 12px 28px;
      border-radius: 30px;
      font-size: 0.95rem;
      cursor: pointer;
      transition: all 0.3s;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .explore-btn:hover {
      background: rgba(255,255,255,0.25);
      transform: translateX(-50%) scale(1.05);
    }

    /* ═══════════════════════════════════════════════════════════════════════
       DETAIL PANELS
       ═══════════════════════════════════════════════════════════════════════ */
    .detail-panel {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      height: 75vh;
      background: rgba(20, 20, 25, 0.98);
      backdrop-filter: blur(20px);
      border-radius: 24px 24px 0 0;
      transform: translateY(100%);
      transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      z-index: 1000;
      overflow-y: auto;
      padding: 0 24px 40px;
    }

    .detail-panel.open {
      transform: translateY(0);
    }

    .detail-header {
      position: sticky;
      top: 0;
      background: rgba(20, 20, 25, 0.95);
      padding: 20px 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      margin-bottom: 20px;
      z-index: 10;
    }

    .detail-header h3 {
      font-size: 1.3rem;
      font-weight: 600;
    }

    .close-btn {
      background: rgba(255,255,255,0.1);
      border: none;
      color: #fff;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      font-size: 1.2rem;
      cursor: pointer;
      transition: background 0.2s;
    }

    .close-btn:hover {
      background: rgba(255,255,255,0.2);
    }

    .detail-content {
      max-width: 800px;
      margin: 0 auto;
    }

    /* Charts in detail panel */
    .chart-container {
      background: rgba(255,255,255,0.03);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 24px;
    }

    /* Data tables */
    .data-table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
      font-size: 0.95rem;
    }

    .data-table th, .data-table td {
      padding: 12px 16px;
      text-align: left;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }

    .data-table th {
      font-weight: 600;
      color: rgba(255,255,255,0.7);
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .data-table tr:nth-child(even) {
      background: rgba(255,255,255,0.02);
    }

    .data-table .number {
      font-variant-numeric: tabular-nums;
      text-align: right;
    }

    /* Explanation boxes */
    .explanation {
      background: rgba(255,255,255,0.05);
      border-left: 3px solid #3498db;
      padding: 16px 20px;
      margin: 20px 0;
      border-radius: 0 12px 12px 0;
    }

    .explanation h4 {
      font-size: 0.9rem;
      color: #3498db;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .explanation p {
      font-size: 0.9rem;
      opacity: 0.8;
      line-height: 1.6;
    }

    .formula {
      background: rgba(0,0,0,0.3);
      padding: 8px 12px;
      border-radius: 6px;
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 0.85rem;
      margin: 10px 0;
      color: #f1c40f;
    }

    /* Backdrop */
    .backdrop {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.6);
      opacity: 0;
      visibility: hidden;
      transition: all 0.3s;
      z-index: 999;
    }

    .backdrop.visible {
      opacity: 1;
      visibility: visible;
    }

    /* ═══════════════════════════════════════════════════════════════════════
       NAVIGATION DOTS
       ═══════════════════════════════════════════════════════════════════════ */
    .nav-dots {
      position: fixed;
      right: 20px;
      top: 50%;
      transform: translateY(-50%);
      z-index: 100;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .nav-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: rgba(255,255,255,0.3);
      cursor: pointer;
      transition: all 0.3s;
    }

    .nav-dot.active {
      background: #fff;
      transform: scale(1.3);
    }

    .nav-dot:hover {
      background: rgba(255,255,255,0.7);
    }

    /* ═══════════════════════════════════════════════════════════════════════
       SUMMARY GRID
       ═══════════════════════════════════════════════════════════════════════ */
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
      max-width: 400px;
      margin: 2rem auto;
    }

    .summary-item {
      background: rgba(255,255,255,0.1);
      padding: 16px;
      border-radius: 12px;
      text-align: left;
    }

    .summary-item .icon {
      font-size: 1.5rem;
      margin-bottom: 8px;
    }

    .summary-item .value {
      font-size: 1.4rem;
      font-weight: 700;
    }

    .summary-item .label {
      font-size: 0.8rem;
      opacity: 0.7;
    }

    /* ═══════════════════════════════════════════════════════════════════════
       ANIMATIONS
       ═══════════════════════════════════════════════════════════════════════ */
    .fade-in {
      opacity: 0;
      transform: translateY(20px);
      transition: opacity 0.6s ease-out, transform 0.6s ease-out;
    }

    .slide.active .fade-in {
      opacity: 1;
      transform: translateY(0);
    }

    .fade-in.delay-1 { transition-delay: 0.2s; }
    .fade-in.delay-2 { transition-delay: 0.4s; }
    .fade-in.delay-3 { transition-delay: 0.6s; }

    /* Count-up animation handled by JS */
    .count-up {
      display: inline-block;
    }

    /* ═══════════════════════════════════════════════════════════════════════
       SVG GRAPHICS & ANIMATIONS
       ═══════════════════════════════════════════════════════════════════════ */
    .sun-icon {
      filter: drop-shadow(0 0 20px rgba(255, 217, 61, 0.5));
    }

    .sun-rays {
      animation: rotateSun 20s linear infinite;
      transform-origin: center center;
    }

    @keyframes rotateSun {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .battery-icon .battery-fill {
      animation: batteryPulse 3s ease-in-out infinite;
    }

    @keyframes batteryPulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    .energy-flow .flow-line {
      stroke-dasharray: 10 5;
      animation: flowPulse 1.5s linear infinite;
    }

    .energy-flow .flow-home {
      animation-direction: normal;
    }

    .energy-flow .flow-grid {
      animation-direction: reverse;
    }

    @keyframes flowPulse {
      from { stroke-dashoffset: 0; }
      to { stroke-dashoffset: 30; }
    }

    .donut-chart .donut-progress {
      animation: donutFill 1.5s ease-out forwards;
    }

    @keyframes donutFill {
      from { stroke-dashoffset: 300; }
    }

    .sparkline {
      opacity: 0;
      animation: sparklineIn 1s ease-out 0.5s forwards;
    }

    @keyframes sparklineIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .yoy-delta {
      display: inline-block;
      margin-left: 8px;
      font-size: 0.9em;
    }

    .yoy-delta.up { animation: pulseGreen 2s ease-in-out infinite; }
    .yoy-delta.down { animation: pulseRed 2s ease-in-out infinite; }

    @keyframes pulseGreen {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    @keyframes pulseRed {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    /* Floating particles animation */
    .particle-container {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
      overflow: hidden;
    }

    .particle {
      position: absolute;
      animation: floatUp var(--duration, 3s) ease-out infinite;
      animation-delay: var(--delay, 0s);
      opacity: 0;
      font-size: 1.5rem;
    }

    @keyframes floatUp {
      0% { opacity: 0; transform: translateY(0) scale(0.5); }
      15% { opacity: 1; }
      85% { opacity: 0.8; }
      100% { opacity: 0; transform: translateY(-150px) scale(1.2); }
    }

    /* Hero number shimmer glow */
    .hero-number.shimmer {
      animation: shimmer 3s ease-in-out infinite;
    }

    @keyframes shimmer {
      0%, 100% { text-shadow: 0 4px 30px rgba(0,0,0,0.3); }
      50% { text-shadow: 0 4px 30px rgba(0,0,0,0.3), 0 0 60px rgba(29,185,84,0.5); }
    }

    /* Staggered cascade entry for lists */
    .cascade > * {
      opacity: 0;
      transform: translateX(-20px);
      animation: cascadeIn 0.5s ease-out forwards;
    }
    .cascade > *:nth-child(1) { animation-delay: 0.1s; }
    .cascade > *:nth-child(2) { animation-delay: 0.2s; }
    .cascade > *:nth-child(3) { animation-delay: 0.3s; }
    .cascade > *:nth-child(4) { animation-delay: 0.4s; }
    .cascade > *:nth-child(5) { animation-delay: 0.5s; }
    .cascade > *:nth-child(6) { animation-delay: 0.6s; }

    @keyframes cascadeIn {
      to { opacity: 1; transform: translateX(0); }
    }

    /* Bar grow animation */
    .bar-fill {
      width: 0;
      animation: barGrow 1s ease-out 0.3s forwards;
    }

    @keyframes barGrow {
      to { width: var(--target-width, 100%); }
    }

    /* Pulsing glow on roof SVG */
    .roof-outline {
      filter: drop-shadow(0 0 10px rgba(29,185,84,0.3));
      animation: roofPulse 2s ease-in-out infinite;
    }

    @keyframes roofPulse {
      0%, 100% { filter: drop-shadow(0 0 10px rgba(29,185,84,0.3)); }
      50% { filter: drop-shadow(0 0 30px rgba(29,185,84,0.7)); }
    }

    /* Split screen layout */
    .split-layout {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      gap: 1.5rem;
      align-items: center;
      max-width: 500px;
      margin: 1.5rem auto;
    }

    .split-divider {
      width: 2px;
      height: 80px;
      background: linear-gradient(to bottom, transparent, rgba(255,255,255,0.3), transparent);
    }

    .split-left, .split-right {
      text-align: center;
    }

    /* Floating card style */
    .floating-card {
      background: rgba(255,255,255,0.05);
      backdrop-filter: blur(10px);
      border-radius: 16px;
      padding: 20px 28px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.1);
    }

    /* Asymmetric offset positioning */
    .offset-left { transform: translateX(-20px); }
    .offset-right { transform: translateX(20px); }

    /* Wacky comparison carousel/chips */
    .wacky-carousel {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      justify-content: center;
      max-width: 450px;
      margin: 1.5rem auto;
    }

    .wacky-chip {
      background: rgba(255,255,255,0.08);
      padding: 10px 18px;
      border-radius: 24px;
      font-size: 0.9rem;
      display: flex;
      align-items: center;
      gap: 8px;
      backdrop-filter: blur(5px);
      border: 1px solid rgba(255,255,255,0.12);
      transition: transform 0.2s, background 0.2s;
    }

    .wacky-chip:hover {
      transform: scale(1.05);
      background: rgba(255,255,255,0.12);
    }

    /* Inline mini-chart containers */
    .mini-chart {
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 1rem 0;
    }

    /* Trophy/badge styling */
    .trophy-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: linear-gradient(135deg, rgba(255,215,0,0.2), rgba(255,165,0,0.1));
      padding: 8px 16px;
      border-radius: 20px;
      border: 1px solid rgba(255,215,0,0.3);
    }

    /* Clock face styling */
    .clock-container {
      position: relative;
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      gap: 0.5rem;
    }

    /* Battery stack styling */
    .battery-stack {
      display: flex;
      gap: 0.5rem;
      align-items: flex-end;
      margin: 1rem 0;
    }

    .battery-ghost {
      opacity: 0.4;
      filter: grayscale(0.5);
    }

    /* Stacked bar chart */
    .stacked-bar {
      display: flex;
      width: 100%;
      max-width: 300px;
      height: 40px;
      border-radius: 8px;
      overflow: hidden;
      margin: 1rem auto;
    }

    .stacked-segment {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.8rem;
      font-weight: 600;
      color: white;
      transition: width 1s ease-out;
    }

    /* Cost comparison bars */
    .cost-bars {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      width: 100%;
      max-width: 350px;
      margin: 1rem auto;
    }

    .cost-bar-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .cost-bar-label {
      width: 60px;
      font-size: 0.8rem;
      text-align: right;
      opacity: 0.8;
    }

    .cost-bar-track {
      flex: 1;
      height: 28px;
      background: rgba(255,255,255,0.1);
      border-radius: 6px;
      overflow: hidden;
    }

    .cost-bar-fill {
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding-right: 8px;
      font-size: 0.85rem;
      font-weight: 600;
      border-radius: 6px;
      transition: width 1s ease-out;
    }

    .cost-bar-fill.you {
      background: linear-gradient(90deg, #1DB954, #22A7F0);
    }

    .cost-bar-fill.grid {
      background: linear-gradient(90deg, #FF6B35, #E74C3C);
    }

    /* Visual layout helpers */
    .visual-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 1.5rem;
      margin: 1rem 0;
    }

    .visual-col {
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .wacky-comparisons {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 1rem;
      margin-top: 1.5rem;
      max-width: 500px;
    }

    .wacky-item {
      background: rgba(255,255,255,0.1);
      padding: 8px 14px;
      border-radius: 20px;
      font-size: 0.85rem;
      display: flex;
      align-items: center;
      gap: 6px;
      backdrop-filter: blur(5px);
    }

    .comparison-strip {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      justify-content: center;
      margin-top: 1rem;
      font-size: 0.75rem;
      opacity: 0.7;
    }

    /* Responsive */
    @media (max-width: 600px) {
      .nav-dots { display: none; }
      .explore-btn { bottom: 60px; padding: 10px 22px; }
    }
  </style>
</head>
<body>
  <!-- Navigation Dots -->
  <nav class="nav-dots" id="navDots"></nav>

  <!-- Backdrop for detail panels -->
  <div class="backdrop" id="backdrop"></div>

  <!-- ═══════════════════════════════════════════════════════════════════════
       SLIDE 1: TITLE
       ═══════════════════════════════════════════════════════════════════════ -->
  <section class="slide theme-intro" data-slide="0">
    ${energyParticles}
    <div class="fade-in">
      ${sunSvg}
    </div>
    <div class="fade-in delay-1">
      <div class="headline">Your Solar Story</div>
      <div class="hero-number shimmer" style="font-size: clamp(3rem, 12vw, 8rem);">${yearRange}</div>
    </div>
    <div class="scroll-hint fade-in delay-2">Scroll to begin ↓</div>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════════════
       SLIDE 2: THE HOOK
       ═══════════════════════════════════════════════════════════════════════ -->
  <section class="slide theme-hook" data-slide="1">
    <div class="fade-in">
      ${roofSvg}
    </div>
    <div class="fade-in delay-1">
      <div class="headline">${hookOpener}</div>
    </div>
    <div class="fade-in delay-2">
      <div class="hero-unit" style="font-size: clamp(2rem, 6vw, 4rem); font-weight: 600; margin-top: 1rem;">${hookEmphasis}</div>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════════════
       SLIDE 3: GENERATION REVEAL
       ═══════════════════════════════════════════════════════════════════════ -->
  <section class="slide theme-generation" data-slide="2" data-panel="generation">
    <div class="fade-in">
      <div class="headline">${generationIntro}</div>
    </div>
    <div class="fade-in delay-1 visual-row">
      <div class="visual-col">
        <div class="hero-number shimmer count-up" data-value="${Math.round(data.totalGenerated)}">${f(data.totalGenerated, 0)}</div>
        <div class="hero-unit">kWh ${genYoY}</div>
      </div>
    </div>
    <div class="fade-in delay-2">
      ${sparklineSvg}
      <div class="subtext" style="margin-top: 0.5rem;">of pure sunshine</div>
    </div>
    <div class="wacky-carousel cascade fade-in delay-3">
      ${wackyComps.slice(0, 6).map(c => `<div class="wacky-chip">${c.icon} <span>${c.text}</span></div>`).join('')}
    </div>
    <button class="explore-btn fade-in delay-3" onclick="openPanel('generation')">Explore details ↑</button>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════════════
       SLIDE 4: CONTEXT
       ═══════════════════════════════════════════════════════════════════════ -->
  <section class="slide theme-context" data-slide="3">
    <div class="fade-in">
      <div class="headline">That's enough to power</div>
    </div>
    <div class="fade-in delay-1 mini-chart">
      ${houseGridSvg}
    </div>
    <div class="fade-in delay-2">
      <div class="hero-number count-up" data-value="${yearsOfPower.toFixed(1)}">${f(yearsOfPower, 1)}</div>
      <div class="hero-unit">years of an average home</div>
    </div>
    <div class="fade-in delay-3">
      <div class="subtext" style="margin-top: 1rem;">or drive an EV ${f(evKm, 0).toLocaleString()} km 🚗</div>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════════════
       SLIDE 5: SELF-CONSUMPTION
       ═══════════════════════════════════════════════════════════════════════ -->
  <section class="slide theme-self" data-slide="4" data-panel="selfconsumption">
    <div class="fade-in">
      <div class="headline">${selfConsumptionPraise}</div>
    </div>
    <div class="fade-in delay-1 visual-row">
      ${donutSvg}
      <div class="visual-col">
        <div class="hero-number shimmer count-up" data-value="${data.selfConsumptionRate.toFixed(1)}">${f(data.selfConsumptionRate, 1)}%</div>
        <div class="hero-unit">kept at home ${selfConsYoY}</div>
      </div>
    </div>
    <div class="fade-in delay-2">
      ${energyFlowSvg}
    </div>
    <div class="fade-in delay-3">
      <div class="floating-card" style="margin-top: 1rem;">
        <div class="subtext">Most homes only manage 30-40%</div>
        <div class="subtext" style="color: #1DB954; margin-top: 0.5rem;">You're in the top ${Math.max(1, Math.round(100 - data.selfConsumptionRate))}% of solar users</div>
      </div>
    </div>
    <button class="explore-btn fade-in delay-3" onclick="openPanel('selfconsumption')">Explore details ↑</button>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════════════
       SLIDE 6: BATTERY HERO
       ═══════════════════════════════════════════════════════════════════════ -->
  <section class="slide theme-battery" data-slide="5" data-panel="battery">
    <div class="fade-in">
      <div class="headline">Your battery cycled</div>
    </div>
    <div class="fade-in delay-1 visual-row">
      ${batterySvg}
      <div class="visual-col">
        <div class="hero-number count-up" data-value="${Math.round(totalCycles)}">${f(totalCycles, 0)}</div>
        <div class="hero-unit">times</div>
      </div>
    </div>
    <div class="fade-in delay-2">
      <div class="subtext">storing sunshine for the evening</div>
      <div class="subtext" style="margin-top: 0.5rem; font-size: 0.85rem;">Avg efficiency: ${f(avgEfficiency, 1)}%</div>
    </div>
    <button class="explore-btn fade-in delay-3" onclick="openPanel('battery')">Explore details ↑</button>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════════════
       SLIDE 7: SAVINGS TEASE
       ═══════════════════════════════════════════════════════════════════════ -->
  <section class="slide theme-tease" data-slide="6">
    ${moneyParticles}
    <div class="fade-in">
      <div class="headline" style="font-size: clamp(1.5rem, 5vw, 2.5rem);">${savingsTease}</div>
    </div>
    <div class="fade-in delay-1" style="margin-top: 2rem;">
      <div class="scroll-hint">↓</div>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════════════
       SLIDE 8: SAVINGS REVEAL
       ═══════════════════════════════════════════════════════════════════════ -->
  <section class="slide theme-savings" data-slide="7" data-panel="savings">
    <div class="fade-in">
      <div class="hero-number shimmer count-up" data-value="${Math.round(data.savings.totalSavings)}">${money(data.savings.totalSavings)}</div>
      <div class="hero-unit">${savingsYoY}</div>
    </div>
    <div class="fade-in delay-1">
      <div class="subtext">${celebratory}</div>
    </div>
    <div class="fade-in delay-2">
      ${savingsBarHtml}
    </div>
    <div class="wacky-carousel cascade fade-in delay-3">
      ${wackyComps.slice(6, 10).map(c => `<div class="wacky-chip">${c.icon} <span>${c.text}</span></div>`).join('')}
    </div>
    <button class="explore-btn fade-in delay-3" onclick="openPanel('savings')">Explore details ↑</button>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════════════
       SLIDE 9: DAILY COST
       ═══════════════════════════════════════════════════════════════════════ -->
  <section class="slide theme-daily" data-slide="8" data-panel="daily">
    <div class="fade-in">
      <div class="headline">Your average electricity cost?</div>
    </div>
    <div class="fade-in delay-1">
      ${costComparisonHtml}
    </div>
    <div class="fade-in delay-2">
      <div class="floating-card">
        <div class="hero-number" style="font-size: 2rem; color: #1DB954;">${money(dailyCostWithoutSolar - dailyCostActual)}</div>
        <div class="subtext">saved per day</div>
      </div>
    </div>
    <button class="explore-btn fade-in delay-3" onclick="openPanel('daily')">Explore details ↑</button>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════════════
       SLIDE 10: BEST SEASON
       ═══════════════════════════════════════════════════════════════════════ -->
  <section class="slide theme-season" data-slide="9" data-panel="seasonal">
    <div class="fade-in">
      <div class="trophy-badge">
        ${trophySvg}
        <span>${bestSeason ? bestSeason.season.charAt(0).toUpperCase() + bestSeason.season.slice(1) : 'Summer'}</span>
      </div>
      <div class="headline" style="margin-top: 1rem;">was your superstar season</div>
    </div>
    <div class="fade-in delay-1 visual-row">
      <div class="visual-col">
        <div class="hero-number shimmer count-up" data-value="${bestSeason?.data.avgDaily.pvGeneration ?? 0}">${f(bestSeason?.data.avgDaily.pvGeneration ?? 0, 1)}</div>
        <div class="hero-unit">kWh/day avg</div>
      </div>
    </div>
    <div class="fade-in delay-2">
      ${seasonBars}
    </div>
    <button class="explore-btn fade-in delay-3" onclick="openPanel('seasonal')">See all seasons ↑</button>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════════════
       SLIDE 11: PEAK ARBITRAGE
       ═══════════════════════════════════════════════════════════════════════ -->
  <section class="slide theme-peak" data-slide="10" data-panel="tou">
    <div class="fade-in">
      <div class="headline">You dodged the peak rates.</div>
    </div>
    <div class="fade-in delay-1 mini-chart">
      ${peakClockSvg}
    </div>
    <div class="fade-in delay-2">
      <div class="hero-number shimmer count-up" data-value="${Math.round(peakAvoided)}">${money(peakAvoided)}</div>
      <div class="hero-unit">avoided at peak rates</div>
    </div>
    <div class="fade-in delay-3">
      <div class="subtext">Using stored solar at $${RATES.peak.toFixed(2)}/kWh hours</div>
    </div>
    <button class="explore-btn fade-in delay-3" onclick="openPanel('tou')">Explore details ↑</button>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════════════
       SLIDE 12: WHAT IF
       ═══════════════════════════════════════════════════════════════════════ -->
  <section class="slide theme-future" data-slide="11" data-panel="scenarios">
    <div class="fade-in">
      <div class="headline">What if you added<br>another battery?</div>
    </div>
    <div class="fade-in delay-1 mini-chart">
      ${batteryStackHtml}
    </div>
    <div class="fade-in delay-2">
      <div class="hero-number shimmer">${bestScenario ? '+' + money(bestScenario.annualSavings) : '+$0'}</div>
      <div class="hero-unit">per year</div>
    </div>
    <div class="fade-in delay-3">
      <div class="floating-card">
        <div class="subtext">${bestScenario && bestScenario.paybackYears < 50 ? f(bestScenario.paybackYears, 0) + ' year payback' : 'Probably not worth it at current prices'}</div>
      </div>
    </div>
    <button class="explore-btn fade-in delay-3" onclick="openPanel('scenarios')">Explore scenarios ↑</button>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════════════
       SLIDE 13: SUMMARY
       ═══════════════════════════════════════════════════════════════════════ -->
  <section class="slide theme-summary" data-slide="12" data-panel="summary">
    ${energyParticles}
    <div class="fade-in">
      ${sunSvg}
      <div class="headline shimmer" style="margin-top: 0.5rem;">Your Solar Wrapped ${yearRange}</div>
    </div>
    <div class="summary-grid cascade fade-in delay-1">
      <div class="summary-item floating-card">
        <div class="icon">☀️</div>
        <div class="value">${f(data.totalGenerated, 0)}</div>
        <div class="label">kWh generated</div>
      </div>
      <div class="summary-item floating-card">
        <div class="icon">🔋</div>
        <div class="value">${f(totalCycles, 0)}</div>
        <div class="label">battery cycles</div>
      </div>
      <div class="summary-item floating-card">
        <div class="icon">💰</div>
        <div class="value">${money(data.savings.totalSavings)}</div>
        <div class="label">saved</div>
      </div>
      <div class="summary-item floating-card">
        <div class="icon">📊</div>
        <div class="value">${f(data.selfConsumptionRate, 1)}%</div>
        <div class="label">self-consumed</div>
      </div>
    </div>
    <div class="wacky-carousel fade-in delay-2" style="margin-top: 1rem;">
      <div class="wacky-chip">🌳 <span>${f(data.comparisons.treesEquivalent, 0)} trees planted</span></div>
      <div class="wacky-chip">🌍 <span>${f(data.comparisons.co2Avoided, 0)} kg CO₂ avoided</span></div>
    </div>
    <button class="explore-btn fade-in delay-2" onclick="openPanel('summary')">Full breakdown ↑</button>
    <div class="fade-in delay-3" style="margin-top: 1rem; opacity: 0.5; font-size: 0.8rem;">
      Generated ${new Date().toLocaleDateString('en-AU', { dateStyle: 'long' })}
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════════════
       DETAIL PANELS
       ═══════════════════════════════════════════════════════════════════════ -->

  <!-- Generation Panel -->
  <div class="detail-panel" id="panel-generation">
    <div class="detail-header">
      <h3>Generation Breakdown</h3>
      <button class="close-btn" onclick="closePanel()">✕</button>
    </div>
    <div class="detail-content">
      <div class="chart-container" id="chart-daily"></div>
      <table class="data-table">
        <thead>
          <tr><th>Year</th><th class="number">Total kWh</th><th class="number">Avg/day</th><th class="number">Days</th></tr>
        </thead>
        <tbody>
          ${data.byYear.map(y => `<tr><td>${y.year}</td><td class="number">${f(y.data.pvGeneration, 0)}</td><td class="number">${f(y.data.avgDaily.pvGeneration, 1)}</td><td class="number">${y.data.days}</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="explanation">
        <h4>ℹ️ How this is calculated</h4>
        <p>Sum of daily PV generation (epv) from your inverter readings. This is the total AC output from your solar panels after inverter conversion losses.</p>
        <div class="formula">Total Generation = Σ daily_epv</div>
      </div>
    </div>
  </div>

  <!-- Self-consumption Panel -->
  <div class="detail-panel" id="panel-selfconsumption">
    <div class="detail-header">
      <h3>Self-Consumption Analysis</h3>
      <button class="close-btn" onclick="closePanel()">✕</button>
    </div>
    <div class="detail-content">
      <div style="display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 20px;">
        <div style="flex: 1; min-width: 150px; background: rgba(29,185,84,0.15); padding: 20px; border-radius: 12px; text-align: center;">
          <div style="font-size: 2rem; font-weight: 700; color: #1DB954;">${f(data.selfConsumptionRate, 1)}%</div>
          <div style="opacity: 0.8;">Used at Home</div>
        </div>
        <div style="flex: 1; min-width: 150px; background: rgba(34,167,240,0.15); padding: 20px; border-radius: 12px; text-align: center;">
          <div style="font-size: 2rem; font-weight: 700; color: #22A7F0;">${f(100 - data.selfConsumptionRate, 1)}%</div>
          <div style="opacity: 0.8;">Exported</div>
        </div>
      </div>
      <table class="data-table">
        <thead>
          <tr><th>Metric</th><th class="number">Value</th></tr>
        </thead>
        <tbody>
          <tr><td>Total Generated</td><td class="number">${f(data.totalGenerated, 0)} kWh</td></tr>
          <tr><td>Used Directly</td><td class="number">${f(data.totalGenerated - data.totalExported, 0)} kWh</td></tr>
          <tr><td>Exported to Grid</td><td class="number">${f(data.totalExported, 0)} kWh</td></tr>
          <tr><td>Feed-in Revenue</td><td class="number">${money(data.totalExported * RATES.feedIn)}</td></tr>
        </tbody>
      </table>
      <div class="explanation">
        <h4>ℹ️ Why this matters</h4>
        <p>Without a battery, typical homes only self-consume 30-40% of solar. Your battery lets you store excess for later, dramatically increasing self-consumption. Every kWh you use yourself saves $${(RATES.peak - RATES.feedIn).toFixed(2)} vs exporting it.</p>
        <div class="formula">Self-consumption = (1 - Export / Generation) × 100</div>
      </div>
    </div>
  </div>

  <!-- Battery Panel -->
  <div class="detail-panel" id="panel-battery">
    <div class="detail-header">
      <h3>Battery Performance</h3>
      <button class="close-btn" onclick="closePanel()">✕</button>
    </div>
    <div class="detail-content">
      <div class="chart-container" id="chart-battery"></div>
      <table class="data-table">
        <thead>
          <tr><th>Quarter</th><th class="number">Charged</th><th class="number">Discharged</th><th class="number">Efficiency</th><th class="number">Cycles</th></tr>
        </thead>
        <tbody>
          ${data.batteryEfficiency.map(p => `<tr><td>${p.period}</td><td class="number">${f(p.charge, 0)} kWh</td><td class="number">${f(p.discharge, 0)} kWh</td><td class="number">${f(p.efficiency * 100, 1)}%</td><td class="number">${f(p.cycleCount, 0)}</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="explanation">
        <h4>ℹ️ Battery Health</h4>
        <p>Round-trip efficiency measures how much energy you get back from the battery. New lithium batteries typically achieve 90-95%. Values below 85% may indicate degradation. Your ${data.batteryKwh}kWh battery is rated for approximately 4,000-6,000 cycles.</p>
        <div class="formula">Efficiency = (Energy Out / Energy In) × 100</div>
        <div class="formula">Cycles = Total Discharge / Battery Capacity</div>
      </div>
    </div>
  </div>

  <!-- Savings Panel -->
  <div class="detail-panel" id="panel-savings">
    <div class="detail-header">
      <h3>Savings Breakdown</h3>
      <button class="close-btn" onclick="closePanel()">✕</button>
    </div>
    <div class="detail-content">
      <div class="chart-container" id="chart-savings"></div>
      <table class="data-table">
        <thead>
          <tr><th>Scenario</th><th class="number">Import Cost</th><th class="number">Feed-in</th><th class="number">Net Cost</th></tr>
        </thead>
        <tbody>
          <tr><td>No Solar (grid only)</td><td class="number">${money(data.savings.noSolar.totalImportCost)}</td><td class="number">$0</td><td class="number">${money(data.savings.noSolar.totalNetCost)}</td></tr>
          <tr><td>Solar Only (no battery)</td><td class="number">${money(data.savings.solarOnly.totalImportCost)}</td><td class="number">${money(data.savings.solarOnly.totalFeedInRevenue)}</td><td class="number">${money(data.savings.solarOnly.totalNetCost)}</td></tr>
          <tr style="background: rgba(29,185,84,0.1);"><td><strong>Solar + Battery (actual)</strong></td><td class="number"><strong>${money(data.savings.actual.totalImportCost)}</strong></td><td class="number"><strong>${money(data.savings.actual.totalFeedInRevenue)}</strong></td><td class="number"><strong>${money(data.savings.actual.totalNetCost)}</strong></td></tr>
        </tbody>
      </table>
      <div class="explanation">
        <h4>ℹ️ How savings are calculated</h4>
        <p><strong>Solar savings:</strong> Difference between grid-only and solar-only scenarios. Your panels reduce imports and earn feed-in revenue.</p>
        <p><strong>Battery savings:</strong> Difference between solar-only and actual. Your battery shifts cheap solar to expensive peak hours, avoiding $${RATES.peak.toFixed(2)}/kWh imports.</p>
        <div class="formula">Total Savings = No-Solar Cost − Actual Cost</div>
      </div>
    </div>
  </div>

  <!-- Daily Cost Panel -->
  <div class="detail-panel" id="panel-daily">
    <div class="detail-header">
      <h3>Daily Cost Analysis</h3>
      <button class="close-btn" onclick="closePanel()">✕</button>
    </div>
    <div class="detail-content">
      <div style="display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 20px;">
        <div style="flex: 1; min-width: 150px; background: rgba(29,185,84,0.15); padding: 20px; border-radius: 12px; text-align: center;">
          <div style="font-size: 2rem; font-weight: 700; color: #1DB954;">${money(dailyCostActual)}</div>
          <div style="opacity: 0.8;">Your Daily Cost</div>
        </div>
        <div style="flex: 1; min-width: 150px; background: rgba(231,76,60,0.15); padding: 20px; border-radius: 12px; text-align: center;">
          <div style="font-size: 2rem; font-weight: 700; color: #E74C3C;">${money(dailyCostWithoutSolar)}</div>
          <div style="opacity: 0.8;">Without Solar</div>
        </div>
      </div>
      <table class="data-table">
        <thead>
          <tr><th>Metric</th><th class="number">Daily Avg</th><th class="number">Total</th></tr>
        </thead>
        <tbody>
          <tr><td>Grid Import Cost</td><td class="number">${money(data.savings.actual.totalImportCost / data.daysAnalyzed)}</td><td class="number">${money(data.savings.actual.totalImportCost)}</td></tr>
          <tr><td>Feed-in Revenue</td><td class="number">-${money(data.savings.actual.totalFeedInRevenue / data.daysAnalyzed)}</td><td class="number">-${money(data.savings.actual.totalFeedInRevenue)}</td></tr>
          <tr style="background: rgba(255,255,255,0.05);"><td><strong>Net Cost</strong></td><td class="number"><strong>${money(dailyCostActual)}</strong></td><td class="number"><strong>${money(data.savings.actual.totalNetCost)}</strong></td></tr>
        </tbody>
      </table>
      <div class="explanation">
        <h4>ℹ️ Daily breakdown</h4>
        <p>Your net daily electricity cost is what you pay to the grid minus what you earn from feed-in. With solar + battery, you're saving ${money(dailyCostWithoutSolar - dailyCostActual)} per day compared to a grid-only home.</p>
      </div>
    </div>
  </div>

  <!-- Seasonal Panel -->
  <div class="detail-panel" id="panel-seasonal">
    <div class="detail-header">
      <h3>Seasonal Performance</h3>
      <button class="close-btn" onclick="closePanel()">✕</button>
    </div>
    <div class="detail-content">
      <div class="chart-container" id="chart-seasonal"></div>
      <table class="data-table">
        <thead>
          <tr><th>Season</th><th class="number">Avg Gen/day</th><th class="number">Avg Load/day</th><th class="number">Avg Import/day</th><th class="number">Days</th></tr>
        </thead>
        <tbody>
          ${data.bySeason.map(s => `<tr><td>${s.season.charAt(0).toUpperCase() + s.season.slice(1)}</td><td class="number">${f(s.data.avgDaily.pvGeneration, 1)} kWh</td><td class="number">${f(s.data.avgDaily.load, 1)} kWh</td><td class="number">${f(s.data.avgDaily.gridImport, 1)} kWh</td><td class="number">${s.data.days}</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="explanation">
        <h4>ℹ️ Seasonal patterns</h4>
        <p>Solar generation varies with daylight hours and sun angle. Summer typically produces 2-3x more than winter. Your battery helps bridge the gap by maximizing self-consumption in lower-generation months.</p>
      </div>
    </div>
  </div>

  <!-- TOU Panel -->
  <div class="detail-panel" id="panel-tou">
    <div class="detail-header">
      <h3>Time-of-Use Analysis</h3>
      <button class="close-btn" onclick="closePanel()">✕</button>
    </div>
    <div class="detail-content">
      <div style="display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 20px;">
        <div style="flex: 1; min-width: 200px;">
          <h4 style="text-align: center; margin-bottom: 10px; opacity: 0.8;">Grid Import</h4>
          <div class="chart-container" id="chart-tou-import"></div>
        </div>
        <div style="flex: 1; min-width: 200px;">
          <h4 style="text-align: center; margin-bottom: 10px; opacity: 0.8;">Grid Export</h4>
          <div class="chart-container" id="chart-tou-export"></div>
        </div>
      </div>
      <table class="data-table">
        <thead>
          <tr><th>Period</th><th class="number">Hours</th><th class="number">Rate</th><th class="number">Import</th><th class="number">Export</th></tr>
        </thead>
        <tbody>
          <tr><td>Peak</td><td class="number">6-10am, 3pm-1am</td><td class="number">$${RATES.peak.toFixed(4)}</td><td class="number">${f(data.importByTOU.peak, 0)} kWh</td><td class="number">${f(data.exportByTOU.peak, 0)} kWh</td></tr>
          <tr><td>Shoulder</td><td class="number">10am-3pm</td><td class="number">$${RATES.shoulder.toFixed(4)}</td><td class="number">${f(data.importByTOU.shoulder, 0)} kWh</td><td class="number">${f(data.exportByTOU.shoulder, 0)} kWh</td></tr>
          <tr><td>Off-peak</td><td class="number">1-6am</td><td class="number">$${RATES.offpeak.toFixed(4)}</td><td class="number">${f(data.importByTOU.offpeak, 0)} kWh</td><td class="number">${f(data.exportByTOU.offpeak, 0)} kWh</td></tr>
        </tbody>
      </table>
      <div class="explanation">
        <h4>ℹ️ Time-of-use strategy</h4>
        <p>${data.hasPowerData ? 'Calculated from actual 5-minute power readings.' : 'Estimated from typical usage patterns.'} Your battery helps avoid expensive peak imports by discharging stored solar during peak hours. The arbitrage value is ${money(RATES.peak - RATES.feedIn)} per kWh shifted from export to peak usage.</p>
      </div>
    </div>
  </div>

  <!-- Scenarios Panel -->
  <div class="detail-panel" id="panel-scenarios">
    <div class="detail-header">
      <h3>Battery Expansion Scenarios</h3>
      <button class="close-btn" onclick="closePanel()">✕</button>
    </div>
    <div class="detail-content">
      <div class="chart-container" id="chart-scenarios"></div>
      <table class="data-table">
        <thead>
          <tr><th>Scenario</th><th class="number">Annual Savings</th><th class="number">Investment</th><th class="number">Payback</th><th class="number">${data.batteryLifespan}yr ROI</th></tr>
        </thead>
        <tbody>
          ${data.scenarios.filter(s => s.additionalBatteries > 0).map(s => `<tr><td>+${s.additionalBatteries} battery (${s.additionalKwh}kWh)</td><td class="number">${money(s.annualSavings)}</td><td class="number">${money(s.investment)}</td><td class="number">${s.paybackYears === Infinity ? 'N/A' : f(s.paybackYears, 1) + ' yrs'}</td><td class="number" style="color: ${s.roi > 0 ? '#1DB954' : '#E74C3C'}">${f(s.roi, 0)}%</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="explanation">
        <h4>ℹ️ Methodology</h4>
        <p>Scenarios model capturing additional export during shoulder hours and discharging during peak. Assumptions:</p>
        <ul style="margin: 10px 0; padding-left: 20px; opacity: 0.8;">
          <li>Battery cost: ${money(BATTERY_COST)} per ${BATTERY_SIZE_KWH}kWh</li>
          <li>Battery lifespan: ${BATTERY_LIFESPAN_YEARS} years</li>
          <li>Round-trip efficiency: ${BATTERY_EFFICIENCY * 100}%</li>
          <li>Max charge rate: ${MAX_CHARGE_RATE_KW}kW × ${SHOULDER_HOURS}h shoulder = ${MAX_CHARGE_RATE_KW * SHOULDER_HOURS}kWh/day</li>
        </ul>
        <div class="formula">ROI = (Lifetime Savings − Investment) / Investment × 100</div>
      </div>
    </div>
  </div>

  <!-- Summary Panel -->
  <div class="detail-panel" id="panel-summary">
    <div class="detail-header">
      <h3>Complete Summary</h3>
      <button class="close-btn" onclick="closePanel()">✕</button>
    </div>
    <div class="detail-content">
      <table class="data-table">
        <thead>
          <tr><th colspan="2">System Overview</th></tr>
        </thead>
        <tbody>
          <tr><td>Analysis Period</td><td class="number">${data.dateRange.start} to ${data.dateRange.end}</td></tr>
          <tr><td>Days Analyzed</td><td class="number">${data.daysAnalyzed}</td></tr>
          <tr><td>Battery Capacity</td><td class="number">${data.batteryKwh} kWh</td></tr>
        </tbody>
      </table>
      <table class="data-table">
        <thead>
          <tr><th colspan="2">Energy Summary</th></tr>
        </thead>
        <tbody>
          <tr><td>Total Solar Generated</td><td class="number">${f(data.totalGenerated, 0)} kWh</td></tr>
          <tr><td>Total Load</td><td class="number">${f(data.totalConsumed, 0)} kWh</td></tr>
          <tr><td>Grid Import</td><td class="number">${f(data.savings.actual.totalImportCost / ((data.importByTOU.peak * RATES.peak + data.importByTOU.shoulder * RATES.shoulder + data.importByTOU.offpeak * RATES.offpeak) / (data.importByTOU.peak + data.importByTOU.shoulder + data.importByTOU.offpeak) || 0.40), 0)} kWh</td></tr>
          <tr><td>Grid Export</td><td class="number">${f(data.totalExported, 0)} kWh</td></tr>
          <tr><td>Self-Consumption Rate</td><td class="number">${f(data.selfConsumptionRate, 1)}%</td></tr>
        </tbody>
      </table>
      <table class="data-table">
        <thead>
          <tr><th colspan="2">Financial Summary</th></tr>
        </thead>
        <tbody>
          <tr><td>Total Savings</td><td class="number" style="color: #1DB954; font-weight: 600;">${money(data.savings.totalSavings)}</td></tr>
          <tr><td>↳ From Solar</td><td class="number">${money(data.savings.savingsFromSolar)}</td></tr>
          <tr><td>↳ From Battery</td><td class="number">${money(data.savings.savingsFromBattery)}</td></tr>
          <tr><td>Annual Savings Rate</td><td class="number">${money(data.savings.totalSavings / data.years)}/yr</td></tr>
          <tr><td>Daily Cost</td><td class="number">${money(dailyCostActual)}/day</td></tr>
        </tbody>
      </table>
      <div class="explanation">
        <h4>ℹ️ Rates Used</h4>
        <p>Peak: $${RATES.peak.toFixed(4)}/kWh | Shoulder: $${RATES.shoulder.toFixed(4)}/kWh | Off-peak: $${RATES.offpeak.toFixed(4)}/kWh | Feed-in: $${RATES.feedIn.toFixed(4)}/kWh</p>
      </div>
    </div>
  </div>

  <script>window.REPORT_CHARTS = ${JSON.stringify(charts)};</script>
  <script>%%BUNDLED_CLIENT%%</script>
  <script>
    // Panel management
    function openPanel(panelId) {
      document.getElementById('panel-' + panelId).classList.add('open');
      document.getElementById('backdrop').classList.add('visible');
      document.body.style.overflow = 'hidden';
      // Trigger chart rendering
      if (window.renderPanelCharts) window.renderPanelCharts(panelId);
    }
    function closePanel() {
      document.querySelectorAll('.detail-panel').forEach(p => p.classList.remove('open'));
      document.getElementById('backdrop').classList.remove('visible');
      document.body.style.overflow = '';
    }
    document.getElementById('backdrop').addEventListener('click', closePanel);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });

    // Initialize
    window.initReport();
  </script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// BUNDLE CLIENT SCRIPT
// ═══════════════════════════════════════════════════════════════════════════

async function bundleClientScript(): Promise<string> {
  console.log('📦 Bundling Vega runtime...');

  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, 'report-client.ts')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2020',
    write: false,
  });

  if (result.outputFiles && result.outputFiles.length > 0) {
    const bundled = result.outputFiles[0]!.text;
    console.log(`   Bundled size: ${(bundled.length / 1024).toFixed(0)} KB`);
    return bundled;
  }

  throw new Error('Failed to bundle client script');
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

function parseArgs(): { systemFilter?: string } {
  const args = process.argv.slice(2);
  let systemFilter: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--system' || arg === '-s') {
      systemFilter = args[++i];
    } else if (arg?.startsWith('--system=')) {
      systemFilter = arg.split('=')[1];
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: npx tsx generate-charts.ts [options]

Options:
  -s, --system <id>   Generate report for specific system ID only
  -h, --help          Show this help message

Examples:
  npx tsx generate-charts.ts                     # Generate reports for ALL systems
  npx tsx generate-charts.ts -s XXXX  # Generate for specific system
`);
      process.exit(0);
    }
  }

  return { systemFilter };
}

async function generateReportForSystem(system: LoadedSystem, bundledClient: string): Promise<void> {
  console.log(`\n📊 Generating report for ${system.systemId}...`);

  const stats = loadSystemStats(system);
  const analysis = analyzeHistoricalData(stats);

  if (analysis.overall.days === 0) {
    console.error(`   ⚠️  No historical energy data for ${system.systemId}`);
    return;
  }

  const data = buildReportData(stats, analysis);
  let html = generateHTML(data);

  // Replace placeholder with bundled script
  // Use function replacement to avoid $ special chars in replace()
  html = html.replace('%%BUNDLED_CLIENT%%', () => bundledClient);

  const date = new Date().toISOString().split('T')[0];
  const outputFile = `solar-report-${system.systemId}-${date}.html`;
  fs.writeFileSync(outputFile, html);

  console.log(`   ✅ ${outputFile}`);
  console.log(`      ${data.daysAnalyzed} days | ${fmt(data.totalGenerated, 0)} kWh | ${fmtMoney(data.savings.totalSavings)} saved`);
  console.log(`      File size: ${(fs.statSync(outputFile).size / 1024).toFixed(0)} KB`);
}

async function main() {
  console.log('🔋 Solar & Battery Report Generator\n');

  const { systemFilter } = parseArgs();
  let systems = loadAllSystems();

  if (systems.length === 0) {
    console.error('❌ No data files found. Run dump-stats.ts first.');
    process.exit(1);
  }

  // Filter to specific system if requested
  if (systemFilter) {
    systems = systems.filter(s => s.systemId.includes(systemFilter));
    if (systems.length === 0) {
      console.error(`❌ No system found matching: ${systemFilter}`);
      console.error('   Available systems:');
      loadAllSystems().forEach(s => console.error(`     - ${s.systemId}`));
      process.exit(1);
    }
  }

  // Bundle the client-side script with Vega (once for all reports)
  const bundledClient = await bundleClientScript();

  // Generate report for each system
  for (const system of systems) {
    await generateReportForSystem(system, bundledClient);
  }

  console.log(`\n✅ Done! Generated ${systems.length} report(s).`);
}

function fmt(n: number, d = 0): string {
  return n.toLocaleString('en-AU', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtMoney(n: number): string {
  return '$' + fmt(n, 0);
}

main().catch(console.error);
