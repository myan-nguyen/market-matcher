import FormSection from "./FormSection";

export default function MethodsField() {
  return (
    <FormSection title="research methods"
      description="declare any particular research methods a resulting profile should be correlated with">
      <input
        className="form-input"
        name="method"
        placeholder="ex: just-in-time adaptive intervention/JITAI"
      />
    </FormSection>
  );
}
