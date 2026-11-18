import { CUSTOMIZATION_SETTINGS_BYTES, parseCustomizationSettings as parseSettingsValue, serializeCustomizationSettings } from '@agentui/contracts/service';
import type { CustomizationSettings } from '@agentui/contracts/service';
import { CustomizationError } from './contract.js';

/** The optional settings file beside the root package's package.json. It is never a build input. */
export const customizationSettingsFile = 'agentui-settings.json';
export { serializeCustomizationSettings };
export type { CustomizationSettings };

export function parseCustomizationSettings(bytes: Uint8Array | string): CustomizationSettings {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  try {
    if (buffer.length > CUSTOMIZATION_SETTINGS_BYTES) throw new Error('Settings too large');
    return parseSettingsValue(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)));
  } catch {
    throw new CustomizationError('invalid-settings', 'Invalid AgentUI settings file.');
  }
}
