import fs from "fs";
import path from "path";

export const SETPOINT_TEMP_KEY = "Cooking.Oven.Option.SetpointTemperature";

const BASE_URL = "https://api.home-connect.com";
const DEVICE_AUTH_URL = `${BASE_URL}/security/oauth/device_authorization`;
const TOKEN_URL = `${BASE_URL}/security/oauth/token`;
const API_URL = `${BASE_URL}/api`;

interface TokenData {
  accessToken: string;
  refreshToken: string;
}

export interface HCAppliance {
  haId: string;
  type: string;
  name: string;
  brand: string;
  connected: boolean;
}

export interface HCProgram {
  key: string;
  name?: string;
}

export interface HCOptionConstraints {
  min?: number;
  max?: number;
  stepsize?: number;
}

export interface HCProgramOption {
  key: string;
  unit?: string;
  constraints?: HCOptionConstraints;
}

export interface HCStatusEntry {
  key: string;
  value: unknown;
  unit?: string;
}

export interface HCActiveProgram {
  key: string;
  options: Array<{ key: string; value: unknown; unit?: string }>;
}

type SimpleLogger = { info: (s: string) => void; error: (s: string) => void };

export class HomeConnect {
  private tokenData: TokenData | null = null;
  private readonly tokenPath: string;

  constructor(
    private readonly clientId: string,
    storagePath: string,
  ) {
    this.tokenPath = path.join(storagePath, "homebridge-griffin-home-connect-tokens.json");
  }

