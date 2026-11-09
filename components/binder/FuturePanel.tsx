"use client";

type Stub = { id: string; title: string; status: string; note: string; live: boolean };

type Props = {
  note: string;
  liveConnections: number;
  stubs: Stub[];
  loaded: boolean;
};

export function FuturePanel({ note, liveConnections, stubs, loaded }: Props) {
  return (
    <section className="screen">
      <header className="screen-head">
        <div>
          <p className="kicker">Future / stub — not built</p>
          <h2>{note}</h2>
          <p className="lede">{liveConnections} live connections. Labels only. Nothing here is wired.</p>
        </div>
      </header>
      {!loaded && <p className="hint">Loading stubs…</p>}
      <div className="stub-grid">
        {stubs.map((stub) => (
          <article key={stub.id} className="stub">
            <div className="label-row">
              <strong>{stub.title}</strong>
              <span className="pill miss">{stub.status}</span>
            </div>
            <p className="mono hint">{stub.id}</p>
            <p>{stub.note}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
