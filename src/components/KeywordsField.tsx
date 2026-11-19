import FormSection from "./FormSection";

export default function KeywordsField() {
  return (
    <FormSection title="custom keywords"
      description="enter keywords that must be included, excluded, or heavily preferred... you get the gist">
      <input
        className="form-input"
        name="include"
        placeholder="include (comma separated, optional)"
      />
      <input
        className="form-input"
        name="prefer"
        placeholder="prefer (comma separated, optional)"
      />
      <input
        className="form-input"
        name="exclude"
        placeholder="exclude (comma separated, optional)"
      />
    </FormSection>
  );
}
