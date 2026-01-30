import Link from "next/link";

export default function Home() {
  return (
    <div style={{ padding: 20 }}>
      <h1>DOCU-LEA</h1>
      <p>Local dev home page</p>

      <Link href="/doculea-test">
        <button style={{ padding: 10, border: "1px solid black", borderRadius: 8 }}>
          Open DOCU-LEA
        </button>
      </Link>
    </div>
  );
}
