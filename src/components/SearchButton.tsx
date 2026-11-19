export default function SearchButton({ loading = false }: { loading?: boolean }) {
  return (
    <button className="search-button" type="submit" disabled={loading}>
      {loading ? "Searching..." : "Search"}
    </button>
  );
}
