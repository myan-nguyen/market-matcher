import SearchWorkspace from "@/components/SearchWorkspace";
import Header from "@/components/Header";
import "./styles.css";

export default function Home() {
  return (
    <main className="page">
      <Header />
      <SearchWorkspace />
    </main>
  );
}
