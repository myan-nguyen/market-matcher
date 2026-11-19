import FormSection from "./FormSection";

export default function CohortField() {
  return (
    <FormSection title="cohort"
      description="five-six words describing the cohort in question">
      <textarea
        required
        className="form-textarea"
        name="cohort"
        rows={1}
        placeholder="ex: computational and quantitative biomedical research"
      />
    </FormSection>
  );
}
