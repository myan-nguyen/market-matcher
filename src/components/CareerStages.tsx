import FormSection from "./FormSection";
import SuggestionChips from "./SuggestionChips";
import { SHOWN_STAGES, STAGE_LABELS, type StageCode } from "@/types/search";

type Props = {
  value: StageCode[];
  onChange: (stages: StageCode[]) => void;
};

const SUGGESTED: StageCode[] = ["postdoc", "advanced-phd"];

export default function CareerStages({ value, onChange }: Props) {
  function toggle(stage: StageCode) {
    onChange(value.includes(stage) ? value.filter((s) => s !== stage) : [...value, stage]);
  }

  return (
    <FormSection title="career stages"
      description="also self-explanatory">
      <SuggestionChips
        chips={SUGGESTED.map((s) => ({
          label: STAGE_LABELS[s],
          selected: value.includes(s),
          onClick: () => toggle(s),
        }))}
      />
      <div className="form-checks">
        {SHOWN_STAGES.map((stage) => (
          <label key={stage} className="form-check">
            <input
              type="checkbox"
              name="stages"
              value={stage}
              checked={value.includes(stage)}
              onChange={() => toggle(stage)}
            />
            {STAGE_LABELS[stage]}
          </label>
        ))}
      </div>
    </FormSection>
  );
}
