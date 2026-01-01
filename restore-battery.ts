#!/usr/bin/env npx tsx
/**
 * Battery Backup/Restore - Backup and restore battery settings
 *
 * Usage:
 *   npx tsx restore-battery.ts --backup --sn=YOUR_SERIAL_NUMBER
 *   npx tsx restore-battery.ts --list --sn=YOUR_SERIAL_NUMBER
 *   npx tsx restore-battery.ts --restore=./backups/alphaess-backup-{SN}-{TIMESTAMP}.json
 *   npx tsx restore-battery.ts --latest --sn=YOUR_SERIAL_NUMBER
 *
 * Options:
 *   --backup            Create a backup of current settings
 *   --list              List available backups for a system
 *   --restore=FILE      Restore settings from a specific backup file
 *   --latest            Restore the most recent backup for a system
 *   --sn=SERIAL         System serial number
 *   --dry-run           Show what would be restored without applying
 *   --force             Skip confirmations
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
  formatChargeConfig,
  formatDischargeConfig,
  type ChargeConfig,
  type DischargeConfig,
  type BackupFile,
} from './alphaess-api-helpers.js';

// ═══════════════════════════════════════════════════════════════════════════
// CLI PARSING
// ═══════════════════════════════════════════════════════════════════════════

interface CliArgs {
  backup: boolean;
  list: boolean;
  restoreFile: string | null;
  latest: boolean;
  sn: string | null;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    backup: false,
    list: false,
    restoreFile: null,
    latest: false,
    sn: null,
    dryRun: false,
    force: false,
  };

  for (const arg of args) {
    if (arg === '--backup') {
      result.backup = true;
    } else if (arg === '--list') {
      result.list = true;
    } else if (arg.startsWith('--restore=')) {
      result.restoreFile = arg.slice(10);
    } else if (arg === '--latest') {
      result.latest = true;
    } else if (arg.startsWith('--sn=')) {
      result.sn = arg.slice(5);
    } else if (arg === '--dry-run') {
      result.dryRun = true;
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
Battery Backup/Restore - Backup and restore battery settings

Usage:
  npx tsx restore-battery.ts --backup --sn=YOUR_SERIAL_NUMBER
  npx tsx restore-battery.ts --list --sn=YOUR_SERIAL_NUMBER
  npx tsx restore-battery.ts --restore=./backups/alphaess-backup-{SN}-{TIMESTAMP}.json
  npx tsx restore-battery.ts --latest --sn=YOUR_SERIAL_NUMBER

Options:
  --backup            Create a backup of current settings (requires --sn)
  --list              List available backups for a system
  --restore=FILE      Restore settings from a specific backup file
  --latest            Restore the most recent backup for a system
  --sn=SERIAL         System serial number
  --dry-run           Show what would be restored without applying
  --force             Skip confirmations

Examples:
  npx tsx restore-battery.ts --backup --sn=YOUR_SERIAL_NUMBER
  npx tsx restore-battery.ts --list --sn=YOUR_SERIAL_NUMBER
  npx tsx restore-battery.ts --restore=./backups/alphaess-backup-YOUR_SERIAL_NUMBER-2025-01-15T10-30-00.json
  npx tsx restore-battery.ts --latest --sn=YOUR_SERIAL_NUMBER

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

async function confirmWithDouble(message: string, skipAll: boolean): Promise<boolean> {
  if (skipAll) return true;

  const first = await askQuestion(`${message} (yes/N): `);
  if (first.toLowerCase() !== 'yes') {
    return false;
  }

  const second = await askQuestion(`Are you sure? (Y/no): `);
  return second.toLowerCase() !== 'no';
}

interface BackupInfo {
  filename: string;
  sysSn: string;
  timestamp: Date;
  reason: string;
  dischargeConfig: DischargeConfig | null;
  chargeConfig: ChargeConfig | null;
}

function listBackups(sn?: string): BackupInfo[] {
  if (!fs.existsSync('./backups')) {
    return [];
  }

  const files = fs.readdirSync('./backups')
    .filter(f => f.startsWith('alphaess-backup-') && f.endsWith('.json'))
    .filter(f => !sn || f.includes(sn));

  const backups: BackupInfo[] = [];

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(`./backups/${file}`, 'utf8')) as BackupFile;
      backups.push({
        filename: `./backups/${file}`,
        sysSn: data.sysSn,
        timestamp: new Date(data.backupTimestamp),
        reason: data.reason,
        dischargeConfig: data.dischargeConfig,
        chargeConfig: data.chargeConfig,
      });
    } catch {
      // Skip invalid files
    }
  }

  // Sort by timestamp (newest first)
  backups.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  return backups;
}

function formatBackupSummary(backup: BackupInfo): string {
  const lines: string[] = [];

  const dateStr = backup.timestamp.toISOString().replace('T', ' ').slice(0, 19);
  lines.push(`${dateStr} - ${backup.filename}`);
  lines.push(`   Reason: ${backup.reason}`);

  if (backup.dischargeConfig) {
    const dc = backup.dischargeConfig;
    lines.push(`   Discharge: ctrDis=${dc.ctrDis}, ${dc.timeDisf1}-${dc.timeDise1}, ${dc.timeDisf2}-${dc.timeDise2}`);
  }

  if (backup.chargeConfig) {
    const cc = backup.chargeConfig;
    lines.push(`   Charge: gridCharge=${cc.gridCharge}, ${cc.timeChaf1}-${cc.timeChae1}`);
  }

  return lines.join('\n');
}

function saveBackup(
  sysSn: string,
  chargeConfig: ChargeConfig | null,
  dischargeConfig: DischargeConfig | null,
  reason: BackupFile['reason'] = 'manual'
): string {
  if (!fs.existsSync('./backups')) {
    fs.mkdirSync('./backups', { recursive: true });
  }

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
  console.log('🔄 BATTERY RESTORE');
  console.log('═'.repeat(80));

  // List backups
  if (args.list) {
    const backups = listBackups(args.sn ?? undefined);

    if (backups.length === 0) {
      console.log('\nNo backups found.');
      if (!args.sn) {
        console.log('Use --sn=SERIAL to filter by system.');
      }
      return;
    }

    console.log(`\nAvailable backups${args.sn ? ` for ${args.sn}` : ''}:\n`);

    for (let i = 0; i < backups.length; i++) {
      const backup = backups[i]!;
      console.log(`  ${i + 1}. ${formatBackupSummary(backup)}`);
      console.log('');
    }

    return;
  }

  // Manual backup
  if (args.backup) {
    if (!args.sn) {
      console.error('❌ --sn=SERIAL is required with --backup');
      process.exit(1);
    }

    // Check API credentials
    const appID = process.env.ALPHAESS_APP_ID;
    const appSecret = process.env.ALPHAESS_APP_SECRET;

    if (!appID || !appSecret) {
      console.error('❌ ALPHAESS_APP_ID and ALPHAESS_APP_SECRET environment variables are required');
      process.exit(1);
    }

    // Initialize client
    const client = new AlphaESSClient({
      appID,
      appSecret,
      timeout: 30000
    });

    console.log(`\n📡 Fetching current config for ${args.sn}...`);

    let chargeConfig: ChargeConfig | null = null;
    let dischargeConfig: DischargeConfig | null = null;

    try {
      chargeConfig = await getChargeConfig(client, args.sn);
      console.log('   ✓ Charge config fetched');
      await sleep(2000);
    } catch (e) {
      console.warn('⚠️  Could not fetch charge config:', e instanceof Error ? e.message : e);
    }

    try {
      dischargeConfig = await getDischargeConfig(client, args.sn);
      console.log('   ✓ Discharge config fetched');
    } catch (e) {
      console.warn('⚠️  Could not fetch discharge config:', e instanceof Error ? e.message : e);
    }

    if (!chargeConfig && !dischargeConfig) {
      console.error('❌ Could not fetch any configuration from API');
      process.exit(1);
    }

    // Show what we're backing up
    console.log('\n' + '─'.repeat(80));
    if (dischargeConfig) {
      console.log('\n📤 DISCHARGE SETTINGS:');
      const lines = formatDischargeConfig(dischargeConfig);
      for (const line of lines) console.log('  ' + line);
    }
    if (chargeConfig) {
      console.log('\n📥 CHARGE SETTINGS:');
      const lines = formatChargeConfig(chargeConfig);
      for (const line of lines) console.log('  ' + line);
    }
    console.log('─'.repeat(80));

    // Save backup
    const filename = saveBackup(args.sn, chargeConfig, dischargeConfig, 'manual');

    console.log('\n' + '═'.repeat(80));
    console.log('✅ BACKUP CREATED');
    console.log('═'.repeat(80));
    console.log(`   File: ${filename}`);
    console.log(`   Restore with: npx tsx restore-battery.ts --restore=${filename}`);
    console.log('');

    return;
  }

  // Determine which backup to restore
  let backupFile: string | null = args.restoreFile;

  if (args.latest) {
    if (!args.sn) {
      console.error('❌ --sn=SERIAL is required with --latest');
      process.exit(1);
    }

    const backups = listBackups(args.sn);
    if (backups.length === 0) {
      console.error(`❌ No backups found for ${args.sn}`);
      process.exit(1);
    }

    backupFile = backups[0]!.filename;
    console.log(`Using latest backup: ${backupFile}`);
  }

  if (!backupFile) {
    console.error('❌ Either --restore=FILE or --latest is required');
    printHelp();
    process.exit(1);
  }

  // Load backup
  if (!fs.existsSync(backupFile)) {
    console.error(`❌ Backup file not found: ${backupFile}`);
    process.exit(1);
  }

  const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8')) as BackupFile;
  const sysSn = backup.sysSn;

  console.log(`\n📂 Loaded backup: ${backupFile}`);
  console.log(`   System: ${sysSn}`);
  console.log(`   Created: ${backup.backupTimestamp}`);
  console.log(`   Reason: ${backup.reason}`);

  // Check API credentials
  const appID = process.env.ALPHAESS_APP_ID;
  const appSecret = process.env.ALPHAESS_APP_SECRET;

  if (!appID || !appSecret) {
    console.error('❌ ALPHAESS_APP_ID and ALPHAESS_APP_SECRET environment variables are required');
    process.exit(1);
  }

  // Initialize client
  const client = new AlphaESSClient({
    appID,
    appSecret,
    timeout: 30000
  });

  // Fetch current config for comparison
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

  // Show what will be restored
  console.log('\n' + '═'.repeat(80));
  console.log('CURRENT vs BACKUP CONFIGURATION');
  console.log('═'.repeat(80));

  // Discharge
  if (backup.dischargeConfig) {
    console.log('\n📤 DISCHARGE SETTINGS:');
    console.log('─'.repeat(80));

    console.log('\n  CURRENT:');
    const currentLines = formatDischargeConfig(currentDischarge);
    for (const line of currentLines) console.log('  ' + line);

    console.log('\n  WILL RESTORE TO:');
    const backupLines = formatDischargeConfig(backup.dischargeConfig);
    for (const line of backupLines) console.log('  ' + line);
  }

  // Charge
  if (backup.chargeConfig) {
    console.log('\n📥 CHARGE SETTINGS:');
    console.log('─'.repeat(80));

    console.log('\n  CURRENT:');
    const currentLines = formatChargeConfig(currentCharge);
    for (const line of currentLines) console.log('  ' + line);

    console.log('\n  WILL RESTORE TO:');
    const backupLines = formatChargeConfig(backup.chargeConfig);
    for (const line of backupLines) console.log('  ' + line);
  }

  // Dry run exit
  if (args.dryRun) {
    console.log('\n' + '═'.repeat(80));
    console.log('🔍 DRY RUN - No changes applied');
    console.log('   Remove --dry-run to restore these settings');
    console.log('═'.repeat(80));
    return;
  }

  // Rate limit warning
  console.log('\n' + '═'.repeat(80));
  console.log('⚠️  WARNING: AlphaESS API allows only ONE setting change per 24 hours!');
  console.log('   If you restore settings now, you cannot change them again until tomorrow.');
  console.log('═'.repeat(80));

  // Confirm
  const confirmed = await confirmWithDouble('\nRestore these settings?', args.force);

  if (!confirmed) {
    console.log('\n❌ Cancelled');
    return;
  }

  // Backup current settings before restore
  console.log('\n💾 Backing up current settings...');
  const preRestoreBackup = saveBackup(sysSn, currentCharge, currentDischarge, 'pre-restore');
  console.log(`   Saved to: ${preRestoreBackup}`);

  // Restore settings
  console.log('\n🔄 Restoring settings...');

  if (backup.dischargeConfig) {
    console.log('   → Restoring discharge config...');
    try {
      await updateDischargeConfig(client, sysSn, backup.dischargeConfig);
      console.log('   ✓ Discharge config restored');
      await sleep(3000);
    } catch (e) {
      console.error('   ❌ Failed to restore discharge config:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  }

  if (backup.chargeConfig) {
    console.log('   → Restoring charge config...');
    try {
      await updateChargeConfig(client, sysSn, backup.chargeConfig);
      console.log('   ✓ Charge config restored');
      await sleep(3000);
    } catch (e) {
      console.error('   ❌ Failed to restore charge config:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  }

  // Update local data file
  const dataFile = `alphaess-data-${sysSn}.json`;
  if (fs.existsSync(dataFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      if (backup.dischargeConfig) {
        data.dischargeConfig = backup.dischargeConfig;
      }
      if (backup.chargeConfig) {
        data.chargeConfig = backup.chargeConfig;
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
  console.log('✅ RESTORE COMPLETE');
  console.log('═'.repeat(80));
  console.log(`   Pre-restore backup saved to: ${preRestoreBackup}`);
  console.log('');
  console.log('   Check the AlphaESS app to confirm settings are applied.');
  console.log('   Note: Settings may take a few minutes to sync to the inverter.');
  console.log('');
}

main().catch(e => {
  console.error('❌ Error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
