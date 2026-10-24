// The Mac switches Ghostbar took over from separate apps: the VPN (exit
// country) and Awake, one switch for what MouseJiggler (Teams stays Available)
// and Insone (no sleep with the lid closed) did. Shared by the sidebar and Today.
import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";

export interface VpnCountry {
  code: string;
  name: string;
  flag: string;
}
export interface VpnState {
  phase: "off" | "starting" | "on" | "stopping" | "failed";
  country: VpnCountry | null;
  reason: string | null;
  countries: VpnCountry[];
}
export interface MacTools {
  awake: boolean;
  jiggler: boolean;
  lid_awake: boolean | null;
  lid_rule: boolean;
}

export function useVpn() {
  const [vpn, setVpn] = useState<VpnState | null>(null);
  useEffect(() => {
    invoke<VpnState>("vpn_state").then(setVpn).catch(() => {});
    const off = listen<VpnState>("vpn-state", (e) => setVpn(e.payload));
    return () => {
      off.then((f) => f());
    };
  }, []);
  return vpn;
}

export function useMacTools() {
  const [tools, setTools] = useState<MacTools | null>(null);
  useEffect(() => {
    invoke<MacTools>("mac_tools_state").then(setTools).catch(() => {});
    const off = listen<MacTools>("mac-tools", (e) => setTools(e.payload));
    return () => {
      off.then((f) => f());
    };
  }, []);
  return tools;
}

export const vpnBusy = (vpn: VpnState) => vpn.phase === "starting" || vpn.phase === "stopping";

export const vpnLabel = (vpn: VpnState) =>
  vpn.phase === "on" && vpn.country
    ? `${vpn.country.flag} ${vpn.country.name}`
    : vpn.phase === "starting" && vpn.country
      ? `Connecting to ${vpn.country.name}…`
      : vpn.phase === "stopping"
        ? "Turning off…"
        : vpn.phase === "failed"
          ? "Failed"
          : "Off";

/** The country picker: Off and every country, the current one ticked. */
export async function pickVpn(vpn: VpnState) {
  const busy = vpnBusy(vpn);
  const current = vpn.phase === "on" || vpn.phase === "starting" ? vpn.country?.code : "off";
  const select = (choice: string) => () => void invoke("vpn_select", { choice });
  const items = [
    ...(vpn.phase === "failed" && vpn.reason
      ? [await MenuItem.new({ text: vpn.reason.slice(0, 80), enabled: false }), await PredefinedMenuItem.new({ item: "Separator" })]
      : []),
    await CheckMenuItem.new({ text: "Off", checked: current === "off", enabled: !busy, action: select("off") }),
    await PredefinedMenuItem.new({ item: "Separator" }),
    ...(await Promise.all(
      vpn.countries.map((c) =>
        CheckMenuItem.new({ text: `${c.flag}  ${c.name}`, checked: current === c.code, enabled: !busy, action: select(c.code) }),
      ),
    )),
  ];
  await (await Menu.new({ items })).popup();
}

const Switch: React.FC<{ on: boolean; busy?: boolean }> = ({ on, busy }) => (
  <span className={`mac-switch${on ? " on" : ""}${busy ? " busy" : ""}`} aria-hidden />
);

/** Today's two switches: Awake, then the VPN. */
export const MacToggles: React.FC = () => {
  const vpn = useVpn();
  const tools = useMacTools();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const off = listen<string>("mac-tools-error", (e) => setError(e.payload));
    return () => {
      off.then((f) => f());
    };
  }, []);

  const setAwake = async (on: boolean) => {
    setError(null);
    setBusy(true);
    try {
      await invoke("mac_set_awake", { on });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="switches" aria-label="Mac">
        {tools && (
          <button
            className="switch-cell"
            disabled={busy}
            onClick={() => void setAwake(!tools.awake)}
            title="On: the Mac doesn't sleep, even with the lid closed, and Teams stays Available. Off: both relax."
          >
            <span className="t">☕ Awake</span>
            <span className="v">{tools.awake ? "Won't sleep · Teams stays Available" : "Sleeps as usual"}</span>
            <Switch on={tools.awake} busy={busy} />
          </button>
        )}
        {vpn && (
          <button className="switch-cell" onClick={() => void pickVpn(vpn)} title={vpn.reason ?? "Where the Mac's internet exits"}>
            <span className="t">🌍 VPN</span>
            <span className="v">{vpnLabel(vpn)}</span>
            <Switch on={vpn.phase === "on"} busy={vpnBusy(vpn)} />
          </button>
        )}
      </section>
      {error && <p className="gus-error">{error}</p>}
    </>
  );
};
