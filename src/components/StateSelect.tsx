import FormSection from "./FormSection";
import SuggestionChips from "./SuggestionChips";
import { US_STATES } from "@/lib/states";

type Props = {
  value: string;
  onChange: (code: string) => void;
};

export default function StateSelect({ value, onChange }: Props) {
  return (
    <FormSection title="state"
      description="self-explanatory (multi-select coming soon)">
      <SuggestionChips
        chips={[
          {
            label: "Rhode Island",
            selected: value === "RI",
            onClick: () => onChange(value === "RI" ? "" : "RI"),
          },
        ]}
      />
      <select
        className="form-input"
        name="state"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">(no state constraint)</option>
        {US_STATES.map((s) => (
          <option key={s.code} value={s.code}>
            {s.name}
          </option>
        ))}
      </select>
    </FormSection>
  );
}
