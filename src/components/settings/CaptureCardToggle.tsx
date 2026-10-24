import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ToggleSwitch } from "../ui/ToggleSwitch";

/** The card in the corner after a screenshot or a Cast. */
export const CaptureCardToggle: React.FC<{ grouped?: boolean }> = ({ grouped = true }) => {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    invoke<boolean>("capture_card_settings").then(setOn).catch(() => {});
  }, []);
  if (on === null) return null;
  return (
    <ToggleSwitch
      checked={on}
      onChange={async (next) => {
        setOn(next);
        await invoke("capture_card_set_enabled", { enabled: next });
      }}
      label="Card after each capture"
      description="A small card in the corner after a screenshot or a Cast: copy, edit, show in Finder, or drag it into any app. Off opens a Cast in the video page instead."
      grouped={grouped}
    />
  );
};
