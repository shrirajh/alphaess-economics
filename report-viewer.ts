// Battery Economics Report Viewer
// Renders analysis JSON as an interactive, printable HTML report with Vega-Lite charts

declare const vegaEmbed: (el: string | HTMLElement, spec: object, opts?: object) => Promise<unknown>;

// ═══════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS (matching analyze-battery-economics.ts output)
// ═══════════════════════════════════════════════════════════════════════════

interface TOUBreakdown {
  peak?: number;
  shoulder?: number;
  offpeak?: number;
  [key: string]: number | undefined;
}

interface BatteryBehavior {
  chargeFromSolar: number;
  chargeFromGrid: number;
  chargeFromGridByTOU: TOUBreakdown;
  dischargeToPeak: number;
  dischargeToShoulder: number;
  dischargeToOffpeak: number;
  maxSoC: number;
  minSoC: number;
  cycleDepth: number;
  solarCapturable: number;
  gridChargeable: number;
  peakOffsetable: number;
  reachedFullSoC: boolean;
  hourReachedFull: number;
  exportAfterFull: number;
}

interface DailyEntry {
  date: string;
  year: number;
  month: number;
  season: string;
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
  earlyMorningLoad: number;
  battery: BatteryBehavior;
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
  exportByFeedInPeriod: TOUBreakdown;
  batteryDischargeTOU: TOUBreakdown;
  gridChargeTOU: TOUBreakdown;
  chargeFromSolar: number;
  chargeFromGrid: number;
  earlyMorningLoad: number;
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

interface BatteryEfficiencyPeriod {
  period: string;
  charge: number;
  discharge: number;
  efficiency: number;
  cycleCount: number;
}

interface SolarDegradationPeriod {
  season: string;
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

interface SavingsComparison {
  actual: { totalImportCost: number; totalFeedInRevenue: number; totalNetCost: number };
  solarOnly: { totalImportCost: number; totalFeedInRevenue: number; totalNetCost: number };
  noSolar: { totalImportCost: number; totalNetCost: number };
  optimal: { totalImportCost: number; totalFeedInRevenue: number; totalNetCost: number };
  savingsFromBattery: number;
  savingsFromSolar: number;
  totalSavings: number;
  solarArbitrageValue: number;
  gridArbitrageValue: number;
  optimalGap: number;
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
  solarArbitrageValue: number;
  gridArbitrageValue: number;
}

interface OptimizationIssue {
  severity: 'high' | 'medium' | 'low';
  category: 'config' | 'hardware';
  issue: string;
  impact: string;
  annualValue: number;
  howToFix: string[];
}

interface CarbonImpact {
  gridCarbonDaytime: number;
  gridCarbonNight: number;
  gridCarbonPeak: number;
  avgExport: number;
  avgGridCharge: number;
  avgSolarCharge: number;
  avgPeakImport: number;
  avgOffpeakImport: number;
  carbonSavedByExport: number;
  carbonFromPeakImport: number;
  carbonFromOffpeakImport: number;
  carbonFromGridCharge: number;
  totalCarbonImport: number;
  batteryCleanPercent: number;
  netCarbonDaily: number;
  netCarbonAnnual: number;
}

interface TariffPeriod {
  name: string;
  hours: number[];
  rate: number;
}

interface Tariff {
  name: string;
  provider?: string;
  state?: string;
  feedInTariff: number;
  dailySupplyCharge?: number;
  periods: { [key: string]: TariffPeriod[] };
  dayTypes: { [key: string]: string };
  feedInPeriods?: { [key: string]: TariffPeriod[] };
}

interface DischargeConfig {
  ctrDis?: number;
  batUseCap?: number;
  timeDisf1?: string;
  timeDise1?: string;
  timeDisf2?: string;
  timeDise2?: string;
}

interface ChargeConfig {
  gridCharge?: number;
  batHighCap?: number;
  timeChaf1?: string;
  timeChae1?: string;
  timeChaf2?: string;
  timeChae2?: string;
}

interface Report {
  generatedAt: string;
  sysSn: string;
  currentBatteryKwh: number;
  configuredReservePercent: number;
  hasPowerData: boolean;
  tariff: Tariff;
  calculatedParameters: {
    efficiency: number;
    usableCapacityPercent: number;
    maxChargeRateKw: number;
    solarChargingHours: number;
    estimatedLifespanYears: number;
    lifespanConfidence: string;
    observedMinSoC: number;
    observedMaxSoC: number;
    warnings: string[];
  };
  assumptions: { batteryCost: number; batterySize: number };
  dateRange: { start: string; end: string };
  overall: PeriodAnalysis;
  byYear: { [key: string]: PeriodAnalysis };
  bySeason: { [key: string]: PeriodAnalysis };
  byYearSeason: { [key: string]: PeriodAnalysis };
  daily: DailyEntry[];
  batteryEfficiency: BatteryEfficiencyPeriod[];
  solarDegradation: SolarDegradation;
  savings: SavingsComparison;
  scenarios: Scenario[];
  optimizationIssues: OptimizationIssue[];
  currentConfig: { discharge: DischargeConfig | null; charge: ChargeConfig | null };
  recommendedConfig: { discharge: DischargeConfig | null; charge: ChargeConfig | null };
  touAnalysis: {
    importPercentages: TOUBreakdown | null;
    exportPercentages: TOUBreakdown | null;
    importCostCalculated: number | null;
    importCostEstimated: number;
    exportByFeedInPeriod: TOUBreakdown | null;
  };
  carbonImpact: CarbonImpact;
  investmentStatus: {
    panelSunkCost: number;
    batterySunkCost: number;
    solarSavingsTotal: number;
    solarSavingsAnnual: number;
    solarPaybackYears: number | null;
    solarRecovered: number | null;
    batterySavingsTotal: number;
    batterySavingsAnnual: number;
    batteryPaybackYears: number | null;
    batteryRecovered: number | null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function fmt(n: number | undefined | null, decimals = 1): string {
  if (n === undefined || n === null || isNaN(n)) return '--';
  return n.toFixed(decimals);
}

function fmtCurrency(n: number | undefined | null): string {
  if (n === undefined || n === null || isNaN(n)) return '--';
  return '$' + n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtPct(n: number | undefined | null): string {
  if (n === undefined || n === null || isNaN(n)) return '--';
  return n.toFixed(1) + '%';
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function touTotal(tou: TOUBreakdown): number {
  return (tou.peak ?? 0) + (tou.shoulder ?? 0) + (tou.offpeak ?? 0);
}

function getTariffRates(tariff: Tariff): { name: string; rate: number }[] {
  const rates: { name: string; rate: number }[] = [];
  const periods = tariff.periods?.everyday ?? tariff.periods?.weekday ?? [];
  for (const p of periods) {
    if (!rates.find(r => r.name === p.name)) {
      rates.push({ name: p.name, rate: p.rate });
    }
  }
  return rates.sort((a, b) => b.rate - a.rate);
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION RENDERERS
// ═══════════════════════════════════════════════════════════════════════════

function renderHeader(report: Report): string {
  const date = new Date(report.generatedAt).toLocaleDateString('en-AU', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  return `
    <div class="report-header">
      <h1>Battery Economics Analysis Report</h1>
      <div class="meta">
        <div class="meta-row">
          <span class="meta-label">Tariff:</span>
          <span class="meta-value">${escapeHtml(report.tariff.name)}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">System:</span>
          <span class="meta-value">${escapeHtml(report.sysSn)}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Battery:</span>
          <span class="meta-value">${report.currentBatteryKwh} kWh (${report.configuredReservePercent}% reserve)</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Data Range:</span>
          <span class="meta-value">${report.dateRange.start} to ${report.dateRange.end} (${report.overall.days} days)</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Generated:</span>
          <span class="meta-value">${date}</span>
        </div>
      </div>
    </div>
  `;
}

function renderTariffSection(report: Report): string {
  const rates = getTariffRates(report.tariff);
  let ratesHtml = rates.map(r =>
    `<tr><td>${r.name.charAt(0).toUpperCase() + r.name.slice(1)}</td><td class="numeric">$${r.rate.toFixed(4)}/kWh</td></tr>`
  ).join('');

  // Feed-in rates
  let feedInHtml = '';
  const feedInPeriods = report.tariff.feedInPeriods;
  if (feedInPeriods && Object.keys(feedInPeriods).length > 0) {
    feedInHtml = '<tr><td colspan="2" class="section-subhead">Feed-in Tariff (TOU)</td></tr>';
    for (const dayType of Object.keys(feedInPeriods)) {
      for (const p of feedInPeriods[dayType]) {
        feedInHtml += `<tr><td>&nbsp;&nbsp;${p.name}</td><td class="numeric">$${p.rate.toFixed(4)}/kWh</td></tr>`;
      }
    }
  } else {
    feedInHtml = `<tr><td>Feed-in Tariff</td><td class="numeric">$${report.tariff.feedInTariff.toFixed(4)}/kWh</td></tr>`;
  }

  // Day types
  const dayTypes = Object.entries(report.tariff.dayTypes || {})
    .map(([name, pattern]) => `<tr><td>${name}</td><td>${pattern}</td></tr>`)
    .join('');

  return `
    <section>
      <h2>Tariff Information</h2>
      <p>All calculations in this report use the rates and time-of-use periods defined in your tariff configuration.</p>
      <div class="two-col">
        <div>
          <h3>Energy Rates</h3>
          <table class="compact">
            ${ratesHtml}
            ${feedInHtml}
            ${report.tariff.dailySupplyCharge ? `<tr><td>Daily Supply Charge</td><td class="numeric">$${report.tariff.dailySupplyCharge.toFixed(2)}/day</td></tr>` : ''}
          </table>
        </div>
        <div>
          <h3>Day Types</h3>
          <table class="compact">
            ${dayTypes || '<tr><td colspan="2">Standard everyday rates</td></tr>'}
          </table>
        </div>
      </div>
    </section>
  `;
}

function renderSummaryCards(report: Report): string {
  const years = report.overall.days / 365;
  const selfConsumption = (1 - report.overall.gridExport / (report.overall.pvGeneration || 1)) * 100;
  const c = report.carbonImpact;

  return `
    <section>
      <h2>Key Metrics Summary</h2>
      <div class="summary-cards">
        <div class="summary-card">
          <div class="value">${fmt(report.overall.avgDaily.pvGeneration, 1)}</div>
          <div class="label">Avg PV Generation<br>(kWh/day)</div>
        </div>
        <div class="summary-card">
          <div class="value">${fmt(report.overall.avgDaily.gridImport, 1)}</div>
          <div class="label">Avg Grid Import<br>(kWh/day)</div>
        </div>
        <div class="summary-card">
          <div class="value">${fmt(report.overall.avgDaily.gridExport, 1)}</div>
          <div class="label">Avg Grid Export<br>(kWh/day)</div>
        </div>
        <div class="summary-card">
          <div class="value">${fmt(selfConsumption, 0)}%</div>
          <div class="label">Self-Consumption<br>Rate</div>
        </div>
        <div class="summary-card ${report.savings.savingsFromBattery > 0 ? 'positive' : ''}">
          <div class="value">${fmtCurrency(report.savings.savingsFromBattery / years)}</div>
          <div class="label">Battery Savings<br>($/year)</div>
        </div>
        <div class="summary-card">
          <div class="value">${fmt(report.calculatedParameters.efficiency * 100, 0)}%</div>
          <div class="label">Battery Round-trip<br>Efficiency</div>
        </div>
        <div class="summary-card ${c.netCarbonAnnual < 0 ? 'positive' : 'negative'}">
          <div class="value">${c.netCarbonAnnual < 0 ? '-' : '+'}${fmt(Math.abs(c.netCarbonAnnual), 0)}</div>
          <div class="label">Net Carbon<br>(kg CO2/year)</div>
        </div>
        <div class="summary-card">
          <div class="value">${fmtCurrency(report.overall.costs.dailyNetCost * 365)}</div>
          <div class="label">Annual Net<br>Electricity Cost</div>
        </div>
      </div>
    </section>
  `;
}

function renderParametersSection(report: Report): string {
  const p = report.calculatedParameters;
  const years = report.overall.days / 365;

  let warningsHtml = '';
  if (p.warnings && p.warnings.length > 0) {
    warningsHtml = `
      <div class="note warning">
        <strong>Notes:</strong>
        <ul>${p.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
      </div>
    `;
  }

  return `
    <section>
      <h2>System Parameters</h2>
      <p>These parameters are calculated from your actual historical data, not manufacturer specifications. They reflect real-world performance of your system.</p>

      <table>
        <thead>
          <tr><th>Parameter</th><th>Value</th><th>Explanation</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Battery Capacity</td>
            <td class="numeric">${report.currentBatteryKwh} kWh</td>
            <td>Nominal battery capacity from system configuration</td>
          </tr>
          <tr>
            <td>Reserve Setting</td>
            <td class="numeric">${report.configuredReservePercent}%</td>
            <td>Configured minimum state of charge (for backup power)</td>
          </tr>
          <tr>
            <td>Round-trip Efficiency</td>
            <td class="numeric">${fmt(p.efficiency * 100, 1)}%</td>
            <td>Energy out vs energy in, calculated from ${report.overall.days} days of charge/discharge data</td>
          </tr>
          <tr>
            <td>Usable Capacity</td>
            <td class="numeric">${fmt(p.usableCapacityPercent * 100, 0)}%</td>
            <td>Observed SoC range: ${fmt(p.observedMinSoC, 0)}% - ${fmt(p.observedMaxSoC, 0)}% (actual usage pattern)</td>
          </tr>
          <tr>
            <td>Max Charge Rate</td>
            <td class="numeric">${fmt(p.maxChargeRateKw, 1)} kW</td>
            <td>Estimated from solar charging speed on high-generation days</td>
          </tr>
          <tr>
            <td>Solar Charging Window</td>
            <td class="numeric">${p.solarChargingHours} hours</td>
            <td>Non-peak daylight hours available for solar charging</td>
          </tr>
          <tr>
            <td>Estimated Lifespan</td>
            <td class="numeric">${fmt(p.estimatedLifespanYears, 1)} years</td>
            <td>${p.lifespanConfidence} confidence (based on ${fmt(years, 1)} years of degradation data)</td>
          </tr>
        </tbody>
      </table>
      ${warningsHtml}
    </section>
  `;
}

function renderLifetimeTotals(report: Report): string {
  const o = report.overall;
  const selfConsumption = (1 - o.gridExport / (o.pvGeneration || 1)) * 100;

  return `
    <section>
      <h2>Lifetime Totals</h2>
      <p>Cumulative energy flows over the ${o.days} days of data (${fmt(o.days / 365, 1)} years).</p>

      <div class="two-col">
        <div>
          <table class="compact">
            <tr><td>Total PV Generation</td><td class="numeric">${fmt(o.pvGeneration, 0)} kWh</td></tr>
            <tr><td>Total Grid Import</td><td class="numeric">${fmt(o.gridImport, 0)} kWh</td></tr>
            <tr><td>Total Grid Export</td><td class="numeric">${fmt(o.gridExport, 0)} kWh</td></tr>
          </table>
        </div>
        <div>
          <table class="compact">
            <tr><td>Total Battery Charged</td><td class="numeric">${fmt(o.batteryCharge, 0)} kWh</td></tr>
            <tr><td>Total Battery Discharged</td><td class="numeric">${fmt(o.batteryDischarge, 0)} kWh</td></tr>
            <tr><td>Self-Consumption Rate</td><td class="numeric">${fmt(selfConsumption, 1)}%</td></tr>
          </table>
        </div>
      </div>
    </section>
  `;
}

function renderYearlyTable(report: Report): string {
  const years = Object.entries(report.byYear).sort(([a], [b]) => parseInt(a) - parseInt(b));
  if (years.length === 0) return '';

  let rows = years.map(([year, p]) => `
    <tr>
      <td>${year}</td>
      <td class="numeric">${p.days}</td>
      <td class="numeric">${fmt(p.avgDaily.pvGeneration)}</td>
      <td class="numeric">${fmt(p.avgDaily.gridExport)}</td>
      <td class="numeric">${fmt(p.avgDaily.gridImport)}</td>
      <td class="numeric">${fmt(p.avgDaily.load)}</td>
      <td class="numeric">${fmt(p.avgDaily.batteryCharge)}</td>
      <td class="numeric">${fmtCurrency(p.costs.dailyNetCost)}</td>
      <td class="numeric">${fmtCurrency(p.costs.dailyNetCost * 365)}</td>
    </tr>
  `).join('');

  return `
    <section>
      <h2>Yearly Breakdown</h2>
      <p>Average daily values for each year of data. Net cost includes grid import minus feed-in revenue.</p>

      <table>
        <thead>
          <tr>
            <th>Year</th>
            <th>Days</th>
            <th>PV Gen</th>
            <th>Export</th>
            <th>Import</th>
            <th>Load</th>
            <th>Batt Chg</th>
            <th>Net $/day</th>
            <th>Net $/yr</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}

function renderSeasonalSection(report: Report): string {
  const seasons = ['summer', 'autumn', 'winter', 'spring'];
  let rows = seasons.map(s => {
    const data = report.bySeason[s];
    if (!data || data.days === 0) return '';
    return `
      <tr>
        <td class="season-${s}">${s.charAt(0).toUpperCase() + s.slice(1)}</td>
        <td class="numeric">${data.days}</td>
        <td class="numeric">${fmt(data.avgDaily.pvGeneration)}</td>
        <td class="numeric">${fmt(data.avgDaily.gridExport)}</td>
        <td class="numeric">${fmt(data.avgDaily.gridImport)}</td>
        <td class="numeric">${fmt(data.avgDaily.load)}</td>
        <td class="numeric">${fmtCurrency(data.costs.dailyNetCost)}</td>
        <td class="numeric">${fmtCurrency(data.costs.dailyNetCost * 365)}</td>
      </tr>
    `;
  }).join('');

  return `
    <section>
      <h2>Seasonal Patterns</h2>
      <p>Average daily values by season. Summer has highest solar generation; winter typically has highest grid import.</p>

      <table>
        <thead>
          <tr>
            <th>Season</th>
            <th>Days</th>
            <th>PV Gen</th>
            <th>Export</th>
            <th>Import</th>
            <th>Load</th>
            <th>Net $/day</th>
            <th>Annualized</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      <div class="chart-container" id="chart-seasonal"></div>
    </section>
  `;
}

function renderYearOverYearComparison(report: Report): string {
  const years = [...new Set(Object.keys(report.byYearSeason).map(k => k.split('-')[0]))].sort();
  if (years.length < 2) {
    return `
      <section>
        <h2>Year-over-Year Comparison</h2>
        <p class="note">Need at least 2 years of data for year-over-year comparison.</p>
      </section>
    `;
  }

  const seasons = ['summer', 'autumn', 'winter', 'spring'];
  let headerCells = years.map(y => `<th colspan="3">${y}</th>`).join('');
  let subHeaderCells = years.map(() => '<th>PV</th><th>Export</th><th>Import</th>').join('');

  let rows = seasons.map(season => {
    let cells = years.map(year => {
      const key = `${year}-${season}`;
      const data = report.byYearSeason[key];
      if (!data || data.days === 0) {
        return '<td>--</td><td>--</td><td>--</td>';
      }
      return `
        <td class="numeric">${fmt(data.avgDaily.pvGeneration)}</td>
        <td class="numeric">${fmt(data.avgDaily.gridExport)}</td>
        <td class="numeric">${fmt(data.avgDaily.gridImport)}</td>
      `;
    }).join('');
    return `<tr><td class="season-${season}">${season.charAt(0).toUpperCase() + season.slice(1)}</td>${cells}</tr>`;
  }).join('');

  return `
    <section>
      <h2>Year-over-Year Seasonal Comparison</h2>
      <p>Compare the same seasons across different years to identify trends and degradation.</p>

      <table class="yoy-table">
        <thead>
          <tr><th>Season</th>${headerCells}</tr>
          <tr><th></th>${subHeaderCells}</tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}

function renderTOUSection(report: Report): string {
  if (!report.hasPowerData) {
    return `
      <section>
        <h2>Time-of-Use Analysis</h2>
        <div class="note warning">
          <strong>No power data available.</strong> TOU breakdown requires timestamped power readings.
          Using estimated distribution: Peak 70%, Shoulder 5%, Off-peak 25%.
        </div>
      </section>
    `;
  }

  const imp = report.touAnalysis.importPercentages;
  const exp = report.touAnalysis.exportPercentages;
  const o = report.overall;
  const impTotal = touTotal(o.importByTOU);
  const expTotal = touTotal(o.exportByTOU);

  const costCalc = report.touAnalysis.importCostCalculated ?? 0;
  const costEst = report.touAnalysis.importCostEstimated;
  const costDiff = costCalc - costEst;
  const costDiffPct = costEst > 0 ? (costDiff / costEst * 100) : 0;

  return `
    <section>
      <h2>Time-of-Use Analysis</h2>
      <p>Breakdown of energy flows by time-of-use period, calculated from actual timestamped power readings.</p>

      <div class="two-col">
        <div>
          <h3>Grid Import by TOU Period</h3>
          <table>
            <thead><tr><th>Period</th><th>%</th><th>kWh</th><th>Cost</th></tr></thead>
            <tbody>
              <tr class="peak-row">
                <td>Peak</td>
                <td class="numeric">${fmt(imp?.peak ?? 0, 1)}%</td>
                <td class="numeric">${fmt(o.importByTOU.peak ?? 0, 0)}</td>
                <td class="numeric">${fmtCurrency((o.importByTOU.peak ?? 0) * (getTariffRates(report.tariff).find(r => r.name === 'peak')?.rate ?? 0))}</td>
              </tr>
              <tr class="shoulder-row">
                <td>Shoulder</td>
                <td class="numeric">${fmt(imp?.shoulder ?? 0, 1)}%</td>
                <td class="numeric">${fmt(o.importByTOU.shoulder ?? 0, 0)}</td>
                <td class="numeric">${fmtCurrency((o.importByTOU.shoulder ?? 0) * (getTariffRates(report.tariff).find(r => r.name === 'shoulder')?.rate ?? 0))}</td>
              </tr>
              <tr class="offpeak-row">
                <td>Off-peak</td>
                <td class="numeric">${fmt(imp?.offpeak ?? 0, 1)}%</td>
                <td class="numeric">${fmt(o.importByTOU.offpeak ?? 0, 0)}</td>
                <td class="numeric">${fmtCurrency((o.importByTOU.offpeak ?? 0) * (getTariffRates(report.tariff).find(r => r.name === 'offpeak')?.rate ?? 0))}</td>
              </tr>
              <tr class="total-row">
                <td><strong>Total</strong></td>
                <td class="numeric"><strong>100%</strong></td>
                <td class="numeric"><strong>${fmt(impTotal, 0)}</strong></td>
                <td class="numeric"><strong>${fmtCurrency(costCalc)}</strong></td>
              </tr>
            </tbody>
          </table>
          <div class="chart-container" id="chart-tou-import"></div>
        </div>
        <div>
          <h3>Grid Export by TOU Period</h3>
          <table>
            <thead><tr><th>Period</th><th>%</th><th>kWh</th></tr></thead>
            <tbody>
              <tr class="peak-row">
                <td>Peak</td>
                <td class="numeric">${fmt(exp?.peak ?? 0, 1)}%</td>
                <td class="numeric">${fmt(o.exportByTOU.peak ?? 0, 0)}</td>
              </tr>
              <tr class="shoulder-row">
                <td>Shoulder</td>
                <td class="numeric">${fmt(exp?.shoulder ?? 0, 1)}%</td>
                <td class="numeric">${fmt(o.exportByTOU.shoulder ?? 0, 0)}</td>
              </tr>
              <tr class="offpeak-row">
                <td>Off-peak</td>
                <td class="numeric">${fmt(exp?.offpeak ?? 0, 1)}%</td>
                <td class="numeric">${fmt(o.exportByTOU.offpeak ?? 0, 0)}</td>
              </tr>
              <tr class="total-row">
                <td><strong>Total</strong></td>
                <td class="numeric"><strong>100%</strong></td>
                <td class="numeric"><strong>${fmt(expTotal, 0)}</strong></td>
              </tr>
            </tbody>
          </table>
          <div class="chart-container" id="chart-tou-export"></div>
        </div>
      </div>

      <div class="note">
        <strong>Cost Comparison:</strong><br>
        Actual TOU cost: ${fmtCurrency(costCalc)} vs Estimated (70/5/25 split): ${fmtCurrency(costEst)}<br>
        Difference: ${fmtCurrency(costDiff)} (${costDiff >= 0 ? '+' : ''}${fmt(costDiffPct, 1)}%)
      </div>
    </section>
  `;
}

function renderBatteryUtilizationSection(report: Report): string {
  const o = report.overall;
  const days = o.days || 1;

  // Charging sources
  const solarChargeDaily = o.chargeFromSolar / days;
  const gridChargeOffpeakDaily = (o.gridChargeTOU.offpeak ?? 0) / days;
  const gridChargePeakDaily = (o.gridChargeTOU.peak ?? 0) / days;
  const gridChargeShoulderDaily = (o.gridChargeTOU.shoulder ?? 0) / days;
  const totalChargeDaily = solarChargeDaily + gridChargeOffpeakDaily + gridChargePeakDaily + gridChargeShoulderDaily;

  // Discharge destinations
  const peakDischargeDaily = (o.batteryDischargeTOU.peak ?? 0) / days;
  const shoulderDischargeDaily = (o.batteryDischargeTOU.shoulder ?? 0) / days;
  const offpeakDischargeDaily = (o.batteryDischargeTOU.offpeak ?? 0) / days;
  const totalDischargeDaily = peakDischargeDaily + shoulderDischargeDaily + offpeakDischargeDaily;

  // Percentages
  const peakDischargePct = totalDischargeDaily > 0 ? (peakDischargeDaily / totalDischargeDaily * 100) : 0;
  const shoulderDischargePct = totalDischargeDaily > 0 ? (shoulderDischargeDaily / totalDischargeDaily * 100) : 0;
  const offpeakDischargePct = totalDischargeDaily > 0 ? (offpeakDischargeDaily / totalDischargeDaily * 100) : 0;

  // Value calculation
  const rates = getTariffRates(report.tariff);
  const peakRate = rates.find(r => r.name === 'peak')?.rate ?? 0;
  const offpeakRate = rates.find(r => r.name === 'offpeak')?.rate ?? 0;
  const feedInRate = report.tariff.feedInTariff;

  const totalCharge = o.chargeFromSolar + o.chargeFromGrid;
  const solarFraction = totalCharge > 0 ? o.chargeFromSolar / totalCharge : 1;
  const gridFraction = 1 - solarFraction;

  const peakDischargeTotal = o.batteryDischargeTOU.peak ?? 0;
  const solarArbValue = peakDischargeTotal * solarFraction * (peakRate - feedInRate);
  const gridArbValue = peakDischargeTotal * gridFraction * (peakRate - offpeakRate);
  const totalBatteryValue = solarArbValue + gridArbValue;

  return `
    <section>
      <h2>Battery Utilization Analysis</h2>
      <p>How your battery is being charged and when it discharges. Optimal configuration maximizes peak discharge and minimizes off-peak discharge.</p>

      <div class="two-col">
        <div>
          <h3>Charging Sources</h3>
          <table>
            <thead><tr><th>Source</th><th>kWh/day</th><th>% of Total</th></tr></thead>
            <tbody>
              <tr class="positive-row">
                <td>From Solar</td>
                <td class="numeric">${fmt(solarChargeDaily, 1)}</td>
                <td class="numeric">${fmt(solarChargeDaily / totalChargeDaily * 100, 0)}%</td>
              </tr>
              <tr class="offpeak-row">
                <td>From Grid (off-peak)</td>
                <td class="numeric">${fmt(gridChargeOffpeakDaily, 1)}</td>
                <td class="numeric">${fmt(gridChargeOffpeakDaily / totalChargeDaily * 100, 0)}%</td>
              </tr>
              ${gridChargePeakDaily > 0.01 ? `
              <tr class="warning-row">
                <td>From Grid (peak) ⚠️</td>
                <td class="numeric">${fmt(gridChargePeakDaily, 1)}</td>
                <td class="numeric">${fmt(gridChargePeakDaily / totalChargeDaily * 100, 0)}%</td>
              </tr>
              ` : ''}
            </tbody>
          </table>
        </div>
        <div>
          <h3>Discharge Destinations</h3>
          <table>
            <thead><tr><th>Period</th><th>kWh/day</th><th>% of Total</th></tr></thead>
            <tbody>
              <tr class="peak-row">
                <td>To Peak Periods</td>
                <td class="numeric">${fmt(peakDischargeDaily, 1)}</td>
                <td class="numeric">${fmt(peakDischargePct, 0)}%</td>
              </tr>
              <tr class="shoulder-row">
                <td>To Shoulder Periods</td>
                <td class="numeric">${fmt(shoulderDischargeDaily, 1)}</td>
                <td class="numeric">${fmt(shoulderDischargePct, 0)}%</td>
              </tr>
              ${offpeakDischargeDaily > 0.1 ? `
              <tr class="warning-row">
                <td>To Off-peak ⚠️</td>
                <td class="numeric">${fmt(offpeakDischargeDaily, 1)}</td>
                <td class="numeric">${fmt(offpeakDischargePct, 0)}%</td>
              </tr>
              ` : ''}
            </tbody>
          </table>
        </div>
      </div>

      <div class="chart-container" id="chart-utilization"></div>

      <h3>Value Attribution</h3>
      <p>How the battery creates value through arbitrage (buying low, using high):</p>
      <table>
        <thead><tr><th>Arbitrage Type</th><th>Mechanism</th><th>Annual Value</th></tr></thead>
        <tbody>
          <tr>
            <td>Solar Arbitrage</td>
            <td>Store solar (instead of exporting at $${fmt(feedInRate, 2)}) → discharge at peak ($${fmt(peakRate, 2)})</td>
            <td class="numeric positive">${fmtCurrency(solarArbValue)}/year</td>
          </tr>
          <tr>
            <td>Grid Arbitrage</td>
            <td>Charge from grid at off-peak ($${fmt(offpeakRate, 2)}) → discharge at peak ($${fmt(peakRate, 2)})</td>
            <td class="numeric positive">${fmtCurrency(gridArbValue)}/year</td>
          </tr>
          <tr class="total-row">
            <td><strong>Total Battery Value</strong></td>
            <td></td>
            <td class="numeric positive"><strong>${fmtCurrency(totalBatteryValue)}/year</strong></td>
          </tr>
        </tbody>
      </table>
    </section>
  `;
}

function renderBatteryEfficiencySection(report: Report): string {
  if (report.batteryEfficiency.length === 0) {
    return `
      <section>
        <h2>Battery Efficiency Over Time</h2>
        <div class="note warning">Insufficient battery data to calculate efficiency trends. Need at least 10 charge/discharge cycles per quarter.</div>
      </section>
    `;
  }

  const first = report.batteryEfficiency[0];
  const last = report.batteryEfficiency[report.batteryEfficiency.length - 1];
  const totalCycles = report.batteryEfficiency.reduce((sum, p) => sum + p.cycleCount, 0);

  let rows = report.batteryEfficiency.map((p, i) => {
    const change = i === 0 ? '--' : fmt((p.efficiency - first!.efficiency) / first!.efficiency * 100, 1) + '%';
    return `
      <tr>
        <td>${p.period}</td>
        <td class="numeric">${fmt(p.charge, 0)}</td>
        <td class="numeric">${fmt(p.discharge, 0)}</td>
        <td class="numeric">${fmt(p.efficiency * 100, 1)}%</td>
        <td class="numeric">${fmt(p.cycleCount, 0)}</td>
        <td class="numeric">${change}</td>
      </tr>
    `;
  }).join('');

  let degradation = '';
  if (first && last && report.batteryEfficiency.length > 1) {
    const totalDeg = (first.efficiency - last.efficiency) / first.efficiency * 100;
    if (totalDeg > 0) {
      degradation = `
        <div class="note">
          <strong>Degradation Analysis:</strong><br>
          Initial efficiency: ${fmt(first.efficiency * 100, 1)}% → Current: ${fmt(last.efficiency * 100, 1)}%<br>
          Total degradation: ${fmt(totalDeg, 2)}% over ~${fmt(totalCycles, 0)} cycles<br>
          Rate: ${fmt(totalDeg / totalCycles * 100, 3)}% per 100 cycles
        </div>
      `;
    }
  }

  return `
    <section>
      <h2>Battery Efficiency Over Time</h2>
      <p>Round-trip efficiency (discharge ÷ charge) tracked over time. Some degradation is normal; typical lithium batteries lose 0.5-1% efficiency per year.</p>

      <table>
        <thead>
          <tr><th>Period</th><th>Charged (kWh)</th><th>Discharged (kWh)</th><th>Efficiency</th><th>Cycles</th><th>Change</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      <div class="chart-container" id="chart-efficiency"></div>

      ${degradation}
    </section>
  `;
}

function renderSolarDegradationSection(report: Report): string {
  const sd = report.solarDegradation;

  if (!sd.hasEnoughData) {
    return `
      <section>
        <h2>Solar Panel Degradation</h2>
        <div class="note warning">
          Need at least 2 complete seasons across different years to measure degradation.
          Requires 30+ days per season for accurate comparison.
        </div>
      </section>
    `;
  }

  let rows = sd.periods.map(p => {
    const changeClass = p.change < -1 ? 'negative' : p.change > 1 ? 'positive' : '';
    return `
      <tr>
        <td class="season-${p.season}">${p.season.charAt(0).toUpperCase() + p.season.slice(1)}</td>
        <td class="numeric">${p.year1} → ${p.year2}</td>
        <td class="numeric">${fmt(p.avgPV1, 1)}</td>
        <td class="numeric">${fmt(p.avgPV2, 1)}</td>
        <td class="numeric ${changeClass}">${p.change >= 0 ? '+' : ''}${fmt(p.change, 1)}%</td>
      </tr>
    `;
  }).join('');

  let assessment = '';
  if (sd.annualRate < -0.3 && sd.annualRate > -1.0) {
    assessment = 'Within normal range. Panels typically degrade 0.5-0.8% per year.';
  } else if (sd.annualRate <= -1.0) {
    assessment = '⚠️ Higher than expected degradation. Typical is 0.5-0.8% per year. Consider panel inspection.';
  } else if (sd.annualRate >= 0) {
    assessment = 'No degradation detected. May need more years of data for accurate measurement.';
  }

  return `
    <section>
      <h2>Solar Panel Degradation</h2>
      <p>Comparing the same seasons across years reveals solar panel performance degradation over time.</p>

      <table>
        <thead>
          <tr><th>Season</th><th>Years</th><th>Avg PV Year 1</th><th>Avg PV Year 2</th><th>Change</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      <div class="note">
        <strong>Average Annual Change: ${sd.annualRate >= 0 ? '+' : ''}${fmt(sd.annualRate, 2)}%/year</strong><br>
        ${assessment}
      </div>
    </section>
  `;
}

function renderSavingsSection(report: Report): string {
  const s = report.savings;
  const years = report.overall.days / 365;

  const totalBatteryValue = s.solarArbitrageValue + s.gridArbitrageValue;
  const solarArbPct = totalBatteryValue > 0 ? (s.solarArbitrageValue / totalBatteryValue * 100) : 0;
  const gridArbPct = totalBatteryValue > 0 ? (s.gridArbitrageValue / totalBatteryValue * 100) : 0;

  return `
    <section>
      <h2>Retrospective Savings Analysis</h2>
      <p>Comparison of actual costs vs hypothetical scenarios over ${fmt(years, 1)} years of data.</p>

      <h3>Scenario Comparison</h3>
      <table>
        <thead>
          <tr><th>Scenario</th><th>Grid Cost</th><th>Feed-in Revenue</th><th>Net Cost</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>No Solar (grid only)</td>
            <td class="numeric">${fmtCurrency(s.noSolar.totalImportCost)}</td>
            <td class="numeric">$0</td>
            <td class="numeric">${fmtCurrency(s.noSolar.totalNetCost)}</td>
          </tr>
          <tr>
            <td>Solar Only (no battery)</td>
            <td class="numeric">${fmtCurrency(s.solarOnly.totalImportCost)}</td>
            <td class="numeric">${fmtCurrency(s.solarOnly.totalFeedInRevenue)}</td>
            <td class="numeric">${fmtCurrency(s.solarOnly.totalNetCost)}</td>
          </tr>
          <tr>
            <td>Solar + Battery (actual)</td>
            <td class="numeric">${fmtCurrency(s.actual.totalImportCost)}</td>
            <td class="numeric">${fmtCurrency(s.actual.totalFeedInRevenue)}</td>
            <td class="numeric">${fmtCurrency(s.actual.totalNetCost)}</td>
          </tr>
          <tr class="highlight-row">
            <td>Solar + Battery (optimal control)</td>
            <td class="numeric">${fmtCurrency(s.optimal.totalImportCost)}</td>
            <td class="numeric">${fmtCurrency(s.optimal.totalFeedInRevenue)}</td>
            <td class="numeric">${fmtCurrency(s.optimal.totalNetCost)}</td>
          </tr>
        </tbody>
      </table>

      <div class="chart-container" id="chart-savings"></div>

      <h3>Savings Breakdown</h3>
      <table>
        <thead><tr><th>Source</th><th>Total (${fmt(years, 1)} yr)</th><th>Per Year</th></tr></thead>
        <tbody>
          <tr>
            <td>Solar savings (vs no solar)</td>
            <td class="numeric positive">${fmtCurrency(s.savingsFromSolar)}</td>
            <td class="numeric positive">${fmtCurrency(s.savingsFromSolar / years)}</td>
          </tr>
          <tr>
            <td>Battery savings (vs solar only)</td>
            <td class="numeric positive">${fmtCurrency(s.savingsFromBattery)}</td>
            <td class="numeric positive">${fmtCurrency(s.savingsFromBattery / years)}</td>
          </tr>
          <tr class="total-row">
            <td><strong>Total savings</strong></td>
            <td class="numeric positive"><strong>${fmtCurrency(s.totalSavings)}</strong></td>
            <td class="numeric positive"><strong>${fmtCurrency(s.totalSavings / years)}</strong></td>
          </tr>
        </tbody>
      </table>

      <h3>Battery Value Attribution</h3>
      <table>
        <thead><tr><th>Source</th><th>Total</th><th>Per Year</th><th>% of Value</th></tr></thead>
        <tbody>
          <tr>
            <td>Solar arbitrage (solar→peak)</td>
            <td class="numeric">${fmtCurrency(s.solarArbitrageValue)}</td>
            <td class="numeric">${fmtCurrency(s.solarArbitrageValue / years)}</td>
            <td class="numeric">${fmt(solarArbPct, 0)}%</td>
          </tr>
          <tr>
            <td>Grid arbitrage (offpeak→peak)</td>
            <td class="numeric">${fmtCurrency(s.gridArbitrageValue)}</td>
            <td class="numeric">${fmtCurrency(s.gridArbitrageValue / years)}</td>
            <td class="numeric">${fmt(gridArbPct, 0)}%</td>
          </tr>
          <tr class="total-row">
            <td><strong>Total battery value</strong></td>
            <td class="numeric"><strong>${fmtCurrency(totalBatteryValue)}</strong></td>
            <td class="numeric"><strong>${fmtCurrency(totalBatteryValue / years)}</strong></td>
            <td class="numeric"><strong>100%</strong></td>
          </tr>
        </tbody>
      </table>

      ${s.optimalGap > 0 ? `
      <div class="note">
        <strong>Optimization Opportunity:</strong><br>
        Gap vs optimal control: ${fmtCurrency(s.optimalGap)} total (${fmtCurrency(s.optimalGap / years)}/year)<br>
        Potential improvement: ${fmt(s.optimalGap / s.savingsFromBattery * 100, 0)}% more battery value possible with better configuration.
      </div>
      ` : ''}
    </section>
  `;
}

function renderScenariosSection(report: Report): string {
  const p = report.calculatedParameters;

  let rows = report.scenarios.map(s => {
    if (s.additionalBatteries === 0) {
      return `
        <tr>
          <td>Current (${s.totalBatteryKwh} kWh)</td>
          <td colspan="6" class="numeric">Baseline - no additional value</td>
        </tr>
      `;
    }
    const payback = s.paybackYears === Infinity ? 'N/A' : fmt(s.paybackYears, 1) + ' yr';
    const roiClass = s.roi > 0 ? 'positive' : 'negative';
    return `
      <tr>
        <td>+${s.additionalBatteries} (${s.additionalKwh} kWh)</td>
        <td class="numeric">${fmtCurrency(s.solarArbitrageValue)}</td>
        <td class="numeric">${fmtCurrency(s.gridArbitrageValue)}</td>
        <td class="numeric">${fmtCurrency(s.annualSavings)}</td>
        <td class="numeric">${payback}</td>
        <td class="numeric">${fmtCurrency(s.lifetimeSavings)}</td>
        <td class="numeric ${roiClass}">${fmt(s.roi, 1)}%</td>
      </tr>
    `;
  }).join('');

  // Find best scenario
  const additionalScenarios = report.scenarios.filter(s => s.additionalBatteries > 0);
  const bestScenario = additionalScenarios.reduce<Scenario | null>(
    (best, s) => !best || s.roi > best.roi ? s : best, null
  );

  let recommendation = '';
  if (bestScenario && bestScenario.roi > 0) {
    recommendation = `
      <div class="note positive">
        <strong>Recommendation:</strong> Based on ${report.overall.days} days of data, adding ${bestScenario.additionalBatteries}x ${report.assumptions.batterySize}kWh battery could be worthwhile.
        <ul>
          <li>Estimated payback: ${fmt(bestScenario.paybackYears, 1)} years</li>
          <li>ROI over ${fmt(p.estimatedLifespanYears, 1)} years: ${fmt(bestScenario.roi, 1)}%</li>
        </ul>
      </div>
    `;
  } else {
    recommendation = `
      <div class="note warning">
        <strong>Recommendation:</strong> Additional battery storage may not be economical.
        The payback period exceeds the expected battery lifespan.
      </div>
    `;
  }

  return `
    <section>
      <h2>Battery Investment Scenarios</h2>
      <p>Modeling the value of additional battery capacity based on your actual usage patterns.</p>

      <div class="note">
        <strong>Assumptions:</strong><br>
        Battery cost: ${fmtCurrency(report.assumptions.batteryCost)} per ${report.assumptions.batterySize}kWh |
        Estimated lifespan: ${fmt(p.estimatedLifespanYears, 1)} years (${p.lifespanConfidence} confidence) |
        Efficiency: ${fmt(p.efficiency * 100, 1)}%
      </div>

      <table>
        <thead>
          <tr>
            <th>Scenario</th>
            <th>Solar Arb</th>
            <th>Grid Arb</th>
            <th>Total $/yr</th>
            <th>Payback</th>
            <th>Lifetime $</th>
            <th>ROI</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      <div class="chart-container" id="chart-scenarios"></div>

      ${recommendation}
    </section>
  `;
}

function renderOptimizationSection(report: Report): string {
  if (report.optimizationIssues.length === 0) {
    return `
      <section>
        <h2>Optimization Recommendations</h2>
        <div class="note positive">
          <strong>No significant optimization issues detected.</strong>
          Battery appears well-configured for your tariff and usage patterns.
        </div>
      </section>
    `;
  }

  const configIssues = report.optimizationIssues.filter(i => i.category === 'config');
  const hardwareIssues = report.optimizationIssues.filter(i => i.category === 'hardware');
  const configTotal = configIssues.reduce((sum, i) => sum + i.annualValue, 0);

  let html = '<section><h2>Optimization Recommendations</h2>';

  if (configIssues.length > 0) {
    html += `
      <h3>Configuration Fixes (Free - Settings Changes Only)</h3>
      <p class="positive">Total potential savings from config fixes: <strong>${fmtCurrency(configTotal)}/year</strong></p>
    `;

    for (const issue of configIssues) {
      const severityClass = issue.severity === 'high' ? 'error' : issue.severity === 'medium' ? 'warning' : '';
      html += `
        <div class="issue ${severityClass}">
          <div class="issue-header">
            <span class="issue-severity ${issue.severity}">${issue.severity.toUpperCase()}</span>
            <span class="issue-value">${fmtCurrency(issue.annualValue)}/year potential</span>
          </div>
          <h4>${escapeHtml(issue.issue)}</h4>
          <p><strong>Impact:</strong> ${escapeHtml(issue.impact)}</p>
          <div class="how-to-fix">
            <strong>How to Fix:</strong>
            <pre>${issue.howToFix.map(s => escapeHtml(s)).join('\n')}</pre>
          </div>
        </div>
      `;
    }
  }

  if (hardwareIssues.length > 0) {
    html += '<h3>Hardware Considerations (Requires Purchase)</h3>';

    for (const issue of hardwareIssues) {
      html += `
        <div class="issue">
          <div class="issue-header">
            <span class="issue-severity ${issue.severity}">${issue.severity.toUpperCase()}</span>
            <span class="issue-value">${fmtCurrency(issue.annualValue)}/year modeled</span>
          </div>
          <h4>${escapeHtml(issue.issue)}</h4>
          <p><strong>Observation:</strong> ${escapeHtml(issue.impact)}</p>
          <div class="how-to-fix">
            <strong>Analysis:</strong>
            <pre>${issue.howToFix.map(s => escapeHtml(s)).join('\n')}</pre>
          </div>
        </div>
      `;
    }
  }

  html += '</section>';
  return html;
}

function renderCurrentConfig(report: Report): string {
  const dc = report.currentConfig.discharge;
  const cc = report.currentConfig.charge;
  const rdc = report.recommendedConfig.discharge as DischargeConfig | null;
  const rcc = report.recommendedConfig.charge as ChargeConfig | null;

  if (!dc && !cc) {
    return '';
  }

  return `
    <section>
      <h2>Battery Configuration</h2>

      <div class="two-col">
        <div>
          <h3>Current Settings</h3>
          <table class="compact">
            <tr><td colspan="2" class="section-subhead">Discharge Control</td></tr>
            <tr><td>Time Control</td><td>${dc?.ctrDis === 1 ? 'Enabled' : 'Disabled'}</td></tr>
            <tr><td>Reserve</td><td>${dc?.batUseCap ?? '--'}%</td></tr>
            <tr><td>Period 1</td><td>${dc?.timeDisf1 ?? '--'} - ${dc?.timeDise1 ?? '--'}</td></tr>
            <tr><td>Period 2</td><td>${dc?.timeDisf2 ?? '--'} - ${dc?.timeDise2 ?? '--'}</td></tr>
            <tr><td colspan="2" class="section-subhead">Charge Control</td></tr>
            <tr><td>Grid Charge</td><td>${cc?.gridCharge === 1 ? 'Enabled' : 'Disabled'}</td></tr>
            <tr><td>Max Charge</td><td>${cc?.batHighCap ?? '--'}%</td></tr>
            <tr><td>Period 1</td><td>${cc?.timeChaf1 ?? '--'} - ${cc?.timeChae1 ?? '--'}</td></tr>
          </table>
        </div>
        <div>
          <h3>Recommended Settings</h3>
          <table class="compact">
            <tr><td colspan="2" class="section-subhead">Discharge Control</td></tr>
            <tr><td>Time Control</td><td class="${rdc?.ctrDis !== dc?.ctrDis ? 'highlight' : ''}">${rdc?.ctrDis === 1 ? 'Enabled' : 'Disabled'}</td></tr>
            <tr><td>Reserve</td><td>${rdc?.batUseCap ?? '--'}%</td></tr>
            <tr><td>Period 1</td><td class="highlight">${rdc?.timeDisf1 ?? '--'} - ${rdc?.timeDise1 ?? '--'}</td></tr>
            <tr><td>Period 2</td><td class="highlight">${rdc?.timeDisf2 ?? '--'} - ${rdc?.timeDise2 ?? '--'}</td></tr>
            <tr><td colspan="2" class="section-subhead">Charge Control</td></tr>
            <tr><td>Grid Charge</td><td>${rcc?.gridCharge === 1 ? 'Enabled' : 'Disabled'}</td></tr>
            <tr><td>Max Charge</td><td>${rcc?.batHighCap ?? '--'}%</td></tr>
            <tr><td>Period 1</td><td>${rcc?.timeChaf1 ?? '--'} - ${rcc?.timeChae1 ?? '--'}</td></tr>
          </table>
        </div>
      </div>
    </section>
  `;
}

function renderCarbonSection(report: Report): string {
  const c = report.carbonImpact;
  const isNegative = c.netCarbonAnnual < 0;

  return `
    <section>
      <h2>Carbon Impact Analysis</h2>
      <p>Environmental impact based on Australian grid carbon intensity estimates (AEMO data).</p>

      <div class="summary-cards">
        <div class="summary-card ${isNegative ? 'positive' : 'negative'}">
          <div class="value">${isNegative ? '-' : '+'}${fmt(Math.abs(c.netCarbonAnnual), 0)} kg</div>
          <div class="label">Net CO2/year</div>
        </div>
        <div class="summary-card positive">
          <div class="value">-${fmt(c.carbonSavedByExport * 365, 0)} kg</div>
          <div class="label">Saved by Solar Export</div>
        </div>
        <div class="summary-card">
          <div class="value">${fmt(c.batteryCleanPercent, 0)}%</div>
          <div class="label">Battery from Solar</div>
        </div>
      </div>

      <h3>Carbon Flow Breakdown</h3>
      <table>
        <thead><tr><th>Flow</th><th>kWh/day</th><th>Carbon Intensity</th><th>kg CO2/day</th></tr></thead>
        <tbody>
          <tr class="positive-row">
            <td>Solar export (saves carbon)</td>
            <td class="numeric">${fmt(c.avgExport, 1)}</td>
            <td class="numeric">${c.gridCarbonDaytime} g/kWh (daytime grid)</td>
            <td class="numeric positive">-${fmt(c.carbonSavedByExport, 2)}</td>
          </tr>
          <tr class="negative-row">
            <td>Peak grid import</td>
            <td class="numeric">${fmt(c.avgPeakImport, 1)}</td>
            <td class="numeric">${c.gridCarbonPeak} g/kWh (peak grid)</td>
            <td class="numeric negative">+${fmt(c.carbonFromPeakImport, 2)}</td>
          </tr>
          <tr class="negative-row">
            <td>Off-peak grid import</td>
            <td class="numeric">${fmt(c.avgOffpeakImport, 1)}</td>
            <td class="numeric">${c.gridCarbonNight} g/kWh (night grid)</td>
            <td class="numeric negative">+${fmt(c.carbonFromOffpeakImport, 2)}</td>
          </tr>
          <tr class="negative-row">
            <td>Grid charging (overnight)</td>
            <td class="numeric">${fmt(c.avgGridCharge, 1)}</td>
            <td class="numeric">${c.gridCarbonNight} g/kWh (night grid)</td>
            <td class="numeric negative">+${fmt(c.carbonFromGridCharge, 2)}</td>
          </tr>
          <tr class="total-row">
            <td><strong>Net Daily</strong></td>
            <td></td>
            <td></td>
            <td class="numeric ${c.netCarbonDaily < 0 ? 'positive' : 'negative'}">
              <strong>${c.netCarbonDaily < 0 ? '-' : '+'}${fmt(Math.abs(c.netCarbonDaily), 2)}</strong>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="note">
        <strong>Note on Grid Arbitrage:</strong><br>
        Grid arbitrage (charging overnight at off-peak rates) is NOT carbon-friendly.
        Off-peak grid electricity is more carbon-intensive (${c.gridCarbonNight} g/kWh) because it's primarily coal baseload,
        while daytime grid includes more renewables (${c.gridCarbonDaytime} g/kWh).
        <br><br>
        To minimize carbon footprint: prioritize solar charging over grid charging.
      </div>
    </section>
  `;
}

function renderInvestmentSection(report: Report): string {
  const i = report.investmentStatus;
  const p = report.calculatedParameters;

  if (i.panelSunkCost === 0 && i.batterySunkCost === 0) {
    return `
      <section>
        <h2>Investment Status</h2>
        <div class="note">
          Set <code>PANEL_SUNK_COST</code> and <code>BATTERY_SUNK_COST</code> in your .env file to track payback progress.
        </div>
      </section>
    `;
  }

  let html = '<section><h2>Investment Status</h2>';
  html += '<p>Tracking payback on your solar and battery investment based on actual savings.</p>';

  if (i.panelSunkCost > 0) {
    const recovered = i.solarRecovered ?? 0;
    const paidOff = recovered >= 1;
    html += `
      <h3>Solar Panels (${fmtCurrency(i.panelSunkCost)})</h3>
      <div class="progress-container">
        <div class="progress-bar"><div class="progress-bar-fill ${paidOff ? 'complete' : ''}" style="width: ${Math.min(100, recovered * 100)}%"></div></div>
        <div class="progress-text">${fmt(recovered * 100, 0)}% recovered (${fmtCurrency(i.solarSavingsTotal)} of ${fmtCurrency(i.panelSunkCost)})</div>
      </div>
      ${paidOff
        ? `<p class="positive"><strong>PAID OFF!</strong> Profit so far: ${fmtCurrency(i.solarSavingsTotal - i.panelSunkCost)}</p>`
        : `<p>Est. payback: ${fmt(i.solarPaybackYears ?? 0, 1)} years total (${fmt((i.solarPaybackYears ?? 0) - (report.overall.days / 365), 1)} more years at current rate)</p>`
      }
    `;
  }

  if (i.batterySunkCost > 0) {
    const recovered = i.batteryRecovered ?? 0;
    const paidOff = recovered >= 1;
    const exceedsLifespan = (i.batteryPaybackYears ?? Infinity) > p.estimatedLifespanYears;
    html += `
      <h3>Battery (${fmtCurrency(i.batterySunkCost)})</h3>
      <div class="progress-container">
        <div class="progress-bar"><div class="progress-bar-fill ${paidOff ? 'complete' : ''}" style="width: ${Math.min(100, recovered * 100)}%"></div></div>
        <div class="progress-text">${fmt(recovered * 100, 0)}% recovered (${fmtCurrency(i.batterySavingsTotal)} of ${fmtCurrency(i.batterySunkCost)})</div>
      </div>
      ${paidOff
        ? `<p class="positive"><strong>PAID OFF!</strong> Profit so far: ${fmtCurrency(i.batterySavingsTotal - i.batterySunkCost)}</p>`
        : `<p>Est. payback: ${fmt(i.batteryPaybackYears ?? 0, 1)} years total</p>`
      }
      ${exceedsLifespan && !paidOff ? `<p class="warning">⚠️ Payback exceeds expected ${fmt(p.estimatedLifespanYears, 1)}-year lifespan</p>` : ''}
    `;
  }

  if (i.panelSunkCost > 0 && i.batterySunkCost > 0) {
    const totalInvestment = i.panelSunkCost + i.batterySunkCost;
    const totalRecovered = i.solarSavingsTotal + i.batterySavingsTotal;
    const recovered = totalRecovered / totalInvestment;
    const paidOff = recovered >= 1;

    html += `
      <h3>Combined System</h3>
      <div class="progress-container">
        <div class="progress-bar"><div class="progress-bar-fill ${paidOff ? 'complete' : ''}" style="width: ${Math.min(100, recovered * 100)}%"></div></div>
        <div class="progress-text">${fmt(recovered * 100, 0)}% recovered (${fmtCurrency(totalRecovered)} of ${fmtCurrency(totalInvestment)})</div>
      </div>
      ${paidOff
        ? `<p class="positive"><strong>FULLY PAID OFF!</strong> Net profit: ${fmtCurrency(totalRecovered - totalInvestment)}</p>`
        : ''
      }
    `;
  }

  html += '</section>';
  return html;
}

function renderMethodologySection(report: Report): string {
  const checks: string[] = [];

  if (report.hasPowerData) {
    checks.push('TOU calculated from actual timestamped power data');
    checks.push('Battery scenarios use real daily import/export');
  } else {
    checks.push('⚠️ TOU estimated (no power data available)');
  }

  if (report.batteryEfficiency.length > 0) {
    checks.push('Battery degradation tracked from historical data');
  }

  if (report.solarDegradation.hasEnoughData) {
    checks.push('Solar degradation tracked year-over-year');
  }

  return `
    <section>
      <h2>Analysis Methodology</h2>
      <ul>
        ${checks.map(c => `<li>${c.startsWith('⚠️') ? c : '✓ ' + c}</li>`).join('')}
      </ul>

      <h3>Limitations</h3>
      <ul>
        <li>Does not account for future electricity rate changes</li>
        <li>Backup power value not included in ROI calculations</li>
        <li>Battery degradation projection based on limited historical data</li>
        <li>Grid carbon intensity uses Australian average estimates</li>
      </ul>
    </section>
  `;
}

function renderDailyChartsSection(): string {
  return `
    <section>
      <h2>Daily Energy Flow</h2>
      <p>Time series of daily energy generation, import, and export over the analysis period.</p>
      <div class="chart-container chart-wide" id="chart-daily-energy"></div>

      <h3>Battery Activity</h3>
      <div class="chart-container chart-wide" id="chart-battery"></div>

      <h3>State of Charge Range</h3>
      <p>Daily minimum and maximum battery state of charge, showing how much of the battery capacity is being utilized.</p>
      <div class="chart-container chart-wide" id="chart-soc"></div>
    </section>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
// VEGA-LITE CHARTS
// ═══════════════════════════════════════════════════════════════════════════

const CHART_WIDTH = 500; // A4 safe width
const CHART_HEIGHT = 250;
const CHART_HEIGHT_SMALL = 180;

async function renderDailyEnergyChart(report: Report, container: string): Promise<void> {
  const maxPoints = 400;
  let data = report.daily;
  if (data.length > maxPoints) {
    const step = Math.ceil(data.length / maxPoints);
    data = data.filter((_, i) => i % step === 0);
  }

  const values = data.flatMap(d => [
    { date: d.date, type: 'PV Generation', value: d.pvGeneration },
    { date: d.date, type: 'Grid Import', value: d.gridImport },
    { date: d.date, type: 'Grid Export', value: -d.gridExport },
  ]);

  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    data: { values },
    mark: { type: 'line', strokeWidth: 1.5, opacity: 0.8 },
    encoding: {
      x: { field: 'date', type: 'temporal', title: 'Date', axis: { format: '%b %Y' } },
      y: { field: 'value', type: 'quantitative', title: 'kWh/day' },
      color: {
        field: 'type',
        type: 'nominal',
        title: 'Energy Flow',
        scale: { domain: ['PV Generation', 'Grid Import', 'Grid Export'], range: ['#f59f00', '#dc3545', '#28a745'] }
      }
    }
  };
  await vegaEmbed(container, spec, { actions: false });
}

async function renderBatteryChart(report: Report, container: string): Promise<void> {
  const maxPoints = 400;
  let data = report.daily;
  if (data.length > maxPoints) {
    const step = Math.ceil(data.length / maxPoints);
    data = data.filter((_, i) => i % step === 0);
  }

  const values = data.flatMap(d => [
    { date: d.date, type: 'Charge', value: d.batteryCharge },
    { date: d.date, type: 'Discharge', value: d.batteryDischarge },
  ]);

  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: CHART_WIDTH,
    height: CHART_HEIGHT_SMALL,
    data: { values },
    mark: { type: 'area', opacity: 0.6 },
    encoding: {
      x: { field: 'date', type: 'temporal', title: 'Date', axis: { format: '%b %Y' } },
      y: { field: 'value', type: 'quantitative', title: 'kWh/day', stack: null },
      color: {
        field: 'type',
        type: 'nominal',
        title: 'Battery',
        scale: { domain: ['Charge', 'Discharge'], range: ['#4dabf7', '#ff6b6b'] }
      }
    }
  };
  await vegaEmbed(container, spec, { actions: false });
}

async function renderTOUPieChart(report: Report, container: string, type: 'import' | 'export'): Promise<void> {
  const data = type === 'import' ? report.overall.importByTOU : report.overall.exportByTOU;
  const total = touTotal(data);
  const values = [
    { period: 'Peak', value: data.peak ?? 0, pct: total > 0 ? ((data.peak ?? 0) / total * 100) : 0 },
    { period: 'Shoulder', value: data.shoulder ?? 0, pct: total > 0 ? ((data.shoulder ?? 0) / total * 100) : 0 },
    { period: 'Off-peak', value: data.offpeak ?? 0, pct: total > 0 ? ((data.offpeak ?? 0) / total * 100) : 0 },
  ].filter(v => v.value > 0);

  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: 250,
    height: 250,
    data: { values },
    encoding: {
      theta: { field: 'value', type: 'quantitative', stack: true },
      color: {
        field: 'period',
        type: 'nominal',
        title: 'Period',
        scale: { domain: ['Peak', 'Shoulder', 'Off-peak'], range: ['#dc3545', '#ffc107', '#28a745'] },
        legend: null
      }
    },
    layer: [
      {
        mark: { type: 'arc', innerRadius: 60, outerRadius: 100 }
      },
      {
        mark: { type: 'text', radius: 125, fontSize: 12, fontWeight: 'bold' },
        encoding: {
          text: { field: 'period', type: 'nominal' }
        }
      },
      {
        mark: { type: 'text', radius: 80, fontSize: 11 },
        encoding: {
          text: {
            field: 'pct',
            type: 'quantitative',
            format: '.0f'
          }
        },
        transform: [{ calculate: "datum.pct + '%'", as: 'pctLabel' }]
      }
    ]
  };

  // Add percentage labels
  const specWithLabels = {
    ...spec,
    layer: [
      { mark: { type: 'arc', innerRadius: 60, outerRadius: 100 } },
      {
        mark: { type: 'text', radius: 130, fontSize: 11 },
        encoding: {
          text: { field: 'period', type: 'nominal' },
          color: { value: '#333' }
        }
      },
      {
        mark: { type: 'text', radius: 80, fontSize: 12, fontWeight: 'bold' },
        encoding: {
          text: { value: '' }  // Will be overridden
        },
        transform: [{ calculate: "format(datum.pct, '.0f') + '%'", as: 'label' }]
      }
    ]
  };

  await vegaEmbed(container, spec, { actions: false });

  // Add percentage labels manually
  setTimeout(() => {
    const el = document.querySelector(container);
    if (!el) return;
    const svg = el.querySelector('svg');
    if (!svg) return;

    const width = 250;
    const height = 250;
    const centerX = width / 2;
    const centerY = height / 2;
    const labelRadius = 80;

    let angle = -Math.PI / 2;
    for (const v of values) {
      const sliceAngle = (v.value / total) * 2 * Math.PI;
      const midAngle = angle + sliceAngle / 2;

      const x = centerX + Math.cos(midAngle) * labelRadius;
      const y = centerY + Math.sin(midAngle) * labelRadius;

      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', x.toString());
      text.setAttribute('y', y.toString());
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'middle');
      text.setAttribute('font-size', '12');
      text.setAttribute('font-weight', 'bold');
      text.setAttribute('fill', '#fff');
      text.textContent = fmt(v.pct, 0) + '%';
      svg.appendChild(text);

      angle += sliceAngle;
    }
  }, 100);
}

async function renderSeasonalBarChart(report: Report, container: string): Promise<void> {
  const seasons = ['Summer', 'Autumn', 'Winter', 'Spring'];
  const values = seasons.flatMap(s => {
    const data = report.bySeason[s.toLowerCase()];
    if (!data || data.days === 0) return [];
    return [
      { season: s, metric: 'PV Generation', value: data.avgDaily.pvGeneration },
      { season: s, metric: 'Grid Import', value: data.avgDaily.gridImport },
      { season: s, metric: 'Grid Export', value: data.avgDaily.gridExport },
    ];
  });

  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: CHART_WIDTH,
    height: CHART_HEIGHT_SMALL,
    data: { values },
    mark: 'bar',
    encoding: {
      x: { field: 'season', type: 'nominal', title: 'Season', axis: { labelAngle: 0 } },
      y: { field: 'value', type: 'quantitative', title: 'kWh/day' },
      color: {
        field: 'metric',
        type: 'nominal',
        title: 'Metric',
        scale: { range: ['#f59f00', '#dc3545', '#28a745'] }
      },
      xOffset: { field: 'metric', type: 'nominal' }
    }
  };
  await vegaEmbed(container, spec, { actions: false });
}

async function renderEfficiencyChart(report: Report, container: string): Promise<void> {
  if (report.batteryEfficiency.length === 0) return;

  const values = report.batteryEfficiency.map(e => ({
    period: e.period,
    efficiency: e.efficiency * 100,
    cycles: e.cycleCount
  }));

  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: CHART_WIDTH,
    height: CHART_HEIGHT_SMALL,
    data: { values },
    layer: [
      {
        mark: { type: 'bar', color: '#4dabf7', opacity: 0.4 },
        encoding: {
          x: { field: 'period', type: 'ordinal', title: 'Period', axis: { labelAngle: -45 } },
          y: { field: 'cycles', type: 'quantitative', title: 'Cycles', axis: { orient: 'right', titleColor: '#4dabf7' } }
        }
      },
      {
        mark: { type: 'line', color: '#2c5aa0', point: { color: '#2c5aa0', size: 60 }, strokeWidth: 2 },
        encoding: {
          x: { field: 'period', type: 'ordinal' },
          y: { field: 'efficiency', type: 'quantitative', title: 'Efficiency %', scale: { domain: [80, 100] }, axis: { titleColor: '#2c5aa0' } }
        }
      }
    ],
    resolve: { scale: { y: 'independent' } }
  };
  await vegaEmbed(container, spec, { actions: false });
}

async function renderSavingsChart(report: Report, container: string): Promise<void> {
  const s = report.savings;
  const values = [
    { scenario: 'No Solar', cost: s.noSolar.totalNetCost, order: 1 },
    { scenario: 'Solar Only', cost: s.solarOnly.totalNetCost, order: 2 },
    { scenario: 'Actual', cost: s.actual.totalNetCost, order: 3 },
    { scenario: 'Optimal', cost: s.optimal.totalNetCost, order: 4 },
  ];

  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: CHART_WIDTH,
    height: CHART_HEIGHT_SMALL,
    data: { values },
    mark: { type: 'bar', cornerRadiusEnd: 4 },
    encoding: {
      x: { field: 'scenario', type: 'nominal', title: 'Scenario', sort: { field: 'order' }, axis: { labelAngle: 0 } },
      y: { field: 'cost', type: 'quantitative', title: 'Total Net Cost ($)' },
      color: {
        field: 'scenario',
        type: 'nominal',
        legend: null,
        scale: {
          domain: ['No Solar', 'Solar Only', 'Actual', 'Optimal'],
          range: ['#dc3545', '#ffc107', '#28a745', '#17a2b8']
        }
      }
    }
  };
  await vegaEmbed(container, spec, { actions: false });
}

async function renderScenarioChart(report: Report, container: string): Promise<void> {
  const values = report.scenarios
    .filter(s => s.additionalBatteries > 0)
    .map(s => ({
      scenario: `+${s.additionalBatteries} (${s.additionalKwh}kWh)`,
      annual: s.annualSavings,
      roi: s.roi,
      order: s.additionalBatteries
    }));

  if (values.length === 0) return;

  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: CHART_WIDTH,
    height: CHART_HEIGHT_SMALL,
    data: { values },
    layer: [
      {
        mark: { type: 'bar', color: '#28a745', opacity: 0.7 },
        encoding: {
          x: { field: 'scenario', type: 'nominal', title: 'Additional Battery', sort: { field: 'order' }, axis: { labelAngle: 0 } },
          y: { field: 'annual', type: 'quantitative', title: 'Annual Savings ($)', axis: { titleColor: '#28a745' } }
        }
      },
      {
        mark: { type: 'line', color: '#dc3545', point: { color: '#dc3545', size: 60 }, strokeWidth: 2 },
        encoding: {
          x: { field: 'scenario', type: 'nominal', sort: { field: 'order' } },
          y: { field: 'roi', type: 'quantitative', title: 'ROI %', axis: { orient: 'right', titleColor: '#dc3545' } }
        }
      }
    ],
    resolve: { scale: { y: 'independent' } }
  };
  await vegaEmbed(container, spec, { actions: false });
}

async function renderSoCChart(report: Report, container: string): Promise<void> {
  const daysWithSoC = report.daily.filter(d => d.battery.maxSoC > 0);
  if (daysWithSoC.length === 0) return;

  const maxPoints = 400;
  let data = daysWithSoC;
  if (data.length > maxPoints) {
    const step = Math.ceil(data.length / maxPoints);
    data = data.filter((_, i) => i % step === 0);
  }

  const values = data.map(d => ({
    date: d.date,
    minSoC: d.battery.minSoC,
    maxSoC: d.battery.maxSoC,
    range: d.battery.cycleDepth
  }));

  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: CHART_WIDTH,
    height: CHART_HEIGHT_SMALL,
    data: { values },
    layer: [
      {
        mark: { type: 'area', opacity: 0.3, color: '#4dabf7' },
        encoding: {
          x: { field: 'date', type: 'temporal', title: 'Date', axis: { format: '%b %Y' } },
          y: { field: 'minSoC', type: 'quantitative', title: 'State of Charge %', scale: { domain: [0, 100] } },
          y2: { field: 'maxSoC' }
        }
      },
      {
        mark: { type: 'line', color: '#2c5aa0', strokeWidth: 1 },
        encoding: {
          x: { field: 'date', type: 'temporal' },
          y: { field: 'range', type: 'quantitative' }
        }
      }
    ]
  };
  await vegaEmbed(container, spec, { actions: false });
}

async function renderUtilizationChart(report: Report, container: string): Promise<void> {
  const o = report.overall;
  const days = o.days || 1;

  const values = [
    { category: 'Charging', source: 'Solar', value: o.chargeFromSolar / days },
    { category: 'Charging', source: 'Grid Off-peak', value: (o.gridChargeTOU.offpeak ?? 0) / days },
    { category: 'Charging', source: 'Grid Peak', value: (o.gridChargeTOU.peak ?? 0) / days },
    { category: 'Discharging', source: 'To Peak', value: (o.batteryDischargeTOU.peak ?? 0) / days },
    { category: 'Discharging', source: 'To Shoulder', value: (o.batteryDischargeTOU.shoulder ?? 0) / days },
    { category: 'Discharging', source: 'To Off-peak', value: (o.batteryDischargeTOU.offpeak ?? 0) / days },
  ].filter(v => v.value > 0.01);

  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: CHART_WIDTH,
    height: 120,
    data: { values },
    mark: { type: 'bar', cornerRadiusEnd: 4 },
    encoding: {
      y: { field: 'category', type: 'nominal', title: '', axis: { labelAngle: 0 } },
      x: { field: 'value', type: 'quantitative', title: 'kWh/day', stack: 'zero' },
      color: {
        field: 'source',
        type: 'nominal',
        title: 'Source/Destination',
        scale: {
          domain: ['Solar', 'Grid Off-peak', 'Grid Peak', 'To Peak', 'To Shoulder', 'To Off-peak'],
          range: ['#f59f00', '#28a745', '#dc3545', '#dc3545', '#ffc107', '#28a745']
        }
      }
    }
  };
  await vegaEmbed(container, spec, { actions: false });
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN RENDER FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

async function renderReport(report: Report): Promise<void> {
  const reportEl = document.getElementById('report');
  if (!reportEl) return;

  // Build HTML structure
  reportEl.innerHTML = `
    ${renderHeader(report)}
    ${renderSummaryCards(report)}

    <div class="page-break"></div>
    ${renderTariffSection(report)}
    ${renderParametersSection(report)}

    <div class="page-break"></div>
    ${renderLifetimeTotals(report)}
    ${renderYearlyTable(report)}
    ${renderSeasonalSection(report)}

    <div class="page-break"></div>
    ${renderYearOverYearComparison(report)}
    ${renderDailyChartsSection()}

    <div class="page-break"></div>
    ${renderTOUSection(report)}

    <div class="page-break"></div>
    ${renderBatteryUtilizationSection(report)}
    ${renderBatteryEfficiencySection(report)}

    <div class="page-break"></div>
    ${renderSolarDegradationSection(report)}

    <div class="page-break"></div>
    ${renderSavingsSection(report)}

    <div class="page-break"></div>
    ${renderScenariosSection(report)}

    <div class="page-break"></div>
    ${renderOptimizationSection(report)}
    ${renderCurrentConfig(report)}

    <div class="page-break"></div>
    ${renderCarbonSection(report)}
    ${renderInvestmentSection(report)}
    ${renderMethodologySection(report)}

    <section class="no-print">
      <h2>Export Data</h2>
      <button onclick="downloadCSV()" class="btn">Download Daily Data as CSV</button>
      <button onclick="window.print()" class="btn">Print / Save as PDF</button>
    </section>
  `;

  // Render charts
  try {
    await Promise.all([
      renderDailyEnergyChart(report, '#chart-daily-energy'),
      renderBatteryChart(report, '#chart-battery'),
      renderSeasonalBarChart(report, '#chart-seasonal'),
      report.hasPowerData ? renderTOUPieChart(report, '#chart-tou-import', 'import') : Promise.resolve(),
      report.hasPowerData ? renderTOUPieChart(report, '#chart-tou-export', 'export') : Promise.resolve(),
      renderUtilizationChart(report, '#chart-utilization'),
      renderSoCChart(report, '#chart-soc'),
      renderEfficiencyChart(report, '#chart-efficiency'),
      renderSavingsChart(report, '#chart-savings'),
      renderScenarioChart(report, '#chart-scenarios'),
    ]);
  } catch (e) {
    console.error('Chart rendering error:', e);
  }

  // Store report for CSV download
  (window as unknown as { currentReport: Report }).currentReport = report;
}

function downloadCSV(): void {
  const report = (window as unknown as { currentReport: Report }).currentReport;
  if (!report) return;

  const headers = ['date', 'year', 'month', 'season', 'pvGeneration', 'gridImport', 'gridExport', 'batteryCharge', 'batteryDischarge', 'load', 'peakImport', 'shoulderImport', 'offpeakImport', 'minSoC', 'maxSoC', 'chargeFromSolar', 'chargeFromGrid'];
  const rows = report.daily.map(d => [
    d.date, d.year, d.month, d.season, d.pvGeneration, d.gridImport, d.gridExport, d.batteryCharge, d.batteryDischarge, d.load, d.peakImport, d.shoulderImport, d.offpeakImport, d.battery.minSoC, d.battery.maxSoC, d.battery.chargeFromSolar, d.battery.chargeFromGrid
  ].join(','));

  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `battery-data-${report.sysSn}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

(window as unknown as { downloadCSV: () => void }).downloadCSV = downloadCSV;

// ═══════════════════════════════════════════════════════════════════════════
// FILE LOADING
// ═══════════════════════════════════════════════════════════════════════════

async function loadReport(file: File): Promise<Report> {
  const text = await file.text();
  return JSON.parse(text) as Report;
}

document.getElementById('jsonFile')?.addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const reportEl = document.getElementById('report');
  if (reportEl) {
    reportEl.innerHTML = '<div class="loading">Loading report...</div>';
  }

  try {
    const report = await loadReport(file);
    await renderReport(report);
  } catch (err) {
    console.error('Failed to load report:', err);
    if (reportEl) {
      reportEl.innerHTML = `<div class="empty-state"><h2>Error Loading Report</h2><p>${(err as Error).message}</p></div>`;
    }
  }
});
