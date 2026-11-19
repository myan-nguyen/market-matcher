type Chip = {
  label: string;
  selected: boolean;
  onClick: () => void;
};

export default function SuggestionChips({ chips }: { chips: Chip[] }) {
  return (
    <div className="chips">
      <span className="chips-label">Suggested</span>
      {chips.map((chip) => (
        <button
          key={chip.label}
          type="button"
          className={chip.selected ? "chip chip-on" : "chip"}
          aria-pressed={chip.selected}
          onClick={chip.onClick}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}
