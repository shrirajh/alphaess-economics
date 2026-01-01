/**
 * AlphaESS API Helpers
 *
 * Workaround for bugs in alphaess-client library:
 * - getChargeConfigInfo calls wrong endpoint (/getSumDataForCustomer instead of /getChargeConfigInfo)
 * - updateDischargeConfigInfo calls wrong endpoint (/updateChargeConfigInfo instead of /updateDisChargeConfigInfo)
 *
 * This module provides fixed versions that call the correct endpoints.
 */

import AlphaESSClient from 'alphaess-client';

// ═══════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

export interface ChargeConfig {
  batHighCap: number;    // Charging Stops at SOC [%]
  gridCharge: number;    // Enable Grid Charging Battery (0=off, 1=on)
  timeChaf1: string;     // Charging Period 1 start time (HH:mm)
  timeChae1: string;     // Charging Period 1 end time (HH:mm)
  timeChaf2: string;     // Charging Period 2 start time (HH:mm)
  timeChae2: string;     // Charging Period 2 end time (HH:mm)
}

export interface DischargeConfig {
  batUseCap: number;     // Discharging Cutoff SOC [%] (reserve)
  ctrDis: number;        // Enable Battery Discharge Time Control (0=off, 1=on)
  timeDisf1: string;     // Discharging Period 1 start time (HH:mm)
  timeDise1: string;     // Discharging Period 1 end time (HH:mm)
  timeDisf2: string;     // Discharging Period 2 start time (HH:mm)
  timeDise2: string;     // Discharging Period 2 end time (HH:mm)
}

export interface RecommendedConfig {
  sysSn: string;
  generatedAt: string;
  tariff: string;
  currentConfig: {
    discharge: DischargeConfig | null;
    charge: ChargeConfig | null;
  };
  recommendedConfig: {
    discharge: DischargeConfig;
    charge: ChargeConfig;
  };
  estimatedAnnualSavings: number;
  reasoning: string[];
}

export interface BackupFile {
  sysSn: string;
  backupTimestamp: string;
  chargeConfig: ChargeConfig | null;
  dischargeConfig: DischargeConfig | null;
  reason: 'pre-optimization' | 'manual' | 'pre-restore';
}

// ═══════════════════════════════════════════════════════════════════════════
// FIXED API CALLS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get charge configuration (FIXED - bypasses buggy client method)
 * The alphaess-client library incorrectly calls /getSumDataForCustomer
 */
export async function getChargeConfig(client: AlphaESSClient, sysSn: string): Promise<ChargeConfig> {
  // Access the internal API and call the correct endpoint
  const api = (client as any).api;
  if (!api) {
    throw new Error('Cannot access internal API from AlphaESSClient');
  }
  return api.get('/getChargeConfigInfo', { sysSn });
}

/**
 * Update charge configuration
 * This method works correctly in the library, but we include it for consistency
 */
export async function updateChargeConfig(
  client: AlphaESSClient,
  sysSn: string,
  settings: ChargeConfig
): Promise<ChargeConfig> {
  const api = (client as any).api;
  if (!api) {
    throw new Error('Cannot access internal API from AlphaESSClient');
  }
  return api.post('/updateChargeConfigInfo', { sysSn, ...settings });
}

/**
 * Get discharge configuration
 * This method works correctly in the library, but we include it for consistency
 */
export async function getDischargeConfig(client: AlphaESSClient, sysSn: string): Promise<DischargeConfig> {
  // The library method works, but let's use direct call for consistency
  const api = (client as any).api;
  if (!api) {
    throw new Error('Cannot access internal API from AlphaESSClient');
  }
  return api.get('/getDisChargeConfigInfo', { sysSn });
}

/**
 * Update discharge configuration (FIXED - bypasses buggy client method)
 * The alphaess-client library incorrectly calls /updateChargeConfigInfo
 */
