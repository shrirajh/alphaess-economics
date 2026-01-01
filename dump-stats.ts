import AlphaESSClient, {
  type GetESSListResponse,
  type EnergySummaryResponse,
  type LastPowerResponse,
  type ChargeConfigResponse,
  type DischargeConfigResponse,
  type OneDayPowerResponse,
  type OneDayEnergyResponse,
  type EVChargerListResponse,
} from 'alphaess-client';
import * as fs from 'node:fs';
import 'dotenv/config';

const appID = process.env.ALPHAESS_APP_ID;
const appSecret = process.env.ALPHAESS_APP_SECRET;

if (!appID || !appSecret) {
  console.error('❌ ALPHAESS_APP_ID and ALPHAESS_APP_SECRET environment variables are required');
  process.exit(1);
}

const client = new AlphaESSClient({
  appID,
  appSecret,
  timeout: 30000
});

// Rate limiting config
const DELAY_BETWEEN_REQUESTS = 3000; // 3 seconds between requests
const MAX_CONSECUTIVE_EMPTY_DAYS = parseInt(process.env.MAX_EMPTY_DAYS ?? '30', 10);

interface ErrorEntry {
  endpoint: string;
  error: string;
  timestamp: string;
}

interface HistoricalDataEntry {
  date: string;
  power: OneDayPowerResponse | null;
  energy: OneDayEnergyResponse | null;
  incomplete?: boolean; // True if saved before end of day
}

interface SystemData {
  systemInfo: GetESSListResponse[number];
  energySummary: EnergySummaryResponse | null;
  lastPower: LastPowerResponse | null;
  chargeConfig: ChargeConfigResponse | null;
  dischargeConfig: DischargeConfigResponse | null;
  historicalData: HistoricalDataEntry[];
  evChargers: EVChargerListResponse | null;
  lastUpdated: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0] ?? '';
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getDataFilePath(sysSn: string): string {
  return `alphaess-data-${sysSn}.json`;
}

function loadExistingData(sysSn: string): SystemData | null {
  const filePath = getDataFilePath(sysSn);
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as SystemData;
      console.log(`  📂 Loaded existing data with ${data.historicalData.length} days`);
      return data;
    } catch {
      console.log(`  ⚠️  Could not parse existing data file, starting fresh`);
    }
  }
  return null;
}

