import FormSection from "./FormSection";
import SuggestionChips from "./SuggestionChips";
import { STAGE_CODES, STAGE_LABELS, type StageCode } from "@/types/search";

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
      description="enter career stages description">
      <SuggestionChips
        chips={SUGGESTED.map((s) => ({
          label: STAGE_LABELS[s],
          selected: value.includes(s),
          onClick: () => toggle(s),
        }))}
      />
      <div className="form-checks">
        {STAGE_CODES.map((stage) => (
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