export async function updateDischargeConfig(
  client: AlphaESSClient,
  sysSn: string,
  settings: DischargeConfig
): Promise<DischargeConfig> {
  const api = (client as any).api;
  if (!api) {
    throw new Error('Cannot access internal API from AlphaESSClient');
  }
  return api.post('/updateDisChargeConfigInfo', { sysSn, ...settings });
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate time format for AlphaESS API
 * Must be HH:mm in 15-minute intervals (00, 15, 30, 45)
 */
export function validateTime(time: string): boolean {
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return false;

  const h = parseInt(match[1]!, 10);
  const m = parseInt(match[2]!, 10);

  return h >= 0 && h <= 23 && [0, 15, 30, 45].includes(m);
}

/**
 * Round time to nearest 15-minute interval
 */
export function roundToQuarterHour(time: string): string {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return time;

  const h = parseInt(match[1]!, 10);
  const m = parseInt(match[2]!, 10);

  // Round minutes to nearest 15
  const roundedM = Math.round(m / 15) * 15;

  // Handle overflow
  if (roundedM === 60) {
    const newH = (h + 1) % 24;
    return `${String(newH).padStart(2, '0')}:00`;
  }

  return `${String(h).padStart(2, '0')}:${String(roundedM).padStart(2, '0')}`;
}

/**
 * Validate discharge config before sending to API
 */
export function validateDischargeConfig(config: DischargeConfig): string[] {
  const errors: string[] = [];

  if (config.batUseCap < 0 || config.batUseCap > 100) {
    errors.push(`batUseCap must be 0-100, got ${config.batUseCap}`);
  }

  if (config.ctrDis !== 0 && config.ctrDis !== 1) {
    errors.push(`ctrDis must be 0 or 1, got ${config.ctrDis}`);
  }

  for (const field of ['timeDisf1', 'timeDise1', 'timeDisf2', 'timeDise2'] as const) {
    if (!validateTime(config[field])) {
      errors.push(`${field} must be HH:mm in 15-min intervals, got "${config[field]}"`);
    }
  }

  return errors;
}

/**
 * Validate charge config before sending to API
 */
export function validateChargeConfig(config: ChargeConfig): string[] {
  const errors: string[] = [];

  if (config.batHighCap < 0 || config.batHighCap > 100) {
    errors.push(`batHighCap must be 0-100, got ${config.batHighCap}`);
  }

  if (config.gridCharge !== 0 && config.gridCharge !== 1) {
    errors.push(`gridCharge must be 0 or 1, got ${config.gridCharge}`);
  }

  for (const field of ['timeChaf1', 'timeChae1', 'timeChaf2', 'timeChae2'] as const) {
    if (!validateTime(config[field])) {
      errors.push(`${field} must be HH:mm in 15-min intervals, got "${config[field]}"`);
    }
  }

  return errors;
}

// ═══════════════════════════════════════════════════════════════════════════
// DISPLAY HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Format discharge config for display
 */
export function formatDischargeConfig(config: DischargeConfig | null): string[] {
  if (!config) return ['  (not available)'];

  const lines: string[] = [];
  lines.push(`  Control:    ${config.ctrDis === 1 ? 'ENABLED' : 'DISABLED'} (ctrDis=${config.ctrDis})`);

  const period1Set = config.timeDisf1 !== '00:00' || config.timeDise1 !== '00:00';
  const period2Set = config.timeDisf2 !== '00:00' || config.timeDise2 !== '00:00';

  if (period1Set) {
    lines.push(`  Period 1:   ${config.timeDisf1}-${config.timeDise1}`);
  } else {
    lines.push(`  Period 1:   not set (00:00-00:00)`);
  }

  if (period2Set) {
    lines.push(`  Period 2:   ${config.timeDisf2}-${config.timeDise2}`);
  } else {
    lines.push(`  Period 2:   not set (00:00-00:00)`);
  }

  lines.push(`  Reserve:    ${config.batUseCap}%`);

  return lines;
}

/**
 * Format charge config for display
 */
export function formatChargeConfig(config: ChargeConfig | null): string[] {
  if (!config) return ['  (not available)'];

  const lines: string[] = [];
  lines.push(`  Grid charge: ${config.gridCharge === 1 ? 'ENABLED' : 'DISABLED'} (gridCharge=${config.gridCharge})`);

  const period1Set = config.timeChaf1 !== '00:00' || config.timeChae1 !== '00:00';
  const period2Set = config.timeChaf2 !== '00:00' || config.timeChae2 !== '00:00';

  if (period1Set) {
    lines.push(`  Period 1:   ${config.timeChaf1}-${config.timeChae1}`);
  } else {
    lines.push(`  Period 1:   not set (00:00-00:00)`);
  }

  if (period2Set) {
    lines.push(`  Period 2:   ${config.timeChaf2}-${config.timeChae2}`);
  } else {
    lines.push(`  Period 2:   not set (00:00-00:00)`);
  }

  lines.push(`  Max charge: ${config.batHighCap}%`);

  return lines;
}

/**
 * Compare two configs and return differences
 */
export function diffDischargeConfig(
  current: DischargeConfig | null,
  recommended: DischargeConfig
): { field: string; current: string; recommended: string }[] {
  const diffs: { field: string; current: string; recommended: string }[] = [];

  if (!current) {
    return [{ field: 'all', current: '(unknown)', recommended: '(new config)' }];
  }

  if (current.ctrDis !== recommended.ctrDis) {
    diffs.push({
      field: 'Control (ctrDis)',
      current: current.ctrDis === 1 ? 'ENABLED' : 'DISABLED',
      recommended: recommended.ctrDis === 1 ? 'ENABLED' : 'DISABLED'
    });
  }

  if (current.timeDisf1 !== recommended.timeDisf1 || current.timeDise1 !== recommended.timeDise1) {
    diffs.push({
      field: 'Period 1',
      current: `${current.timeDisf1}-${current.timeDise1}`,
      recommended: `${recommended.timeDisf1}-${recommended.timeDise1}`
    });
  }

  if (current.timeDisf2 !== recommended.timeDisf2 || current.timeDise2 !== recommended.timeDise2) {
    diffs.push({
      field: 'Period 2',
      current: `${current.timeDisf2}-${current.timeDise2}`,
      recommended: `${recommended.timeDisf2}-${recommended.timeDise2}`
    });
  }

  if (current.batUseCap !== recommended.batUseCap) {
    diffs.push({
      field: 'Reserve (batUseCap)',
      current: `${current.batUseCap}%`,
      recommended: `${recommended.batUseCap}%`
    });
  }

  return diffs;
}

export function diffChargeConfig(
  current: ChargeConfig | null,
  recommended: ChargeConfig
): { field: string; current: string; recommended: string }[] {
  const diffs: { field: string; current: string; recommended: string }[] = [];

  if (!current) {
    return [{ field: 'all', current: '(unknown)', recommended: '(new config)' }];
  }

  if (current.gridCharge !== recommended.gridCharge) {
    diffs.push({
      field: 'Grid Charge',
      current: current.gridCharge === 1 ? 'ENABLED' : 'DISABLED',
      recommended: recommended.gridCharge === 1 ? 'ENABLED' : 'DISABLED'
    });
  }

  if (current.timeChaf1 !== recommended.timeChaf1 || current.timeChae1 !== recommended.timeChae1) {
    diffs.push({
      field: 'Period 1',
      current: `${current.timeChaf1}-${current.timeChae1}`,
      recommended: `${recommended.timeChaf1}-${recommended.timeChae1}`
    });
  }

  if (current.timeChaf2 !== recommended.timeChaf2 || current.timeChae2 !== recommended.timeChae2) {
    diffs.push({
      field: 'Period 2',
      current: `${current.timeChaf2}-${current.timeChae2}`,
      recommended: `${recommended.timeChaf2}-${recommended.timeChae2}`
    });
  }

  if (current.batHighCap !== recommended.batHighCap) {
    diffs.push({
      field: 'Max Charge (batHighCap)',
      current: `${current.batHighCap}%`,
      recommended: `${recommended.batHighCap}%`
    });
  }

  return diffs;
}