function saveSystemData(sysSn: string, data: SystemData): void {
  const filePath = getDataFilePath(sysSn);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function getExistingDates(data: SystemData): Set<string> {
  return new Set(data.historicalData.map(d => d.date));
}

function hasEnergyData(entry: HistoricalDataEntry): boolean {
  if (!entry.energy) return false;
  // Check if there's any actual data (not all zeros/nulls)
  const e = entry.energy;
  return (e.epv ?? 0) > 0 || (e.eInput ?? 0) > 0 || (e.eOutput ?? 0) > 0;
}

async function dumpAllStats(): Promise<void> {
  const errors: ErrorEntry[] = [];

  console.log('🔌 Fetching AlphaESS system list...\n');

  try {
    const systems = await client.getESSList();
    console.log(`Found ${systems.length} system(s)\n`);

    for (const system of systems) {
      console.log(`\n📊 Processing system: ${system.sysSn}`);
      console.log('─'.repeat(50));

      // Load existing data or create new
      const existingData = loadExistingData(system.sysSn);
      const existingDates = existingData ? getExistingDates(existingData) : new Set<string>();

      const systemData: SystemData = existingData ?? {
        systemInfo: system,
        energySummary: null,
        lastPower: null,
        chargeConfig: null,
        dischargeConfig: null,
        historicalData: [],
        evChargers: null,
        lastUpdated: new Date().toISOString()
      };

      // Always update system info
      systemData.systemInfo = system;
      systemData.lastUpdated = new Date().toISOString();

      // Energy Summary (always refresh)
      try {
        console.log('  → Fetching energy summary...');
        systemData.energySummary = await client.getSumDataForCustomer(system.sysSn);
        await sleep(2000);
      } catch (e) {
        errors.push({ endpoint: 'getSumDataForCustomer', error: getErrorMessage(e), timestamp: new Date().toISOString() });
      }

      // Last Power Data (always refresh)
      try {
        console.log('  → Fetching real-time power data...');
        systemData.lastPower = await client.getLastPowerData(system.sysSn);
        await sleep(2000);
      } catch (e) {
        errors.push({ endpoint: 'getLastPowerData', error: getErrorMessage(e), timestamp: new Date().toISOString() });
      }

      // Charge Config
      try {
        console.log('  → Fetching charge configuration...');
        systemData.chargeConfig = await client.getChargeConfigInfo(system.sysSn);
        await sleep(2000);
      } catch (e) {
        errors.push({ endpoint: 'getChargeConfigInfo', error: getErrorMessage(e), timestamp: new Date().toISOString() });
      }

      // Discharge Config
      try {
        console.log('  → Fetching discharge configuration...');
        systemData.dischargeConfig = await client.getDisChargeConfigInfo(system.sysSn);
        await sleep(2000);
      } catch (e) {
        errors.push({ endpoint: 'getDisChargeConfigInfo', error: getErrorMessage(e), timestamp: new Date().toISOString() });
      }

      // Historical data - fetch ALL missing dates
      console.log('  → Fetching historical data (all available, skipping existing)...');
      const today = new Date();
      const todayStr = formatDate(today);
      let consecutiveEmptyDays = 0;
      let daysFetched = 0;
      let daysSkipped = 0;
      let daysRefreshed = 0;

      // Build set of incomplete dates that need refresh
      const incompleteDates = new Set(
        systemData.historicalData.filter(d => d.incomplete).map(d => d.date)
      );

      // Go back up to 5 years (1825 days) or until we hit too many empty days
      for (let i = 0; i < 1825; i++) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dateStr = formatDate(date);
        const isToday = dateStr === todayStr;
        // Refresh if: it's today, OR it was previously saved as incomplete
        const shouldRefresh = isToday || incompleteDates.has(dateStr);

        // Skip if we already have this date (unless it needs refresh)
        if (existingDates.has(dateStr) && !shouldRefresh) {
          daysSkipped++;
          continue;
        }

        try {
          const [powerData, energyData] = await Promise.all([
            client.getOneDayPowerBySn(system.sysSn, dateStr).catch(() => null),
            client.getOneDateEnergyBySn(system.sysSn, dateStr).catch(() => null)
          ]);

          const entry: HistoricalDataEntry = {
            date: dateStr,
            power: powerData,
            energy: energyData,
            incomplete: isToday ? true : undefined // Only today is incomplete
          };

          // If refreshing, replace existing entry; otherwise add new
          if (shouldRefresh && existingDates.has(dateStr)) {
            const existingIndex = systemData.historicalData.findIndex(d => d.date === dateStr);
            if (existingIndex >= 0) {
              systemData.historicalData[existingIndex] = entry;
            }
            daysRefreshed++;
          } else {
            systemData.historicalData.push(entry);
            existingDates.add(dateStr);
            daysFetched++;
          }

          // Check if this day has actual data
          if (hasEnergyData(entry)) {
            consecutiveEmptyDays = 0;
          } else {
            consecutiveEmptyDays++;
          }

          // Save after each fetch (incremental save)
          saveSystemData(system.sysSn, systemData);

          const status = shouldRefresh ? '(refresh)' : '';
          process.stdout.write(`    Fetched: ${daysFetched} | Refreshed: ${daysRefreshed} | Skipped: ${daysSkipped} | Date: ${dateStr} ${status}   \r`);
          await sleep(DELAY_BETWEEN_REQUESTS);

          // Stop if we've hit too many consecutive empty days
          if (consecutiveEmptyDays >= MAX_CONSECUTIVE_EMPTY_DAYS) {
            console.log(`\n    Reached ${MAX_CONSECUTIVE_EMPTY_DAYS} consecutive days with no data, stopping`);
            break;
          }
        } catch (e) {
          errors.push({ endpoint: `historical-${dateStr}`, error: getErrorMessage(e), timestamp: new Date().toISOString() });
        }
      }

      // Sort historical data by date (newest first)
      systemData.historicalData.sort((a, b) => b.date.localeCompare(a.date));

      console.log(`\n    Historical data complete: ${systemData.historicalData.length} total days`);

      // EV Chargers
      try {
        console.log('  → Fetching EV charger info...');
        systemData.evChargers = await client.getEvChargerConfigList(system.sysSn);
        await sleep(2000);
      } catch {
        systemData.evChargers = null;
      }

      // Final save
      saveSystemData(system.sysSn, systemData);
      console.log(`  💾 Saved to ${getDataFilePath(system.sysSn)}`);

      // Print summary
      console.log('\n' + '═'.repeat(50));
      console.log('📈 QUICK SUMMARY');
      console.log('═'.repeat(50));

      console.log(`\nSystem: ${systemData.systemInfo.sysSn}`);
      console.log(`Battery Capacity: ${systemData.systemInfo.cobat} kWh`);
      console.log(`Inverter: ${systemData.systemInfo.minv} (${systemData.systemInfo.poinv}W)`);
      console.log(`PV Capacity: ${systemData.systemInfo.popv}W`);
      console.log(`Total Historical Days: ${systemData.historicalData.length}`);

      if (systemData.energySummary) {
        console.log(`\nToday's Generation: ${systemData.energySummary.epvtoday} kWh`);
        console.log(`Today's Load: ${systemData.energySummary.eload} kWh`);
        console.log(`Today's Feed-in: ${systemData.energySummary.eoutput} kWh`);
        console.log(`Today's Grid Consumption: ${systemData.energySummary.einput} kWh`);
        console.log(`Today's Battery Charged: ${systemData.energySummary.echarge} kWh`);
        console.log(`Today's Battery Discharged: ${systemData.energySummary.edischarge} kWh`);
        console.log(`Self-consumption: ${systemData.energySummary.eselfConsumption}%`);
        console.log(`Self-sufficiency: ${systemData.energySummary.eselfSufficiency}%`);
      }

      if (systemData.lastPower) {
        console.log(`\nCurrent State:`);
        console.log(`  PV Power: ${systemData.lastPower.ppv}W`);
        console.log(`  Load: ${systemData.lastPower.pload}W`);
        console.log(`  Battery: ${systemData.lastPower.pbat}W (${systemData.lastPower.soc}% SOC)`);
        console.log(`  Grid: ${systemData.lastPower.pgrid}W ${systemData.lastPower.pgrid > 0 ? '(importing)' : '(exporting)'}`);
      }
    }
  } catch (e) {
    console.error('❌ Failed to fetch system list:', getErrorMessage(e));
    errors.push({ endpoint: 'getESSList', error: getErrorMessage(e), timestamp: new Date().toISOString() });
  }

  if (errors.length > 0) {
    console.log(`\n⚠️  ${errors.length} error(s) occurred during fetch`);
  }

  console.log('\n✅ Done!');
}

dumpAllStats().catch(console.error);