  async initialize(log: SimpleLogger): Promise<void> {
    if (fs.existsSync(this.tokenPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.tokenPath, "utf-8")) as TokenData;
        this.tokenData = data;
        log.info("[HomeConnect] Loaded stored tokens");
        return;
      } catch {
        log.error("[HomeConnect] Failed to parse stored tokens, re-authorizing");
      }
    }

    const deviceRes = await fetch(DEVICE_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.clientId, scope: "IdentifyAppliance Monitor Control" }),
    });

    if (!deviceRes.ok) {
      throw new Error(`Device authorization request failed: ${deviceRes.status} ${await deviceRes.text()}`);
    }

    const deviceData = await deviceRes.json() as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };

    log.info(`[HomeConnect] Visit ${deviceData.verification_uri} and enter code: ${deviceData.user_code}`);
    log.info("[HomeConnect] Waiting for authorization...");

    const pollIntervalMs = (deviceData.interval ?? 5) * 1000;
    const expiresAt = Date.now() + (deviceData.expires_in ?? 1800) * 1000;

    while (Date.now() < expiresAt) {
      await new Promise(r => setTimeout(r, pollIntervalMs));

      const tokenRes = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceData.device_code,
          client_id: this.clientId,
        }),
      });

      const tokenText = await tokenRes.text();
      let tokenData: { access_token?: string; refresh_token?: string; error?: string };
      try {
        tokenData = JSON.parse(tokenText);
      } catch {
        throw new Error(`Token endpoint returned non-JSON (${tokenRes.status}): ${tokenText}`);
      }

      if (tokenData.access_token) {
        this.tokenData = {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token ?? "",
        };
        this.saveTokens();
        log.info("[HomeConnect] Authorization successful");
        return;
      }

      if (tokenData.error !== "authorization_pending" && tokenData.error !== "slow_down") {
        throw new Error(`Authorization failed: ${tokenData.error}`);
      }
    }

    throw new Error("[HomeConnect] Authorization timed out — restart homebridge and try again");
  }

  private saveTokens(): void {
    if (this.tokenData) {
      fs.writeFileSync(this.tokenPath, JSON.stringify(this.tokenData), "utf-8");
    }
  }

  private async refreshToken(): Promise<void> {
    if (!this.tokenData) throw new Error("Not authenticated");

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.tokenData.refreshToken,
        client_id: this.clientId,
      }),
    });

    if (!res.ok) {
      throw new Error("[HomeConnect] Token refresh failed — delete stored tokens and restart homebridge to re-authorize");
    }

    const data = await res.json() as { access_token: string; refresh_token?: string };
    this.tokenData = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? this.tokenData.refreshToken,
    };
    this.saveTokens();
  }

  private async withAuth(request: () => Promise<Response>): Promise<Response> {
    const res = await request();
    if (res.status !== 401 && res.status !== 403) return res;
    await this.refreshToken();
    const retryRes = await request();
    if (retryRes.status === 401 || retryRes.status === 403) {
      throw new Error("[HomeConnect] Authorization failed after token refresh — delete stored tokens and restart homebridge to re-authorize");
    }
    return retryRes;
  }

  private get authHeader(): { Authorization: string } {
    if (!this.tokenData) throw new Error("Not authenticated");
    return { Authorization: `Bearer ${this.tokenData.accessToken}` };
  }

  async getAppliances(): Promise<HCAppliance[]> {
    const res = await this.withAuth(() =>
      fetch(`${API_URL}/homeappliances`, { headers: this.authHeader }),
    );
    if (!res.ok) throw new Error(`getAppliances failed (${res.status}): ${await res.text()}`);
    const data = await res.json() as { data: { homeappliances: HCAppliance[] } };
    return data.data.homeappliances ?? [];
  }

  async getAvailablePrograms(haId: string): Promise<HCProgram[]> {
    const res = await this.withAuth(() =>
      fetch(`${API_URL}/homeappliances/${haId}/programs/available`, { headers: this.authHeader }),
    );
    if (!res.ok) return [];
    const data = await res.json() as { data: { programs: HCProgram[] } };
    return data.data.programs ?? [];
  }

  async getStatus(haId: string): Promise<HCStatusEntry[]> {
    const res = await this.withAuth(() =>
      fetch(`${API_URL}/homeappliances/${haId}/status`, { headers: this.authHeader }),
    );
    if (!res.ok) return [];
    const data = await res.json() as { data: { status: HCStatusEntry[] } };
    return data.data.status ?? [];
  }

  async getActiveProgram(haId: string): Promise<HCActiveProgram | null> {
    const res = await this.withAuth(() =>
      fetch(`${API_URL}/homeappliances/${haId}/programs/active`, { headers: this.authHeader }),
    );
    if (!res.ok) return null;
    const data = await res.json() as { data: HCActiveProgram };
    return data.data ?? null;
  }

  async startProgram(haId: string, programKey: string, setpoint?: number, unit = "°C", durationSeconds?: number): Promise<void> {
    const options: Array<{ key: string; value: number | string; unit?: string }> = [];
    if (setpoint !== undefined) options.push({ key: SETPOINT_TEMP_KEY, value: setpoint, unit });
    if (durationSeconds !== undefined) options.push({ key: "BSH.Common.Option.Duration", value: durationSeconds });
    const body = { data: { key: programKey, options } };
    console.log(`[HomeConnect] startProgram ${haId} body: ${JSON.stringify(body)}`);
    const res = await this.withAuth(() =>
      fetch(`${API_URL}/homeappliances/${haId}/programs/active`, {
        method: "PUT",
        headers: { ...this.authHeader, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) throw new Error(`startProgram failed (${res.status}): ${await res.text()}`);
  }

  async stopProgram(haId: string): Promise<void> {
    const res = await this.withAuth(() =>
      fetch(`${API_URL}/homeappliances/${haId}/programs/active`, {
        method: "DELETE",
        headers: this.authHeader,
      }),
    );
    if (!res.ok && res.status !== 409) throw new Error(`stopProgram failed (${res.status}): ${await res.text()}`);
  }

  async getProgramDetail(haId: string, programKey: string): Promise<HCProgramOption[]> {
    const res = await this.withAuth(() =>
      fetch(`${API_URL}/homeappliances/${haId}/programs/available/${encodeURIComponent(programKey)}`, { headers: this.authHeader }),
    );
    if (!res.ok) return [];
    const data = await res.json() as { data: { options: HCProgramOption[] } };
    return data.data.options ?? [];
  }
}
