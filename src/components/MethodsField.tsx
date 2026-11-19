import FormSection from "./FormSection";

export default function MethodsField() {
  return (
    <FormSection title="research methods"
      description="enter methods description">
      <input
        className="form-input"
        name="method"
        placeholder="enter something"
      />
    </FormSection>
  );
}
