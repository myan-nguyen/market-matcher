import { Bookmark, Star } from "lucide-react";
import type { Candidate, ClaimStatus } from "@/types/search";
import { STAGE_LABELS } from "@/types/search";
import { stateName } from "@/lib/states";

type Props = {
  candidate: Candidate;
  saved: boolean;
  onToggleSave: (c: Candidate) => void;
};

/** Filled star when the claim is verified, outline otherwise. Sits left of the content. */
function Mark({ status }: { status: ClaimStatus }) {
  const verified = status === "verified";
  return (
    <Star
      className="card-star"
      size={14}
      aria-label={verified ? "verified" : "not verified"}
      fill={verified ? "currentColor" : "none"}
      style={{ marginRight: 6, verticalAlign: "-2px", flexShrink: 0 }}
    />
  );
}

/** The text itself links to its source when there is one. */
function Linked({ url, children }: { url: string | null; children: React.ReactNode }) {
  if (!url) return <>{children}</>;
  return (
    <a className="card-source" href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export default function CandidateCard({ candidate: c, saved, onToggleSave }: Props) {
  const org = c.organizations[0];
  const stageText = c.stage.value ? STAGE_LABELS[c.stage.value] : "Unknown";
  const locText = c.location.value ? (stateName(c.location.value) ?? c.location.value) : "Unknown";

  return (
    <article className="card">
      <div className="card-top">
        <div>
          <h3 className="card-name">{c.name}</h3>
          <p className="card-org">
            {org && <Mark status={org.status} />}
            <Linked url={org?.source ?? null}>
              {org ? org.name : "Unknown organization"}
              {org?.lab ? ` · ${org.lab}` : ""}
            </Linked>
          </p>
        </div>
        <button
          type="button"
          className="card-bookmark"
          onClick={() => onToggleSave(c)}
          aria-pressed={saved}
          aria-label={saved ? `Remove ${c.name} from bookmarks` : `Bookmark ${c.name}`}
          title={saved ? "Remove bookmark" : "Bookmark"}
        >
          <Bookmark size={20} fill={saved ? "currentColor" : "none"} />
        </button>
      </div>

      <p className="card-line">
        <span className="card-label">University / institution</span>
        {c.organizations.length ? (
          <span className="card-orgs">
            {c.organizations.slice(0, 3).map((o, i) => (
              <span className="card-org-item" key={`${o.name}-${i}`}>
                <Mark status={o.status} />
                <Linked url={o.source}>{o.name}</Linked>
              </span>
            ))}
          </span>
        ) : (
          "Not found"
        )}
      </p>
      <p className="card-line">
        <span className="card-label">Stage</span>
        <Mark status={c.stage.status} />
        <Linked url={c.stage.source}>{c.stage.status === "conflicting" ? "Conflicting" : stageText}</Linked>
      </p>
      <p className="card-line">
        <span className="card-label">Location</span>
        <Mark status={c.location.status} />
        <Linked url={c.location.source}>{c.location.status === "conflicting" ? "Conflicting" : locText}</Linked>
      </p>
      <p className="card-line">
        <span className="card-label">Why they fit</span>
        {c.fit}
      </p>
      {c.focus.value && (
        <p className="card-line">
          <span className="card-label">Research focus</span>
          <Mark status={c.focus.status} />
          <Linked url={c.focus.source}>{c.focus.value}</Linked>
        </p>
      )}
      <p className="card-line">
        <span className="card-label">Methods</span>
        {c.methods.length ? c.methods.join(", ") : "Not extracted"}
      </p>
      <p className="card-line">
        <span className="card-label">Evidence</span>
      </p>
      <ul className="card-evidence">
        {c.evidence.map((e) => (
          <li key={e.url}>
            <a href={e.url} target="_blank" rel="noopener noreferrer">
              {e.label}
            </a>{" "}
            <span className="card-meta">
              {e.type} · {e.date.slice(0, 4)}
            </span>
          </li>
        ))}
      </ul>
      <p className="card-line">
        <span className="card-label">Contact</span>
        {c.contact?.kind === "email" ? (
          <>
            <a href={`mailto:${c.contact.value}`}>Email: {c.contact.value}</a>
            <a className="card-source" href={c.contact.source} target="_blank" rel="noopener noreferrer">
              published here · checked {c.contact.checkedAt.slice(0, 10)}
            </a>
          </>
        ) : c.contact?.kind === "page" ? (
          <a href={c.contact.value} target="_blank" rel="noopener noreferrer">
            Contact page
          </a>
        ) : (
          "No verified contact found"
        )}
      </p>
    </article>
  );
}
