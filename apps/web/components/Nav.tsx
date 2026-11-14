"use client";
import { useEffect, useState } from "react";
import { go as navigate, type Account, api, currentAccount } from "@/lib/api";

/** Top navigation shared by the non-workspace pages. */
export default function Nav({ onAccount }: { onAccount?: (a: Account | null) => void }) {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  useEffect(() => {
    void currentAccount().then((a) => {
      setAccount(a);
      onAccount?.(a);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const signOut = async (): Promise<void> => {
    await api("POST", "/api/auth/logout", {});
    navigate("/");
  };
  return (
    <nav className="nav container">
      <a className="brand" href="/">
        <span className="brand-mark" />
        Mission Forge
      </a>
      <div className="row">
        <a className="btn ghost sm" href="/lobby">Missions</a>
        <a className="btn ghost sm" href="/leaderboard">Leaderboard</a>
        <a className="btn ghost sm" href="/research">Research</a>
        {account === undefined ? null : account ? (
          <>
            <span className="chip info" title={account.role === "admin" ? "Platform administrator" : "Member"}>{account.displayName}</span>
            <button className="btn ghost sm" onClick={signOut}>Sign out</button>
          </>
        ) : (
          <a className="btn sm primary" href="/auth">Sign in</a>
        )}
      </div>
    </nav>
  );
}
