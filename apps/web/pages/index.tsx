import Link from "next/link";

export default function Home() {
  return (
    <div style={{ padding: 20 }}>
      <h1>Docu-Lea</h1>
      <p>Document Legitimacy Assistant</p>

      <Link href="/doculea-test">
        <button style={{ padding: 10, border: "1px solid black", borderRadius: 8 }}>
          Open Docu-Lea
        </button>
      </Link>
    </div>
  );
}

