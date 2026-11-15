"use client";
import { useEffect, useState } from "react";
import Backdrop from "@/components/Backdrop";
import { go as navigate, api, currentAccount } from "@/lib/api";

export default function AuthPage() {
  const [mode, setMode] = useState<"guest" | "login" | "register">("guest");
  const [form, setForm] = useState({ username: "", displayName: "", password: "" });
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = (): string => {
    const target = new URLSearchParams(window.location.search).get("next") ?? "/lobby";
    return target.startsWith("/") && !target.startsWith("//") ? target : "/lobby"; // same-site only
  };
  useEffect(() => {
    void currentAccount().then((a) => a && (navigate(next())));
  }, []);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "guest") await api("POST", "/api/auth/guest", { nickname });
      else await api("POST", `/api/auth/${mode}`, mode === "register" ? form : { username: form.username, password: form.password });
      navigate(next());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="page">
      <Backdrop variant="ambient" />
      <div className="content center" style={{ minHeight: "100vh", padding: 24 }}>
        <form className="glass card fade-in stack" style={{ width: "min(420px, 100%)", padding: 28, gap: 16 }} onSubmit={submit}>
          <a className="brand" href="/"><span className="brand-mark" />Mission Forge</a>
          <div>
            <h1 style={{ fontSize: 26 }}>{mode === "guest" ? "Pick a nickname" : mode === "login" ? "Welcome back, engineer" : "Join the design lab"}</h1>
            <p className="dim" style={{ marginTop: 6 }}>{mode === "guest" ? "That is all you need to play. No account, no email, no personal details." : mode === "login" ? "Sign in to rejoin your missions." : "Create an account to start or join a mission."}</p>
          </div>
          <div className="tabs">
            <button type="button" className={`tab ${mode === "guest" ? "active" : ""}`} onClick={() => setMode("guest")}>Nickname</button>
            <button type="button" className={`tab ${mode === "login" ? "active" : ""}`} onClick={() => setMode("login")}>Sign in</button>
            <button type="button" className={`tab ${mode === "register" ? "active" : ""}`} onClick={() => setMode("register")}>Create account</button>
          </div>
          {mode === "guest" && <label className="field">Nickname<input className="input" value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="How your crew sees you" required minLength={2} maxLength={24} autoFocus /></label>}
          {mode !== "guest" && <label className="field">Username<input className="input" value={form.username} onChange={set("username")} autoComplete="username" required minLength={3} maxLength={32} autoFocus /></label>}
          {mode === "register" && <label className="field">Display name<input className="input" value={form.displayName} onChange={set("displayName")} placeholder="How teammates see you" maxLength={40} /></label>}
          {mode !== "guest" && <label className="field">Password<input className="input" type="password" value={form.password} onChange={set("password")} autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={10} /></label>}
          {mode === "register" && <div className="faint" style={{ fontSize: 12 }}>At least 10 characters. Stored only as a salted scrypt hash.</div>}
          {error && <div className="chip bad" style={{ whiteSpace: "normal", borderRadius: 10, padding: "8px 12px" }}>{error}</div>}
          <button className="btn primary lg" disabled={busy}>{busy ? <span className="spinner" /> : mode === "guest" ? "Enter" : mode === "login" ? "Sign in" : "Create account"}</button>
        </form>
      </div>
    </div>
  );
}
