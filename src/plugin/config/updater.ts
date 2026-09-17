/**
 * OpenCode configuration file updater.
 *
 * Updates ~/.config/opencode/opencode.json(c) with plugin models.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { OPENCODE_MODEL_DEFINITIONS } from "./models";

// =============================================================================
// Types
// =============================================================================

export interface UpdateConfigResult {
  success: boolean;
  configPath: string;
  error?: string;
}

export interface OpencodeConfig {
  $schema?: string;
  plugin?: unknown[];
  plugins?: unknown[];
  provider?: {
    google?: {
      models?: Record<string, unknown>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  providers?: {
    google?: {
      models?: Record<string, unknown>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface UpdateConfigOptions {
  /** Override the config file path (for testing) */
  configPath?: string;
}

// =============================================================================
// Constants
// =============================================================================

const PLUGIN_NAME = "opencode-antigravity-auth@latest";
const SCHEMA_URL = "https://opencode.ai/config.json";
const OPENCODE_JSON_FILENAME = "opencode.json";
const OPENCODE_JSONC_FILENAME = "opencode.jsonc";

function stripJsonCommentsAndTrailingCommas(json: string): string {
  return json
    .replace(
      /\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g,
      (match: string, group: string | undefined) => (group ? "" : match)
    )
    .replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Get the opencode config directory path.
 */
export function getOpencodeConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

/**
 * Get the opencode config file path.
 *
 * Prefers opencode.jsonc when present so we update the active config file
 * instead of creating a new opencode.json.
 */
export function getOpencodeConfigPath(): string {
  const configDir = getOpencodeConfigDir();
  const jsoncPath = join(configDir, OPENCODE_JSONC_FILENAME);
  const jsonPath = join(configDir, OPENCODE_JSON_FILENAME);

  if (existsSync(jsoncPath)) {
    return jsoncPath;
  }
  if (existsSync(jsonPath)) {
    return jsonPath;
  }

  return jsonPath;
}

// =============================================================================
// Main Function
// =============================================================================

/**
 * Updates the opencode configuration file with plugin models.
 *
 * This function:
 * 1. Reads existing opencode.json/opencode.jsonc (or creates default structure)
 * 2. Uses V2 native keys (`plugins` and `providers`) while supporting legacy V1
 * 3. Replaces google models with plugin models
 * 4. Writes back to disk with proper formatting
 *
 * Preserves:
 * - $schema and other top-level config keys
 * - Non-google provider sections
 * - Other settings within google provider (except models)
 *
 * @param options - Optional configuration (e.g., custom configPath for testing)
 * @returns UpdateConfigResult with success status and path
 */
export async function updateOpencodeConfig(
  options: UpdateConfigOptions = {}
): Promise<UpdateConfigResult> {
  const configPath = options.configPath ?? getOpencodeConfigPath();

  try {
    let config: OpencodeConfig;

    // Read existing config or create default
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, "utf-8");
      config = JSON.parse(stripJsonCommentsAndTrailingCommas(content)) as OpencodeConfig;
    } else {
      // Create default V2 config structure
      config = {
        $schema: SCHEMA_URL,
        plugins: [],
        providers: {},
      };
    }

    // Ensure $schema is set
    if (!config.$schema) {
      config.$schema = SCHEMA_URL;
    }

    // Determine target plugins list (prefer V2 `plugins`, fallback to legacy `plugin`)
    const hasV2Plugins = Array.isArray(config.plugins);
    const hasV1Plugin = Array.isArray(config.plugin);

    let targetPluginsList: unknown[];
    if (hasV2Plugins) {
      targetPluginsList = config.plugins!;
    } else if (hasV1Plugin) {
      // Migrate V1 `plugin` to V2 `plugins`
      config.plugins = [...config.plugin!];
      delete config.plugin;
      targetPluginsList = config.plugins;
    } else {
      config.plugins = [];
      targetPluginsList = config.plugins;
    }

    // Check if plugin is already in the list (package name or local path or object)
    const hasPlugin = targetPluginsList.some((item) => {
      if (typeof item === "string") {
        return item.includes("opencode-antigravity-auth");
      }
      if (item && typeof item === "object" && "package" in item) {
        return String((item as { package: unknown }).package).includes("opencode-antigravity-auth");
      }
      return false;
    });

    if (!hasPlugin) {
      targetPluginsList.push(PLUGIN_NAME);
    }

    // Determine target providers section (prefer V2 `providers`, fallback to legacy `provider`)
    const hasV2Providers = config.providers && typeof config.providers === "object";
    const hasV1Provider = config.provider && typeof config.provider === "object";

    let targetProviders: Record<string, unknown>;
    if (hasV2Providers) {
      targetProviders = config.providers!;
    } else if (hasV1Provider) {
      // Migrate V1 `provider` to V2 `providers`
      config.providers = { ...config.provider! };
      delete config.provider;
      targetProviders = config.providers;
    } else {
      config.providers = {};
      targetProviders = config.providers;
    }

    // Ensure google provider object exists
    if (!targetProviders.google || typeof targetProviders.google !== "object") {
      targetProviders.google = {};
    }

    const googleProvider = targetProviders.google as Record<string, unknown>;

    // Replace google models with plugin models
    googleProvider.models = { ...OPENCODE_MODEL_DEFINITIONS };

    // Ensure config directory exists
    const configDir = dirname(configPath);
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    // Write config with proper formatting (2-space indent)
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    return {
      success: true,
      configPath,
    };
  } catch (error) {
    return {
      success: false,
      configPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
