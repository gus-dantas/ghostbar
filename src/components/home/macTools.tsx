// The Mac switches Gus Assistant took over from separate apps: the VPN (exit
// country), keeping Teams available (was MouseJiggler) and staying awake with
// the lid closed (was Insone). Shared by the sidebar and Today.
import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { Globe, MousePointer2, Zap, MoonStar } from "lucide-react";

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

/** Today's row of Mac switches. */
export const MacToggles: React.FC = () => {
  const vpn = useVpn();
  const tools = useMacTools();
  const [error, setError] = useState<string | null>(null);
  const [lidBusy, setLidBusy] = useState(false);
  useEffect(() => {
    const off = listen<string>("mac-tools-error", (e) => setError(e.payload));
    return () => {
      off.then((f) => f());
    };
  }, []);

  const setLid = async (on: boolean) => {
    setError(null);
    setLidBusy(true);
    try {
      await invoke("mac_set_lid_awake", { on });
    } catch (e) {
      setError(String(e));
    } finally {
      setLidBusy(false);
    }
  };

  return (
    <>
      <section className="mac-row" aria-label="Mac">
        {vpn && (
          <button className={`mac-tile${vpn.phase === "on" ? " on" : ""}`} onClick={() => void pickVpn(vpn)} title={vpn.reason ?? "Where the Mac's internet exits"}>
            <Globe size={16} />
            <span className="t">VPN</span>
            <span className="v">{vpnLabel(vpn)}</span>
            <Switch on={vpn.phase === "on"} busy={vpnBusy(vpn)} />
          </button>
        )}
        {tools && (
          <button
            className={`mac-tile${tools.jiggler ? " on" : ""}`}
            onClick={() => void invoke("mac_set_keep_available", { on: !tools.jiggler })}
            title="While you're away, the pointer moves one pixel now and then so Teams stays Available"
          >
            <MousePointer2 size={16} />
            <span className="t">Keep Teams available</span>
            <span className="v">{tools.jiggler ? "On while you're away" : "Off"}</span>
            <Switch on={tools.jiggler} />
          </button>
        )}
        {tools && (
          <button
            className={`mac-tile${tools.lid_awake ? " on" : ""}`}
            disabled={tools.lid_awake === null || lidBusy}
            onClick={() => void setLid(!tools.lid_awake)}
            title="Keeps the Mac running with the lid closed (pmset disablesleep)"
          >
            {tools.lid_awake ? <Zap size={16} /> : <MoonStar size={16} />}
            <span className="t">Awake with the lid closed</span>
            <span className="v">{tools.lid_awake === null ? "Can't read it" : tools.lid_awake ? "Stays on" : "Sleeps as usual"}</span>
            <Switch on={!!tools.lid_awake} busy={lidBusy} />
          </button>
        )}
      </section>
      {error && <p className="gus-error">{error}</p>}
    </>
  );
};
