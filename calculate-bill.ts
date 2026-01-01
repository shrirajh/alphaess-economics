import * as fs from 'node:fs';
import 'dotenv/config';
import {
  loadTariff,
  createTariffHelpers,
  type Tariff,
  type TariffHelpers,
  type TOUBreakdown,
} from './tariff-utils.js';

// ═══════════════════════════════════════════════════════════════════════════
// CLI ARGUMENT PARSING
// ═══════════════════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const tariffPaths: string[] = [];
let targetSn: string | null = null;

for (const arg of args) {
  if (arg.startsWith('--tariff=')) {
    tariffPaths.push(arg.slice(9));
  } else if (arg.startsWith('--sn=') || arg.startsWith('--only=')) {
    targetSn = arg.includes('=') ? arg.split('=')[1] ?? null : null;
  }
}

// If no tariffs specified, use default
if (tariffPaths.length === 0) {
  tariffPaths.push('./tariffs/default.json');
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
  eGridCharge?: number;
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

interface DayBill {
  date: string;
  year: number;
  month: number;
  week: number;        // ISO week number
  quarter: number;
  dayOfWeek: number;   // 0=Sunday, 6=Saturday
  // Energy values (kWh)
  gridImport: number;
  gridExport: number;
  pvGeneration: number;
  load: number;
  // TOU breakdown (kWh)
  importByTOU: TOUBreakdown;
  exportByTOU: TOUBreakdown;
}

interface PeriodBill {
  label: string;
  startDate: string;
  endDate: string;
  days: number;
  // Energy totals (kWh)
  gridImport: number;
  gridExport: number;
  pvGeneration: number;
  load: number;
  // TOU breakdown (kWh)
  importByTOU: TOUBreakdown;
  exportByTOU: TOUBreakdown;
  // Costs per tariff ($)
  tariffCosts: Map<string, TariffBill>;
}

interface TariffBill {
  tariffName: string;
  importCost: number;
  feedInCredit: number;   // Credit from positive feed-in rate periods
  exportCharge: number;   // Charge from negative feed-in rate periods
  feedInRevenue: number;  // Net: feedInCredit - exportCharge (for backward compat)
  netCost: number;
  avgRate: number;      // $/kWh effective rate
}

interface BillSummary {
  weekly: PeriodBill[];
  monthly: PeriodBill[];
  quarterly: PeriodBill[];
  yearly: PeriodBill[];
  overall: PeriodBill;
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function getQuarter(month: number): number {
  return Math.ceil(month / 3);
}

function emptyTOUBreakdown(): TOUBreakdown {
  return {};
}

function addTOU(target: TOUBreakdown, source: TOUBreakdown): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function touTotal(tou: TOUBreakdown): number {
  return Object.values(tou).reduce((sum, v) => sum + v, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════════════════

function loadSystemData(): SystemData {
  let systemFiles = fs.readdirSync('.').filter(f => f.startsWith('alphaess-data-') && f.endsWith('.json'));

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
  console.log(`Loading ${file}...`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as SystemData;
}

function loadTariffs(): Map<string, { tariff: Tariff; helpers: TariffHelpers }> {
  const tariffs = new Map<string, { tariff: Tariff; helpers: TariffHelpers }>();

  for (const path of tariffPaths) {
    try {
      const tariff = loadTariff(path);
      const helpers = createTariffHelpers(tariff);
      tariffs.set(tariff.name, { tariff, helpers });
    } catch (e) {
      console.error(`Failed to load tariff from ${path}: ${e}`);
    }
  }

  if (tariffs.size === 0) {
    console.error('No valid tariffs loaded');
    process.exit(1);
  }

  return tariffs;
}

// ═══════════════════════════════════════════════════════════════════════════
// TOU CALCULATION FROM POWER READINGS
// ═══════════════════════════════════════════════════════════════════════════

function calculateTOUFromPower(
  powerReadings: PowerReading[] | null | undefined,
  helpers: TariffHelpers
): { importTOU: TOUBreakdown; exportTOU: TOUBreakdown } {
  const importTOU = emptyTOUBreakdown();
  const exportTOU = emptyTOUBreakdown();

  if (!powerReadings || powerReadings.length === 0) {
    return { importTOU, exportTOU };
  }

  const sorted = [...powerReadings].sort((a, b) =>
    a.uploadTime.localeCompare(b.uploadTime)
  );

  for (let i = 0; i < sorted.length; i++) {
    const reading = sorted[i]!;
    const dateObj = new Date(reading.uploadTime);
    const dayOfWeek = dateObj.getDay();
    const timePart = reading.uploadTime.includes('T')
      ? reading.uploadTime.split('T')[1]
      : reading.uploadTime.split(' ')[1];
    const hour = parseInt(timePart?.split(':')[0] ?? '0', 10);

    // Calculate interval (default 5 minutes)
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

    const period = helpers.getRatePeriod(hour, dayOfWeek);
    importTOU[period.name] = (importTOU[period.name] ?? 0) + importKwh;
    exportTOU[period.name] = (exportTOU[period.name] ?? 0) + exportKwh;
  }

  return { importTOU, exportTOU };
}

// ═══════════════════════════════════════════════════════════════════════════
// BILL CALCULATION
// ═══════════════════════════════════════════════════════════════════════════

function calculateDayBills(
  system: SystemData,
  primaryHelpers: TariffHelpers
): DayBill[] {
  const bills: DayBill[] = [];

  for (const day of system.historicalData) {
    if (!day.energy) continue;

    const e = day.energy;
    const [yearStr, monthStr, dayStr] = day.date.split('-');
    if (!yearStr || !monthStr || !dayStr) continue;

    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const dateObj = new Date(year, month - 1, parseInt(dayStr, 10));
    const dayOfWeek = dateObj.getDay();
    const week = getISOWeek(dateObj);
    const quarter = getQuarter(month);

    const load = (e.epv ?? 0) + (e.eInput ?? 0) + (e.eDischarge ?? 0) - (e.eOutput ?? 0) - (e.eCharge ?? 0);

    // Calculate TOU from power readings (use primary tariff for bucketing)
    const { importTOU, exportTOU } = calculateTOUFromPower(
      day.power as PowerReading[] | null,
      primaryHelpers
    );

    bills.push({
      date: day.date,
      year,
      month,
      week,
      quarter,
      dayOfWeek,
      gridImport: e.eInput ?? 0,
      gridExport: e.eOutput ?? 0,
      pvGeneration: e.epv ?? 0,
      load,
      importByTOU: importTOU,
      exportByTOU: exportTOU,
    });
  }

  return bills.sort((a, b) => a.date.localeCompare(b.date));
}

function calculateTariffCost(
  importByTOU: TOUBreakdown,
  exportByTOU: TOUBreakdown,
  gridImport: number,
  gridExport: number,
  helpers: TariffHelpers
): TariffBill {
  const hasTOUData = touTotal(importByTOU) > 0;

  let importCost: number;
  if (hasTOUData) {
    importCost = helpers.calculateTOUCost(importByTOU);
  } else {
    // Fallback to weighted average
    const fallbackDist = { peak: 0.70, shoulder: 0.05, offpeak: 0.25 };
    importCost = gridImport * helpers.calculateWeightedAvgRate(fallbackDist);
  }

  // Calculate feed-in (credit and charges)
  let feedInCredit: number;
  let exportCharge: number;
  let feedInRevenue: number;

  if (hasTOUData && helpers.hasTOUFeedIn()) {
    const result = helpers.calculateFeedInRevenue(exportByTOU);
    feedInCredit = result.feedInCredit;
    exportCharge = result.exportCharge;
    feedInRevenue = result.netFeedIn;
  } else {
    // Flat rate - check if negative (export charge)
    const value = gridExport * helpers.tariff.feedInTariff;
    if (value >= 0) {
      feedInCredit = value;
      exportCharge = 0;
    } else {
      feedInCredit = 0;
      exportCharge = -value;
    }
    feedInRevenue = feedInCredit - exportCharge;
  }

  const netCost = importCost - feedInRevenue;
  const avgRate = gridImport > 0 ? importCost / gridImport : 0;

  return {
    tariffName: helpers.tariff.name,
    importCost,
    feedInCredit,
    exportCharge,
    feedInRevenue,
    netCost,
    avgRate,
  };
}

function aggregatePeriod(
  bills: DayBill[],
  label: string,
  tariffs: Map<string, { tariff: Tariff; helpers: TariffHelpers }>
): PeriodBill {
  const period: PeriodBill = {
    label,
    startDate: bills[0]?.date ?? '',
    endDate: bills[bills.length - 1]?.date ?? '',
    days: bills.length,
    gridImport: 0,
    gridExport: 0,
    pvGeneration: 0,
    load: 0,
    importByTOU: emptyTOUBreakdown(),
    exportByTOU: emptyTOUBreakdown(),
    tariffCosts: new Map(),
  };

  for (const bill of bills) {
    period.gridImport += bill.gridImport;
    period.gridExport += bill.gridExport;
    period.pvGeneration += bill.pvGeneration;
    period.load += bill.load;
    addTOU(period.importByTOU, bill.importByTOU);
    addTOU(period.exportByTOU, bill.exportByTOU);
  }

  // Calculate costs for each tariff
  for (const [name, { helpers }] of tariffs) {
    const cost = calculateTariffCost(
      period.importByTOU,
      period.exportByTOU,
      period.gridImport,
      period.gridExport,
      helpers
    );
    period.tariffCosts.set(name, cost);
  }

  return period;
}

function calculateBillSummary(
  dayBills: DayBill[],
  tariffs: Map<string, { tariff: Tariff; helpers: TariffHelpers }>
): BillSummary {
  // Group by week
  const weeklyGroups = new Map<string, DayBill[]>();
  for (const bill of dayBills) {
    const key = `${bill.year}-W${bill.week.toString().padStart(2, '0')}`;
    if (!weeklyGroups.has(key)) weeklyGroups.set(key, []);
    weeklyGroups.get(key)!.push(bill);
  }

  // Group by month
  const monthlyGroups = new Map<string, DayBill[]>();
  for (const bill of dayBills) {
    const key = `${bill.year}-${bill.month.toString().padStart(2, '0')}`;
    if (!monthlyGroups.has(key)) monthlyGroups.set(key, []);
    monthlyGroups.get(key)!.push(bill);
  }

  // Group by quarter
  const quarterlyGroups = new Map<string, DayBill[]>();
  for (const bill of dayBills) {
    const key = `${bill.year}-Q${bill.quarter}`;
    if (!quarterlyGroups.has(key)) quarterlyGroups.set(key, []);
    quarterlyGroups.get(key)!.push(bill);
  }

  // Group by year
  const yearlyGroups = new Map<string, DayBill[]>();
  for (const bill of dayBills) {
    const key = bill.year.toString();
    if (!yearlyGroups.has(key)) yearlyGroups.set(key, []);
    yearlyGroups.get(key)!.push(bill);
  }

  const sortedKeys = (groups: Map<string, DayBill[]>) =>
    Array.from(groups.keys()).sort();

  return {
    weekly: sortedKeys(weeklyGroups).map(k => aggregatePeriod(weeklyGroups.get(k)!, k, tariffs)),
    monthly: sortedKeys(monthlyGroups).map(k => aggregatePeriod(monthlyGroups.get(k)!, k, tariffs)),
    quarterly: sortedKeys(quarterlyGroups).map(k => aggregatePeriod(quarterlyGroups.get(k)!, k, tariffs)),
    yearly: sortedKeys(yearlyGroups).map(k => aggregatePeriod(yearlyGroups.get(k)!, k, tariffs)),
    overall: aggregatePeriod(dayBills, 'TOTAL', tariffs),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// DISPLAY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

function fmtMoney(n: number): string {
  return '$' + n.toFixed(2);
}

function pad(str: string, len: number): string {
  return str.padStart(len);
}

function printPeriodTable(
  title: string,
  periods: PeriodBill[],
  tariffNames: string[],
  showEnergy: boolean = true
): void {
  console.log(`\n${title}`);
  console.log('='.repeat(120));

  // Build header
  let header = 'Period'.padEnd(14) + 'Days'.padStart(5);
  if (showEnergy) {
    header += 'Import'.padStart(10) + 'Export'.padStart(10) + 'PV'.padStart(10);
  }
  for (const name of tariffNames) {
    const shortName = name.length > 18 ? name.slice(0, 15) + '...' : name;
    header += shortName.padStart(20);
  }
  if (tariffNames.length > 1) {
    header += 'Diff'.padStart(12);
  }
  console.log(header);
  console.log('-'.repeat(120));

  for (const period of periods) {
    let row = period.label.padEnd(14) + pad(period.days.toString(), 5);

    if (showEnergy) {
      row += pad(fmt(period.gridImport, 0) + 'kWh', 10);
      row += pad(fmt(period.gridExport, 0) + 'kWh', 10);
      row += pad(fmt(period.pvGeneration, 0) + 'kWh', 10);
    }

    const costs: number[] = [];
    for (const name of tariffNames) {
      const cost = period.tariffCosts.get(name);
      if (cost) {
        row += pad(fmtMoney(cost.netCost), 20);
        costs.push(cost.netCost);
      } else {
        row += pad('--', 20);
      }
    }

    // Show difference if comparing tariffs
    if (tariffNames.length > 1 && costs.length >= 2) {
      const diff = costs[1]! - costs[0]!;
      const diffStr = diff >= 0 ? '+' + fmtMoney(diff) : fmtMoney(diff);
      row += pad(diffStr, 12);
    }

    console.log(row);
  }
  console.log('-'.repeat(120));
}

function printComparisonSummary(
  summary: BillSummary,
  tariffNames: string[]
): void {
  if (tariffNames.length < 2) return;

  console.log('\n' + '='.repeat(80));
  console.log('TARIFF COMPARISON SUMMARY');
  console.log('='.repeat(80));

  const t1 = tariffNames[0]!;
  const t2 = tariffNames[1]!;
  const c1 = summary.overall.tariffCosts.get(t1)!;
  const c2 = summary.overall.tariffCosts.get(t2)!;

  console.log(`\nComparing: ${t1} vs ${t2}`);
  console.log('-'.repeat(80));

  console.log(`\n  ${t1}:`);
  console.log(`    Import cost:      ${fmtMoney(c1.importCost)}`);
  console.log(`    Feed-in credit:   ${fmtMoney(c1.feedInCredit)}`);
  if (c1.exportCharge > 0) {
    console.log(`    Export charge:    ${fmtMoney(c1.exportCharge)}`);
  }
  console.log(`    Net feed-in:      ${fmtMoney(c1.feedInRevenue)}`);
  console.log(`    Net cost:         ${fmtMoney(c1.netCost)}`);
  console.log(`    Avg import rate:  ${fmtMoney(c1.avgRate)}/kWh`);

  console.log(`\n  ${t2}:`);
  console.log(`    Import cost:      ${fmtMoney(c2.importCost)}`);
  console.log(`    Feed-in credit:   ${fmtMoney(c2.feedInCredit)}`);
  if (c2.exportCharge > 0) {
    console.log(`    Export charge:    ${fmtMoney(c2.exportCharge)}`);
  }
  console.log(`    Net feed-in:      ${fmtMoney(c2.feedInRevenue)}`);
  console.log(`    Net cost:         ${fmtMoney(c2.netCost)}`);
  console.log(`    Avg import rate:  ${fmtMoney(c2.avgRate)}/kWh`);

  const netDiff = c2.netCost - c1.netCost;
  const winner = netDiff > 0 ? t1 : t2;
  const savings = Math.abs(netDiff);
  const days = summary.overall.days;
  const annualSavings = (savings / days) * 365;

  console.log(`\n  RESULT:`);
  if (Math.abs(netDiff) < 1) {
    console.log(`    Tariffs are nearly identical (difference: ${fmtMoney(Math.abs(netDiff))})`);
  } else {
    console.log(`    Winner: ${winner}`);
    console.log(`    Total savings: ${fmtMoney(savings)} over ${days} days`);
    console.log(`    Projected annual savings: ${fmtMoney(annualSavings)}/year`);
  }

  // Monthly comparison
  console.log('\n  Monthly breakdown:');
  console.log('  ' + '-'.repeat(60));
  console.log('  ' + 'Month'.padEnd(12) + t1.slice(0, 15).padStart(18) + t2.slice(0, 15).padStart(18) + 'Diff'.padStart(12));
  console.log('  ' + '-'.repeat(60));

  for (const month of summary.monthly) {
    const mc1 = month.tariffCosts.get(t1);
    const mc2 = month.tariffCosts.get(t2);
    if (mc1 && mc2) {
      const diff = mc2.netCost - mc1.netCost;
      const diffStr = diff >= 0 ? '+' + fmtMoney(diff) : fmtMoney(diff);
      console.log(
        '  ' +
        month.label.padEnd(12) +
        fmtMoney(mc1.netCost).padStart(18) +
        fmtMoney(mc2.netCost).padStart(18) +
        diffStr.padStart(12)
      );
    }
  }
}

function printTariffDetails(tariffs: Map<string, { tariff: Tariff; helpers: TariffHelpers }>): void {
  console.log('\nTARIFF DETAILS');
  console.log('='.repeat(80));

  for (const [name, { tariff, helpers }] of tariffs) {
    console.log(`\n  ${name}:`);
    console.log('  ' + '-'.repeat(40));

    // Show rates sorted by price
    const periods = helpers.getPeriodsByRate();
    for (const p of periods) {
      console.log(`    ${p.name.padEnd(12)} ${fmtMoney(p.rate)}/kWh`);
    }

    // Feed-in
    if (helpers.hasTOUFeedIn()) {
      console.log('    Feed-in (TOU):');
      for (const p of helpers.getFeedInPeriodsByRate()) {
        console.log(`      ${p.name.padEnd(10)} ${fmtMoney(p.rate)}/kWh`);
      }
    } else {
      console.log(`    Feed-in:     ${fmtMoney(tariff.feedInTariff)}/kWh`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

function main(): void {
  console.log('='.repeat(80));
  console.log('POWER BILL CALCULATOR');
  console.log('='.repeat(80));

  // Load data and tariffs
  const system = loadSystemData();
  const tariffs = loadTariffs();
  const tariffNames = Array.from(tariffs.keys());

  // Use first tariff as primary for TOU bucketing
  const primaryHelpers = tariffs.values().next().value!.helpers;

  // Calculate day bills
  const dayBills = calculateDayBills(system, primaryHelpers);
  if (dayBills.length === 0) {
    console.error('No billing data available');
    process.exit(1);
  }

  console.log(`\nAnalyzing ${dayBills.length} days of data...`);
  console.log(`Date range: ${dayBills[0]!.date} to ${dayBills[dayBills.length - 1]!.date}`);

  // Show tariff details
  printTariffDetails(tariffs);

  // Calculate summary
  const summary = calculateBillSummary(dayBills, tariffs);

  // Print tables
  printPeriodTable('MONTHLY BILLS', summary.monthly, tariffNames);
  printPeriodTable('QUARTERLY BILLS', summary.quarterly, tariffNames);
  printPeriodTable('YEARLY BILLS', summary.yearly, tariffNames);

  // Overall summary
  console.log('\nOVERALL SUMMARY');
  console.log('='.repeat(80));
  console.log(`  Period: ${summary.overall.startDate} to ${summary.overall.endDate} (${summary.overall.days} days)`);
  console.log(`  Total import: ${fmt(summary.overall.gridImport, 0)} kWh`);
  console.log(`  Total export: ${fmt(summary.overall.gridExport, 0)} kWh`);
  console.log(`  Total PV generation: ${fmt(summary.overall.pvGeneration, 0)} kWh`);

  for (const name of tariffNames) {
    const cost = summary.overall.tariffCosts.get(name);
    if (cost) {
      console.log(`\n  ${name}:`);
      console.log(`    Total import cost:  ${fmtMoney(cost.importCost)}`);
      console.log(`    Feed-in credit:     ${fmtMoney(cost.feedInCredit)}`);
      if (cost.exportCharge > 0) {
        console.log(`    Export charge:      ${fmtMoney(cost.exportCharge)}`);
      }
      console.log(`    Net feed-in:        ${fmtMoney(cost.feedInRevenue)}`);
      console.log(`    Total net cost:     ${fmtMoney(cost.netCost)}`);
      console.log(`    Avg daily cost:     ${fmtMoney(cost.netCost / summary.overall.days)}/day`);
      console.log(`    Projected annual:   ${fmtMoney((cost.netCost / summary.overall.days) * 365)}/year`);
    }
  }

  // Print comparison if multiple tariffs
  if (tariffNames.length > 1) {
    printComparisonSummary(summary, tariffNames);
  }

  // Weekly view if requested or data is short
  if (dayBills.length <= 90 || args.includes('--weekly')) {
    printPeriodTable('WEEKLY BILLS', summary.weekly, tariffNames, false);
  }
}

main();
