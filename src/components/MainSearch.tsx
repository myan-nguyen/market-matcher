import FormSection from "./FormSection";

export default function MainSearch() {
  return (
    <FormSection title="main search"
      description="enter main search description">
      <input
        required
        className="form-input"
        type="text"
        name="query"
        autoComplete="off"
        placeholder="type any field (e.g. biomedical engineering, single cell analysis)..."
      />
    </FormSection>
  );
}
