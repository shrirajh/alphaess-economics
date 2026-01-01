#!/usr/bin/env npx tsx
/**
 * Battery Optimizer - Apply recommended charge/discharge settings
 *
 * Usage:
 *   npx tsx optimize-battery.ts --config=./recommended-config-{SN}.json
 *   npx tsx optimize-battery.ts --sn=YOUR_SERIAL_NUMBER
 *
 * Options:
 *   --config=FILE       Apply settings from a recommended config file
 *   --sn=SERIAL         System serial number (for interactive mode)
 *   --dry-run           Show what would change without applying
 *   --discharge-only    Only update discharge settings
 *   --charge-only       Only update charge settings
 *   --yes               Skip first confirmation
 *   --force             Skip ALL confirmations (for automation)
 *
 * IMPORTANT: AlphaESS API only allows setting changes once per 24 hours!
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import 'dotenv/config';
import AlphaESSClient from 'alphaess-client';
import {
  getChargeConfig,
  getDischargeConfig,
  updateChargeConfig,
  updateDischargeConfig,
  validateChargeConfig,
  validateDischargeConfig,
  formatChargeConfig,
  formatDischargeConfig,
  diffChargeConfig,
  diffDischargeConfig,
  type ChargeConfig,
  type DischargeConfig,
  type RecommendedConfig,
  type BackupFile,
} from './alphaess-api-helpers.js';

// ═══════════════════════════════════════════════════════════════════════════
// CLI PARSING
// ═══════════════════════════════════════════════════════════════════════════

interface CliArgs {
  configFile: string | null;
  sn: string | null;
  dryRun: boolean;
  dischargeOnly: boolean;
  chargeOnly: boolean;
  yes: boolean;
  force: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    configFile: null,
    sn: null,
    dryRun: false,
    dischargeOnly: false,
    chargeOnly: false,
    yes: false,
    force: false,
  };

  for (const arg of args) {
    if (arg.startsWith('--config=')) {
      result.configFile = arg.slice(9);
    } else if (arg.startsWith('--sn=')) {
      result.sn = arg.slice(5);
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--discharge-only') {
      result.dischargeOnly = true;
    } else if (arg === '--charge-only') {
      result.chargeOnly = true;
    } else if (arg === '--yes' || arg === '-y') {
      result.yes = true;
    } else if (arg === '--force' || arg === '-f') {
      result.force = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
Battery Optimizer - Apply recommended charge/discharge settings

Usage:
  npx tsx optimize-battery.ts --config=./recommended-config-{SN}.json
  npx tsx optimize-battery.ts --sn=YOUR_SERIAL_NUMBER

Options:
  --config=FILE       Apply settings from a recommended config file
  --sn=SERIAL         System serial number (required if no config file)
  --dry-run           Show what would change without applying
  --discharge-only    Only update discharge settings
  --charge-only       Only update charge settings
  --yes               Skip first confirmation
  --force             Skip ALL confirmations (for automation)

Examples:
  npx tsx optimize-battery.ts --config=./recommended-config-YOUR_SERIAL_NUMBER.json
  npx tsx optimize-battery.ts --config=./recommended-config-YOUR_SERIAL_NUMBER.json --dry-run
  npx tsx optimize-battery.ts --config=./recommended-config-YOUR_SERIAL_NUMBER.json --discharge-only

IMPORTANT: AlphaESS API only allows setting changes once per 24 hours!
`);
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function askQuestion(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function confirmWithDouble(message: string, skipFirst: boolean, skipAll: boolean): Promise<boolean> {
  if (skipAll) return true;

  if (!skipFirst) {
    const first = await askQuestion(`${message} (yes/N): `);
    if (first.toLowerCase() !== 'yes') {
      return false;
    }
  }

  const second = await askQuestion(`Are you sure? (Y/no): `);
  return second.toLowerCase() !== 'no';
}

function ensureBackupDir(): void {
  if (!fs.existsSync('./backups')) {
    fs.mkdirSync('./backups', { recursive: true });
    console.log('📁 Created ./backups directory');
  }
}

function saveBackup(
  sysSn: string,
  chargeConfig: ChargeConfig | null,
  dischargeConfig: DischargeConfig | null,
  reason: BackupFile['reason']
): string {
  ensureBackupDir();

  const backup: BackupFile = {
    sysSn,
    backupTimestamp: new Date().toISOString(),
    chargeConfig,
    dischargeConfig,
    reason,
  };

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `./backups/alphaess-backup-${sysSn}-${timestamp}.json`;
  fs.writeFileSync(filename, JSON.stringify(backup, null, 2));

  return filename;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('═'.repeat(80));
  console.log('🔋 BATTERY OPTIMIZER');
  console.log('═'.repeat(80));

  // Validate args
  if (!args.configFile && !args.sn) {
    console.error('❌ Either --config=FILE or --sn=SERIAL is required');
    printHelp();
    process.exit(1);
  }

  // Check API credentials
  const appID = process.env.ALPHAESS_APP_ID;
  const appSecret = process.env.ALPHAESS_APP_SECRET;

  if (!appID || !appSecret) {
    console.error('❌ ALPHAESS_APP_ID and ALPHAESS_APP_SECRET environment variables are required');
    process.exit(1);
  }

  // Load recommended config if provided
  let recommendedConfig: RecommendedConfig | null = null;
  let sysSn: string;

  if (args.configFile) {
    if (!fs.existsSync(args.configFile)) {
      console.error(`❌ Config file not found: ${args.configFile}`);
      process.exit(1);
    }

    recommendedConfig = JSON.parse(fs.readFileSync(args.configFile, 'utf8')) as RecommendedConfig;
    sysSn = recommendedConfig.sysSn;
    console.log(`📂 Loaded config from ${args.configFile}`);
    console.log(`   System: ${sysSn}`);
    console.log(`   Tariff: ${recommendedConfig.tariff}`);
    console.log(`   Generated: ${recommendedConfig.generatedAt}`);
  } else {
    sysSn = args.sn!;
  }

  // Initialize client
  const client = new AlphaESSClient({
    appID,
    appSecret,
    timeout: 30000
  });

  // Fetch current config from API (fresh, not cached)
  console.log('\n📡 Fetching current config from API...');

  let currentCharge: ChargeConfig | null = null;
  let currentDischarge: DischargeConfig | null = null;

  try {
    currentCharge = await getChargeConfig(client, sysSn);
    await sleep(2000);
  } catch (e) {
    console.warn('⚠️  Could not fetch charge config:', e instanceof Error ? e.message : e);
  }

  try {
    currentDischarge = await getDischargeConfig(client, sysSn);
  } catch (e) {
    console.warn('⚠️  Could not fetch discharge config:', e instanceof Error ? e.message : e);
  }

  // If no recommended config, we'd need to generate one (future: interactive mode)
  if (!recommendedConfig) {
    console.log('\n⚠️  Interactive mode not yet implemented.');
    console.log('    Run analyze-battery-economics.ts first to generate a recommended config file,');
    console.log('    then use: npx tsx optimize-battery.ts --config=./recommended-config-{SN}.json');
    process.exit(1);
  }

  // Show current vs recommended
  console.log('\n' + '═'.repeat(80));
  console.log('CURRENT vs RECOMMENDED CONFIGURATION');
  console.log('═'.repeat(80));

  // Discharge config comparison
  if (!args.chargeOnly) {
    console.log('\n📤 DISCHARGE SETTINGS:');
    console.log('─'.repeat(80));

    console.log('\n  CURRENT:');
    const currentDischargeLines = formatDischargeConfig(currentDischarge);
    for (const line of currentDischargeLines) console.log('  ' + line);

    console.log('\n  RECOMMENDED:');
    const recDischargeLines = formatDischargeConfig(recommendedConfig.recommendedConfig.discharge);
    for (const line of recDischargeLines) console.log('  ' + line);

    const dischargeDiffs = diffDischargeConfig(currentDischarge, recommendedConfig.recommendedConfig.discharge);
    if (dischargeDiffs.length > 0) {
      console.log('\n  CHANGES:');
      for (const diff of dischargeDiffs) {
        console.log(`    ${diff.field}: ${diff.current} → ${diff.recommended}`);
      }
    } else {
      console.log('\n  ✓ No changes needed (already optimal)');
    }
  }

  // Charge config comparison
  if (!args.dischargeOnly) {
    console.log('\n📥 CHARGE SETTINGS:');
    console.log('─'.repeat(80));

    console.log('\n  CURRENT:');
    const currentChargeLines = formatChargeConfig(currentCharge);
    for (const line of currentChargeLines) console.log('  ' + line);

    console.log('\n  RECOMMENDED:');
    const recChargeLines = formatChargeConfig(recommendedConfig.recommendedConfig.charge);
    for (const line of recChargeLines) console.log('  ' + line);

    const chargeDiffs = diffChargeConfig(currentCharge, recommendedConfig.recommendedConfig.charge);
    if (chargeDiffs.length > 0) {
      console.log('\n  CHANGES:');
      for (const diff of chargeDiffs) {
        console.log(`    ${diff.field}: ${diff.current} → ${diff.recommended}`);
      }
    } else {
      console.log('\n  ✓ No changes needed (already optimal)');
    }
  }

  // Show estimated savings
  if (recommendedConfig.estimatedAnnualSavings > 0) {
    console.log('\n' + '─'.repeat(80));
    console.log(`💰 Estimated annual savings: $${recommendedConfig.estimatedAnnualSavings.toFixed(0)}/year`);
  }

  // Dry run exit
  if (args.dryRun) {
    console.log('\n' + '═'.repeat(80));
    console.log('🔍 DRY RUN - No changes applied');
    console.log('   Remove --dry-run to apply these settings');
    console.log('═'.repeat(80));
    return;
  }

  // Rate limit warning
  console.log('\n' + '═'.repeat(80));
  console.log('⚠️  WARNING: AlphaESS API allows only ONE setting change per 24 hours!');
  console.log('   If you change settings now, you cannot change them again until tomorrow.');
  console.log('═'.repeat(80));

  // Determine what to apply
  let applyDischarge = !args.chargeOnly;
  let applyCharge = !args.dischargeOnly;

  // If both are possible, let user choose
  if (!args.chargeOnly && !args.dischargeOnly && !args.force) {
    console.log('\nWhat would you like to apply?');
    console.log('  [1] Discharge settings only (Recommended)');
    console.log('  [2] Charge settings only');
    console.log('  [3] Both discharge and charge');
    console.log('  [4] Cancel');

    const choice = await askQuestion('\nEnter choice [1-4]: ');

    switch (choice) {
      case '1':
        applyDischarge = true;
        applyCharge = false;
        break;
      case '2':
        applyDischarge = false;
        applyCharge = true;
        break;
      case '3':
        applyDischarge = true;
        applyCharge = true;
        break;
      default:
        console.log('\n❌ Cancelled');
        return;
    }
  }

  // Confirm
  const settingsDesc = applyDischarge && applyCharge
    ? 'discharge AND charge settings'
    : applyDischarge
      ? 'discharge settings'
      : 'charge settings';

  const confirmed = await confirmWithDouble(
    `\nApply ${settingsDesc}?`,
    args.yes,
    args.force
  );

  if (!confirmed) {
    console.log('\n❌ Cancelled');
    return;
  }

  // Backup current settings
  console.log('\n💾 Creating backup...');
  const backupFile = saveBackup(sysSn, currentCharge, currentDischarge, 'pre-optimization');
  console.log(`   Saved to: ${backupFile}`);

  // Apply settings
  console.log('\n🚀 Applying settings...');

  if (applyDischarge) {
    const discharge = recommendedConfig.recommendedConfig.discharge;

    // Validate
    const errors = validateDischargeConfig(discharge);
    if (errors.length > 0) {
      console.error('❌ Invalid discharge config:');
      for (const err of errors) console.error(`   ${err}`);
      process.exit(1);
    }

    console.log('   → Updating discharge config...');
    try {
      await updateDischargeConfig(client, sysSn, discharge);
      console.log('   ✓ Discharge config updated');
      await sleep(3000);
    } catch (e) {
      console.error('   ❌ Failed to update discharge config:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  }

  if (applyCharge) {
    const charge = recommendedConfig.recommendedConfig.charge;

    // Validate
    const errors = validateChargeConfig(charge);
    if (errors.length > 0) {
      console.error('❌ Invalid charge config:');
      for (const err of errors) console.error(`   ${err}`);
      process.exit(1);
    }

    console.log('   → Updating charge config...');
    try {
      await updateChargeConfig(client, sysSn, charge);
      console.log('   ✓ Charge config updated');
      await sleep(3000);
    } catch (e) {
      console.error('   ❌ Failed to update charge config:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  }

  // Verify
  console.log('\n🔍 Verifying changes...');

  if (applyDischarge) {
    try {
      const verified = await getDischargeConfig(client, sysSn);
      const expected = recommendedConfig.recommendedConfig.discharge;

      if (verified.ctrDis === expected.ctrDis &&
          verified.timeDisf1 === expected.timeDisf1 &&
          verified.timeDise1 === expected.timeDise1) {
        console.log('   ✓ Discharge config verified');
      } else {
        console.log('   ⚠️  Discharge config may not have applied correctly');
        console.log('      Expected:', JSON.stringify(expected));
        console.log('      Got:', JSON.stringify(verified));
      }
      await sleep(2000);
    } catch (e) {
      console.warn('   ⚠️  Could not verify discharge config:', e instanceof Error ? e.message : e);
    }
  }

  if (applyCharge) {
    try {
      const verified = await getChargeConfig(client, sysSn);
      const expected = recommendedConfig.recommendedConfig.charge;

      if (verified.gridCharge === expected.gridCharge &&
          verified.timeChaf1 === expected.timeChaf1 &&
          verified.timeChae1 === expected.timeChae1) {
        console.log('   ✓ Charge config verified');
      } else {
        console.log('   ⚠️  Charge config may not have applied correctly');
        console.log('      Expected:', JSON.stringify(expected));
        console.log('      Got:', JSON.stringify(verified));
      }
    } catch (e) {
      console.warn('   ⚠️  Could not verify charge config:', e instanceof Error ? e.message : e);
    }
  }

  // Update local data file
  const dataFile = `alphaess-data-${sysSn}.json`;
  if (fs.existsSync(dataFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      if (applyDischarge) {
        data.dischargeConfig = recommendedConfig.recommendedConfig.discharge;
      }
      if (applyCharge) {
        data.chargeConfig = recommendedConfig.recommendedConfig.charge;
      }
      data.lastUpdated = new Date().toISOString();
      fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
      console.log(`   ✓ Updated local data file: ${dataFile}`);
    } catch {
      console.warn(`   ⚠️  Could not update local data file: ${dataFile}`);
    }
  }

  // Done
  console.log('\n' + '═'.repeat(80));
  console.log('✅ OPTIMIZATION COMPLETE');
  console.log('═'.repeat(80));
  console.log(`   Backup saved to: ${backupFile}`);
  console.log(`   Restore with: npx tsx restore-battery.ts --restore=${backupFile}`);
  console.log('');
  console.log('   Check the AlphaESS app to confirm settings are applied.');
  console.log('   Note: Settings may take a few minutes to sync to the inverter.');
  console.log('');
}

main().catch(e => {
  console.error('❌ Error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
