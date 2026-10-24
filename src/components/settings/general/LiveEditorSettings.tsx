import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { commands } from "@/bindings";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { SettingContainer } from "../../ui/SettingContainer";
import { ToggleSwitch } from "../../ui/ToggleSwitch";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button";

interface DictationSettings {
  live_editor: boolean;
  refiner: string | null;
  proofreader: string;
  has_anthropic_key: boolean;
}

const modelName = (id: string | null) => {
  if (!id) return "Not downloaded";
  const file = id.split("/").pop() || id;
  const quant = file.match(/(Q\d[_A-Z0-9]*|BF16|F16)\.gguf$/)?.[1];
  return id.includes("cohere-transcribe") ? `Cohere Transcribe${quant ? ` (${quant})` : ""}` : file;
};

/** The editable panel, its second pass and the Cmd+Enter proofread. */
export const LiveEditorSettings: React.FC = () => {
  const [state, setState] = useState<DictationSettings | null>(null);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = () => invoke<DictationSettings>("dictation_settings").then(setState).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);

  const toggle = async (on: boolean) => {
    await invoke("dictation_set_live_editor", { enabled: on });
    refresh();
  };
  const saveKey = async () => {
    setSaving(true);
    await commands.changePostProcessApiKeySetting("anthropic", key.trim());
    setKey("");
    setSaving(false);
    refresh();
  };

  if (!state) return null;
  const proofreader =
    state.proofreader === "Claude Haiku"
      ? "Claude Haiku 5.5"
      : state.proofreader === "Apple Intelligence"
        ? "Apple Intelligence (basic, add a key for Claude)"
        : "Needs an Anthropic key";

  return (
    <SettingsGroup title="Live editor">
      <ToggleSwitch
        checked={state.live_editor}
        onChange={toggle}
        label="Edit while you talk"
        description="Dictation opens a panel you can type into while talking. Enter pastes, ⌘Enter proofreads then pastes, Esc closes."
        grouped={true}
      />
      <SettingContainer
        title="Accurate second pass"
        description="At each pause this model re-hears what you said and replaces the live text, unless you edited it."
        grouped={true}
      >
        <span className="text-sm text-mid-gray">{modelName(state.refiner)}</span>
      </SettingContainer>
      <SettingContainer
        title="Proofreading (⌘Enter)"
        description="Uses the instructions written from your proofreading chat: fixes misheard words, punctuation and paragraphs without changing what you meant."
        grouped={true}
        layout="stacked"
      >
        <div className="flex items-center gap-2 w-full">
          <span className="text-sm text-mid-gray flex-1">{proofreader}</span>
          <Input
            type="password"
            variant="compact"
            placeholder={state.has_anthropic_key ? "Anthropic key saved" : "Anthropic API key"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="w-64"
          />
          <Button size="sm" onClick={saveKey} disabled={saving || !key.trim()}>
            Save
          </Button>
        </div>
      </SettingContainer>
    </SettingsGroup>
  );
};
