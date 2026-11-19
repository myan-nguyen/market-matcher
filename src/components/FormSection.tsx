import type { ReactNode } from "react";

type FormSectionProps = {
  title: string;
  description?: string;
  children: ReactNode;
};

export default function FormSection({ title, description = "enter description", children }: FormSectionProps) {
  return (
    <section className="form-section">
      <h2 className="form-title">{title}</h2>
      <p className="form-description">{description}</p>
      {children}
    </section>
  );
}
