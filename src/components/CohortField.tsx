import FormSection from "./FormSection";

export default function CohortField() {
  return (
    <FormSection title="cohort"
      description="enter cohort description">
      <textarea
        required
        className="form-textarea"
        name="cohort"
        rows={1}
        placeholder="describe the cohort..."
      />
    </FormSection>
  );
}
