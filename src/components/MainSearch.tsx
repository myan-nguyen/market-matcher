import FormSection from "./FormSection";

export default function MainSearch() {
  return (
    <FormSection title="main search"
      description="enter a brief summary/objective of this search. we'll reference this throughout the search process!">
      <input
        required
        className="form-input"
        type="text"
        name="query"
        autoComplete="off"
        placeholder="exactly who are we trying to find today?"
      />
    </FormSection>
  );
}
